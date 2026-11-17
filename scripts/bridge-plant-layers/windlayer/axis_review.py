"""Reconcile scanned support centerlines with the straight axes sampled by UE."""
import numpy as np
from scipy.spatial import cKDTree


def retraced_axis(poly):
    """Return a real turnaround and old-arc to new-axis mapping, or no evidence."""
    if len(poly) < 4:
        return None
    relative = poly - poly[0]
    arc = np.r_[0., np.cumsum(np.linalg.norm(np.diff(poly, axis=0), axis=1))]
    chord = np.linalg.norm(relative[-1])
    if arc[-1] < 1e-4 or chord >= .1 * arc[-1]:
        return None
    radius = np.linalg.norm(relative, axis=1)
    end = int(np.argmax(radius))
    extent = radius[end]
    if not 0 < end < len(poly)-1 or extent < 1e-4 or chord > .08 * extent:
        return None
    # A genuine loop or fork can also end near its base. Both halves must
    # occupy the same narrow corridor, in both directions, before changing it.
    outward, returning = poly[:end+1], poly[end:]
    if any(cKDTree(a).query(b)[0].max() > .08 * extent
           for a, b in ((outward, returning), (returning, outward))):
        return None
    weights = np.clip(relative @ relative[end] / extent**2, 0., 1.)
    return poly[end], float(arc[end]), arc / arc[-1], weights


def repair_retraced_axes(variant, paths, minimum, size):
    """Keep branch identity and actual attachment points, including return-leg children."""
    remaps = {}
    for (table, i), poly in paths:
        axis = variant[table][i]
        if len(axis.get("units", [])) < 2:
            continue
        match = retraced_axis(poly)
        if match is None:
            continue
        tip, length, arc, weights = match
        axis["tip"] = ((tip-minimum)/np.maximum(size, 1e-9)).round(6).tolist()
        axis["lengthCm"] = round(length, 4)
        remaps[table, i] = (arc, weights)
    if not remaps:
        return set()

    def mapped(key, old):
        if old < 0 or key not in remaps:
            return old
        arc, weights = remaps[key]
        return round(float(np.interp(old, arc, weights)), 5)

    for axis in variant["secondaryAxes"]:
        axis["attachOnPrimary"] = mapped(("primaryAxes", axis["primary"]), axis["attachOnPrimary"])
    for row in variant["bindings"]:
        if row.get("review") or not row.get("influence", True):
            continue
        pid, sid = row["primary"], row["secondary"]
        row["primaryAttachment"] = (variant["secondaryAxes"][sid]["attachOnPrimary"]
                                    if sid >= 0 and ("primaryAxes", pid) in remaps else
                                    mapped(("primaryAxes", pid), row["primaryAttachment"]))
        row["secondaryAttachment"] = mapped(("secondaryAxes", sid), row["secondaryAttachment"])
    return set(remaps)


def sync_terminal_owners(variant):
    # Re-evaluate after tubular rejection and inherited-fragment review.
    owners = {r["primary"] for r in variant["bindings"] if r["terminal"] and
              not r.get("review") and r.get("influence", True) and r["secondary"] < 0
              and r["primaryAttachment"] < 0}
    for axis in variant["primaryAxes"]:
        axis["terminalBlade"] = axis["id"] in owners
