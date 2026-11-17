"""Resolve ambiguous bindings only where the original mesh gives a root or a unique parent contact."""
import numpy as np
from scipy.spatial import cKDTree

from .review_geometry import tubular_islands
from .surface_fragments import triangle_distances
from .root_stems import recover_measured_roots


def support_surface_contacts(points, radii, vertices, triangles, labels, support, tolerance, *, point_tolerances=None, identity_key=None):
    """Measure finite source faces; a sparse support need not have a vertex at the joint."""
    owner_by_island = np.full(int(labels.max()) + 1, -1, dtype=np.int32)
    identities = []
    identity_ids = {}
    for row in support:
        identity = identity_key(row) if identity_key else (row["primary"], row["secondary"])
        if identity not in identity_ids:
            identity_ids[identity] = len(identities)
            identities.append(identity)
        owner_by_island[row["island"]] = identity_ids[identity]
    selected = triangles[owner_by_island[labels[triangles[:, 0]]] >= 0]
    nearest = np.full(len(points), np.inf)
    owners = np.full(len(points), -1, dtype=np.int32)
    if not len(selected):
        return nearest, owners, identities
    xyz = vertices[selected]
    centers = xyz.mean(axis=1)
    face_radii = np.linalg.norm(xyz - centers[:, None], axis=2).max(axis=1)
    face_owners = owner_by_island[labels[selected[:, 0]]]
    levels = np.floor(np.log2(np.maximum(face_radii, tolerance) / tolerance)).astype(int)
    buckets = []
    for level in np.unique(levels):
        ids = np.flatnonzero(levels == level)
        buckets.append((cKDTree(centers[ids]), ids, face_radii[ids].max()))
    for start in range(0, len(points), 512):
        probes = points[start:start + 512]
        bounds = radii[start:start + 512]
        contact_tolerance = (np.full(len(probes), tolerance) if point_tolerances is None else
                             np.asarray(point_tolerances)[start:start+len(probes)])
        best = np.full(len(probes), np.inf)
        contacts = []
        for tree, ids, radius in buckets:
            hits = tree.query_ball_point(probes, bounds + radius, return_sorted=False)
            counts = np.fromiter(map(len, hits), dtype=int, count=len(hits))
            if not counts.any():
                continue
            probe_ids = np.repeat(np.arange(len(probes)), counts)
            face_ids = ids[np.concatenate([hit for hit in hits if len(hit)]).astype(np.intp)]
            delta = probes[probe_ids] - centers[face_ids]
            possible = np.einsum("ij,ij->i", delta, delta) <= (bounds[probe_ids] + face_radii[face_ids])**2
            probe_ids, face_ids = probe_ids[possible], face_ids[possible]
            distances = triangle_distances(probes[probe_ids], xyz[face_ids])
            np.minimum.at(best, probe_ids, distances)
            close = distances <= (3 * contact_tolerance[probe_ids])**2
            if close.any():
                contacts.append((probe_ids[close], face_owners[face_ids[close]], distances[close]))
        least = np.full(len(probes), len(identities), dtype=np.int32)
        most = np.full(len(probes), -1, dtype=np.int32)
        uncertainty = np.maximum(2 * contact_tolerance, 3 * np.sqrt(best))**2
        for probe_ids, branches, distances in contacts:
            close = distances <= uncertainty[probe_ids]
            np.minimum.at(least, probe_ids[close], branches[close])
            np.maximum.at(most, probe_ids[close], branches[close])
        unique = (least == most) & (most >= 0)
        owners[start:start + len(probes)] = np.where(unique, most, -1)
        nearest[start:start + len(probes)] = np.sqrt(best)
    return nearest, owners, identities


def is_support(row):
    return (row.get("attachMethod") == "support" and not row.get("review")
            and row.get("influence", True) and row["primary"] >= 0
            and (row["primaryAttachment"] < 0 if row["secondary"] < 0 else row["secondaryAttachment"] < 0))


