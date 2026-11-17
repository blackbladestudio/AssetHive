"""Run with Blender --background --factory-startup --python-exit-code 1 --python this_file -- output_dir [language]."""
import importlib.util
import hashlib
import json
from pathlib import Path
import sys

import bpy

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[1]
args = sys.argv[sys.argv.index("--") + 1:]
output = Path(args[0]).resolve()
language = args[1] if len(args) > 1 else "en_US"
try:
    bpy.context.preferences.view.language = language
except TypeError:
    if language != "zh_HANS":
        raise
    language = "zh_CN"
    bpy.context.preferences.view.language = language
bpy.context.preferences.view.use_translate_new_dataname = True
output.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location("assethive_test", root / "BlenderPlugin/assethive/__init__.py")
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
addon.register()
checks = []
reduction_report = []


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    checks.append(message)


def triangle_count(mesh):
    return sum(len(face.vertices) - 2 for face in mesh.polygons)


def uv_boundary_signature(mesh):
    """Compare boundary positions and UV segments independently of vertex order."""
    signature = set()
    for layer_index, layer in enumerate(mesh.uv_layers):
        edges = {}
        for face in mesh.polygons:
            loops = list(face.loop_indices)
            for i, loop_index in enumerate(loops):
                following = loops[(i + 1) % len(loops)]
                vertices = [mesh.loops[index].vertex_index for index in (loop_index, following)]
                uvs = [tuple(round(value, 6) for value in layer.data[index].uv) for index in (loop_index, following)]
                if vertices[0] > vertices[1]:
                    vertices.reverse()
                    uvs.reverse()
                edges.setdefault(tuple(vertices), []).append(tuple(uvs))
        for vertices, segments in edges.items():
            if len(segments) != 2 or segments[0] != segments[1]:
                positions = [tuple(round(value, 6) for value in mesh.vertices[index].co) for index in vertices]
                for segment in segments:
                    signature.add((layer_index, tuple(sorted(zip(positions, segment)))))
    return signature


def material_boundary_signature(mesh):
    """Compare material border positions and the material pair on each side."""
    edges = {}
    for face in mesh.polygons:
        loops = list(face.loop_indices)
        for i, loop_index in enumerate(loops):
            following = loops[(i + 1) % len(loops)]
            vertices = tuple(sorted((mesh.loops[loop_index].vertex_index, mesh.loops[following].vertex_index)))
            edges.setdefault(vertices, []).append(face.material_index)
    signature = set()
    for vertices, materials in edges.items():
        if len(set(materials)) > 1:
            positions = tuple(sorted(tuple(round(value, 6) for value in mesh.vertices[index].co) for index in vertices))
            signature.add((positions, tuple(sorted(materials))))
    return signature


image = bpy.data.images.new("Fixture alpha", width=4, height=4, alpha=True)
image.pixels = [0.5, 0.5, 1.0, 0.25] * 16
image.filepath_raw = str(output / "fixture_ALO.png")
image.file_format = "PNG"
image.save()
png = image.filepath_raw
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.object
cube.name = "SourceCube"
original_objects = set(bpy.data.objects)
source = str(output / "source.fbx")
bpy.ops.export_scene.fbx(filepath=source, use_selection=True, add_leaf_bones=False)
base = {"id": "cube", "name": "Cube", "assetType": "3d", "models": [{"file": source}], "materials": [
    {"groupId": 1, "areaIndex": 1, "normalMapFormat": "dx", "textures": [
        {"file": png, "slot": "albedo", "textureType": "AlbedoOpacityMasked"},
        {"file": png, "slot": "normal", "textureType": "Normal"}]}]}
addon.import_asset(base)
imported = set(bpy.data.objects) - original_objects
check(len(imported) == 1, "FBX imports a model into the scene")
mesh = next(iter(imported))
check(mesh.get("assethive_asset") == "cube", "Imported objects retain the library asset ID")
check(mesh.name == "Cube_cube" and mesh.data.name == "Cube_cube", "Imported object and mesh use asset name_ID")
material = mesh.material_slots[0].material
shader = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
material_output = next(node for node in material.node_tree.nodes if node.type == "OUTPUT_MATERIAL")
check(material_output.inputs["Surface"].links[0].from_node == shader, "Principled shader reaches Material Output regardless of UI language")
check(shader.inputs["Alpha"].is_linked, "Combined color/opacity connects alpha")
check(shader.inputs["Normal"].is_linked, "Normal map reaches Principled BSDF")
normal_map = next(node for node in material.node_tree.nodes if node.type == "NORMAL_MAP")
flip = normal_map.inputs["Color"].links[0].from_node
check(flip.operation == "MULTIPLY_ADD" and tuple(flip.inputs[1].default_value) == (1, -1, 1)
      and tuple(flip.inputs[2].default_value) == (0, 1, 0), "DirectX normals use (R, 1-G, B) before the Normal Map node")
