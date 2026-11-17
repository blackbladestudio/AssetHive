bl_info = {
    "name": "AssetHive",
    "author": "Black Blade Studio",
    "version": (1, 0, 2),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar > AssetHive",
    "description": "Receive assets, PBR materials and HDRI from AssetHive",
    "category": "Import-Export",
}

import json
import os
import queue
import socket
import threading
import traceback
from pathlib import Path

import bpy

_server = None
_port = None
_stop = threading.Event()
_queue = queue.Queue()
_jobs = {}
_lock = threading.Lock()
_token = ""
_identity = {}
_last_message = "Ready"


def _texture(material, entry, tiling):
    nodes, links = material.node_tree.nodes, material.node_tree.links
    node = nodes.new("ShaderNodeTexImage")
    node.label = entry.get("textureType") or entry.get("slot", "")
    node.image = bpy.data.images.load(entry["file"], check_existing=False)
    color_type = entry.get("textureType", "").lower()
    is_color = entry.get("slot") in {"albedo", "emissive", "subsurfacecolor"} or color_type == "basecolorroughness"
    node.image.colorspace_settings.name = "sRGB" if is_color else "Non-Color"
    if tiling != 1:
        coordinates = nodes.get("AssetHive UV")
        if coordinates is None:
            coordinates = nodes.new("ShaderNodeTexCoord")
            coordinates.name = "AssetHive UV"
            mapping = nodes.new("ShaderNodeVectorMath")
            mapping.name = "AssetHive Tiling"
            mapping.operation = "SCALE"
            mapping.inputs[3].default_value = tiling
            links.new(coordinates.outputs["UV"], mapping.inputs[0])
        links.new(nodes["AssetHive Tiling"].outputs["Vector"], node.inputs["Vector"])
    return node


def _material(asset, group):
    material = bpy.data.materials.new(f"{asset['name']}_{asset['id']}_{group.get('groupId', 1)}")
    material.use_nodes = True
    material["assethive_group"] = group.get("groupId", 1)
    material["assethive_asset"] = asset["id"]
    nodes, links = material.node_tree.nodes, material.node_tree.links
    # Default node names are translated when Blender creates new data in Chinese.
    nodes.clear()
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    signals = {}
    for entry in group.get("textures", []):
        image = _texture(material, entry, asset.get("baseTiling", 1))
        slot = entry.get("slot", "")
        kind = entry.get("textureType", "").lower()
        if kind in {"orm", "mask", "opacitymaskroughnesstranslucency"} or slot in {"orm", "mask"}:
            separate = nodes.new("ShaderNodeSeparateColor")
            separate.mode = "RGB"
            links.new(image.outputs["Color"], separate.inputs[0])
            if kind == "opacitymaskroughnesstranslucency":
                signals.setdefault("opacity", separate.outputs[0])
                signals.setdefault("roughness", separate.outputs[1])
                signals.setdefault("translucency", separate.outputs[2])
            else:
                signals.setdefault("ao", separate.outputs[0])
                signals.setdefault("roughness", separate.outputs[1])
                signals.setdefault("displacement" if slot == "mask" else "metalness", separate.outputs[2])
        else:
            signals[slot] = image.outputs["Color"]
        if kind in {"albedoopacitymasked", "diffuseopacitymasked", "basecoloropacitymasked"}:
            signals.setdefault("opacity", image.outputs["Alpha"])
        elif kind == "basecolorroughness":
            signals.setdefault("roughness", image.outputs["Alpha"])
    if "albedo" in signals and "ao" in signals:
        mix = nodes.new("ShaderNodeMixRGB")
        mix.blend_type = "MULTIPLY"
        mix.inputs[0].default_value = 1
        links.new(signals["albedo"], mix.inputs[1])
        links.new(signals["ao"], mix.inputs[2])
        signals["albedo"] = mix.outputs[0]
    if "gloss" in signals and "roughness" not in signals:
        invert = nodes.new("ShaderNodeMath")
        invert.operation = "SUBTRACT"
        invert.inputs[0].default_value = 1
        links.new(signals["gloss"], invert.inputs[1])
        signals["roughness"] = invert.outputs[0]
    inputs = {"albedo": "Base Color", "roughness": "Roughness", "metalness": "Metallic", "opacity": "Alpha",
              "emissive": "Emission Color" if bpy.app.version >= (4, 0, 0) else "Emission",
              "translucency": "Transmission Weight" if bpy.app.version >= (4, 0, 0) else "Transmission"}
    for slot, name in inputs.items():
        if slot in signals and name in shader.inputs:
            links.new(signals[slot], shader.inputs[name])
    if "emissive" in signals and "Emission Strength" in shader.inputs:
        shader.inputs["Emission Strength"].default_value = 1
    if "opacity" in signals:
        if hasattr(material, "surface_render_method"):
            material.surface_render_method = "DITHERED"
        elif hasattr(material, "blend_method"):
            material.blend_method = "HASHED"
    normal_output = None
    if "normal" in signals:
        normal = signals["normal"]
        if group.get("normalMapFormat", "dx") == "dx":
            flip = nodes.new("ShaderNodeVectorMath")
            flip.name = "AssetHive DirectX to OpenGL"
            flip.label = "DirectX → OpenGL (G = 1 - G)"
            flip.operation = "MULTIPLY_ADD"
            flip.inputs[1].default_value = (1, -1, 1)
            flip.inputs[2].default_value = (0, 1, 0)
            links.new(normal, flip.inputs[0])
            normal = flip.outputs["Vector"]
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.space = "TANGENT"
        links.new(normal, normal_map.inputs["Color"])
        normal_output = normal_map.outputs["Normal"]
    if "displacement" in signals:
        bump = nodes.new("ShaderNodeBump")
        bump.inputs["Distance"].default_value = 0.01
        links.new(signals["displacement"], bump.inputs["Height"])
        if normal_output is not None:
            links.new(normal_output, bump.inputs["Normal"])
        normal_output = bump.outputs["Normal"]
    if normal_output is not None:
        links.new(normal_output, shader.inputs["Normal"])
    return material


