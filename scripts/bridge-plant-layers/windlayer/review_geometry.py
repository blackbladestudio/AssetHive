import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

def orient_terminal_blades(variant):
    """A rooted grass blade uses its attached end as the origin for Ripple."""
    changed = 0
    size = variant["frame"]["sizeCm"]
    for row in variant["bindings"]:
        if not row["terminal"] or row.get("review") or row["primary"] < 0 or row["secondary"] >= 0 or row["primaryAttachment"] >= 0:
            continue
        base = variant["primaryAxes"][row["primary"]]["base"]
        blade = row["blade"]
        distance = [sum(((p[k] - base[k]) * size[k]) ** 2 for k in range(3)) for p in blade]
        if distance[1] < distance[0]:
            row["blade"] = [blade[1], blade[0]]
            changed += 1
    return changed


def review_geometry(variant, positions, triangles, labels, static):
    """Verify botanical roles against original (uncut) connected geometry."""
    rows = variant['bindings']
    count = len(rows)
    if not count:
        return
    lower = np.full((count, 3), np.inf)
    upper = np.full((count, 3), -np.inf)
    np.minimum.at(lower, labels, positions)
    np.maximum.at(upper, labels, positions)
    origin = positions.min(0)
    span = np.maximum(np.ptp(positions, axis=0), 1e-9)
    centers = ((lower + upper) * .5 - origin) / span
    # One-loop sheet outlines and two separated end rings represent different
    # tissue even if the atlas or silhouette makes both look like leaves.
    edges = np.sort(np.vstack([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]]), axis=1)
    unique, incidence = np.unique(edges, axis=0, return_counts=True)
    boundary = unique[incidence == 1]
    tubular = tubular_islands(positions, labels, boundary)
    for row in rows:
        i = row['island']
        row['boundsCenter'] = centers[i].round(7).tolist()
        if static:
            row.update(primary=-1, secondary=-1, primaryAttachment=0, secondaryAttachment=0, terminal=False,
                       influence=False, layers=[], review=False, attachMethod='static')
        elif i in tubular:
            row['terminal'] = False
            row['layers'] = [layer for layer in row.get('layers', []) if layer != 'Ripple']
        if row.get('attachMethod') == 'synthetic':
            row.update(review=True, influence=False, layers=['Shared'], terminal=False)
    if static:
        variant['primaryAxes'] = []
        variant['secondaryAxes'] = []
        variant['review'] = {'status':'static', 'reasons':[]}
    orient_terminal_blades(variant)
    counts=variant['counts']
    counts.update(primaryAxes=len(variant['primaryAxes']),secondaryAxes=len(variant['secondaryAxes']),
                  foliageIslands=sum(row['terminal'] for row in rows),tubularIslands=len(tubular))


def tubular_islands(positions, labels, boundary):
    """A stem has two closed boundary rings separated by more than their diameter."""
    tubular = set()
    if len(boundary):
        boundary = boundary[np.argsort(labels[boundary[:, 0]], kind='stable')]
        starts = np.flatnonzero(np.r_[True, np.diff(labels[boundary[:, 0]]) != 0])
        for group in np.split(boundary, starts[1:]):
            vertices, ids, degree = np.unique(group, return_inverse=True, return_counts=True)
            if len(vertices) < 6 or np.any(degree != 2):
                continue
            pairs = ids.reshape(-1, 2)
            graph = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(vertices), len(vertices)))
            num, rims = connected_components(graph, directed=False)
            if num != 2:
                continue
            end_rings = [positions[vertices[rims == end]] for end in (0, 1)]
            bases = [ring.mean(0) for ring in end_rings]
            radius = max(np.linalg.norm(ring - base, axis=1).max() for ring, base in zip(end_rings, bases))
            if np.linalg.norm(bases[0] - bases[1]) > 3 * radius:
                tubular.add(int(labels[vertices[0]]))
    return tubular
