"""Minimal read-only binary FBX reader for Megascans 3dplant assets.

Only parses what the wind-layer analysis needs: GlobalSettings, object list,
connections, geometry vertices/polygons, model transforms, material names.

Written for FBX 7400/7500/7700 binary files as shipped by Quixel Bridge.
No third-party dependencies beyond numpy.
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np


class Node:
    __slots__ = ("name", "props", "children")

    def __init__(self, name):
        self.name = name
        self.props = []
        self.children = []

    def child(self, name):
        for c in self.children:
            if c.name == name:
                return c
        return None

    def child_all(self, name):
        return [c for c in self.children if c.name == name]

    def __repr__(self):
        return f"<{self.name} props={len(self.props)} children={len(self.children)}>"


def _read_prop(buf, off, wide):
    t = chr(buf[off])
    off += 1
    if t == "Y":
        v = struct.unpack_from("<h", buf, off)[0]
        return v, off + 2
    if t == "C":
        v = bool(buf[off])
        return v, off + 1
    if t == "I":
        v = struct.unpack_from("<i", buf, off)[0]
        return v, off + 4
    if t == "F":
        v = struct.unpack_from("<f", buf, off)[0]
        return v, off + 4
    if t == "D":
        v = struct.unpack_from("<d", buf, off)[0]
        return v, off + 8
    if t == "L":
        v = struct.unpack_from("<q", buf, off)[0]
        return v, off + 8
    if t in "fdlib":
        n, enc, clen = struct.unpack_from("<III", buf, off)
        off += 12
        raw = bytes(buf[off:off + clen])
        off += clen
        if enc == 1:
            raw = zlib.decompress(raw)
        if t == "f":
            arr = np.frombuffer(raw, dtype="<f4", count=n)
        elif t == "d":
            arr = np.frombuffer(raw, dtype="<f8", count=n)
        elif t == "l":
            arr = np.frombuffer(raw, dtype="<i8", count=n)
        elif t == "i":
            arr = np.frombuffer(raw, dtype="<i4", count=n)
        else:
            arr = np.frombuffer(raw, dtype=np.uint8, count=n)
        return arr, off
    if t in "SR":
        n = struct.unpack_from("<I", buf, off)[0]
        off += 4
        raw = bytes(buf[off:off + n])
        off += n
        if t == "S":
            return raw.decode("utf-8", "replace"), off
        return raw, off
    raise ValueError(f"unsupported FBX property type {t!r} at {off}")


def _parse_node(buf, off, ver):
    wide = ver >= 7500
    if wide:
        end, nprops, plen = struct.unpack_from("<QQQ", buf, off)
        nlen = buf[off + 24]
        hdr = 25
    else:
        end, nprops, plen = struct.unpack_from("<III", buf, off)
        nlen = buf[off + 12]
        hdr = 13
    if end == 0:
        return None, off + hdr
    name = bytes(buf[off + hdr:off + hdr + nlen]).decode("utf-8", "replace")
    node = Node(name)
    p = off + hdr + nlen
    for _ in range(nprops):
        v, p = _read_prop(buf, p, wide)
        node.props.append(v)
    while p < end:
        child, p2 = _parse_node(buf, p, ver)
        if child is None:
            p = p2
            break
        node.children.append(child)
        p = p2
    return node, end


def parse(path):
    data = Path(path).read_bytes()
    if not data.startswith(b"Kaydara FBX Binary"):
        raise ValueError("not a binary FBX: " + str(path))
    ver = struct.unpack_from("<I", data, 23)[0]
    nodes = []
    off = 27
    n = len(data)
    while off < n:
        node, off = _parse_node(data, off, ver)
        if node is None:
            break
        nodes.append(node)
    return ver, nodes


def _p70(node):
    """Properties70 -> dict name -> tuple(values)."""
    out = {}
    if node is None:
        return out
    for p in node.children:
        if p.name != "P" or len(p.props) < 5:
            continue
        out[p.props[0]] = tuple(p.props[4:])
    return out


def _vec3(d, key, default):
    v = d.get(key)
    if not v or len(v) < 3:
        return default
    return np.array([float(v[0]), float(v[1]), float(v[2])], dtype=np.float64)


def _rotmat_deg(deg):
    x, y, z = np.radians(deg)
    cx, sx = np.cos(x), np.sin(x)
    cy, sy = np.cos(y), np.sin(y)
    cz, sz = np.cos(z), np.sin(z)
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return rz @ ry @ rx


def _trs(trans, rot_deg, scale):
    m = np.eye(4)
    m[:3, :3] = _rotmat_deg(rot_deg) @ np.diag(scale)
    m[:3, 3] = trans
    return m


def _local_matrix(props):
    t = _vec3(props, "Lcl Translation", np.zeros(3))
    r = _vec3(props, "Lcl Rotation", np.zeros(3))
    s = _vec3(props, "Lcl Scaling", np.ones(3))
    roff = _vec3(props, "RotationOffset", np.zeros(3))
    rp = _vec3(props, "RotationPivot", np.zeros(3))
    pre = _vec3(props, "PreRotation", np.zeros(3))
    post = _vec3(props, "PostRotation", np.zeros(3))
    soff = _vec3(props, "ScalingOffset", np.zeros(3))
    sp = _vec3(props, "ScalingPivot", np.zeros(3))

    m = np.eye(4)
    m = m @ _trs(t, np.zeros(3), np.ones(3))
    m = m @ _trs(roff, np.zeros(3), np.ones(3))
    m = m @ _trs(rp, np.zeros(3), np.ones(3))
    m = m @ _trs(np.zeros(3), pre, np.ones(3))
    m = m @ _trs(np.zeros(3), r, np.ones(3))
    m = m @ _trs(np.zeros(3), -post, np.ones(3))
    m = m @ _trs(-rp, np.zeros(3), np.ones(3))
    m = m @ _trs(soff, np.zeros(3), np.ones(3))
    m = m @ _trs(sp, np.zeros(3), np.ones(3))
    m = m @ _trs(np.zeros(3), np.zeros(3), s)
    m = m @ _trs(-sp, np.zeros(3), np.ones(3))
    return m


class Scene:
    """Parsed FBX scene: meshes already in source world space."""

    def __init__(self, version, nodes):
        self.version = version
        self.settings = {}
        self.meshes = []  # dict(name, verts Nx3, tris Mx3, material_ids, materials)
        self.up_axis = 1
        self.up_sign = 1
        self.front_axis = 2
        self.front_sign = -1
        self.coord_axis = 0
        self.coord_sign = 1
        self.unit_scale = 1.0
        self._parse(nodes)

    def _parse(self, nodes):
        gs = next((n for n in nodes if n.name == "GlobalSettings"), None)
        if gs is not None:
            p = _p70(gs.child("Properties70"))
            self.settings = {k: v for k, v in p.items()}
            self.up_axis = int(p.get("UpAxis", (1,))[0])
            self.up_sign = int(p.get("UpAxisSign", (1,))[0])
            self.front_axis = int(p.get("FrontAxis", (2,))[0])
            self.front_sign = int(p.get("FrontAxisSign", (-1,))[0])
            self.coord_axis = int(p.get("CoordAxis", (0,))[0])
            self.coord_sign = int(p.get("CoordAxisSign", (1,))[0])
            self.unit_scale = float(p.get("UnitScaleFactor", (1.0,))[0])

        objs = next((n for n in nodes if n.name == "Objects"), None)
        conns = next((n for n in nodes if n.name == "Connections"), None)
        if objs is None:
            return

        models = {}
        geometries = {}
        mats = {}
        for o in objs.children:
            if o.name == "Model":
                mid = int(o.props[0])
                name = str(o.props[1]).split("\x00")[0]
                typ = str(o.props[2]) if len(o.props) > 2 else ""
                props = _p70(o.child("Properties70"))
                models[mid] = {"id": mid, "name": name, "type": typ, "props": props}
            elif o.name == "Geometry":
                gid = int(o.props[0])
                name = str(o.props[1]).split("\x00")[0]
                geometries[gid] = {"id": gid, "name": name, "node": o}
            elif o.name == "Material":
                mats[int(o.props[0])] = str(o.props[1]).split("\x00")[0]

        # connections
        parent_of = {}
        geo_to_model = {}
        model_mats = {}
        geom_mats = {}
        if conns is not None:
            for c in conns.children:
                if c.name != "C" or len(c.props) < 3:
                    continue
                kind, child, parent = str(c.props[0]), int(c.props[1]), int(c.props[2])
                if kind == "OO":
                    if child in models and parent in models:
                        parent_of[child] = parent
                    elif child in geometries and parent in models:
                        geo_to_model[child] = parent
                    elif child in mats and parent in models:
                        model_mats.setdefault(parent, []).append(child)
                    elif child in mats and parent in geometries:
                        geom_mats.setdefault(parent, []).append(child)

        def world(mid, _cache={}):
            if mid in _cache:
                return _cache[mid]
            m = _local_matrix(models[mid]["props"])
            par = parent_of.get(mid)
            if par is not None and par in models:
                m = world(par) @ m
            _cache[mid] = m
            return m

        for gid, g in geometries.items():
            mid = geo_to_model.get(gid)
            if mid is None:
                continue
            geo = _extract_geometry(g["node"])
            if geo is None:
                continue
            verts, tris, poly_mat = geo
            m = world(mid)
            verts = verts @ m[:3, :3].T + m[:3, 3]
            self.meshes.append({
                "name": g["name"] or models[mid]["name"],
                "model": models[mid]["name"],
                "verts": verts,
                "tris": tris,
                "poly_mat": poly_mat,
                "materials": [mats[i] for i in (geom_mats.get(gid) or model_mats.get(mid) or []) if i in mats],
            })

        # convert to UE frame (cm, Z up)
        for mesh in self.meshes:
            v = mesh["verts"]
            v = _to_ue_frame(v, self)
            mesh["verts"] = v * self.unit_scale

    def bbox(self):
        if not self.meshes:
            return None
        allv = np.vstack([m["verts"] for m in self.meshes])
        return allv.min(0), allv.max(0)


def _to_ue_frame(v, scene):
    """Map FBX axis convention to UE x=forward, y=right, z=up (source units)."""
    out = np.empty_like(v)
    for axis, sign in ((0, 1), (1, 2), (2, 3)):
        pass
    # build from declared axes: UE X = CoordAxis*CoordSign, UE Y = ? ,
    # Use standard UE importer mapping: X=fbx_x, Y=fbx_z, Z=fbx_y is not universal,
    # so derive from Up/Front/Coord declarations.
    idx = [0, 1, 2]
    src_coord = scene.coord_axis * 1  # noqa: F841
    # generic: UE Z = up axis; UE X = front axis; UE Y = coordinate axis
    ax_up = scene.up_axis
    ax_front = scene.front_axis
    ax_coord = scene.coord_axis
    out[:, 0] = v[:, ax_coord] * scene.coord_sign
    out[:, 1] = v[:, ax_front] * scene.front_sign
    out[:, 2] = v[:, ax_up] * scene.up_sign
    return out


def _extract_geometry(node):
    vn = node.child("Vertices")
    pn = node.child("PolygonVertexIndex")
    if vn is None or pn is None:
        return None
    verts = np.asarray(vn.props[0], dtype=np.float64).reshape(-1, 3)
    idx = np.asarray(pn.props[0], dtype=np.int64)
    tris = []
    poly_mat = []
    mat_layer = node.child("LayerElementMaterial")
    mat_idx = None
    if mat_layer is not None:
        mi = mat_layer.child("Materials")
        if mi is not None:
            mat_idx = np.asarray(mi.props[0], dtype=np.int64)
    cur = []
    poly_no = 0
    for i in idx:
        if i < 0:
            cur.append(int(~i))
            for k in range(1, len(cur) - 1):
                tris.append((cur[0], cur[k], cur[k + 1]))
                if mat_idx is not None and len(mat_idx) > 1:
                    poly_mat.append(int(mat_idx[min(poly_no, len(mat_idx) - 1)]))
            cur = []
            poly_no += 1
        else:
            cur.append(int(i))
    if cur and len(cur) >= 3:
        for k in range(1, len(cur) - 1):
            tris.append((cur[0], cur[k], cur[k + 1]))
            if mat_idx is not None and len(mat_idx) > 1:
                poly_mat.append(int(mat_idx[min(poly_no, len(mat_idx) - 1)]))
    tris = np.asarray(tris, dtype=np.int64).reshape(-1, 3)
    return verts, tris, poly_mat


def load(path):
    ver, nodes = parse(path)
    return Scene(ver, nodes)