def _import_model(file):
    extension = Path(file).suffix.lower()
    if extension == ".fbx":
        result = bpy.ops.import_scene.fbx(filepath=file, use_anim=True)
    elif extension == ".obj":
        if bpy.app.version >= (4, 0, 0):
            result = bpy.ops.wm.obj_import(filepath=file)
        else:
            result = bpy.ops.import_scene.obj(filepath=file)
    elif extension in {".gltf", ".glb"}:
        result = bpy.ops.import_scene.gltf(filepath=file)
    elif extension == ".abc":
        result = bpy.ops.wm.alembic_import(filepath=file)
    else:
        raise ValueError(f"Unsupported Blender model format: {extension}")
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender could not import {file}")


def _assign_materials(objects, materials, groups):
    import re
    for obj in objects:
        if obj.type != "MESH" or not materials:
            continue
        if not obj.data.materials:
            obj.data.materials.append(materials[0])
            continue
        for index in range(len(obj.material_slots)):
            slot = obj.material_slots[index]
            name = slot.name.lower()
            matches = [i for i, group in enumerate(groups)
                       if re.search(rf"(?:^|[_ .-])0*{group.get('areaIndex', 1)}(?:$|[_ .-])", name)
                       and (not group.get("materialRole") or group["materialRole"] in name)]
            if not matches:
                matches = [i for i, group in enumerate(groups) if group.get("materialRole") and group["materialRole"] in name]
            chosen = matches[0] if len(matches) == 1 else min(index, len(materials) - 1)
            slot.link = "OBJECT"
            slot.material = materials[chosen]


def _uv_boundary_vertices(mesh):
    import bmesh
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        uv_layers = list(bm.loops.layers.uv.values())
        protected = set()
        for edge in bm.edges:
            boundary = edge.seam or not edge.is_manifold
            if not boundary:
                a, b = edge.link_loops
                boundary = a.face.material_index != b.face.material_index
                for layer in uv_layers:
                    other_start, other_end = (b, b.link_loop_next) if a.vert == b.vert else (b.link_loop_next, b)
                    if ((a[layer].uv - other_start[layer].uv).length_squared > 1e-12
                            or (a.link_loop_next[layer].uv - other_end[layer].uv).length_squared > 1e-12):
                        boundary = True
                        break
            if boundary:
                protected.update(vertex.index for vertex in edge.verts)
        return protected
    finally:
        bm.free()