def _recover_contacts_once(variant, rows, vertices, triangles, labels, form, *, detail_contacts=False):
    """Rows may be a subset, but must include every reviewed island and every active support."""
    candidates = {row["island"]: row for row in rows if row.get("review")}
    if not candidates or not form:
        return
    origin = vertices.min(axis=0)
    size = np.maximum(np.ptp(vertices, axis=0), 1e-9)
    height = size[2]
    index = np.argsort(labels, kind="stable")
    offsets = np.r_[0, np.cumsum(np.bincount(labels))]
    faces = np.bincount(labels[triangles[:, 0]], minlength=len(offsets) - 1)
    primary, secondary = variant["primaryAxes"], variant["secondaryAxes"]

    def positions(i):
        return vertices[index[offsets[i]:offsets[i + 1]]]

    def norm(point):
        return ((point - origin) / size).round(6).tolist()

    def param(p, axis):
        a = origin + size * axis["base"]
        ab = size * (np.asarray(axis["tip"]) - axis["base"])
        return round(float(np.clip(np.dot(p - a, ab) / max(np.dot(ab, ab), 1e-12), 0., 1.)), 5)

    # A triangle fragment or a plain atlas quad doesn't identify a botanical organ.
    # Use the mean of each end band to avoid treating the corner of a wide card as its stem.
    # Only open sheet components qualify as terminal leaves. Reuse the original FBX
    # incidence so a narrow, flattened tube never gains Ripple by its silhouette.
    relevant = np.zeros(len(faces), dtype=bool)
    relevant[list(candidates)] = True
    subset = triangles[relevant[labels[triangles[:, 0]]]]
    edges = np.sort(np.concatenate([subset[:, [0, 1]], subset[:, [1, 2]], subset[:, [2, 0]]]), axis=1)
    unique, incidence = np.unique(edges, axis=0, return_counts=True)
    boundary = unique[incidence == 1]
    boundary_count = np.bincount(labels[boundary[:, 0]], minlength=len(faces))
    edge_count = np.bincount(labels[unique[:, 0]], minlength=len(faces))
    manifold = np.ones(len(faces), dtype=bool)
    manifold[labels[unique[incidence > 2, 0]]] = False
    disk = manifold & (boundary_count >= 3) & (np.diff(offsets) - edge_count + faces == 1)
    structural = np.zeros(len(faces), dtype=bool)
    structural[[i for i, row in candidates.items() if row.get("attachMethod") == "unplacedSupport"]] = True
    tubes = tubular_islands(vertices, labels, boundary[structural[labels[boundary[:, 0]]]])
    bodies = {}
    for i, row in candidates.items():
        if faces[i] < 3:
            continue
        pts = positions(i)
        center = pts.mean(axis=0)
        vals, axes = np.linalg.eigh((pts-center).T @ (pts-center))
        along = (pts-center) @ axes[:, -1]
        length = float(np.ptp(along))
        if length < (.12 if detail_contacts else max(.12, height * .012)) or vals[-1] < 3.0 * vals[-2]:
            continue
        band = .03 if detail_contacts else .12
        ends = [pts[along <= along.min() + band * length], pts[along >= along.max() - band * length]]
        base, tip = (end.mean(axis=0) for end in ends)
        if base[2] > tip[2]:
            base, tip = tip, base
        bodies[i] = (base, tip, length, vals)

    # Paired surfaces share a unit in an inline manifest. In compact chunks the unit
    # identity is absent: never invent an independent support axis for those islands.
    groups = {}
    for i, row in candidates.items():
        if "unit" in row:
            groups.setdefault(row["unit"], []).append(i)
    for unit, ids in sorted(groups.items()):
        if not all(i in bodies for i in ids):
            continue
        base = np.mean([bodies[i][0] for i in ids], axis=0)
        tip = np.mean([bodies[i][1] for i in ids], axis=0)
        length = np.linalg.norm(tip-base)
        if (length < .19 * height or tip[2] - base[2] < .55 * length
                or base[2] - origin[2] > .065 * height):
            continue
        # Grass blades with a narrow, planar body can establish their own root.
        # In other forms only a previously detected structural support qualifies.
        grass = form == "grass"
        if not all((bodies[i][3][2] >= 16 * bodies[i][3][1]
                    and disk[i] and bodies[i][3][0] <= .12 * bodies[i][3][1]) if grass else
                   (candidates[i].get("unplacedSupport") and bodies[i][3][2] >= 25 * bodies[i][3][1])
                   for i in ids):
            continue
        pid = len(primary)
        axis = dict(id=pid, base=norm(base), tip=norm(tip), lengthCm=round(float(length), 4),
                    rooted=True, synthetic=False, units=[unit], terminalBlade=grass)
        primary.append(axis)
        for i in ids:
            row = candidates[i]
            row.update(primary=pid, secondary=-1, primaryAttachment=-1., secondaryAttachment=-1.,
                       blade=[norm(bodies[i][0]), norm(bodies[i][1])], terminal=grass, review=False,
                       influence=True, layers=["Shared", "Branch1"] + (["Ripple"] if grass else []),
                       attachMethod="support")
            for key in ("unplacedSupport", "unassigned", "syntheticAxis"):
                row.pop(key, None)

    if groups and not any(not ax.get("synthetic") for ax in primary):
        recover_basal_stems(variant, candidates, groups, positions, faces, origin, size)

    recover_measured_roots(variant, rows, vertices, triangles, labels)

    # Index only structural geometry. Two leaves that cross in space are not
    # evidence that either is attached to the other's branch.
    support = [row for row in rows if is_support(row)]
    if not support:
        return
    tol = np.clip(.0025 * np.linalg.norm(size), .025, .25)
    body_ids = [i for i in bodies if candidates[i].get("review")]
    if not body_ids:
        return
    probes = np.vstack([[bodies[i][0], bodies[i][1]] for i in body_ids])
    tolerances = {i: min(tol, max(.015, .08*bodies[i][2])) if detail_contacts else tol for i in body_ids}
    radii = np.repeat([max(3 * tolerances[i], .12 * bodies[i][2]) for i in body_ids], 2)
    per_point = np.repeat([tolerances[i] for i in body_ids], 2)
    distances, owners, identities = support_surface_contacts(probes, radii, vertices, triangles, labels, support, tol,
                                                           point_tolerances=per_point)
    contacts_by_island = {i: (distances[2*k:2*k+2], owners[2*k:2*k+2]) for k, i in enumerate(body_ids)}
    proposals = {}
    lateral = {}
    for i, (a, b, length, vals) in bodies.items():
        row = candidates[i]
        # Unplaced structural pieces cannot be classified as leaves by proximity.
        if not row.get("review"):
            continue
        stem = row.get("attachMethod") == "unplacedSupport"
        if stem:
            if (i not in tubes or "unit" not in row or form not in ("herb", "bush", "tree", "palm")
                    or vals[2] < 16 * vals[1]):
                continue
        elif not disk[i] or vals[0] > .16 * vals[1]:
            continue
        ends = np.array([a, b])
        dist, endpoint_owners = contacts_by_island[i]
        near = int(np.argmin(dist))
        body_tolerance = tolerances[i]
        if dist[near] > body_tolerance or dist[1-near] <= max(3 * body_tolerance, .12 * length):
            continue
        if endpoint_owners[near] < 0:
            continue
        pid, sid = identities[endpoint_owners[near]]
        if stem:
            if sid < 0:
                lateral[i] = (pid, ends[near], ends[1-near])
        else:
            proposals[i] = (pid, sid, ends[near], ends[1-near])

    for unit, ids in sorted(groups.items()):
        if not all(i in lateral for i in ids) or len({lateral[i][0] for i in ids}) != 1:
            continue
        pid = lateral[ids[0]][0]
        base = np.mean([lateral[i][1] for i in ids], axis=0)
        tip = np.mean([lateral[i][2] for i in ids], axis=0)
        attach = param(base, primary[pid])
        sid = len(secondary)
        secondary.append(dict(id=sid, primary=pid, base=norm(base), tip=norm(tip),
                              lengthCm=round(float(np.linalg.norm(tip-base)), 4), attachOnPrimary=attach,
                              synthetic=False, units=[unit]))
        for i in ids:
            row = candidates[i]
            row.update(primary=pid, secondary=sid, primaryAttachment=attach, secondaryAttachment=-1.,
                       blade=[norm(lateral[i][1]), norm(lateral[i][2])], terminal=False, review=False,
                       influence=True, layers=["Shared", "Branch1", "Branch2"], attachMethod="support")
            row.pop("unplacedSupport", None)

    # Both faces of a paired leaf must reach the same unique parent.
    for ids in groups.values():
        decisions = {proposals[i][:2] if i in proposals else None for i in ids}
        if len(decisions) > 1:
            for i in ids:
                proposals.pop(i, None)
    compact = [i for i in proposals if "unit" not in candidates[i]]
    if compact:
        # Chunked rows omit unit IDs. Conservatively treat nearby components of
        # the same topology as possible opposite faces of the card.
        counts = np.diff(offsets)
        centers = np.column_stack([np.bincount(labels, weights=vertices[:, k]) / counts for k in range(3)])
        nearby = cKDTree(centers).query_ball_point(centers[compact], .05)
        for i, neighbors in zip(compact, nearby):
            if any(counts[i] == counts[j] and faces[i] == faces[j]
                   and proposals.get(j, (None, None))[:2] != proposals[i][:2] for j in neighbors):
                proposals.pop(i)
    for i, (pid, sid, attached, free) in proposals.items():
        row = candidates[i]
        row.update(primary=pid, secondary=sid, review=False, influence=True, terminal=True,
                   primaryAttachment=secondary[sid]["attachOnPrimary"] if sid >= 0 else param(attached, primary[pid]),
                   secondaryAttachment=param(attached, secondary[sid]) if sid >= 0 else -1.,
                   blade=[norm(attached), norm(free)], attachMethod="surfaceContact",
                   layers=["Shared", "Branch1"] + (["Branch2"] if sid >= 0 else []) + ["Ripple"])
        for key in ("syntheticAxis", "unassigned", "unplacedSupport"):
            row.pop(key, None)

