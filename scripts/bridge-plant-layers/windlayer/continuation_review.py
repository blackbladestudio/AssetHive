"""Recover a capped scanned shaft only after closed cross-sections and a real joint agree."""
import numpy as np

from .contact_review import is_support, support_surface_contacts


def capped_shaft(points, faces):
    """A closed tubular section distinguishes a capped stem from a long leaf sheet."""
    if len(points) < 10 or len(faces) < 8:
        return None
    center = points.mean(axis=0)
    values, vectors = np.linalg.eigh((points-center).T @ (points-center))
    if values[-1] < 16 * values[-2]:
        return None
    direction = vectors[:, -1]
    along = (points-center) @ direction
    length = float(np.ptp(along))
    if length < .15:
        return None
    edges = np.sort(np.vstack((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]])), axis=1)
    edges, incidence = np.unique(edges, axis=0, return_counts=True)
    if np.any(incidence > 2):
        return None
    z0, z1 = along[edges[:, 0]], along[edges[:, 1]]
    widths = []
    for fraction in (.05, .18, .36, .55, .73, .91):
        z = float(along.min() + fraction * length)
        hit = (z0 < z) != (z1 < z)
        if hit.sum() < 4 or np.any(incidence[hit] != 2):
            return None
        a, b = points[edges[hit, 0]], points[edges[hit, 1]]
        q = a + ((z-z0[hit])/(z1[hit]-z0[hit]))[:, None] * (b-a)
        delta = q-q.mean(axis=0)
        section_values = np.linalg.eigvalsh(delta.T @ delta)
        # A solid double-sided leaf can also have closed sections, but is very flat.
        if section_values[1] < .035 * section_values[2]:
            return None
        widths.append(2 * float(np.linalg.norm(delta, axis=1).max()))
    if max(widths) > .085 * length or min(widths) < .22 * max(widths):
        return None
    band = min(.02 * length, .05)
    samples = [points[along <= along.min()+band], points[along >= along.max()-band]]
    ends = np.array([q.mean(axis=0) for q in samples])
    return ends, length, samples


def recover_capped_stems(variant, rows, vertices, triangles, labels, form):
    """Keep a continuation on its existing branch; create B2 only at a primary joint."""
    if form not in ('grass', 'herb', 'fern', 'bush', 'tree', 'palm', 'groundcover'):
        return []
    supports = [row for row in rows if is_support(row)]
    if not supports:
        return []
    n = int(labels.max())+1
    vertex_order = np.argsort(labels, kind='stable')
    vertex_ends = np.r_[0, np.bincount(labels, minlength=n).cumsum()]
    face_islands = labels[triangles[:, 0]]
    face_order = np.argsort(face_islands, kind='stable')
    face_ends = np.r_[0, np.bincount(face_islands, minlength=n).cumsum()]
    low = vertices.min(axis=0)
    size = np.maximum(np.ptp(vertices, axis=0), 1e-9)
    tolerance = float(np.clip(.0025*np.linalg.norm(size), .025, .25))
    candidates = []
    for row in rows:
        if not row.get('review') or row.get('attachMethod') not in ('unplacedSupport','synthetic','unassigned'):
            continue
        i = row['island']
        idx = vertex_order[vertex_ends[i]:vertex_ends[i+1]]
        points = vertices[idx]
        if np.linalg.norm(np.ptp(points, axis=0)) < .02*size[2]:
            continue
        faces = triangles[face_order[face_ends[i]:face_ends[i+1]]]
        local = np.searchsorted(np.sort(idx), faces)
        points = vertices[np.sort(idx)]
        proof = capped_shaft(points, local)
        if proof:
            candidates.append((row, *proof))
    if not candidates:
        return []
    samples = [q for _, _, _, ends in candidates for q in ends]
    probes = np.vstack(samples)
    sizes = np.array([len(q) for q in samples])
    offsets = np.r_[0, sizes.cumsum()]
    radii = np.repeat([max(3*tolerance, .12*length) for _, _, length, _ in candidates for _ in range(2)], sizes)
    distances, owners, identities = support_surface_contacts(probes, radii, vertices, triangles, labels, supports, tolerance)
    endpoint_distances = np.minimum.reduceat(distances, offsets[:-1])
    endpoint_owners = []
    for start, stop in zip(offsets[:-1], offsets[1:]):
        close = distances[start:stop] <= tolerance
        close_owners = set(owners[start:stop][close].tolist())
        endpoint_owners.append(close_owners.pop() if len(close_owners) == 1 else -1)
    def norm(point):
        return ((point-low)/size).round(8).tolist()
    def parameter(point, axis):
        a = low+size*np.asarray(axis['base'])
        delta = size*(np.asarray(axis['tip'])-axis['base'])
        return float(np.clip((point-a)@delta/max(delta@delta, 1e-10), 0, 1))
    recovered = []
    for k, (row, ends, length, _) in enumerate(candidates):
        dist, branch = endpoint_distances[2*k:2*k+2], endpoint_owners[2*k:2*k+2]
        near = int(np.argmin(dist))
        if (dist[near] > tolerance or branch[near] < 0 or
                dist[1-near] <= max(3*tolerance, .12*length)):
            continue
        pid, sid = identities[branch[near]]
        base, tip = ends[near], ends[1-near]
        axis = variant['primaryAxes'][pid] if sid < 0 else variant['secondaryAxes'][sid]
        axis_direction = size*(np.asarray(axis['tip'])-axis['base'])
        direction = tip-base
        cosine = abs(float(direction@axis_direction/max(np.linalg.norm(direction)*np.linalg.norm(axis_direction), 1e-10)))
        continuation = cosine >= .9
        if sid < 0 and not continuation:
            attached = round(parameter(base, axis), 5)
            sid = len(variant['secondaryAxes'])
            variant['secondaryAxes'].append(dict(id=sid, primary=pid, base=norm(base), tip=norm(tip),
                lengthCm=round(float(np.linalg.norm(direction)), 4), attachOnPrimary=attached,
                synthetic=False, units=[]))
        primary_attachment = variant['secondaryAxes'][sid]['attachOnPrimary'] if sid >= 0 else -1.
        # Deeper lateral twigs share the parent's rigid response at their joint.
        # A continuation samples the same field on both sides of the scan seam.
        secondary_attachment = (-1. if continuation or axis is not variant['secondaryAxes'][sid]
                                else round(parameter(base, axis), 5)) if sid >= 0 else -1.
        row.update(primary=pid, secondary=sid, primaryAttachment=primary_attachment,
            secondaryAttachment=secondary_attachment, terminal=False, review=False, influence=True,
            blade=[norm(base), norm(tip)], layers=['Shared','Branch1']+(['Branch2'] if sid >= 0 else []),
            attachMethod='support')
        for key in ('unassigned','unplacedSupport','syntheticAxis'):
            row.pop(key, None)
        recovered.append(dict(island=row['island'], primary=pid, secondary=sid,
            continuation=continuation, jointDistanceCm=float(dist[near]), lengthCm=length))
    return recovered