normal_image = flip.inputs[0].links[0].from_node.image
check(normal_image.colorspace_settings.name == "Non-Color" and normal_map.space == "TANGENT", "Normal uses Non-Color in tangent space")
check(shader.inputs["Base Color"].links[0].from_node.image.colorspace_settings.name == "sRGB", "Basecolor uses sRGB")
check(bpy.context.view_layer.objects.active == cube and cube.select_get(), "Import restores the previous selection and active object")
surface = {"id": "surface", "name": "Surface", "assetType": "surface", "models": [], "decimationRatio": 0.1, "baseTiling": 2, "materials": [
    {"groupId": 1, "normalMapFormat": "opengl", "textures": [
        {"file": png, "slot": "albedo", "textureType": "BasecolorRoughness"},
        {"file": png, "slot": "orm", "textureType": "ORM"},
        {"file": png, "slot": "normal", "textureType": "Normal"}]}]}
addon.import_asset(surface)
surface_mesh = next(obj for obj in bpy.data.objects if obj.get("assethive_asset") == "surface")
surface_material = surface_mesh.material_slots[0].material
surface_shader = next(node for node in surface_material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
check(surface_shader.inputs["Roughness"].is_linked and surface_shader.inputs["Metallic"].is_linked, "BCR and ORM populate roughness and metallic")
check(surface_material.node_tree.nodes["AssetHive Tiling"].inputs[3].default_value == 2, "Surface base tiling reaches the shader")
check(not any(node.type == "VECT_MATH" and node.operation == "MULTIPLY_ADD" for node in surface_material.node_tree.nodes), "OpenGL normals retain the green channel")
check(not any(modifier.type == "DECIMATE" for modifier in surface_mesh.modifiers), "Surface never receives mesh reduction")
plain = {**base, "id": "plain", "materials": [{"groupId": 1, "normalMapFormat": "opengl", "textures": [
    {"file": png, "slot": "albedo", "textureType": "Basecolor"},
    {"file": png, "slot": "roughness", "textureType": "Roughness"},
    {"file": png, "slot": "normal", "textureType": "Normal"}]}]}
addon.import_asset(plain)
plain_mesh = next(obj for obj in bpy.data.objects if obj.get("assethive_asset") == "plain")
plain_material = plain_mesh.material_slots[0].material
plain_shader = next(node for node in plain_material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
check(plain_shader.inputs["Roughness"].links[0].from_node.image.colorspace_settings.name == "Non-Color", "Roughness uses Non-Color and connects to Principled Roughness")
plain_normal = plain_shader.inputs["Normal"].links[0].from_node
check(plain_normal.type == "NORMAL_MAP" and plain_normal.inputs["Color"].links[0].from_node.type == "TEX_IMAGE", "OpenGL connects directly through Normal Map without green inversion")
addon.import_asset({**plain, "id": "multiple", "models": [{"file": source}, {"file": source}]})
multiple = [obj for obj in bpy.data.objects if obj.get("assethive_asset") == "multiple"]
check({obj.name for obj in multiple} == {"Cube_multiple_01", "Cube_multiple_02"}
      and {obj.data.name for obj in multiple} == {"Cube_multiple_01", "Cube_multiple_02"}, "Multiple models retain asset name_ID with distinct numeric suffixes")
before = set(bpy.data.objects)
broken = {**base, "id": "broken", "models": [{"file": source}, {"file": str(output / "missing.fbx")}]}
try:
    addon.import_asset(broken)
    raise AssertionError("Missing model unexpectedly succeeded")
except (RuntimeError, OSError):
    pass
check(set(bpy.data.objects) == before, "Failed multi-model import rolls back only its new objects")
check(not any(collection.get("assethive_asset") == "broken" for collection in bpy.data.collections), "Failed import removes its asset collection")
bpy.ops.object.select_all(action="DESELECT")
cube.select_set(True)
bpy.context.view_layer.objects.active = cube
obj = str(output / "source.obj")
bpy.ops.wm.obj_export(filepath=obj, export_selected_objects=True)
addon.import_asset({**base, "id": "obj", "models": [{"file": obj}]})
check(any(obj.get("assethive_asset") == "obj" for obj in bpy.data.objects), "OBJ imports with the version-appropriate operator")
bpy.ops.object.select_all(action="DESELECT")
cube.select_set(True)
bpy.context.view_layer.objects.active = cube
glb = str(output / "source.glb")
bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True)
addon.import_asset({**base, "id": "glb", "models": [{"file": glb}]})
check(any(obj.get("assethive_asset") == "glb" for obj in bpy.data.objects), "glTF imports into its own collection")

# A closed mesh without UV borders can reach every requested percentage.
bpy.ops.object.select_all(action="DESELECT")
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3)
sphere = bpy.context.object
# The primitive ships with a UV layout whose seams would legitimately limit
# reduction; strip it so this fixture measures the plain ratio only.
while sphere.data.uv_layers:
    sphere.data.uv_layers.remove(sphere.data.uv_layers[0])
