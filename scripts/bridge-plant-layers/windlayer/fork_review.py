"""Resolve several physical support paths folded into one two-endpoint wind axis."""
import numpy as np
from scipy.spatial import cKDTree

from .surface_fragments import triangle_distances


def along(point, line):
    delta = line[-1] - line[0]
    return round(float(np.clip(np.dot(point-line[0], delta) / max(delta @ delta, 1e-12), 0, 1)), 5)


def sample(points, count=25):
    arc = np.r_[0., np.linalg.norm(np.diff(points, axis=0), axis=1).cumsum()]
    return np.column_stack([np.interp(np.linspace(0., arc[-1], count), arc, c) for c in points.T])


def nearest(point, line):
    delta = np.diff(line, axis=0)
    t = np.clip(np.sum((point-line[:-1])*delta, axis=1) /
                np.maximum(np.sum(delta*delta, axis=1), 1e-12), 0, 1)
    offsets = line[:-1] + t[:, None]*delta - point
    distances = np.einsum("ij,ij->i", offsets, offsets)
    i = int(distances.argmin())
    return float(np.sqrt(distances[i])), i + t[i], point + offsets[i]


def separate_paths(lines, root_distance):
    """Join measured tips to bases; retain a distinct path at each actual fork."""
    duplicates = {}
    unique = {}
    shapes = {}
    for u, line in sorted(lines.items()):
        shape = sample(line)
        length = np.linalg.norm(line[-1]-line[0])
        for j, other in shapes.items():
            error = min(np.linalg.norm(shape-s, axis=1).max() for s in (other,other[::-1]))
            if error <= max(.12, .012*length):
                duplicates[u] = j
                break
        else:
            shapes[u] = shape
            unique[u] = line

    # Directed Prim growth, starting at the ground or at the existing parent tissue.
    # Only bridge gaps comparable to the two adjoining stems, in local centimetres.
    remaining = set(unique)
    paths = []
    members = {}
    while remaining:
        _, _, u, reverse = min((root_distance(line[end]), line[end,2], u, end==-1)
                                for u in remaining for line in (unique[u],) for end in (0,-1))
        oriented = unique[u][::-1] if reverse else unique[u]
        seed = len(paths)
        paths.append(dict(line=oriented.copy(), units=[u], parent=None))
        members[u] = seed
        remaining.remove(u)
        visited = [(u, oriented, seed)]
        while remaining:
            best = None
            for child in sorted(remaining):
                raw = unique[child]
                for rev in (False, True):
                    c = raw[::-1] if rev else raw
                    for owner, parent_line, parent_path in visited:
                        gap, param, contact = nearest(c[0], parent_line)
                        limit = np.clip(.065*min(np.linalg.norm(p[-1]-p[0]) for p in (raw,parent_line)), .12, 1.)
                        if gap > limit:
                            continue
                        # Independent shoots can touch at the base. They share a joint,
                        # but do not run tip-to-base through one another.
                        step = max(0, min(int(param),len(parent_line)-2))
                        tangent = parent_line[min(step+3,len(parent_line)-1)]-parent_line[max(step-2,0)]
                        direction = c[min(3,len(c)-1)]-c[0]
                        length_product = np.linalg.norm(tangent) * np.linalg.norm(direction)
                        cosine = float(tangent @ direction) / max(length_product, 1e-12)
                        candidate = (gap/limit + .15*(1-cosine), child, rev, owner)
                        if best is None or candidate < best[0]:
                            best = candidate, c, parent_path, contact, cosine, limit
            if best is None:
                break
            (_, child, rev, owner), line, parent_path, contact, cosine, limit = best
            parent = paths[parent_path]
            # No U-turn at a continuation. An interior attachment or a second
            # child departing the joint starts its own measured path.
            if cosine >= .65 and np.linalg.norm(parent["line"][-1]-line[0]) <= limit:
                parent["line"] = np.vstack((parent["line"],line))
                parent["units"].append(child)
                number = parent_path
            else:
                number = len(paths)
                paths.append(dict(line=line.copy(),units=[child],parent=(parent_path, contact)))
            members[child] = number
            remaining.remove(child)
            visited.append((child,line,number))
    for alias, owner in duplicates.items():
        members[alias] = members[owner]
        paths[members[alias]]["units"].append(alias)
    return paths, members


