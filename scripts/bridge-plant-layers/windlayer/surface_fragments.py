"""Transfer wind from an identified tissue surface to small disconnected scan fragments."""
import numpy as np
import copy
from scipy.spatial import cKDTree


def triangle_distances(points, triangles):
    """Squared point-to-triangle distance, including finite edges and degenerate faces."""
    a, b, c = triangles.transpose(1, 0, 2)
    def dot(x, y):
        return np.einsum("ij,ij->i", x, y)
    ab, ac, ap = b-a, c-a, points-a
    normal = np.cross(ab, ac)
    nn = dot(normal, normal)
    inside = ((dot(np.cross(ab, ap), normal) >= 0) &
              (dot(np.cross(c-b, points-b), normal) >= 0) &
              (dot(np.cross(a-c, points-c), normal) >= 0) & (nn > 1e-22))
    dist = np.where(inside, dot(ap, normal)**2 / np.maximum(nn, 1e-22), np.inf)
    for start, edge in ((a, ab), (b, c-b), (c, -ac)):
        delta = points-start
        fraction = np.clip(dot(delta, edge) / np.maximum(dot(edge, edge), 1e-22), 0., 1.)
        residual = delta - fraction[:, None]*edge
        dist = np.minimum(dist, dot(residual, residual))
    return dist


def find_fragment_parents(vertices, triangles, labels, rows, height, *, review_only=False, max_faces=6):
    """Return an island-to-parent lookup; -1 means that no unique physical surface was proved."""
    face_islands = labels[triangles[:, 0]]
    n = int(labels.max()) + 1
    counts = np.bincount(face_islands, minlength=n)
    lo = np.full((n, 3), np.inf)
    hi = np.full((n, 3), -np.inf)
    np.minimum.at(lo, labels, vertices)
    np.maximum.at(hi, labels, vertices)
    span = np.linalg.norm(hi-lo, axis=1)
    max_fragment = min(.65, .015 * height)  # cm
    small = (span <= max_fragment) & (span > 1e-5)
    fragment = (counts >= 1) & (counts <= max_faces) & small
    matched = np.full(n, -1, dtype=np.int32)
    parents = []
    if not fragment.any():
        return matched, parents
    tissue = (counts >= 4) & (span >= max(4 * max_fragment, .035 * height))
    owners = np.full(n, -1, dtype=np.int32)
    identities = {}
    pending = np.zeros(n, dtype=bool)
    inherited = np.zeros(n, dtype=bool)
    for row in rows:
        island = row["island"]
        pending[island] = row.get("review",False)
        inherited[island] = row.get("attachMethod") == "surfaceInherited"
        if (not tissue[island] or row.get("review") or not row.get("influence", True)
                or row["attachMethod"] not in ("support", "surfaceContact")):
            continue
        key = (row["primary"], row["secondary"], row["primaryAttachment"], row["secondaryAttachment"],
               row["terminal"], tuple(map(tuple, row["blade"])) if row["terminal"] else (),
               tuple(row["rootContact"]["center"]) + (row["rootContact"]["innerHeight"], row["rootContact"]["outerHeight"])
               if "rootContact" in row else None)
        owner = identities.get(key)
        if owner is None:
            owner = len(parents)
            identities[key] = owner
            parents.append(row)
        owners[island] = owner
    fragment &= pending if review_only else ((counts == 1) | pending | inherited)
    if not parents or not fragment.any():
        return matched, parents

    faces = triangles[owners[face_islands] >= 0]
    xyz = vertices[faces]
    c = xyz.mean(axis=1)
    radii = np.max(np.linalg.norm(xyz - c[:, None], axis=2), axis=1)
    owner = owners[labels[faces[:, 0]]]
    tol = float(np.clip(.0006 * height, .015, .07))
    # Buckets bound the search by each triangle's true radius, including wide faces.
    buckets = []
    levels = np.floor(np.log2(np.maximum(radii, tol)/tol)).astype(int)
    for level in np.unique(levels):
        idx = np.flatnonzero(levels == level)
        buckets.append((cKDTree(c[idx]), idx, radii[idx].max() + 2 * tol))
    fragments = triangles[fragment[face_islands]]
    minimum_owner = np.full(n,len(parents),dtype=np.int32)
    maximum_owner = np.full(n,-1,dtype=np.int32)
    for start in range(0, len(fragments), 1024):
        faces = fragments[start:start+1024]
        probes = vertices[faces].reshape(-1, 3)
        best = np.full(len(probes), np.inf)
        least = np.full(len(probes), len(parents), dtype=np.int32)
        most = np.full(len(probes), -1, dtype=np.int32)
        for tree, idx, radius in buckets:
            hits = tree.query_ball_point(probes, radius, return_sorted=False)
            sizes = np.fromiter(map(len, hits), dtype=int, count=len(hits))
            if not sizes.any():
                continue
            probe_id = np.repeat(np.arange(len(hits)), sizes)
            face_id = idx[np.concatenate(hits[sizes > 0]).astype(np.intp)]
            diff = probes[probe_id] - c[face_id]
            possible = np.einsum("ij,ij->i", diff, diff) <= (radii[face_id] + 2 * tol)**2
            probe_id, face_id = probe_id[possible], face_id[possible]
            dist = triangle_distances(probes[probe_id], xyz[face_id])
            close = dist <= (2*tol)**2
            np.minimum.at(least, probe_id[close], owner[face_id[close]])
            np.maximum.at(most, probe_id[close], owner[face_id[close]])
            np.minimum.at(best, probe_id, dist)
        a = least.reshape(-1, 3).min(axis=1)
        b = most.reshape(-1, 3).max(axis=1)
        distances = best.reshape(-1, 3)
        valid = ((a == b) & (distances.min(axis=1) <= (.5*tol)**2)
                 & ((distances <= tol**2).sum(axis=1) >= 2) & (distances.max(axis=1) <= (2*tol)**2))
        # Every triangle of a disconnected piece must agree, including
        # triangles on opposite sides of a processing batch.
        ids = labels[faces[:,0]]
        np.minimum.at(minimum_owner, ids, np.where(valid,a,-1))
        np.maximum.at(maximum_owner, ids, np.where(valid,a,-1))
    good = fragment & (minimum_owner == maximum_owner) & (minimum_owner >= 0)
    matched[good] = minimum_owner[good]
    return matched, parents


def inherit_surface(row, parent):
    fields = ("primary", "secondary", "primaryAttachment", "secondaryAttachment", "terminal", "layers", "blade")
    if (not row.get("review") and all(row.get(k) == parent[k] for k in fields
                                     if k != "blade" or parent["terminal"])
            and row.get("rootContact") == parent.get("rootContact")):
        return False
    row.update({k: parent[k] for k in fields})
    if "rootContact" in parent:
        row["rootContact"] = copy.deepcopy(parent["rootContact"])
    else:
        row.pop("rootContact", None)
    row.update(review=False, influence=True, attachMethod="surfaceInherited")
    for k in ("unassigned", "syntheticAxis", "unplacedSupport", "parentUnit", "tipCluster"):
        row.pop(k, None)
    return True