def recover_contacts(variant, rows, vertices, triangles, labels, form, *, detail_contacts=False):
    """Resolve parents before descendants, stopping when no additional contact is proved."""
    initial = sum(bool(row.get("review")) for row in rows)
    for _ in range(6):
        before = sum(bool(row.get("review")) for row in rows)
        if not before:
            break
        _recover_contacts_once(variant, rows, vertices, triangles, labels, form, detail_contacts=detail_contacts)
        if sum(bool(row.get("review")) for row in rows) == before:
            break
    return initial - sum(bool(row.get("review")) for row in rows)


def recover_basal_stems(variant, candidates, groups, positions, faces, origin, size):
    """An upright mesh with a narrow grounded stalk can supply its own primary axis."""
    height = size[2]
    if height < .55 * max(size[:2]) or abs(origin[2]) > .15 * height:
        return
    stalks = []
    for unit, members in sorted(groups.items()):
        if any(faces[i] < 5 or len(positions(i)) < 8 for i in members):
            continue
        points = np.vstack([positions(i) for i in members])
        z = points[:, 2]
        rise = np.ptp(z)
        if (rise < .22 * height or z.min() - origin[2] > .045 * height
                or rise < .8 * np.linalg.norm(np.ptp(points[:, :2], axis=0))):
            continue
        low = points[z <= z.min() + .08 * rise]
        middle = points[np.abs(z - .5 * (z.max() + z.min())) <= .19 * rise]
        if not len(middle) or np.linalg.norm(np.ptp(low[:, :2], axis=0)) > .14 * rise:
            continue
        top = points[z >= z.max() - .08 * rise]
        samples = np.stack([low.mean(0), middle.mean(0), top.mean(0)])
        # Paired scan cards sometimes have distinct unit IDs. Require agreement
        # at the base, middle and tip before assigning a shared physical axis.
        tol = np.clip(.018 * rise, .06, .55)
        matches = [g for g in stalks if all(np.linalg.norm(samples-q, axis=1).max() <= min(tol, other_tol)
                                            for q, other_tol, _, _ in g)]
        if len(matches) > 1:
            continue
        if matches:
            matches[0].append((samples, tol, unit, members))
        else:
            stalks.append([(samples, tol, unit, members)])
    for stalk in stalks:
        base, middle, tip = np.mean([s[0] for s in stalk], axis=0)
        endpoints = [((p-origin)/size).round(6).tolist() for p in (base, tip)]
        pid = len(variant["primaryAxes"])
        variant["primaryAxes"].append(dict(id=pid, base=endpoints[0], tip=endpoints[1],
            lengthCm=round(float(np.linalg.norm(middle-base) + np.linalg.norm(tip-middle)), 4),
            rooted=True, synthetic=False, units=[s[2] for s in stalk], terminalBlade=False))
        for _, _, _, members in stalk:
            for i in members:
                row = candidates[i]
                row.update(primary=pid, secondary=-1, primaryAttachment=-1., secondaryAttachment=-1.,
                           blade=endpoints, terminal=False, influence=True, review=False,
                           layers=["Shared", "Branch1"], attachMethod="support")
                for key in ("unassigned", "unplacedSupport", "syntheticAxis"):
                    row.pop(key, None)


def prune_synthetic_axes(variant):
    """Discard the provisional cluster axes rejected by the geometry review."""
    axes = variant["primaryAxes"]
    if not any(axis.get("synthetic") for axis in axes):
        return None
    ids = {}
    retained = []
    for i, axis in enumerate(axes):
        if not axis.get("synthetic"):
            ids[i] = len(retained)
            axis["id"] = len(retained)
            retained.append(axis)
    for axis in variant["secondaryAxes"]:
        axis["primary"] = ids[axis["primary"]]
    variant["primaryAxes"] = retained
    variant["counts"]["primaryAxes"] = len(retained)
    return ids


def remap_primary(row, ids):
    old = row.get("primary", -1)
    if ids is None or old < 0:
        return
    if old in ids:
        row["primary"] = ids[old]
    elif row.get("review") or not row.get("influence", True):
        row.update(primary=-1, secondary=-1, primaryAttachment=-1., secondaryAttachment=-1.)
    else:
        raise ValueError("An active binding references a rejected synthetic primary")
