"""Isolated headless bridge fixture; sends real TCP receipts while imports run on the main thread."""
import importlib.util
import json
from pathlib import Path
import sys
import time

import bpy

sys.dont_write_bytecode = True
args = sys.argv[sys.argv.index("--") + 1:]
addon_path, output = Path(args[0]), Path(args[1])
language = args[2] if len(args) > 2 else "en_US"
try:
    bpy.context.preferences.view.language = language
except TypeError:
    if language != "zh_HANS":
        raise
    language = "zh_CN"
    bpy.context.preferences.view.language = language
bpy.context.preferences.view.use_translate_new_dataname = True
spec = importlib.util.spec_from_file_location("assethive_live_test", addon_path / "__init__.py")
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
addon.register()
addon._start_bridge()
assert addon._port, addon._last_message
output.mkdir(parents=True, exist_ok=True)
(output / "ready.json").write_text(json.dumps({"port": addon._port}), encoding="utf-8")
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    addon._pump()
    if addon._jobs and all(state["done"].is_set() for state in addon._jobs.values()):
        time.sleep(1)
        (output / "receipt.json").write_text(json.dumps([state["results"] for state in addon._jobs.values()]), encoding="utf-8")
        scene = []
        for material in bpy.data.materials:
            if not material.get("assethive_asset"):
                continue
            nodes = material.node_tree.nodes
            shader = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
            normal = shader.inputs["Normal"].links[0].from_node if shader.inputs["Normal"].is_linked else None
            normal_source = normal.inputs["Color"].links[0].from_node if normal and normal.type == "NORMAL_MAP" else None
            scene.append({"assetId": material["assethive_asset"],
                "textures": [{"type": node.label, "file": node.image.filepath,
                    "colorSpace": node.image.colorspace_settings.name, "readable": len(node.image.pixels) > 0}
                    for node in nodes if node.type == "TEX_IMAGE"],
                "linkedInputs": [socket.name for socket in shader.inputs if socket.is_linked],
                "normalSpace": normal.space if normal and normal.type == "NORMAL_MAP" else None,
                "greenFlipped": bool(normal_source and normal_source.type == "VECT_MATH"
                    and normal_source.operation == "MULTIPLY_ADD"
                    and tuple(normal_source.inputs[1].default_value) == (1, -1, 1)
                    and tuple(normal_source.inputs[2].default_value) == (0, 1, 0))})
        (output / "scene-report.json").write_text(json.dumps({"version":bpy.app.version_string,"language":language,
            "materials":scene,"objects":[{"assetId":obj.get("assethive_asset"),"type":obj.type,"name":obj.name,
                "dataName":obj.data.name if obj.data else None}
                for obj in bpy.data.objects if obj.get("assethive_asset")]},indent=2),encoding="utf-8")
        bpy.ops.wm.save_as_mainfile(filepath=str(output / "tcp-import.blend"))
        break
    time.sleep(0.05)
else:
    raise RuntimeError("No complete import received by Blender")
addon.unregister()
