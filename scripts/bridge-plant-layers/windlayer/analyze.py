"""Wind-layer hierarchy analysis for Bridge 3dplant LOD0 meshes (read-only source).

Output schema: schemaVersion 1, per-asset out/<libraryAssetId>/_layer.json.
Row coordinates are normalized UE-local bbox coordinates (per-axis 0..1);
frame.bboxMinCm/bboxMaxCm let a renderer rebuild centimeters.
"""
from __future__ import annotations

import hashlib
from collections import defaultdict

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

from . import fbxread
from .axis_review import repair_retraced_axes
from .root_stems import rooted_stalks
from .fork_review import ForkBindings, UnitSurfaces, remap_final_side

WELD_EPS = 1e-4          # cm; coincident FBX vertices weld together
PAIR_CENTROID_EPS = 0.05  # cm; front/back card centre coincidence
PAIR_VERT_EPS = 0.22      # cm; front/back card offset (cards are ~1-1.5mm apart)
CHAIN_ANGLE_DEG = 50.0


# ---------------------------------------------------------------- loading
def load_lod0(path):
    ver, nodes = fbxread.parse(path)
    sc = fbxread.Scene(ver, nodes)
    if not sc.meshes:
        return None
    v = np.vstack([m["verts"] for m in sc.meshes])
    offsets = np.cumsum([0] + [len(m["verts"]) for m in sc.meshes[:-1]])
    t = np.vstack([m["tris"] + int(offset) for m, offset in zip(sc.meshes, offsets)])
    if len(t) == 0:
        return None
    q = np.round(v / WELD_EPS).astype(np.int64)
    uniq, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    nv = v[first]
    nt = inv[t]
    bad = (nt[:, 0] == nt[:, 1]) | (nt[:, 1] == nt[:, 2]) | (nt[:, 0] == nt[:, 2])
    nt = nt[~bad]
    return {"verts": nv, "tris": nt}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- topology
def island_labels(tris, nverts):
    r = np.concatenate([tris[:, 0], tris[:, 1], tris[:, 2]])
    c = np.concatenate([tris[:, 1], tris[:, 2], tris[:, 0]])
    g = coo_matrix((np.ones(len(r), np.int8), (r, c)), shape=(nverts, nverts))
    n, lab = connected_components(g, directed=False)
    return lab, n


def boundary_stats(tris, lab, n):
    e = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    e = np.sort(e, axis=1)
    key = e[:, 0].astype(np.int64) * (len(lab) + 1) + e[:, 1]
    u, cnt = np.unique(key, return_counts=True)
    be = e[np.isin(key, u[cnt == 1])]
    if len(be) == 0:
        return np.zeros(n, np.int32), np.zeros(n, np.int32)
    r = np.concatenate([be[:, 0], be[:, 1]])
    c = np.concatenate([be[:, 1], be[:, 0]])
    g = coo_matrix((np.ones(len(r), np.int8), (r, c)), shape=(len(lab), len(lab)))
    _, comp = connected_components(g, directed=False)
    isl = lab[be[:, 0]]
    loops = np.zeros(n, np.int64)
    pairs = np.unique(np.column_stack([isl, comp[be[:, 0]]]), axis=0)
    np.add.at(loops, pairs[:, 0], 1)
    bedge = np.bincount(isl, minlength=n)
    return loops, bedge


def island_stats(v, tris, lab, n):
    area = 0.5 * np.linalg.norm(
        np.cross(v[tris[:, 1]] - v[tris[:, 0]], v[tris[:, 2]] - v[tris[:, 0]]), axis=1)
    nv = np.bincount(lab, minlength=n).astype(np.int64)
    c = np.zeros((n, 3))
    for k in range(3):
        c[:, k] = np.bincount(lab, weights=v[:, k], minlength=n)
    c /= np.maximum(nv, 1)[:, None]
    x = v - c[lab]
    cov = np.zeros((n, 3, 3))
    for a in range(3):
        for b in range(3):
            cov[:, a, b] = np.bincount(lab, weights=x[:, a] * x[:, b], minlength=n)
    cov /= np.maximum(nv - 1, 1)[:, None, None]
    w, vec = np.linalg.eigh(cov)
    ext = np.sqrt(np.maximum(w, 0))[:, ::-1]
    vec = vec[:, :, ::-1]
    axis = vec[:, :, 0]
    axis[axis[:, 0] < 0] *= -1
    vec[:, :, 0] = axis
    vec[:, :, 2] = np.cross(vec[:, :, 0], vec[:, :, 1])
    spans = np.zeros((n, 3))
    for k in range(3):
        ak = vec[lab, :, k]
        pk = np.einsum("ij,ij->i", v, ak)
        mn = np.full(n, np.inf)
        mx = np.full(n, -np.inf)
        np.minimum.at(mn, lab, pk)
        np.maximum.at(mx, lab, pk)
        spans[:, k] = mx - mn
    zmin = np.full(n, np.inf)
    np.minimum.at(zmin, lab, v[:, 2])
    zmax = np.full(n, -np.inf)
    np.maximum.at(zmax, lab, v[:, 2])
    return {"nv": nv, "nt": np.bincount(lab[tris[:, 0]], minlength=n),
            "area": np.bincount(lab[tris[:, 0]], weights=area, minlength=n),
            "center": c, "ext": ext, "vec": vec, "span": spans,
            "zmin": zmin, "zmax": zmax}


