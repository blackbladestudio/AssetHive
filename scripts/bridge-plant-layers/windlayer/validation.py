"""Checks shared by publishing and the read-only audit of the installed library."""
import hashlib
import json
import math
import re


def unique_fields(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate JSON object key")
    return result


def fail_constant(value):
    raise ValueError(f"Non-finite JSON number: {value}")


def parse(data):
    return json.loads(data, object_pairs_hook=unique_fields, parse_constant=fail_constant)


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def validate_asset(doc, asset, folder, storage, *, managed_sources=None):
    def require(condition, error):
        if not condition:
            raise ValueError(f"{asset['id']} {name}: {error}")
    def vector(p):
        return isinstance(p, list) and len(p) == 3 and all(type(x) in (float, int) and math.isfinite(x) for x in p)
    def point(p):
        return vector(p) and all(-.15 <= x <= 1.15 for x in p)
    def valid_index(i, axes):
        return type(i) is int and 0 <= i < len(axes)

    name = "manifest"
    static = not asset["form"]
    originals = (set(managed_sources) if managed_sources is not None else
                 {int(p.name[3:]) for p in folder.iterdir() if p.is_dir() and re.fullmatch(r"Var\d+", p.name, re.I)})
    require(doc.get("provider") == "DeepSeek Harness" and type(doc["schemaVersion"]) is int and
            doc["schemaVersion"] == 1 and doc["assetId"] == asset["id"] and doc["form"] == asset["form"], "wrong identity/form")
    require(doc.get("lodWindMode") in (None, "lod0-uv0-surface"), "unsupported LOD wind reuse mode")
    require(originals and {f"Var{i}" for i in originals} == set(doc["variants"]), "incomplete variant coverage")
    parts = []
    for name, v in doc["variants"].items():
        no = int(name[3:])
        path = v["source"].replace("\\", "/")
        m = re.fullmatch(r"Var(\d+)/Var(\d+)_LOD0\.fbx", path, re.I)
        original = (folder / path).resolve()
        expected = (original == managed_sources[no].resolve() if managed_sources is not None else
                    m and int(m[1]) == int(m[2]) == no)
        require(expected and original.is_relative_to(folder.resolve()) and digest(original) == v["sha256"], "wrong original LOD0 or fingerprint")
        if doc.get("lodWindMode"):
            from .lod_sources import original_lods
            records = v.get("lodSources")
            require(isinstance(records, dict), "missing LOD source declarations")
            if managed_sources is None:
                actual = original_lods(original.parent, no)
                require(set(records) == {f"LOD{i}" for i in actual if i > 0}, "incomplete LOD source coverage")
            for level, record in records.items():
                require(re.fullmatch(r"LOD[1-9]\d*", level), "invalid source LOD number")
                path = record["source"].replace("\\", "/")
                source = (folder / path).resolve()
                require(source.is_relative_to(folder.resolve()) and source != original and
                        source.suffix.lower() == ".fbx" and record["windSource"] == "LOD0" and
                        digest(source) == record["sha256"], "wrong LOD source or fingerprint")
                require(record.get("layers") in (None, ["Shared"]) and
                        (record.get("representation") != "billboard" or record.get("layers") == ["Shared"]),
                        "Billboard must use Shared only")
                if managed_sources is None:
                    require(source == actual[int(level[3:])].resolve(), "LOD source belongs to another variant")
        frame = v["frame"]
        require(frame["units"] == "cm" and frame["up"] == "Z" and all(vector(frame[k]) for k in ("sizeCm","bboxMinCm","bboxMaxCm")), "invalid frame")
        size = frame["sizeCm"]
        require(all(s >= 0 and abs(hi-lo-s) < .0001 for lo,hi,s in zip(frame["bboxMinCm"], frame["bboxMaxCm"], size)), "inconsistent frame bounds")
        primary, secondary = v["primaryAxes"], v["secondaryAxes"]
        require(not static or not (primary or secondary), "wind on static asset")
        for table in (primary, secondary):
            for i, axis in enumerate(table):
                require(axis["id"] == i and all(point(axis[k]) for k in ("base","tip")), "invalid branch axis")
                require(axis.get("weightProfile", "smoothstep") in ("smoothstep", "cantilever"), "unsupported branch weight profile")
                require(any(abs((b-a)*s) > 1e-8 for a,b,s in zip(axis["base"],axis["tip"],size)), "collapsed branch axis")
        require(all(valid_index(ax["primary"], primary) and 0 <= ax["attachOnPrimary"] <= 1 for ax in secondary), "invalid Branch2 parent/attachment")
        inline = "bindings" in v
        require(inline != ("bindingChunks" in v), "expected exactly one binding representation")
        def batches():
            if inline:
                yield v["bindings"]
                return
            require(isinstance(v["bindingChunks"], list) and v["bindingChunks"], "empty chunk list")
            for ordinal, filename in enumerate(v["bindingChunks"]):
                match = re.fullmatch(rf"{name}_{ordinal:04d}_([a-f0-9]{{64}})\.json", filename)
                require(match, "invalid chunk owner, ordinal or name")
                part = storage / "_layer_data" / filename
                data = part.read_bytes()
                require(hashlib.sha256(data).hexdigest() == match[1], "chunk hash mismatch")
                parts.append(part)
                yield parse(data)
        count = active = side = terminal = pending = 0
        owners = set()
        for batch in batches():
            require(isinstance(batch, list), "expected a binding list")
            for b in batch:
                require(type(b["island"]) is int and b["island"] == count and point(b["boundsCenter"]), f"invalid island {count}")
                count += 1
                tip, review, influence = b["terminal"], b.get("review", False), b.get("influence", True)
                require(all(type(x) is bool for x in (tip,review,influence)), "invalid flags")
                if review or not influence:
                    require(not tip and b["layers"] == ([] if static else ["Shared"]) and not (static and review), "inactive island carries wind")
                    pending += review
                    continue
                p, s = b["primary"], b["secondary"]
                if "rootContact" in b:
                    contact = b["rootContact"]
                    require(isinstance(contact, dict) and point(contact.get("center")) and
                            all(type(contact.get(k)) in (int, float) and math.isfinite(contact[k])
                                for k in ("innerHeight", "outerHeight")) and
                            0 <= contact["innerHeight"] < contact["outerHeight"], "invalid root contact")
                require(not static and valid_index(p, primary) and type(s) is int and (s == -1 or valid_index(s, secondary) and secondary[s]["primary"] == p), "invalid branch binding")
                require(b["layers"] == ["Shared","Branch1"] + (["Branch2"] if s>=0 else []) + (["Ripple"] if tip else []), "layer flags disagree with binding")
                require(all(type(x) in (int,float) and (x == -1 or 0 <= x <= 1) for x in (b["primaryAttachment"],b["secondaryAttachment"])), "invalid attachment")
                blade = b["blade"]
                require(isinstance(blade,list) and len(blade)==2 and all(point(x) for x in blade), "missing blade for UE binding")
                if tip:
                    require(any(abs((y-x)*z)>1e-8 for x,y,z in zip(*blade,size)), "collapsed Ripple blade")
                    if s < 0 and b["primaryAttachment"] < 0:
                        owners.add(p)
                        root = primary[p]["base"]
                        root_dist, tip_dist = (math.dist(tuple((x-y)*s for x,y,s in zip(endpoint,root,size)), (0,0,0))
                                               for endpoint in blade)
                        require(root_dist <= tip_dist + .001, "rooted Ripple blade points back to its base")
                active += 1; side += s >= 0; terminal += tip
        require(all(ax["terminalBlade"] is (ax["id"] in owners) for ax in primary), "terminalBlade disagrees with final Ripple owners")
        keys = ("islands","primaryAxes","secondaryAxes","branch1InfluencedIslands","branch2InfluencedIslands","foliageIslands","unattachedIslands")
        require(tuple(v["counts"][k] for k in keys) == (count,len(primary),len(secondary),active,side,terminal,pending), "stale hierarchy counts")
        require(v["review"]["status"] == ("static" if static else "review" if pending else "ok"), "stale review status")
        if not inline:
            require(v["bindingCount"]==count and v["hasSecondary"] is bool(side) and v["hasTerminal"] is bool(terminal), "invalid chunk summary")
    return parts
