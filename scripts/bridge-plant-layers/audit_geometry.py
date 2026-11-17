"""Read each original LOD0 and audit its published per-island wind binding.

Run after publish.py --check-library. Geometry and binding batches are streamed per
variant; the output is one JSON line per variant, including cases needing inspection.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
import json
import struct
from pathlib import Path

import numpy as np

from windlayer import analyze
from windlayer.parts import chunk_files
from windlayer.ripple_review import ripple_shape, wind_unit, zero_at_max_gain


def anchor_gain(base_cm):
    # Same centimetre rounding, byte order and amplitude range as PackGrassRippleWeight.
    values = np.floor(np.asarray(base_cm,dtype=np.float32)*np.float32(100.)+.5).astype(np.int64)
    h = 2166136261
    for value in struct.pack("<III", *(int(x) & 0xffffffff for x in values)):
        h = ((h ^ value)*16777619) & 0xffffffff
    return .60+.30*(((h ^ 0x9e3779b9) & 0xffffff)/0x1000000)


def geometry(folder, variant, mesh=None):
    if mesh is None:
        mesh = analyze.load_lod0(folder / variant["source"])
    positions, triangles = mesh["verts"], mesh["tris"]
    del mesh
    labels, n = analyze.island_labels(triangles, len(positions))
    low, span = positions.min(0), np.ptp(positions, axis=0)
    frame = variant["frame"]
    if not (np.allclose(low, frame["bboxMinCm"], atol=.0001, rtol=0) and
            np.allclose(span, frame["sizeCm"], atol=.0001, rtol=0) and n == variant["counts"]["islands"]):
        raise ValueError("source frame or island count differs")
    slices = np.argsort(labels, kind="stable")
    counts = np.bincount(labels, minlength=n)
    offsets = np.r_[0, counts.cumsum()]
    has_faces = np.zeros(n, bool)
    has_faces[labels[triangles[:,0]]] = True
    del triangles
    totals = dict(islands=n, vertices=len(positions), terminal=0, noSurface=int((~has_faces).sum()),
                  branch1=0, branch2=0, projectedGradient=0, projectedZero=0, projectedFlat=0)
    issues = {}
    examples = {}
    organs = {}
    def issue(key, ids):
        if len(ids):
            issues[key] = issues.get(key,0) + len(ids)
            sample = examples.setdefault(key,[])
            sample.extend(int(i) for i in ids[:max(0,12-len(sample))])
    first = 0
    chunks = [variant["bindings"]] if "bindings" in variant else (json.loads(p.read_bytes()) for p in chunk_files(folder,variant))
    for rows in chunks:
        end = first+len(rows)
        if end > n or not all(r["island"]==first+i for i,r in enumerate(rows)):
            raise ValueError("unexpected island ID in source order")
        # Sub-batches bound the temporary vertex arrays on large inline/chunked variants.
        for start in range(first,end,8192):
            stop = min(start+8192,end)
            batch = rows[start-first:stop-first]
            indices = slices[offsets[start]:offsets[stop]]
            p = positions[indices]
            local = labels[indices]-start
            off = offsets[start:stop]-offsets[start]
            mid = (np.minimum.reduceat(p,off,axis=0)+np.maximum.reduceat(p,off,axis=0))*.5
            centers = np.asarray([r["boundsCenter"] for r in batch])
            error = (mid-low)/np.maximum(span,1e-9)-centers
            issue("unmatchedBounds",start+np.flatnonzero((error*error).sum(axis=1) >= .0025**2))
            active = np.asarray([not r.get("review") and r.get("influence",True) for r in batch])
            terminal = np.asarray([r["terminal"] for r in batch])
            has_surface = has_faces[start:stop]
            issue("windOnEmptyIsland",start+np.flatnonzero(active & ~has_surface))
            totals["branch1"] += int(active.sum())
            totals["branch2"] += sum(r.get("secondary",-1)>=0 for r,enabled in zip(batch,active) if enabled)
            totals["terminal"] += int(terminal.sum())
            if terminal.any():
                smooth = ripple_shape(p, local, batch, terminal, low, span)
                # Check the entire native amplitude range; if even .90 quantizes
                # to zero, no choice of position hash can make this island move.
                lower = np.minimum.reduceat(smooth,off)
                upper = np.maximum.reduceat(smooth,off)
                zero = terminal & (zero_at_max_gain(upper))
                gradient = terminal & (np.floor(255*.60*upper+.5)>np.floor(255*.60*lower+.5))
                totals["projectedGradient"] += int(gradient.sum())
                totals["projectedZero"] += int(zero.sum())
                totals["projectedFlat"] += int((terminal & ~gradient & ~zero).sum())
                for b, l, h in zip(batch, lower, upper):
                    if not b["terminal"]:
                        continue
                    # Compact chunks have no unit IDs. Two islands receiving
                    # the exact same parent, attachment and blade are evaluated
                    # as one wind unit, including inherited slivers at its base.
                    key = wind_unit(b)
                    packet = organs.get(key)
                    if packet is None:
                        organs[key] = [l,h,b["island"],1]
                    else:
                        packet[0] = min(packet[0],l)
                        packet[1] = max(packet[1],h)
                        packet[3] += 1
        first = end
    if first!=n:
        raise ValueError("incomplete binding rows")
    totals["windUnits"] = len(organs)
    flat_at_min_gain = 0
    marginal = []
    minimum_cm = low.copy()
    for key, (low, high, representative, num_islands) in organs.items():
        if zero_at_max_gain(high):
            issue("zeroRippleUnit", [representative])

        elif np.floor(high*.60*255+.5)==np.floor(low*.60*255+.5):
            flat_at_min_gain += 1
            if high-low < 1e-8:
                issue("constantRippleUnit", [representative])
        if 255*.60*(high-low) < 1 and not zero_at_max_gain(high):
            gain = anchor_gain(minimum_cm + span*np.array(key[4]))
            codes = [int(np.floor(x*gain*255+.5)) for x in (low, high)]
            if codes[0] == codes[1]:
                issue("constantAtBakedGain", [representative])
            if len(marginal) < 12:
                marginal.append(dict(island=representative, codeMin=codes[0], codeMax=codes[1]))
    if marginal:
        examples["nearQuantizationBoundary"] = marginal
    totals["flatUnitsAtMinGain"] = flat_at_min_gain
    return {"counts":totals, "findings":issues, "examples":examples}


def inspect(task):
    folder, aid = task
    doc = json.loads((folder/"_layer.json").read_bytes())
    results = []
    for k,v in doc["variants"].items():
        try:
            results.append(dict(id=aid, variant=k, **geometry(folder,v)))
        except Exception as exc:
            results.append(dict(id=aid, variant=k, error=f"{type(exc).__name__}: {exc}"))
    return results


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library",type=Path)
    parser.add_argument("catalog",type=Path)
    parser.add_argument("report",type=Path)
    parser.add_argument("--workers",type=int,default=2)
    args=parser.parse_args()
    catalog=json.loads(args.catalog.read_bytes())
    if not (1 <= args.workers <= 16):
        parser.error("--workers must be between 1 and 16")
    tasks=[(args.library/a["dir"],a["id"]) for a in catalog]
    failed=False
    with args.report.open("x",encoding="utf-8") as report, ProcessPoolExecutor(args.workers) as pool:
        jobs={pool.submit(inspect,task):task[1] for task in tasks}
        for job in as_completed(jobs):
            for line in job.result():
                report.write(json.dumps(line)+"\n")
                failed |= bool(line.get("error") or line.get("findings"))
            report.flush()
    return int(failed)


if __name__=="__main__":
    raise SystemExit(main())
