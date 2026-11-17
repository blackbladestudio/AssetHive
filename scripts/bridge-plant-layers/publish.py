"""Publish staged hierarchy files after checking coverage, IDs and FBX fingerprints."""
import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path

from windlayer.validation import digest as file_hash, parse, validate_asset


def read(path):
    return parse(path.read_bytes())


def atomic_copy(source, target):
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".", delete=False) as tmp:
        temporary = Path(tmp.name)
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def publish(library, catalog, outputs):
    sources = {}
    for output in outputs:
        manifest = read(output / "manifest.json")
        for asset_id in manifest["completed"]:
            sources[asset_id] = output / asset_id / "_layer.json"
    if set(sources) != {asset["id"] for asset in catalog}:
        raise ValueError("Staged assets differ from the Bridge catalog")
    index = {}
    chunk_copies = {}
    variants = 0
    for asset in catalog:
        asset_id = asset["id"]
        folder = (library / asset["dir"]).resolve()
        doc = read(sources[asset_id])
        if folder.parent != library:
            raise ValueError(f"Wrong directory for {asset_id}")
        for part in validate_asset(doc, asset, folder, sources[asset_id].parent):
            chunk_copies[folder / "_layer_data" / part.name] = part
        variants += len(doc["variants"])
        destination = folder / "_layer.json"
        if destination.exists() and file_hash(sources[asset_id]) != file_hash(destination):
            previous = read(destination)
            if previous.get("provider") != "DeepSeek Harness" or previous.get("assetId") != asset_id:
                raise ValueError(f"Existing hierarchy has different ownership: {destination}")
        index[asset_id.lower()] = str(destination)
        del doc
    for target, source in chunk_copies.items():
        target.parent.mkdir(parents=True, exist_ok=True)
        digest = target.stem.rsplit("_", 1)[-1]
        if not target.exists() or file_hash(target) != digest:
            atomic_copy(source, target)
        if file_hash(target) != digest:
            raise IOError(f"Binding chunk verification failed: {target}")
    for asset_id, source in sources.items():
        target = Path(index[asset_id.lower()])
        if not target.exists() or file_hash(target) != file_hash(source):
            atomic_copy(source, target)
        if file_hash(target) != file_hash(source):
            raise IOError(f"Sidecar verification failed: {target}")
    # Managed ThirdParty assets can have UUID folders and renamed FBXs.
    cache = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "AssetHive/plant-wind-layers"
    cache.mkdir(parents=True, exist_ok=True)
    index_path = cache / "index.json"
    existing = read(index_path).get("assets", {}) if index_path.exists() else {}
    existing.update(index)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=cache, delete=False) as tmp:
        json.dump({"schemaVersion": 1, "assets": existing}, tmp, ensure_ascii=False)
    os.replace(tmp.name, index_path)
    return {"assets": len(index), "variants": variants, "index": str(index_path)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library", type=Path)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("staged", type=Path, nargs="*")
    parser.add_argument("--check-library", action="store_true", help="validate installed sidecars and exit without publishing")
    args = parser.parse_args()
    library, catalog = args.library.resolve(), read(args.catalog)
    if args.check_library:
        if args.staged:
            parser.error("--check-library reads the installed library, not staged data")
        variants = chunks = 0
        for asset in catalog:
            folder = (library / asset["dir"]).resolve()
            if folder.parent != library:
                raise ValueError(f"Wrong directory for {asset['id']}")
            doc = read(folder / "_layer.json")
            chunks += len(validate_asset(doc, asset, folder, folder))
            variants += len(doc["variants"])
        print(json.dumps(dict(assets=len(catalog), variants=variants, chunks=chunks)))
    elif args.staged:
        print(json.dumps(publish(library, catalog, args.staged)))
    else:
        parser.error("supply staged results or --check-library")
