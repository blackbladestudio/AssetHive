"""Identify narrow, rising stalks from cross-sections of the original LOD0."""
import numpy as np


def rooted_stalks(vertices, triangles, labels):
    """Return island IDs. The lower endpoint alone cannot distinguish a dangling leaf."""
    count = int(labels.max()) + 1
    floor = float(vertices[:, 2].min())
    height = float(np.ptp(vertices[:, 2]))
    if height <= 0 or abs(floor) > max(.6, .09 * height):
        return set()
    low = np.full(count, np.inf)
    high = np.full(count, -np.inf)
    np.minimum.at(low, labels, vertices[:, 2])
    np.maximum.at(high, labels, vertices[:, 2])
    rise = high - low
    face_ids = labels[triangles[:, 0]]
    counts = np.bincount(face_ids, minlength=count)
    candidates = np.flatnonzero((low <= min(floor + .04 * height, max(.12, min(.5, .012 * height))))
                                & (rise >= .14 * height) & (counts >= 6))
    if not len(candidates):
        return set()
    order = np.argsort(face_ids, kind="stable")
    ends = np.r_[0, counts.cumsum()]
    result = set()
    for island in candidates:
        faces = triangles[order[ends[island]:ends[island + 1]]]
        edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
        a, b = vertices[edges[:, 0]], vertices[edges[:, 1]]
        widths, centers = [], []
        for fraction in (.025, .10, .23, .42, .62, .80):
            z = low[island] + fraction * rise[island]
            hit = (a[:, 2] < z) != (b[:, 2] < z)
            p, q = a[hit], b[hit]
            if len(p) < 2:
                break
            xy = p[:, :2] + ((z - p[:, 2]) / (q[:, 2] - p[:, 2]))[:, None] * (q[:, :2] - p[:, :2])
            widths.append(np.linalg.norm(np.ptp(xy, axis=0)))
            centers.append((xy.min(axis=0) + xy.max(axis=0)) * .5)
        if len(widths) < 6:
            continue
        # Basal shaft must continue at comparable width through most of the organ.
        # A leaf tip brushing the ground usually widens rapidly or returns upwards.
        if (max(widths) > .052 * rise[island] or min(widths) < .42 * max(widths)
                or widths[0] < .60 * np.median(widths[1:])
                or np.linalg.norm(centers[1] - centers[0]) > .075 * rise[island]):
            continue
        result.add(int(island))
    return result


def root_response(points, row, variant, low, size):
    """Branch1, Branch2 and the Ripple ramp, before the per-blade Ripple gain."""
    def project(axis, attachment, start, gain):
        if attachment >= 0:
            along = np.full(len(points), attachment)
        else:
            base, tip = low + size * np.asarray(axis)
            d = tip - base
            along = (points - base) @ d / max(d @ d, 1e-10)
        x = np.clip((along - start) / (1 - start), 0, 1)
        return gain * x * x * (3 - 2 * x)

    primary = variant["primaryAxes"][row["primary"]]
    w = project([primary["base"], primary["tip"]], row["primaryAttachment"], .025, .70)
    if row["secondary"] >= 0:
        side = variant["secondaryAxes"][row["secondary"]]
        w = np.maximum(w, project([side["base"], side["tip"]], row["secondaryAttachment"], .035, .64))
    if row["terminal"]:
        w = np.maximum(w, project(row["blade"], -1., .30, 1.))
    return w