class Group:
    def __init__(self, poly, lines, paths, members):
        self.samples = {}
        self.poly = poly
        cumulative = np.r_[0., np.linalg.norm(np.diff(poly, axis=0),axis=1).cumsum()]
        self.arc = cumulative / cumulative[-1]
        self.paths = paths
        self.members = members
        # Old attachments reference the sampled source walk. Map them back to
        # their recorded strip before projecting onto the replacement axis.
        cloud = np.vstack(list(lines.values()))
        owners = np.concatenate([np.full(len(p),u) for u,p in lines.items()])
        self.poly_owner = owners[cKDTree(cloud).query(poly)[1]]

    def fixed(self, weight):
        if weight in self.samples:
            return self.samples[weight]
        step = min(int(np.searchsorted(self.arc, weight, side="right"))-1, len(self.arc)-2)
        step = max(0, step)
        mix = (weight-self.arc[step])/max(1e-12,self.arc[step+1]-self.arc[step])
        point = self.poly[step] + mix*(self.poly[step+1]-self.poly[step])
        owner = self.poly_owner[step + int(mix > .5)]
        value = self.paths[self.members[owner]], point
        self.samples[weight] = value
        return value


class UnitSurfaces:
    def __init__(self, positions, triangles, labels, units):
        face_units = units[labels[triangles[:,0]]]
        self.order = np.argsort(face_units,kind="stable")
        self.offsets = np.r_[0,np.bincount(face_units,minlength=int(units.max())+1).cumsum()]
        self.positions = positions
        self.triangles = triangles

    def __call__(self, unit):
        section = self.order[self.offsets[unit]:self.offsets[unit+1]]
        return self.positions[self.triangles[section]]