# ---------------------------------------------------------------- units
class UF:
    def __init__(self, n):
        self.p = np.arange(n)

    def find(self, a):
        p = self.p
        while p[a] != a:
            p[a] = p[p[a]]
            a = p[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def island_vertex_groups(lab, n):
    order = np.argsort(lab, kind="stable")
    cnt = np.bincount(lab, minlength=n)
    return np.split(order, np.cumsum(cnt)[:-1])


def build_units(v, lab, n, stats, groups):
    uf = UF(n)
    key = stats["nv"].astype(np.int64) * 1000003 + stats["nt"]
    pairs = cKDTree(stats["center"]).query_pairs(PAIR_CENTROID_EPS, output_type="ndarray")
    if len(pairs):
        pairs = pairs[key[pairs[:, 0]] == key[pairs[:, 1]]]
    for a, b in pairs:
        if uf.find(a) == uf.find(b):
            continue
        d, _ = cKDTree(v[groups[b]]).query(v[groups[a]])
        if float(np.mean(d)) < PAIR_VERT_EPS:
            uf.union(int(a), int(b))
    roots = np.array([uf.find(i) for i in range(n)])
    _, unit_of = np.unique(roots, return_inverse=True)
    return unit_of, int(unit_of.max()) + 1


# ---------------------------------------------------------------- centerline
def unit_centerline(v, groups, isl_ids):
    idx = np.concatenate([groups[i] for i in isl_ids])
    p = v[idx]
    c = p.mean(0)
    x = p - c
    w, vec = np.linalg.eigh(x.T @ x / max(1, len(p) - 1))
    axis = vec[:, int(np.argmax(w))]
    proj = x @ axis
    span = proj.max() - proj.min()
    bins = int(np.clip(round(span / 0.3), 4, 64))
    t = (proj - proj.min()) / max(span, 1e-9)
    bi = np.clip((t * (bins - 1)).astype(int), 0, bins - 1)
    cnt = np.bincount(bi, minlength=bins)
    pts = np.zeros((bins, 3))
    for k in range(3):
        pts[:, k] = np.bincount(bi, weights=p[:, k], minlength=bins)
    ok = cnt > 0
    pts[ok] /= cnt[ok, None]
    pts = pts[ok]
    if len(pts) >= 5:
        sm = pts.copy()
        sm[1:-1] = 0.25 * pts[:-2] + 0.5 * pts[1:-1] + 0.25 * pts[2:]
        pts = sm
    return pts


def chain_centerline(us, cl, chain_tol):
    """Walk the original unit centerlines in their measured endpoint order."""
    if len(us) == 1:
        poly = cl[us[0]]
    else:
        # walk chain from the unit whose far end is lowest
        def low_end(u):
            p = cl[u]
            return min(p[0][2], p[-1][2])
        start = min(us, key=low_end)
        p = cl[start]
        poly = list(p if p[0][2] <= p[-1][2] else p[::-1])
        remaining = [u for u in us if u != start]
        while remaining:
            best = None
            for u in remaining:
                p = cl[u]
                d0 = np.linalg.norm(poly[-1] - p[0])
                d1 = np.linalg.norm(poly[-1] - p[-1])
                if best is None or min(d0, d1) < best[0]:
                    best = (min(d0, d1), u, d1 < d0)
            d, u, rev = best
            if d > chain_tol * 2.5:
                break
            poly.extend(list(cl[u][::-1] if rev else cl[u]))
            remaining.remove(u)
        poly = np.array(poly)
        keep = [0]
        for i in range(1, len(poly)):
            if np.linalg.norm(poly[i] - poly[keep[-1]]) > 1e-4:
                keep.append(i)
        poly = poly[keep]
    return poly


def polyline_len(pts):
    if len(pts) < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum())