dense_source = str(output / "dense.fbx")
bpy.ops.export_scene.fbx(filepath=dense_source, use_selection=True, add_leaf_bones=False)
source_hash = hashlib.sha256(Path(dense_source).read_bytes()).hexdigest()
for ratio in (1, 0.75, 0.5, 0.25, 0.1):
    asset_id = f"reduced-{ratio}"
    addon.import_asset({"id": asset_id, "name": "Dense", "assetType": "3d", "decimationRatio": ratio,
                        "models": [{"file": dense_source}], "materials": []})
    obj = next(obj for obj in bpy.data.objects if obj.get("assethive_asset") == asset_id)
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    reduced = evaluated.to_mesh()
    try:
        original, actual = triangle_count(obj.data), triangle_count(reduced)
        check(abs(actual - round(original * ratio)) <= 4, f"{int(ratio * 100)}% keeps the requested triangle proportion")
        check((ratio == 1 and not obj.modifiers) or any(modifier.type == "DECIMATE" and abs(modifier.ratio - ratio) < 1e-6 for modifier in obj.modifiers),
              f"{int(ratio * 100)}% reduction is automatic and preserves the editable source mesh")
        reduction_report.append({"ratio": ratio, "original": original, "actual": actual, "uvProtected": False})
    finally:
        evaluated.to_mesh_clear()
check(hashlib.sha256(Path(dense_source).read_bytes()).hexdigest() == source_hash, "Reduction never changes the source model file")
# Add-ons used by older AssetHive builds receive no ratio at all.
addon.import_asset({"id": "no-ratio", "name": "No Ratio", "assetType": "3d",
                    "models": [{"file": dense_source}], "materials": []})
no_ratio = next(obj for obj in bpy.data.objects if obj.get("assethive_asset") == "no-ratio")
check(not any(modifier.type == "DECIMATE" for modifier in no_ratio.modifiers), "A missing ratio keeps the full-resolution import")

# Two UV layers include unmarked seams; compare the full boundary before/after.
bpy.ops.object.select_all(action="DESELECT")
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16)
uv_sphere = bpy.context.object
first_uv = uv_sphere.data.uv_layers.active
second_uv = uv_sphere.data.uv_layers.new(name="Second UV")
for face in uv_sphere.data.polygons:
    for loop_index in face.loop_indices:
        second_uv.data[loop_index].uv = first_uv.data[loop_index].uv
        if face.center.z > 0.25:
            second_uv.data[loop_index].uv.x += 0.125