class ForkBindings:
    def __init__(self, variant, traces, get_line, minimum, size, surfaces=None):
        self.v = variant
        self.minimum = minimum
        self.size = size
        self.groups = {}
        self.original_sides = [(a["primary"], a["attachOnPrimary"]) for a in variant["secondaryAxes"]]
        # Physical primary surfaces are used to choose a parent and orient
        # detached lateral strips. A straight material chord can miss a bent stem.
        self.get_line = get_line
        self.primary_lines = {}
        self.root_map = {}
        for table, i, poly in traces:
            if table == "primaryAxes":
                self.add_group(table, i, poly)
        for sid, (pid, weight) in enumerate(self.original_sides):
            if pid in self.root_map:
                group = self.groups["primaryAxes",pid]
                path, contact = group.fixed(weight)
                driver = path["driver"]
                parent = driver["primary"]
                # A lateral already below a fork keeps the primary weight at
                # the insertion of its supporting lateral.
                attach = (self.v["secondaryAxes"][driver["secondary"]]["attachOnPrimary"]
                          if driver["secondary"] >= 0 else self.on_primary(parent,contact))
                self.v["secondaryAxes"][sid].update(primary=parent,attachOnPrimary=attach)
        # Query the actual primary tissues, including previously distinct plants
        # whose branches crossed the collapsed chain in projection.
        segments = [
            (pid, line)
            for pid, axis in enumerate(self.v["primaryAxes"]) if not axis.get("synthetic")
            for line in self.tissue(pid) if len(line) > 1
        ]
        self.seg_base = np.vstack([line[:-1] for _,line in segments])
        self.seg_delta = np.vstack([np.diff(line,axis=0) for _,line in segments])
        self.seg_len2 = np.maximum(np.sum(self.seg_delta**2,axis=1), 1e-12)
        self.seg_pid = np.concatenate([np.full(len(line)-1,pid) for pid,line in segments])
        self.neighbors = {}
        for table, i, poly in traces:
            if table == "secondaryAxes":
                self.add_group(table, i, poly)

        if surfaces is not None:
            self.fold_distal_contacts(surfaces)

    def fold_distal_contacts(self, surfaces):
        # An extra strip may attach to the side of another lateral, even at the
        # opposite end from the closest primary. Check both ends on source faces.
        sides = self.v["secondaryAxes"]
        paths = [p for group in self.groups.values() for p in group.paths]
        distant = {p["driver"]["secondary"]:p for p in paths if p.get("parentGapCm",0)>.65
                   and p["driver"]["secondary"] >= len(self.original_sides)}
        if not distant:
            return
        redirects = {}
        for sid, path in distant.items():
            checks = []
            own = sides[sid]["units"]
            surface = np.vstack([surfaces(u).reshape(-1,3) for u in path["units"]])
            for end in (0,-1):
                point = path["line"][end]
                radii = np.linalg.norm(surface-point,axis=1)
                rim = np.unique(surface[radii <= max(.25,radii.min()+.15)], axis=0)
                for j,axis in enumerate(sides):
                    if j in distant:
                        continue
                    for unit in axis["units"]:
                        if unit in own or nearest(point,self.get_line(unit))[0] > 1.8:
                            continue
                        faces = surfaces(unit)
                        ds = [np.sqrt(triangle_distances(np.broadcast_to(x,(len(faces),3)),faces).min()) for x in rim]
                        if min(ds) <= .04 and np.median(ds) <= .12:
                            checks.append((float(np.median(ds)),j,end,unit))
            if not checks:
                continue
            checks.sort()
            median, donor, end, unit = checks[0]
            if any(other!=donor and score < median+.02 for score,other,_,_ in checks[1:]):
                continue
            axis = sides[donor]
            line = np.array([self.real(axis["base"]), self.real(axis["tip"])])
            fixed = along(path["line"][end],line)
            redirects[sid] = dict(primary=axis["primary"], secondary=donor, line=line),fixed
            path["surfaceContact"] = dict(donorUnit=unit, end=end, medianCm=median)
        if not redirects:
            return
        for sid,(driver,_) in redirects.items():
            sides[driver["secondary"]]["units"].extend(sides[sid]["units"])
        retained = [s for s in sides if s["id"] not in redirects]
        new_ids = {s["id"]:i for i,s in enumerate(retained)}
        for path in paths:
            sid = path["driver"]["secondary"]
            if sid in redirects:
                path["driver"],path["fixed"] = redirects[sid]
        # A driver can be shared by several distal paths.
        drivers = {id(p["driver"]):p["driver"] for p in paths}
        for driver in drivers.values():
            if driver["secondary"]>=0:
                driver["secondary"] = new_ids[driver["secondary"]]
        for i,s in enumerate(retained):
            s["id"] = i
        sides[:] = retained

    def finish_existing_laterals(self):
        """Reconcile previously independent branches after their old parent splits.

        Run after bind() has consumed the original axis IDs. Return the final
        per-side remap so chunked and inline bindings use the same wind pivot.
        """
        sides = self.v["secondaryAxes"]
        old_joints = [(axis["primary"], axis["attachOnPrimary"]) for axis in sides]
        inherited = {}
        for sid, (pid, weight) in enumerate(self.original_sides):
            if pid not in self.root_map or ("secondaryAxes", sid) in self.groups:
                continue
            path, _ = self.root_map[pid].fixed(weight)
            driver = path["driver"]
            if driver["secondary"] < 0:
                continue

            root = self.real(sides[sid]["base"])
            gap, _, contact = nearest(root, path["line"])
            parent = driver["primary"]
            donor = driver["secondary"]
            primary_gap, _, nearest_primary = min(
                (nearest(root, line) for line in self.tissue(parent)), key=lambda hit: hit[0]
            )
            if primary_gap <= min(.65, gap + .10):
                sides[sid].update(primary=parent, attachOnPrimary=self.on_primary(parent, nearest_primary))
                continue

            if gap > .65:
                # A folded scan path can pass a different plant. Require a
                # unique nearby physical axis before overriding its old joint.
                hits = []
                for candidate in sides:
                    if candidate["id"] == sid or not candidate["units"]:
                        continue
                    dist, _, point = min(
                        (nearest(root, self.get_line(u)) for u in candidate["units"]),
                        key=lambda hit: hit[0],
                    )
                    if dist <= .65:
                        hits.append((dist, candidate["id"], point))
                hits.sort(key=lambda hit: hit[0])
                if not hits or (len(hits) > 1 and hits[1][0] <= hits[0][0] + .10):
                    continue
                gap, donor, contact = hits[0]
                _, nearest_main_gap = self.parent_at(root, sides[donor]["primary"])
                if nearest_main_gap <= gap + .10:
                    continue
                fixed = None
            else:
                fixed = path.get("fixed")

            axis = sides[donor]
            line = np.array([self.real(axis["base"]), self.real(axis["tip"])])
            if fixed is None and np.linalg.norm(contact-line[0]) <= max(.30, .08*np.linalg.norm(line[1]-line[0])):
                # Two shoots at the same insertion can use independent axes.
                continue
            inherited[sid] = (donor, fixed if fixed is not None else along(contact, line))

        # A child of a third-order twig uses that twig's already fixed joint.
        # If scans imply a cycle, keep those axes independent.
        resolved = {}
        for sid, (parent, attachment) in inherited.items():
            seen = {sid}
            while parent in inherited and parent not in seen:
                seen.add(parent)
                parent, attachment = inherited[parent]
            if parent not in seen:
                resolved[sid] = (parent, attachment)
        for sid, (parent, _) in resolved.items():
            sides[parent]["units"].extend(sides[sid]["units"])
        retained = [axis for axis in sides if axis["id"] not in resolved]
        new_ids = {axis["id"]: i for i, axis in enumerate(retained)}
        remap = {}
        for sid in range(len(sides)):
            parent, attachment = resolved.get(sid, (sid, None))
            axis = sides[parent]
            joint = (axis["primary"], axis["attachOnPrimary"])
            replace_joint = sid in resolved or joint != old_joints[sid]
            remap[sid] = (joint[0], new_ids[parent], joint[1] if replace_joint else None, attachment)
        for axis in retained:
            axis["id"] = new_ids[axis["id"]]
        sides[:] = retained
        return remap

    def real(self, point):
        return self.minimum + np.array(point)*self.size

    def on_primary(self, pid, point):
        axis = self.v["primaryAxes"][pid]
        return along(point,np.array([self.real(axis["base"]),self.real(axis["tip"])]))

    def tissue(self, pid):
        if pid not in self.primary_lines:
            axis = self.v["primaryAxes"][pid]
            lines = [self.get_line(u) for u in axis.get("units",[])]
            if not lines:
                lines = [np.array([self.real(axis["base"]),self.real(axis["tip"])])]
            self.primary_lines[pid] = lines
        return self.primary_lines[pid]

    def parent_at(self, point, preferred):
        key = (preferred,*point)
        if key not in self.neighbors:
            offset = point-self.seg_base
            t = np.clip(np.sum(offset*self.seg_delta,axis=1)/self.seg_len2,0,1)
            diff = offset-t[:,None]*self.seg_delta
            dist = np.linalg.norm(diff,axis=1)
            # Sub-millimetre differences at crossed stems cannot identify a
            # different parent. Retain the recorded parent in such ties.
            index = int(np.argmin(dist + .1*(self.seg_pid != preferred)))
            self.neighbors[key] = int(self.seg_pid[index]), float(dist[index])
        return self.neighbors[key]

    def add_group(self, table, idx, poly):
        original = self.v[table][idx].copy()
        is_primary = table == "primaryAxes"
        old_parent = None if is_primary else original["primary"]
        if is_primary:
            def distance(p):
                return np.linalg.norm(p-poly[0])
        else:
            def distance(p):
                return self.parent_at(p,old_parent)[1]
        lines = {u:self.get_line(u) for u in original["units"]}
        paths, members = separate_paths(lines,distance)
        group = self.groups[table,idx] = Group(poly,lines,paths,members)
        if is_primary:
            self.root_map[idx] = group
        for n, path in enumerate(paths):
            curve = path["line"]
            parent_path = path["parent"]
            is_root = is_primary and (n==0 or (parent_path is None and
                       curve[0,2] <= self.minimum[2]+.08*self.size[2]))
            if is_root:
                out = "primaryAxes"
                pid = idx if n == 0 else len(self.v[out])
                sid = -1
            else:
                out = "secondaryAxes"
                if parent_path is not None:
                    ancestor = paths[parent_path[0]]["driver"]
                    point = parent_path[1]
                    # A third-order fork inherits Branch2 at the real joint.
                    # A pair separating at its insertion gets independent lateral axes.
                    start, tip = ancestor["line"][[0, -1]]
                    basal_range = max(.3, .08 * np.linalg.norm(tip - start))
                    if ancestor["secondary"] >= 0 and np.linalg.norm(point - start) > basal_range:
                        path["driver"] = ancestor
                        path["fixed"] = paths[parent_path[0]].get("fixed",along(point,ancestor["line"]))
                        self.v[out][ancestor["secondary"]]["units"].extend(path["units"])
                        continue
                    pid = ancestor["primary"]
                else:
                    point = curve[0]
                    if is_primary:
                        # An unconnected elevated strip in a former primary
                        # follows the nearest rooted path of that original group.
                        candidates = [p["driver"]["primary"] for p in paths[:n] if p["driver"]["secondary"]<0]
                        pid = min(candidates,key=lambda p:min(nearest(point,q)[0] for q in self.tissue(p)))
                    else:
                        pid, gap = self.parent_at(point,old_parent)
                        path["parentGapCm"] = gap
                sid = idx if not is_primary and n==0 else len(self.v[out])
            number = pid if is_root else sid
            result = dict(id=number,units=path["units"].copy(),synthetic=False,
                          base=((curve[0]-self.minimum)/np.maximum(self.size,1e-9)).round(6).tolist(),
                          tip=((curve[-1]-self.minimum)/np.maximum(self.size,1e-9)).round(6).tolist(),
                          lengthCm=round(float(np.linalg.norm(np.diff(curve,axis=0),axis=1).sum()),4))
            if is_root:
                result.update(rooted=True,terminalBlade=original.get("terminalBlade",False))
                self.primary_lines[pid] = [curve]
            else:
                result.update(primary=pid,attachOnPrimary=self.on_primary(pid,point))
            if n==0:
                self.v[out][number] = result
            else:
                self.v[out].append(result)
            path["driver"] = dict(primary=pid,secondary=sid,line=curve)

    def bind(self,row,unit,source_method=None):
        if row.get("review") or not row.get("influence",True):
            return
        p,s = row["primary"],row["secondary"]
        group = self.groups.get(("secondaryAxes",s)) if s>=0 else self.groups.get(("primaryAxes",p))
        if group is None:
            if s>=0 and p in self.root_map:
                side = self.v["secondaryAxes"][s]
                row.update(primary=side["primary"],primaryAttachment=side["attachOnPrimary"])
            return
        weight = row["secondaryAttachment"] if s>=0 else row["primaryAttachment"]
        if weight < 0 and unit in group.members:
            path = group.paths[group.members[unit]]
            value = -1.
        elif weight < 0:
            # A disconnected scan fragment inherits a support's whole motion.
            # Its copied blade lies on the donor rather than on the fragment.
            point = self.real(row["blade"][0])
            path = min(group.paths,key=lambda p:nearest(point,p["line"])[0])
            value = -1.
        elif (source_method or row.get("attachMethod")) == "surfaceContact":
            point = self.real(row["blade"][0])
            path = min(group.paths,key=lambda p:nearest(point,p["line"])[0])
            value = along(point,path["driver"]["line"])
        else:
            path,point = group.fixed(weight)
            value = along(point,path["driver"]["line"])
        value = path.get("fixed",value)
        driver = path["driver"]
        p,s = driver["primary"],driver["secondary"]
        row.update(
            primary=p, secondary=s,
            primaryAttachment=value if s < 0 else self.v["secondaryAxes"][s]["attachOnPrimary"],
            secondaryAttachment=-1. if s < 0 else value,
        )
        row["layers"] = ["Shared","Branch1"] + (["Branch2"] if s>=0 else []) + (["Ripple"] if row["terminal"] else [])


def remap_final_side(row, side_remap):
    """Preserve terminal leaf motion while inheriting a distal branch joint."""
    sid = row.get("secondary", -1)
    if sid < 0 or row.get("review") or not row.get("influence", True):
        return
    pid, final_side, primary_attachment, fixed = side_remap[sid]
    row.update(primary=pid, secondary=final_side)
    if primary_attachment is not None:
        row["primaryAttachment"] = primary_attachment
    if fixed is not None:
        row["secondaryAttachment"] = fixed