def polyline_param(pts):
    d = np.r_[0, np.linalg.norm(np.diff(pts, axis=0), axis=1).cumsum()] if len(pts) > 1 else np.zeros(1)
    return d / max(d[-1], 1e-9)


def endpoint_tangent(pts, at_start):
    if len(pts) < 2:
        return np.zeros(3)
    k = min(4, len(pts) - 1)
    if at_start:
        d = pts[0] - pts[k]
    else:
        d = pts[-1] - pts[-1 - k]
    n = np.linalg.norm(d)
    return d / n if n > 0 else np.zeros(3)


# ---------------------------------------------------------------- main analysis
def analyze_variant(v, tris, static=False, form=""):
    h = float(v[:, 2].max() - v[:, 2].min())
    size = float(np.linalg.norm(v.max(0) - v.min(0)))
    lab, n = island_labels(tris, len(v))
    stats = island_stats(v, tris, lab, n)
    loops, bedges = boundary_stats(tris, lab, n)
    groups = island_vertex_groups(lab, n)
    unit_of, nu = build_units(v, lab, n, stats, groups)

    unit_isls = island_vertex_groups(unit_of, nu)
    u_span = np.zeros((nu, 3))
    u_area = np.zeros(nu)
    u_zmin = np.full(nu, np.inf)
    u_c = np.zeros((nu, 3))
    u_ext = np.zeros((nu, 3))
    u_nv = np.zeros(nu, int)
    for i in range(n):
        u = int(unit_of[i])
        u_span[u] = np.maximum(u_span[u], stats["span"][i])
        u_area[u] += stats["area"][i]
        u_zmin[u] = min(u_zmin[u], stats["zmin"][i])
    for u in range(nu):
        idx = unit_isls[u]
        p = np.vstack([v[groups[i]] for i in idx])
        u_c[u] = p.mean(0)
        u_nv[u] = len(p)
        w = np.linalg.eigvalsh((p - u_c[u]).T @ (p - u_c[u]) / max(len(p) - 1, 1))
        u_ext[u] = np.sqrt(np.maximum(w[::-1], 0))

    # ---- support selection
    lens = u_span[:, 0]
    p90 = float(np.percentile(lens, 90))
    rooted = u_zmin < 0.06 * h
    narrow = u_span[:, 1] < 0.35 * np.maximum(u_span[:, 0], 1e-6)
    # morphology-specific support-length rules; herb/other uses the card-size
    # distribution because cotton-type herbs have many small leaves on short twigs
    if form == "grass":
        is_support = narrow & (lens > 0.25 * h)
        support_rule = "grass-blades"
    elif form in ("fern", "palm"):
        is_support = lens > 0.32 * h
        support_rule = "frond"
    elif form in ("bush", "tree"):
        is_support = lens > max(0.25 * h, 1.1 * p90)
        support_rule = "woody-p90"
    elif form == "groundcover":
        is_support = lens > max(0.22 * h, 1.1 * p90)
        support_rule = "groundcover-p90"
    else:
        is_support = lens > max(0.18 * h, p90)
        support_rule = "herb-p90"
    u_loopmax = np.zeros(nu)
    u_bedge = np.zeros(nu, int)
    for i in range(n):
        u = int(unit_of[i])
        u_loopmax[u] = max(u_loopmax[u], loops[i])
        u_bedge[u] += bedges[i]
    # tube-like: two open end rings, few boundary edges (paired flat cards also have 2 loops)
    is_tube_unit = ((u_loopmax == 2) & (u_bedge <= 24) & (u_nv >= 40)
                    & (u_ext[:, 2] > 0.04) & (u_span[:, 0] > 5.0)
                    & (u_span[:, 0] > 4.0 * np.maximum(u_span[:, 1], 1e-6)))
    is_support |= is_tube_unit
    # Scan cards for individual stems can be much shorter than the 90th percentile.
    # Seed them before parent selection so leaves inherit their actual moving stem.
    shaft_units = set()
    if not static and form in ("herb", "groundcover", "bush", "tree"):
        shafts = rooted_stalks(v, tris, lab)
        shaft_units = {int(unit_of[i]) for i in shafts if all(j in shafts for j in unit_isls[unit_of[i]])}
        for u in shaft_units:
            is_support[u] = True
    mode = "threshold"
    if not is_support.any():
        cand = rooted & narrow & (lens > 0.30 * h)
        if cand.sum() >= 1:
            is_support = cand
            mode = "rooted-blades"
        else:
            mode = "no-support"

    supp_units = np.where(is_support)[0]
    cl = {int(u): unit_centerline(v, groups, unit_isls[u]) for u in supp_units}

    # ---- chain support units end-to-end, requiring tangent continuity
    chain_tol = max(0.8, 0.03 * size)
    cos_lim = np.cos(np.radians(CHAIN_ANGLE_DEG))
    grounded = u_zmin < 0.06 * h
    uf = UF(nu)
    chain_on = form not in ("grass", "fern")
    if len(supp_units) > 1 and chain_on:
        P = []
        for u in supp_units:
            p = cl[int(u)]
            P.append((p[0], p[-1], endpoint_tangent(p, True), endpoint_tangent(p, False)))
        for ia in range(len(supp_units)):
            for ib in range(ia + 1, len(supp_units)):
                u, w = int(supp_units[ia]), int(supp_units[ib])
                # tubules chain only with tubules, blades only with blades
                if bool(is_tube_unit[u]) != bool(is_tube_unit[w]):
                    continue
                if form == "palm" and not (is_tube_unit[u] and is_tube_unit[w]):
                    continue
                # two independently rooted supports never form one axis
                if grounded[u] and grounded[w]:
                    continue
                a0, a1, ta0, ta1 = P[ia]
                b0, b1, tb0, tb1 = P[ib]
                for ea, pa, ta in ((0, a0, ta0), (1, a1, ta1)):
                    for eb, pb, tb in ((0, b0, tb0), (1, b1, tb1)):
                        d = np.linalg.norm(pa - pb)
                        if d < chain_tol and np.dot(ta, -tb) > cos_lim:
                            uf.union(u, w)
    chains = defaultdict(list)
    for u in supp_units:
        chains[uf.find(int(u))].append(int(u))

    primaries, secondaries = [], []
    unit_role, unit_axis = {}, {}
    chain_recs = []
    for root, us in chains.items():
        poly = chain_centerline(us, cl, chain_tol)
        length = polyline_len(poly)
        base, tip = poly[0], poly[-1]
        if base[2] > tip[2]:
            poly = poly[::-1]
            base, tip = poly[0], poly[-1]
        if form == "palm":
            root_xy = v[v[:, 2] < np.percentile(v[:, 2], 2)][:, :2].mean(0)
            rooted_chain = (base[2] < 0.12 * h and length > 0.18 * h
                            and np.linalg.norm(base[:2] - root_xy) < 0.10 * size)
        elif form == "fern":
            rooted_chain = base[2] < 0.18 * h and length > 0.18 * h
        else:
            rooted_chain = base[2] < 0.08 * h and length > 0.18 * h
        vertical = bool((poly[:, 2].max() - poly[:, 2].min()) > 0.60 * max(length, 1e-6))
        rooted_chain |= any(u in shaft_units for u in us)
        chain_recs.append({"units": us, "poly": poly, "base": base, "tip": tip,
                           "length": length, "rooted": bool(rooted_chain),
                           "vertical": vertical})
    # choose primary axes: rooted tube chains win; otherwise all rooted chains
    rooted = [r for r in chain_recs if r["rooted"]]
    tube_rooted = [r for r in rooted if all(bool(is_tube_unit[u]) for u in r["units"])]
    if form == "grass":
        prim = list(chain_recs)          # every rooted blade is its own support
    elif form == "palm":
        trunk = [r for r in chain_recs if r["vertical"] and r["base"][2] < 0.12 * h
                 and r["length"] > 0.5 * h
                 and max(float(u_span[u, 1]) for u in r["units"]) < 0.25 * r["length"]]
        prim = trunk if trunk else (rooted if rooted else list(chain_recs))
    else:
        prim = ([r for r in rooted if all(is_tube_unit[u] for u in r["units"]) or any(u in shaft_units for u in r["units"])]
                if tube_rooted else rooted)
    prim_ids = {id(r) for r in prim}
    for r in prim:
        r["id"] = len(primaries)
        primaries.append(r)
        for u in r["units"]:
            unit_role[u] = "branch1"
            unit_axis[u] = ("primary", r["id"])
    for r in chain_recs:
        if id(r) not in prim_ids:
            secondaries.append(r)

    # ---- attach secondary chains to nearest primary
    sec_ok = []
    tol_sec = max(1.2, 0.03 * size)
    for s in secondaries:
        if not primaries:
            continue
        best = None
        sp = s["poly"]
        for p in primaries:
            d, idx = cKDTree(p["poly"]).query(sp)
            j = int(np.argmin(d))
            if best is None or d[j] < best[0]:
                best = (float(d[j]), p, int(idx[j]))
        d, p, idx = best
        if d > tol_sec:
            continue
        s["id"] = len(sec_ok)
        s["primary"] = p["id"]
        s["attach"] = float(polyline_param(p["poly"])[idx])
        # orient the lateral so its base end is the one at the parent contact
        contact = p["poly"][idx]
        if np.linalg.norm(contact - sp[-1]) < np.linalg.norm(contact - sp[0]):
            s["poly"] = sp[::-1]
        s["base"], s["tip"] = s["poly"][0], s["poly"][-1]
        sec_ok.append(s)
        for u in s["units"]:
            unit_role[u] = "branch2"
            unit_axis[u] = ("secondary", s["id"])
    # palm rosettes: any remaining frond radiates from the trunk crown
    if form == "palm" and primaries:
        trunk = max(primaries, key=lambda p: float(p["poly"][:, 2].max() - p["poly"][:, 2].min()))
        crown = trunk["poly"][int(np.argmax(trunk["poly"][:, 2]))]
        for s in secondaries:
            if s.get("id") is not None:
                continue
            sp = s["poly"]
            d = np.linalg.norm(sp - crown, axis=1)
            if float(d.min()) > 0.15 * size:
                continue
            s["id"] = len(sec_ok)
            s["primary"] = trunk["id"]
            s["attach"] = 1.0
            if np.linalg.norm(crown - sp[-1]) < np.linalg.norm(crown - sp[0]):
                s["poly"] = sp[::-1]
            s["base"], s["tip"] = s["poly"][0], s["poly"][-1]
            sec_ok.append(s)
            for u in s["units"]:
                unit_role[u] = "branch2"
                unit_axis[u] = ("secondary", s["id"])
    secondaries = sec_ok

    # ---- axis point cloud for foliage attachment
    unplaced = {int(u) for u in supp_units if int(u) not in unit_role}
    ap = []
    for p in primaries:
        t = polyline_param(p["poly"])
        ap.append(np.column_stack([p["poly"], np.zeros(len(t)), np.full(len(t), p["id"]), t]))
    for s in secondaries:
        t = polyline_param(s["poly"])
        ap.append(np.column_stack([s["poly"], np.ones(len(t)), np.full(len(t), s["id"]), t]))
    AP = np.vstack(ap) if ap else np.zeros((0, 6))
    apt = cKDTree(AP[:, :3]) if len(AP) else None

    # ---- foliage
    # Welding can leave standalone FBX positions with no surviving triangle.
    # Retain their island rows for UE matching, but exclude them from the organ
    # attachment search so a visible leaf cannot inherit wind from an empty point.
    has_surface = stats["nt"] > 0
    surface_units = np.unique(unit_of[has_surface])
    foliage = [int(u) for u in surface_units if u not in unit_role and u not in unplaced]
    fol = {}
    fkind = {}
    fe = {}
    tol_leaf = max(0.6, 0.02 * size)
    for u in foliage:
        p = np.vstack([v[groups[i]] for i in unit_isls[u]])
        c = p.mean(0)
        w, vec = np.linalg.eigh((p - c).T @ (p - c) / max(len(p) - 1, 1))
        ax = vec[:, int(np.argmax(w))]
        pr = (p - c) @ ax
        fe[u] = (p, p[int(np.argmin(pr))], p[int(np.argmax(pr))])
    # pass 1: proximal end sits on a support centreline
    for u in foliage:
        p, e0, e1 = fe[u]
        if apt is None:
            fol[u] = None
            continue
        d0, i0 = apt.query(e0)
        d1, i1 = apt.query(e1)
        d, ii = (float(d0), int(i0)) if d0 <= d1 else (float(d1), int(i1))
        if d > tol_leaf:
            fol[u] = None
            continue
        kind, axid, t = int(AP[ii, 3]), int(AP[ii, 4]), float(AP[ii, 5])
        attach = e0 if d0 <= d1 else e1
        free = e1 if d0 <= d1 else e0
        if kind == 0:
            fol[u] = {"primary": axid, "secondary": -1, "primaryAttachment": t,
                      "secondaryAttachment": -1.0, "attach": attach, "free": free, "dist": d}
        else:
            s = secondaries[axid]
            fol[u] = {"primary": s["primary"], "secondary": axid,
                      "primaryAttachment": s["attach"], "secondaryAttachment": t,
                      "attach": attach, "free": free, "dist": d}
        fkind[u] = "support"

    # pass 2: terminal organs hanging just past a support tip (bolls, flower heads)
    tips, tkind, tid = [], [], []
    for p in primaries:
        tips.append(p["tip"]); tkind.append(0); tid.append(p["id"])
    for s in secondaries:
        tips.append(s["tip"]); tkind.append(1); tid.append(s["id"])
    if tips:
        tip_tree = cKDTree(np.array(tips))
    else:
        tip_tree = None
    tol_tip = max(3.0, 0.08 * size)
    for u in foliage:
        if fol.get(u) is not None or tip_tree is None:
            continue
        p, e0, e1 = fe[u]
        d, ii = tip_tree.query(p)
        j = int(np.argmin(d))
        if d[j] > tol_tip:
            continue
        ti = int(ii[j])
        kind, ax = int(tkind[ti]), int(tid[ti])
        if kind == 0:
            fol[u] = {"primary": ax, "secondary": -1, "primaryAttachment": 1.0,
                      "secondaryAttachment": -1.0, "attach": p[j], "free": e0 if
                      np.linalg.norm(e0 - p[j]) > np.linalg.norm(e1 - p[j]) else e1,
                      "dist": float(d[j]), "tipCluster": True}
        else:
            s = secondaries[ax]
            fol[u] = {"primary": s["primary"], "secondary": ax,
                      "primaryAttachment": s["attach"], "secondaryAttachment": 1.0,
                      "attach": p[j], "free": e0 if
                      np.linalg.norm(e0 - p[j]) > np.linalg.norm(e1 - p[j]) else e1,
                      "dist": float(d[j]), "tipCluster": True}
        fkind[u] = "tipCluster"

    # pass 3: organ clusters inherit the binding of the nearest attached organ
    unassigned = [u for u in foliage if fol.get(u) is None]
    if unassigned and len(unassigned) < 6000:
        for _ in range(3):
            have = [u for u in foliage if fol.get(u) is not None]
            if not have or not unassigned:
                break
            owner, pts = [], []
            for u in have:
                p = np.vstack([v[groups[i]] for i in unit_isls[u]])
                pts.append(p)
                owner.append(np.full(len(p), u))
            cloud = np.vstack(pts)
            own = np.concatenate(owner)
            tree = cKDTree(cloud)
            still = []
            for u in unassigned:
                p = np.vstack([v[groups[i]] for i in unit_isls[u]])
                d, ii = tree.query(p)
                j = int(np.argmin(d))
                if d[j] > tol_leaf * 1.6:
                    still.append(u)
                    continue
                parent = int(own[ii[j]])
                f = fol[parent]
                contact = p[j]
                free = p[int(np.argmax(((p - contact) ** 2).sum(1)))]
                fol[u] = {"primary": f["primary"], "secondary": f["secondary"],
                          "primaryAttachment": f["primaryAttachment"],
                          "secondaryAttachment": f["secondaryAttachment"],
                          "attach": contact, "free": free,
                          "dist": float(d[j]), "parentUnit": parent}
                fkind[u] = "inherited"
            unassigned = still
        for u in unassigned:
            fol[u] = None

    # pass 4: rosette/groundcover fallback - one synthetic rooted cluster axis
    synthetic_used = False
    unassigned = [u for u in foliage if fol.get(u) is None]
    if unassigned and len(unassigned) > 0.35 * max(1, len(foliage)):
        zlo = float(np.percentile(v[:, 2], 0.5))
        zhi = float(np.percentile(v[:, 2], 99.5))
        low = v[v[:, 2] <= np.percentile(v[:, 2], 2)]
        high = v[v[:, 2] >= np.percentile(v[:, 2], 95)]
        base = np.array([low[:, 0].mean(), low[:, 1].mean(), zlo])
        tip = np.array([high[:, 0].mean(), high[:, 1].mean(), zhi])
        if np.linalg.norm(tip - base) < 0.12 * h:
            tip = base + np.array([0, 0, max(h * 0.9, 1e-3)])
        poly = np.linspace(base, tip, 12)
        rec = {"units": [], "poly": poly, "base": base, "tip": tip,
               "length": polyline_len(poly), "id": len(primaries), "synthetic": True}
        primaries.append(rec)
        tp = polyline_param(poly)
        for u in unassigned:
            p, e0, e1 = fe[u]
            d0, i0 = cKDTree(poly).query(e0)
            d1, i1 = cKDTree(poly).query(e1)
            if d0 <= d1:
                attach, free, ii, d = e0, e1, i0, float(d0)
            else:
                attach, free, ii, d = e1, e0, i1, float(d1)
            fol[u] = {"primary": rec["id"], "secondary": -1,
                      "primaryAttachment": float(tp[ii]),
                      "secondaryAttachment": -1.0, "attach": attach,
                      "free": free, "dist": d, "synthetic": True}
            fkind[u] = "synthetic"
        synthetic_used = True

    # ---- a rooted card support with no children is itself a terminal blade
    # (grass blades): it carries Branch1 at the base and Ripple at the free end.
    for p in primaries:
        pid = p["id"]
        kids = any(s["primary"] == pid for s in secondaries) or any(
            f is not None and f["primary"] == pid for f in fol.values())
        p["terminal_blade"] = (not kids) and not any(is_tube_unit[u] or u in shaft_units for u in p["units"])

    bmin, bmax = v.min(0), v.max(0)
    size_cm = bmax - bmin

    def N(p):
        return np.round((np.asarray(p) - bmin) / np.maximum(size_cm, 1e-9), 6).tolist()

    prim_rows = [{"id": p["id"], "base": N(p["base"]), "tip": N(p["tip"]),
                  "lengthCm": round(float(p["length"]), 4), "rooted": True,
                  "synthetic": bool(p.get("synthetic", False)),
                  "terminalBlade": bool(p.get("terminal_blade", False)),
                  "units": p["units"]} for p in primaries]
    sec_rows = [{"id": s["id"], "primary": s["primary"], "base": N(s["base"]),
                 "tip": N(s["tip"]), "lengthCm": round(float(s["length"]), 4),
                 "attachOnPrimary": round(float(s["attach"]), 5),
                 "synthetic": False, "units": s["units"]}
                for s in secondaries]

    rows = []
    unattached = 0

    def support_blade(p):
        c = p.mean(0)
        w, vec = np.linalg.eigh((p - c).T @ (p - c) / max(len(p) - 1, 1))
        ax = vec[:, int(np.argmax(w))]
        pr = (p - c) @ ax
        return [N(p[int(np.argmin(pr))]), N(p[int(np.argmax(pr))])]

    for i in range(n):
        u = int(unit_of[i])
        p = v[groups[i]]
        row = {"island": i, "unit": u, "center": N(stats["center"][i]),
               "primary": -1, "secondary": -1, "blade": None,
               "primaryAttachment": -1.0, "secondaryAttachment": -1.0,
               "terminal": False, "layers": [], "review": False}
        role = unit_role.get(u)
        if not has_surface[i]:
            row.update(influence=False, layers=["Shared"], attachMethod="noSurface")
        elif role == "branch1":
            pid = unit_axis[u][1]
            row.update(primary=pid, primaryAttachment=-1.0,
                       layers=["Shared", "Branch1"], attachMethod="support")
            if primaries[pid].get("terminal_blade"):
                row["terminal"] = True
                row["layers"] = ["Shared", "Branch1", "Ripple"]
            row["blade"] = support_blade(p)
        elif role == "branch2":
            sid = unit_axis[u][1]
            s = secondaries[sid]
            row.update(primary=s["primary"], secondary=sid,
                       primaryAttachment=round(float(s["attach"]), 5),
                       secondaryAttachment=-1.0,
                       layers=["Shared", "Branch1", "Branch2"], attachMethod="support")
            row["blade"] = support_blade(p)
        elif u in unplaced:
            row["review"] = True
            row["unplacedSupport"] = True
            row["attachMethod"] = "unplacedSupport"
            row["blade"] = support_blade(p)
            unattached += 1
        elif fol.get(u) is not None:
            f = fol[u]
            row.update(primary=f["primary"], secondary=f["secondary"],
                       primaryAttachment=round(float(f["primaryAttachment"]), 5),
                       secondaryAttachment=round(float(f["secondaryAttachment"]), 5),
                       terminal=True,
                       layers=["Shared", "Branch1", "Ripple"] if f["secondary"] < 0 else
                              ["Shared", "Branch1", "Branch2", "Ripple"])
            row["blade"] = [N(f["attach"]), N(f["free"])]
            row["attachMethod"] = fkind.get(u, "support")
            if f.get("parentUnit") is not None:
                row["parentUnit"] = int(f["parentUnit"])
            if f.get("tipCluster"):
                row["tipCluster"] = True
            if f.get("synthetic"):
                row["syntheticAxis"] = True
        else:
            row["review"] = True
            row["unassigned"] = True
            row["attachMethod"] = "unassigned"
            row["blade"] = support_blade(p)
            unattached += 1
        if static:
            # pilot: micro clover is static - keep structure, zero wind influence
            row["layers"] = []
            row["static"] = True
        rows.append(row)

    n_fol = sum(1 for r in rows if r["terminal"])
    n_b1 = sum(1 for r in rows if "Branch1" in r["layers"])
    n_b2 = sum(1 for r in rows if "Branch2" in r["layers"])
    n_direct = sum(1 for k in fkind.values() if k == "support")
    n_tip = sum(1 for k in fkind.values() if k == "tipCluster")
    n_inh = sum(1 for k in fkind.values() if k == "inherited")
    n_syn = sum(1 for k in fkind.values() if k == "synthetic")
    reasons = []
    if mode == "no-support":
        reasons.append("no rooted support axis detected")
    if not primaries:
        reasons.append("no primary axis")
    if synthetic_used:
        reasons.append("synthetic cluster axis used for rosette/groundcover fallback")
    if unplaced:
        reasons.append(f"support units not attachable to an axis: {len(unplaced)}")
    frac = unattached / max(1, n)
    if frac > 0.08:
        reasons.append(f"unattached islands {unattached}/{n} ({frac:.0%})")
    if static:
        reasons = ["static (pilot: micro clover)"]
    status = "static" if static else ("review" if reasons else "ok")
    counts = {
        "islands": n, "triangles": int(len(tris)), "vertices": int(len(v)),
        "noSurfaceIslands": int(np.count_nonzero(~has_surface)),
        "units": nu, "supportUnits": int(len(supp_units)),
        "pairsWelded": int(n - nu),
        "primaryAxes": len(primaries), "secondaryAxes": len(secondaries),
        "branch1InfluencedIslands": n_b1, "branch2InfluencedIslands": n_b2,
        "foliageIslands": n_fol, "unattachedIslands": unattached,
        "attachDirect": n_direct, "attachTipCluster": n_tip,
        "attachInherited": n_inh, "attachSynthetic": n_syn,
        "supportMode": mode, "supportRule": support_rule,
        "heightCm": round(h, 4), "bboxCm": [round(float(x), 4) for x in size_cm],
        "meanAttachDistCm": round(float(np.mean([f["dist"] for f in fol.values() if f])), 4)
        if any(fol.values()) else None,
        "maxAttachDistCm": round(float(np.max([f["dist"] for f in fol.values() if f])), 4)
        if any(fol.values()) else None,
    }
    variant = {
        "frame": {"units": "cm", "up": "Z", "origin": "source mesh local origin",
                  "normalize": "per-axis (p-bboxMin)/bboxSize -> 0..1",
                  "bboxMinCm": [round(float(x), 5) for x in bmin],
                  "bboxMaxCm": [round(float(x), 5) for x in bmax],
                  "sizeCm": [round(float(x), 5) for x in size_cm]},
        "review": {"status": status, "reasons": reasons},
        "counts": counts,
        "primaryAxes": prim_rows,
        "secondaryAxes": sec_rows,
        "bindings": rows,
    }
    if not static:
        # Keep attachment search on the original surfaces, then express its
        # samples in the straight-axis coordinates actually baked into UVs.
        paths = [((table, axis["id"]), axis["poly"])
                 for table, axes in (("primaryAxes", primaries), ("secondaryAxes", secondaries))
                 for axis in axes if len(axis["units"]) > 1 and
                 np.linalg.norm(axis["tip"] - axis["base"]) < .1 * axis["length"]]
        resolved = repair_retraced_axes(variant, paths, bmin, size_cm)
        forks = [(table, i, line) for (table, i), line in paths if (table,i) not in resolved]
        if forks:
            branches = ForkBindings(variant, forks, cl.__getitem__, bmin, size_cm,
                                    UnitSurfaces(v, tris, lab, unit_of))
            for row in rows:
                branches.bind(row, row["unit"])
            side_remap = branches.finish_existing_laterals()
            for row in rows:
                remap_final_side(row, side_remap)
            counts.update(primaryAxes=len(prim_rows), secondaryAxes=len(sec_rows),
                          branch2InfluencedIslands=sum("Branch2" in r["layers"] for r in rows))
    return variant
