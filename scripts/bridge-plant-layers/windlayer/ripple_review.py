"""Terminal membership must survive the per-vertex Ripple bake and its UV3 quantization."""
import numpy as np


def wind_unit(row):
    """All fragments evaluated with the same equation, including inherited slivers."""
    return (row["primary"], row["secondary"], row["primaryAttachment"], row["secondaryAttachment"],
            tuple(row["blade"][0]), tuple(row["blade"][1]))


def ripple_shape(points, local, batch, terminal, minimum, size):
    axes = np.zeros((len(batch), 2, 3))
    axes[terminal] = [row["blade"] for row, tip in zip(batch, terminal) if tip]
    axes = minimum + axes * size
    ab = axes[:, 1] - axes[:, 0]
    d2 = np.einsum("ij,ij->i", ab, ab)
    along = ((points - axes[local, 0]) * ab[local]).sum(axis=1) / np.maximum(d2[local], 1e-8)
    t = np.clip((along - .30) / .70, 0, 1)
    shape = t*t*(3-2*t)
    if any(row.get("rootContact") for row in batch):
        centers = np.zeros((len(batch), 3))
        inner = np.full(len(batch), -1.)
        outer = np.zeros(len(batch))
        for i, row in enumerate(batch):
            if contact := row.get("rootContact"):
                centers[i] = minimum + size * np.asarray(contact["center"])
                inner[i] = contact["innerHeight"]
                outer[i] = contact["outerHeight"]
        # UE applies the measured root fade before baking either UV2.g or UV3.
        distance = np.linalg.norm(points - centers[local], axis=1) / max(size[2], 1e-9)
        root = np.clip((distance - inner[local]) / (outer[local] - inner[local]), 0, 1)
        shape *= root*root*(3-2*root)
    return shape


def zero_at_max_gain(shape):
    # Even the largest per-leaf amplitude supported by the baker rounds to code 0.
    return shape * (.90 * 255.) < .5


def suppress_silent_tips(variant, positions, labels):
    rows = variant["bindings"]
    order = np.argsort(labels, kind="stable")
    offset = np.r_[0, np.bincount(labels, minlength=len(rows)).cumsum()]
    minimum, size = positions.min(0), np.ptp(positions, axis=0)
    possible, moving = {}, set()
    for start in range(0, len(rows), 8192):
        batch = rows[start:start+8192]
        terminal = np.array([r["terminal"] for r in batch], dtype=bool)
        if not terminal.any():
            continue
        indices = order[offset[start]:offset[start+len(batch)]]
        shape = ripple_shape(positions[indices], labels[indices]-start, batch, terminal, minimum, size)
        peak = np.maximum.reduceat(shape, offset[start:start+len(batch)]-offset[start])
        silent = zero_at_max_gain(peak)
        for i in np.flatnonzero(terminal):
            key = wind_unit(batch[i])
            if silent[i]:
                possible.setdefault(key, []).append(batch[i])
            else:
                moving.add(key)
    changed = 0
    for key, islands in possible.items():
        if key in moving:
            continue
        for row in islands:
            row["terminal"] = False
            row["layers"] = [layer for layer in row["layers"] if layer != "Ripple"]
            changed += 1
    return changed