def _decimate_meshes(objects, ratio):
    if ratio not in (1, 0.75, 0.5, 0.25, 0.1):
        raise ValueError("Unsupported AssetHive mesh reduction ratio")
    if ratio == 1:
        return
    for obj in objects:
        if obj.type != "MESH" or not obj.data.polygons:
            continue
        protected = _uv_boundary_vertices(obj.data)
        interior = [vertex.index for vertex in obj.data.vertices if vertex.index not in protected]
        if not interior:
            continue
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        group = obj.vertex_groups.new(name="AssetHive Decimation Interior")
        group.add(interior, 1.0, "REPLACE")
        modifier = obj.modifiers.new("AssetHive Decimate", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        # Blender's collapse algorithm refuses any edge touching a zero-weight
        # vertex. Unassigned seam/border vertices stay fixed, including their UVs.
        modifier.vertex_group = group.name
        modifier.vertex_group_factor = 1


def import_asset(asset):
    """Run only on Blender's main thread; roll back this asset if import fails."""
    if bpy.context.mode != "OBJECT":
        raise RuntimeError("Switch Blender to Object Mode before importing assets")
    before_objects = set(bpy.data.objects)
    before_materials = set(bpy.data.materials)
    before_images = set(bpy.data.images)
    before_meshes = set(bpy.data.meshes)
    previous_selection = list(bpy.context.selected_objects)
    previous_active = bpy.context.view_layer.objects.active
    previous_world = bpy.context.scene.world
    collection = None
    created_world = None
    try:
        if asset["assetType"] == "hdri":
            created_world = bpy.data.worlds.new(f"{asset['name']}_{asset['id']}")
            created_world.use_nodes = True
            nodes, links = created_world.node_tree.nodes, created_world.node_tree.links
            nodes.clear()
            environment = nodes.new("ShaderNodeTexEnvironment")
            background = nodes.new("ShaderNodeBackground")
            output = nodes.new("ShaderNodeOutputWorld")
            environment.image = bpy.data.images.load(asset["hdri"], check_existing=False)
            links.new(environment.outputs["Color"], background.inputs["Color"])
            links.new(background.outputs["Background"], output.inputs["Surface"])
            bpy.context.scene.world = created_world
            return
        collection = bpy.data.collections.new(f"{asset['name']}_{asset['id']}")
        collection["assethive_asset"] = asset["id"]
        bpy.context.scene.collection.children.link(collection)
        groups = asset.get("materials", [])
        materials = [_material(asset, group) for group in groups]
        for model in asset.get("models", []):
            _import_model(model["file"])
        objects = set(bpy.data.objects) - before_objects
        if not asset.get("models"):
            bpy.ops.mesh.primitive_plane_add(size=2)
            objects = {bpy.context.object}
        if not objects:
            raise RuntimeError("The model contained no importable objects")
        asset_name = f"{asset['name']}_{asset['id']}"
        for index, obj in enumerate(sorted(objects, key=lambda item: item.name)):
            object_name = asset_name if len(objects) == 1 else f"{asset_name}_{index + 1:02d}"
            obj.name = object_name
            if obj.type == "MESH":
                obj.data.name = object_name
            for owner in list(obj.users_collection):
                owner.objects.unlink(obj)
            collection.objects.link(obj)
            obj["assethive_asset"] = asset["id"]
        _assign_materials(objects, materials, groups)
        if asset["assetType"] in ("3d", "3dasset"):
            # Keep the source mesh, UVs, materials and animation editable. Blender
            # evaluates the reduction in the viewport, render and mesh export.
            _decimate_meshes(objects, asset.get("decimationRatio", 1))
    except Exception:
        for obj in set(bpy.data.objects) - before_objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        if collection is not None:
            bpy.data.collections.remove(collection)
        if created_world is not None:
            bpy.context.scene.world = previous_world
            bpy.data.worlds.remove(created_world)
        for material in set(bpy.data.materials) - before_materials:
            bpy.data.materials.remove(material, do_unlink=True)
        for mesh in set(bpy.data.meshes) - before_meshes:
            bpy.data.meshes.remove(mesh)
        for image in set(bpy.data.images) - before_images:
            if image.users == 0:
                bpy.data.images.remove(image)
        raise
    finally:
        for obj in bpy.context.selected_objects:
            obj.select_set(False)
        for obj in previous_selection:
            if obj.name in bpy.context.view_layer.objects:
                obj.select_set(True)
        if previous_active and previous_active.name in bpy.context.view_layer.objects:
            bpy.context.view_layer.objects.active = previous_active


def _pump():
    global _last_message
    if _stop.is_set():
        return None
    try:
        state = _queue.get_nowait()
    except queue.Empty:
        return 0.1
    asset = state["assets"][state["position"]]
    try:
        import_asset(asset)
        result = {"assetId": asset["id"], "status": "success", "message": "Blender import complete"}
    except Exception as error:
        traceback.print_exc()
        result = {"assetId": asset.get("id", ""), "status": "failed", "message": str(error)}
    with _lock:
        state["results"].append(result)
        state["position"] += 1
        state["percent"] = round(state["position"] / len(state["assets"]) * 100)
        _last_message = f"{asset.get('name', '')}: {result['message']}"
        if state["position"] == len(state["assets"]):
            state["done"].set()
        else:
            _queue.put(state)
    return 0.01


def _send(client, value):
    client.sendall((json.dumps(value, ensure_ascii=False) + "\n").encode("utf-8"))


def _client(client):
    try:
        client.settimeout(10)
        stream = client.makefile("rb")
        while not _stop.is_set():
            line = stream.readline(32 * 1024 * 1024 + 1)
            if not line or len(line) > 32 * 1024 * 1024:
                return
            message = json.loads(line)
            if not _token or message.get("token") != _token or message.get("protocolVersion") != 1:
                _send(client, {"type": "error", "message": "AssetHive authentication or protocol mismatch"})
                return
            if message.get("type") == "hello":
                _send(client, {"type": "hello", "protocolVersion": 1, **_identity})
                continue
            if message.get("type") != "import":
                return
            request_id = message.get("requestId")
            assets = message.get("job", {}).get("assets")
            if not isinstance(request_id, str) or not isinstance(assets, list) or not 0 < len(assets) <= 1000:
                _send(client, {"type": "error", "message": "Invalid AssetHive import job"})
                return
            with _lock:
                state = _jobs.get(request_id)
                if state is None:
                    for key in list(_jobs):
                        if len(_jobs) < 64:
                            break
                        if _jobs[key]["done"].is_set():
                            del _jobs[key]
                    if len(_jobs) >= 64:
                        _send(client, {"type": "error", "message": "Blender import queue is full"})
                        return
                    state = {"assets": assets, "results": [], "position": 0, "percent": 0, "done": threading.Event()}
                    _jobs[request_id] = state
                    _queue.put(state)
            _send(client, {"type": "accepted", "requestId": request_id})
            while not state["done"].wait(0.5):
                if _stop.is_set():
                    return
                _send(client, {"type": "progress", "percent": state["percent"], "message": "Blender importing assets"})
            _send(client, {"type": "complete", "requestId": request_id, "results": state["results"]})
            return
    except (OSError, ValueError, TypeError):
        pass
    finally:
        client.close()


def _listen(server, stop):
    while not stop.is_set():
        try:
            client, _ = server.accept()
            threading.Thread(target=_client, args=(client,), daemon=True).start()
        except socket.timeout:
            continue
        except OSError:
            return


class ASSETHIVE_PT_bridge(bpy.types.Panel):
    bl_label = "AssetHive"
    bl_idname = "ASSETHIVE_PT_bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "AssetHive"

    def draw(self, context):
        self.layout.label(text=f"Ready on port {_port}" if _port else "Bridge unavailable", icon="LINKED" if _port else "ERROR")
        self.layout.label(text="Export assets from the AssetHive app.")
        self.layout.label(text=_last_message[:90])


def _start_bridge():
    global _server, _port, _token, _identity, _last_message, _stop
    if _server is not None:
        return
    try:
        _token = json.loads((Path(__file__).parent / "bridge.json").read_text(encoding="utf-8"))["token"]
        _identity = {"version": bpy.app.version_string, "executable": bpy.app.binary_path,
                     "capabilities": ["meshDecimation"]}
        _stop = threading.Event()
        for port in range(13450, 13460):
            candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                candidate.bind(("127.0.0.1", port))
                candidate.listen(8)
                candidate.settimeout(0.5)
                _server, _port = candidate, port
                break
            except OSError:
                candidate.close()
        if _server is None:
            raise RuntimeError("AssetHive ports 13450-13459 are occupied")
        threading.Thread(target=_listen, args=(_server, _stop), daemon=True).start()
        bpy.app.timers.register(_pump, first_interval=0.1, persistent=True)
    except Exception as error:
        _last_message = str(error)


def register():
    bpy.utils.register_class(ASSETHIVE_PT_bridge)
    if not bpy.app.background:
        _start_bridge()


def unregister():
    global _server, _port
    _stop.set()
    if _server:
        _server.close()
    _server, _port = None, None
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)
    while not _queue.empty():
        try:
            _queue.get_nowait()
        except queue.Empty:
            break
    _jobs.clear()
    bpy.utils.unregister_class(ASSETHIVE_PT_bridge)
