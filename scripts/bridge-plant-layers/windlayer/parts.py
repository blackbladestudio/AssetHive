"""Bound memory use for large Bridge plants while preserving a single asset entry point."""
import hashlib
import json
import os
import re
from pathlib import Path

ROWS_PER_CHUNK = 8192


def split_variant(variant, directory, name, limit=ROWS_PER_CHUNK):
    rows = variant["bindings"]
    if len(rows) <= limit:
        return
    parts = directory / "_layer_data"
    parts.mkdir(parents=True, exist_ok=True)
    names = []
    secondary = terminal = False
    for start in range(0, len(rows), limit):
        batch = []
        for row in rows[start:start + limit]:
            active = row.get("influence", True) and not row.get("review", False)
            if active:
                secondary |= row["secondary"] >= 0
                terminal |= row["terminal"]
                fields = ("island", "boundsCenter", "primary", "secondary", "primaryAttachment",
                          "secondaryAttachment", "blade", "terminal", "layers", "attachMethod", "rootContact")
            else:
                fields = ("island", "boundsCenter", "influence", "review", "terminal", "layers", "attachMethod")
            batch.append({key: row[key] for key in fields if key in row})
        data = json.dumps(batch, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
        digest = hashlib.sha256(data).hexdigest()
        filename = f"{name}_{start // limit:04d}_{digest}.json"
        target = parts / filename
        if not target.exists():
            tmp = target.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_bytes(data)
            tmp.replace(target)
        names.append(filename)
    variant.update(bindingCount=len(rows), bindingChunks=names, hasSecondary=bool(secondary), hasTerminal=bool(terminal))
    del variant["bindings"]


def chunk_files(directory, variant):
    for name in variant.get("bindingChunks", []):
        if not re.fullmatch(r"Var\d+_\d+_[a-f0-9]{64}\.json", name):
            raise ValueError(f"Invalid binding chunk {name}")
        yield directory / "_layer_data" / name
