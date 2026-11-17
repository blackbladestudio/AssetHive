"""Generate validated wind sidecars from the original Bridge LOD0 geometry.

Pass a JSON catalog of {id, name, dir, form} produced with AssetHive's
classifyBridgePlantWind. An empty form is static. Output is staged per ID.
"""
import argparse
import copy
import hashlib
import json
import os
import re
from concurrent.futures import ProcessPoolExecutor, as_completed
from collections import Counter
from pathlib import Path

from windlayer import analyze
from windlayer.root_stems import protect_root_contacts
from windlayer.review_geometry import review_geometry, orient_terminal_blades
from windlayer.axis_review import sync_terminal_owners
from windlayer.ripple_review import suppress_silent_tips
from windlayer.contact_review import recover_contacts, is_support, prune_synthetic_axes, remap_primary
from windlayer.continuation_review import recover_capped_stems
from windlayer.cluster_review import recover_organ_clusters
from windlayer.seam_review import recover_edge_seams, wind_field
from windlayer.surface_fragments import find_fragment_parents, inherit_surface
from windlayer.parts import split_variant, chunk_files
from windlayer.lod_sources import LOD_WIND_MODE, source_records


def write_json(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(contents, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def generate_variant(mesh, form, fbx, *, template_bank=None, variant_name=None):
    static = not form
    if mesh is None:
        raise ValueError(f"No geometry in {fbx}")
    vertices, triangles = mesh["verts"], mesh["tris"]
    variant = analyze.analyze_variant(vertices, triangles, static=static, form=form)
    labels, count = analyze.island_labels(triangles, len(vertices))
    if sorted(row["island"] for row in variant["bindings"]) != list(range(count)):
        raise ValueError(f"Island coverage mismatch in {fbx}")
    review_geometry(variant, vertices, triangles, labels, static)
    rows = variant["bindings"]
    if not static:
        recover_contacts(variant, rows, vertices, triangles, labels, form, detail_contacts=True)
        for _ in range(3):
            if not recover_capped_stems(variant, rows, vertices, triangles, labels, form):
                break
            recover_contacts(variant, rows, vertices, triangles, labels, form, detail_contacts=True)
        # Root attenuation is part of the donor's wind field, so establish it before copying scan fragments.
        protect_root_contacts(variant, vertices, triangles, labels)
        matched, parents = find_fragment_parents(vertices, triangles, labels, rows,
                                                variant["frame"]["sizeCm"][2], max_faces=32)
        for row in rows:
            parent = matched[row["island"]]
            if parent >= 0:
                inherit_surface(row, parents[parent])
        recover_organ_clusters(variant, rows, vertices, triangles, labels,
                               template_bank=template_bank, variant_name=variant_name)
        recover_edge_seams(variant, rows, vertices, triangles, labels)
        parents_with_children = {axis["primary"] for axis in variant["secondaryAxes"]}
        parents_with_children.update(row["primary"] for row in rows if not row.get("review")
                                     and row.get("attachMethod") in ("surfaceContact", "clusterBranch"))
        for pid in parents_with_children:
            variant["primaryAxes"][pid]["terminalBlade"] = False
        disable = {wind_field(row) for row in rows if is_support(row) and row["secondary"] < 0
                   and row["primary"] in parents_with_children and row["terminal"]}
        # 支撑及其扫描接缝碎片同步关闭末端摆动，避免接缝两侧使用不同风场。
        for row in rows:
            if not row.get("review") and row.get("influence", True) and row["terminal"] and wind_field(row) in disable:
                row["terminal"] = False
                row["layers"] = [layer for layer in row["layers"] if layer != "Ripple"]
    primary_ids = prune_synthetic_axes(variant)
    pending = Counter()
    branch1 = branch2 = terminal = 0
    for row in rows:
        remap_primary(row, primary_ids)
        if row.get("review"):
            row["influence"] = False
            row["terminal"] = False
            row["layers"] = [] if static else ["Shared"]
            pending[row["attachMethod"]] += 1
        if row.get("influence", True) and not static:
            branch1 += row["primary"] >= 0
            branch2 += row["secondary"] >= 0
            terminal += row["terminal"]
            for key, axes in [("primary", "primaryAxes"), ("secondary", "secondaryAxes")]:
                idx = row[key]
                if idx < -1 or idx >= len(variant[axes]):
                    raise ValueError(f"Invalid {key} attachment in {fbx}")
            if row["secondary"] >= 0 and row["primary"] < 0:
                raise ValueError(f"Missing primary parent in {fbx}")
    variant["counts"].update(primaryAxes=len(variant["primaryAxes"]), secondaryAxes=len(variant["secondaryAxes"]),
                             branch1InfluencedIslands=branch1, branch2InfluencedIslands=branch2,
                             foliageIslands=terminal, unattachedIslands=sum(pending.values()))
    variant["review"] = {"status": "static" if static else ("review" if pending else "ok"),
                         "reasons": [f"{kind}: {n} unresolved islands" for kind, n in sorted(pending.items())]}
    orient_terminal_blades(variant)
    if not static:
        protect_root_contacts(variant, vertices, triangles, labels)
        variant["counts"]["foliageIslands"] -= suppress_silent_tips(variant, vertices, labels)
    sync_terminal_owners(variant)
    return variant


def retain_reviewed_weights(previous, fbx, directory):
    """Keep native-reviewed culm contacts while their exact source is unchanged."""
    if not any(axis.get("weightProfile") == "cantilever" for axis in previous.get("primaryAxes", [])):
        return None
    if previous.get("sha256") != analyze.sha256(fbx):
        raise ValueError(f"Reviewed culm source changed; recheck its native contacts: {fbx}")
    variant = copy.deepcopy(previous)
    if "bindingChunks" in variant:
        rows = []
        for part in chunk_files(directory, variant):
            data = part.read_bytes()
            if hashlib.sha256(data).hexdigest() != part.stem.rsplit("_", 1)[-1]:
                raise ValueError(f"Reviewed culm binding chunk changed: {part}")
            rows.extend(json.loads(data))
        variant["bindings"] = rows
        for key in ("bindingChunks", "bindingCount", "hasSecondary", "hasTerminal"):
            variant.pop(key, None)
    return variant


def generate(asset, library, output):
    asset_id = asset["id"]
    directory = (library / asset["dir"]).resolve()
    if directory.parent != library or not re.fullmatch(r"[\w-]+", asset_id):
        raise ValueError("Invalid Bridge asset directory or ID")
    meta = json.loads((directory / f"{asset_id}.json").read_text(encoding="utf-8-sig"))
    if str(meta.get("id", asset_id)).lower() != asset_id.lower():
        raise ValueError("Bridge metadata ID does not match catalog")
    previous = {}
    try:
        installed = json.loads((directory / "_layer.json").read_text(encoding="utf-8-sig"))
        if isinstance(installed, dict) and installed.get("schemaVersion") == 1 and installed.get("assetId") == asset_id:
            previous = installed.get("variants", {})
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    folders = sorted((p for p in directory.iterdir() if p.is_dir() and re.fullmatch(r"Var\d+", p.name, re.I)),
                     key=lambda path: int(path.name[3:]))
    if not folders:
        raise ValueError("No variant folders")
    variants = {}
    unresolved = 0
    review_count = 0
    template_bank = {}
    for folder in folders:
        number = int(folder.name[3:])
        files = [path for path in folder.glob("*.fbx")
                 if (match := re.fullmatch(r"Var(\d+)_LOD0", path.stem, re.I)) and int(match[1]) == number]
        if len(files) != 1:
            raise ValueError(f"Expected one original LOD0 for variant {number} in {folder}, found {len(files)}")
        fbx = files[0]
        name = f"Var{number}"
        prior = previous.get(name, {})
        variant = retain_reviewed_weights(prior, fbx, directory)
        if variant is not None and installed.get("form") != asset["form"]:
            raise ValueError(f"Reviewed culm growth form changed; recheck its native contacts: {fbx}")
        if variant is None:
            variant = generate_variant(analyze.load_lod0(fbx), asset["form"], fbx,
                                       template_bank=template_bank, variant_name=name)
        variant["source"] = fbx.relative_to(directory).as_posix()
        variant["sha256"] = analyze.sha256(fbx)
        variant["lodSources"] = source_records(directory, number, folder, reference=variant, metadata=meta)
        # Retain the UV audit only while the exact source file is unchanged.
        for level, record in variant["lodSources"].items():
            audited = previous.get(name, {}).get("lodSources", {}).get(level, {})
            if all(audited.get(key) == record[key] for key in ("source", "sha256")):
                for key in ("sourceUVChannels", "geometries"):
                    if type(audited.get(key)) is int and audited[key] > 0:
                        record[key] = audited[key]
        unresolved += variant["counts"]["unattachedIslands"]
        split_variant(variant, output / asset_id, name)
        variants[name] = variant
        review_count += variant["review"]["status"] == "review"
    write_json(output / asset_id / "_layer.json", {
        "schemaVersion": 1, "assetId": asset_id, "name": asset["name"], "form": asset["form"],
        "provider": "DeepSeek Harness", "sourceKind": "original LOD0 FBX", "lodWindMode": LOD_WIND_MODE,
        "variants": variants})
    return {"variants": len(variants), "reviewVariants": review_count, "unresolvedIslands": unresolved}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library", type=Path)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    catalog = json.loads(args.catalog.read_text(encoding="utf-8-sig"))
    if len({entry["id"].lower() for entry in catalog}) != len(catalog):
        raise ValueError("Duplicate Bridge ID in catalog")
    result = {"requested": len(catalog), "completed": {}, "failed": {}}
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        pending = {pool.submit(generate, asset, args.library.resolve(), args.output): asset["id"] for asset in catalog}
        for task in as_completed(pending):
            asset_id = pending[task]
            try:
                result["completed"][asset_id] = task.result()
            except Exception as error:
                result["failed"][asset_id] = str(error)
            write_json(args.output / "manifest.json", result)
    print(f'{len(result["completed"])} assets complete, {len(result["failed"])} failed', flush=True)
    return bool(result["failed"])


if __name__ == "__main__":
    raise SystemExit(main())
