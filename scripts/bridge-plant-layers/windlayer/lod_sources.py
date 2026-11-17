"""Fingerprint source LODs that reuse one variant's verified LOD0 wind field."""
import re

from .validation import digest

LOD_WIND_MODE = "lod0-uv0-surface"


def original_lods(folder, number):
    result = {}
    for file in folder.glob('*.fbx'):
        match = re.fullmatch(r'Var(\d+)_LOD(\d+)', file.stem, re.I)
        if not match or int(match[1]) != number:
            continue
        level = int(match[2])
        if level in result:
            raise ValueError(f'Duplicate original LOD{level} in {folder}')
        result[level] = file
    return dict(sorted(result.items()))


def billboard_levels(directory, number, reference=None, metadata=None, variant_folder=None):
    files = original_lods(variant_folder or directory / f'Var{number}', number)
    if not files or max(files) == 0:
        return {}
    level = max(files)
    metadata = metadata or {}
    declared = []
    for model in metadata.get('models', []):
        match = re.search(r'(?:^|[/\\])Var(\d+)_LOD(\d+)\.fbx$', str(model.get('uri', '')), re.I)
        if match and int(match[1]) == number:
            declared.append(int(match[2]))
    uses_billboard = any(item.get('key') == 'useBillboardMaterial' and item.get('value') is True
                         for item in metadata.get('meta', []))
    if uses_billboard and metadata.get('billboards') and declared and level == max(declared):
        return {level: 'bridge-billboard-material-on-final-lod'}
    if reference is None or not metadata.get('billboards'):
        return {}
    # Some old packages omit the Billboard material flag. Confirm the terminal
    # whole-plant proxy geometrically before assigning its Billboard material.
    import numpy as np
    from . import fbxread
    scene = fbxread.load(files[level])
    if not scene.meshes or sum(len(mesh['tris']) for mesh in scene.meshes) > 64:
        return {}
    points = np.vstack([mesh['verts'] for mesh in scene.meshes])
    span = np.ptp(points, axis=0)
    original = np.asarray(reference['frame']['sizeCm'])
    diagonal = float(np.linalg.norm(original))
    multiple = reference['counts']['primaryAxes'] > 1 or reference['counts']['secondaryAxes'] > 0
    singular = np.linalg.svd(points-points.mean(0), compute_uv=False)
    flat = singular[-1] <= max(1e-4, singular[0]*1e-4)
    if flat and not multiple and reference['counts']['foliageIslands'] > 1:
        from .validation import parse
        batches = ([reference['bindings']] if 'bindings' in reference else
                   (parse((directory/'_layer_data'/name).read_bytes()) for name in reference.get('bindingChunks', [])))
        blades = set()
        for batch in batches:
            for row in batch:
                if row['terminal']:
                    blades.add(tuple(map(tuple, row['blade'])))
                    if len(blades)>1:
                        multiple=True
                        break
            if multiple:
                break
    if (multiple and flat and np.min(original) > max(1e-4, .001*diagonal) and
            np.count_nonzero(span >= .5*original) >= 2):
        return {level: 'terminal-whole-plant-planar-proxy'}
    return {}


def source_records(directory, number, variant_folder=None, *, reference=None, metadata=None):
    billboards = billboard_levels(directory, number, reference, metadata, variant_folder)
    return {f'LOD{level}': dict(source=file.relative_to(directory).as_posix(), sha256=digest(file),
                               **({'representation': 'billboard', 'layers': ['Shared'], 'billboardEvidence': billboards[level]}
                                  if level in billboards else {}),
                               windSource='LOD0')
            for level, file in original_lods(variant_folder or directory / f'Var{number}', number).items() if level > 0}