uv_source = str(output / "uv-boundaries.fbx")
bpy.ops.export_scene.fbx(filepath=uv_source, use_selection=True, add_leaf_bones=False)
for ratio in (0.75, 0.5, 0.25, 0.1):
    asset_id = f"uv-protected-{ratio}"
    addon.import_asset({"id": asset_id, "name": "UV Sphere", "assetType": "3d", "decimationRatio": ratio,
                        "models": [{"file": uv_source}], "materials": []})
    obj = next(obj for obj in bpy.data.objects if obj.get("assethive_asset") == asset_id)
    before_boundary = uv_boundary_signature(obj.data)
    check(len(obj.data.uv_layers) == 2 and bool(before_boundary), "The boundary fixture retains both UV layers and seams")
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    reduced = evaluated.to_mesh()
    try:
        check(uv_boundary_signature(reduced) == before_boundary, f"{int(ratio * 100)}% preserves UV boundary positions and coordinates in every UV layer")
        check(triangle_count(reduced) < triangle_count(obj.data), f"{int(ratio * 100)}% still reduces the protected mesh interior")
        reduction_report.append({"ratio": ratio, "original": triangle_count(obj.data), "actual": triangle_count(reduced), "uvProtected": True})
    finally:
        evaluated.to_mesh_clear()

# Material borders are protected like UV seams so a two-map asset keeps its split.
bpy.ops.object.select_all(action="DESELECT")
bpy.ops.mesh.primitive_grid_add(x_subdivisions=20, y_subdivisions=20, size=4)
split_grid = bpy.context.object
split_grid.data.materials.append(bpy.data.materials.new("AssetHive Fixture A"))
split_grid.data.materials.append(bpy.data.materials.new("AssetHive Fixture B"))
for face in split_grid.data.polygons:
    face.material_index = 0 if face.center.x < 0 else 1
material_source = str(output / "material-boundaries.fbx")
bpy.ops.export_scene.fbx(filepath=material_source, use_selection=True, add_leaf_bones=False)
for ratio in (0.5, 0.25, 0.1):
    asset_id = f"material-protected-{ratio}"
    addon.import_asset({"id": asset_id, "name": "Material Split", "assetType": "3d", "decimationRatio": ratio,
                        "models": [{"file": material_source}], "materials": []})
    obj = next(obj for obj in bpy.data.objects if obj.get("assethive_asset") == asset_id)
    before_boundary = material_boundary_signature(obj.data)
    check(len(obj.data.materials) == 2 and bool(before_boundary), "The material fixture keeps two slots across one border")
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    reduced = evaluated.to_mesh()
    try:
        check(material_boundary_signature(reduced) == before_boundary,
              f"{int(ratio * 100)}% preserves material border positions and the material pair on each side")
        check(triangle_count(reduced) < triangle_count(obj.data), f"{int(ratio * 100)}% still reduces the material-protected interior")
    finally:
        evaluated.to_mesh_clear()
for kind in ("3dplant", "animation", "decal"):
    asset_id = f"unreduced-{kind}"
    addon.import_asset({"id": asset_id, "name": kind, "assetType": kind, "decimationRatio": 0.1,
                        "models": [{"file": dense_source}], "materials": []})
    obj = next(obj for obj in bpy.data.objects if obj.get("assethive_asset") == asset_id)
    check(not any(modifier.type == "DECIMATE" for modifier in obj.modifiers), f"{kind} cannot receive 3D Assets reduction")
hdr = bpy.data.images.new("HDR fixture", width=8, height=4)
hdr.pixels = [0.8, 0.6, 0.4, 1.0] * 32
hdr.filepath_raw = str(output / "environment.hdr")
hdr.file_format = "HDR"
hdr.save()
previous_world = bpy.context.scene.world
addon.import_asset({"id": "sky", "name": "Sky", "assetType": "hdri", "hdri": hdr.filepath_raw})
check(bpy.context.scene.world != previous_world, "HDRI creates and assigns an environment World")
world_nodes = bpy.context.scene.world.node_tree.nodes
environment = next(node for node in world_nodes if node.type == "TEX_ENVIRONMENT")
background = next(node for node in world_nodes if node.type == "BACKGROUND")
world_output = next(node for node in world_nodes if node.type == "OUTPUT_WORLD")
check(background.inputs["Color"].links[0].from_node == environment and world_output.inputs["Surface"].links[0].from_node == background,
      "HDRI connects environment, background and World Output regardless of UI language")
bpy.ops.wm.save_as_mainfile(filepath=str(output / "validated.blend"))
addon.unregister()
(output / "result.json").write_text(json.dumps({"ok": True, "version": bpy.app.version_string, "language": language,
    "checks": checks, "reduction": reduction_report}, indent=2), encoding="utf-8")
print("ASSETHIVE_BLENDER_TEST=" + json.dumps(checks))