def recover_measured_roots(variant, rows, vertices, triangles, labels):
    """A measured basal shaft remains a support even in a very wide ground-cover patch."""
    by_island = {row["island"]: row for row in rows}
    candidates = {i for i in rooted_stalks(vertices, triangles, labels)
                  if i in by_island and by_island[i].get("review")}
    if not candidates:
        return 0
    order = np.argsort(labels, kind="stable")
    ends = np.r_[0, np.bincount(labels).cumsum()]
    low = vertices.min(axis=0)
    size = np.maximum(np.ptp(vertices, axis=0), 1e-9)
    groups = {}
    for island in candidates:
        row = by_island[island]
        key = ("unit", row["unit"]) if "unit" in row else ("island", island)
        groups.setdefault(key, []).append(island)
    recovered = 0
    for key, members in sorted(groups.items()):
        samples = []
        for island in members:
            points = vertices[order[ends[island]:ends[island + 1]]]
            z = points[:, 2]
            rise = float(np.ptp(z))
            base = points[z <= z.min() + .025 * rise].mean(axis=0)
            tip = points[z >= z.max() - .025 * rise].mean(axis=0)
            samples.append((base, tip))
        base, tip = np.mean(samples, axis=0)
        length = float(np.linalg.norm(tip - base))
        if length <= 1e-5:
            continue
        # A shared unit must still describe the same physical stalk at both ends.
        tolerance = float(np.clip(.012 * length, .025, .2))
        if any(np.linalg.norm(np.asarray(pair) - [base, tip], axis=1).max() > tolerance for pair in samples):
            continue
        normalized = [((point - low) / size).round(8).tolist() for point in (base, tip)]
        pid = len(variant["primaryAxes"])
        variant["primaryAxes"].append(dict(id=pid, base=normalized[0], tip=normalized[1],
            lengthCm=round(length, 4), rooted=True, synthetic=False,
            units=[key[1]] if key[0] == "unit" else [], terminalBlade=False))
        for island in members:
            row = by_island[island]
            row.update(primary=pid, secondary=-1, primaryAttachment=-1., secondaryAttachment=-1.,
                       blade=normalized, terminal=False, review=False, influence=True,
                       layers=["Shared", "Branch1"], attachMethod="support")
            for name in ("unassigned", "unplacedSupport", "syntheticAxis", "rootContact"):
                row.pop(name, None)
            recovered += 1
    return recovered


def protect_root_contacts(variant, vertices, triangles, labels):
    """Constrain only active bindings at measured soil contacts on the original mesh."""
    if not variant["primaryAxes"]:
        return 0
    low, size = vertices.min(axis=0), np.ptp(vertices, axis=0)
    height = size[2]
    if height <= 0:
        return 0
    shafts = rooted_stalks(vertices, triangles, labels)
    visible = np.unique(triangles)
    floor = vertices[visible, 2].min()
    band = float(np.clip(.025 * height, .04, .5))
    ids = visible[np.argsort(labels[visible], kind="stable")]
    owners, starts, counts = np.unique(labels[ids], return_index=True, return_counts=True)
    basal = set(labels[visible[vertices[visible, 2] <= floor + band]]) | shafts
    updated = 0
    for i, start, count in zip(owners, starts, counts):
        if i not in basal:
            continue
        row = variant["bindings"][i]
        if "Branch1" not in row["layers"]:
            continue
        pts = vertices[ids[start:start+count]]
        axis = variant["primaryAxes"][row["primary"]]
        base = low + size * axis["base"]
        foot = pts[:0]
        if i in shafts:
            foot = pts[pts[:, 2] <= pts[:, 2].min() + np.clip(.012 * np.ptp(pts[:, 2]), .035, .12)]
        # A broad leaf brushing the ground is free to move. Constrain a separate
        # surface only where it actually meets its own grounded primary pivot.
        if axis["rooted"] and base[2] <= floor + band:
            neighbors = pts[(pts[:, 2] <= floor + band) & (np.linalg.norm(pts - base, axis=1) <= band)]
            if len(neighbors):
                foot = np.vstack((foot, neighbors))
        if not len(foot):
            continue
        response = root_response(foot, row, variant, low, size)
        if contact := row.get("rootContact"):
            center = low + size * np.asarray(contact["center"])
            ramp = np.clip((np.linalg.norm(foot - center, axis=1) / height - contact["innerHeight"]) /
                           (contact["outerHeight"] - contact["innerHeight"]), 0, 1)
            response *= ramp * ramp * (3 - 2 * ramp)
        if np.max(response) <= .01:
            continue
        point = (foot.min(0) + foot.max(0)) * .5
        inner = np.linalg.norm(foot - point, axis=1).max() + max(1e-4, 2e-6 * np.linalg.norm(size))
        fade = np.clip(.06 * np.ptp(pts[:, 2]), .06, 2.)
        row["rootContact"] = {"center": ((point-low)/np.maximum(size, 1e-9)).round(8).tolist(),
                              "innerHeight": float(inner / height), "outerHeight": float((inner + fade) / height)}
        updated += 1
    return updated
