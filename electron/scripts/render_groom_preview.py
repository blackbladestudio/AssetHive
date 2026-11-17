"""Read-only Alembic hair preview, run by a background Blender process."""
import bpy
import json
import math
from pathlib import Path
import sys
from mathutils import Vector, Matrix

source, output = sys.argv[sys.argv.index('--') + 1:]
output = Path(output).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.alembic_import(filepath=source, as_background_job=False)
# The supported XGen Groom cache uses -Y up; Blender renders Z-up.
for obj in bpy.context.scene.objects:
    if obj.parent is None:
        obj.matrix_world = Matrix.Rotation(-math.pi / 2, 4, 'X') @ obj.matrix_world
bpy.context.view_layer.update()
objects = [obj for obj in bpy.context.scene.objects if obj.type in ('CURVES', 'CURVE')]
if not objects:
    raise RuntimeError('ABC contains no hair curves')
points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
center = (low + high) / 2
span = max(high - low)
if not math.isfinite(span) or span <= 0:
    raise RuntimeError('Invalid hair bounds')
material = bpy.data.materials.new('GroomPreviewNeutral')
material.diffuse_color = (.16, .13, .11, 1)
material.use_nodes = True
shader = material.node_tree.nodes.get('Principled BSDF')
shader.inputs['Base Color'].default_value = (.16, .13, .11, 1)
shader.inputs['Roughness'].default_value = .55
for obj in objects:
    obj.data.materials.clear()
    obj.data.materials.append(material)
    if obj.type == 'CURVES' and not obj.data.attributes.get('radius'):
        radius = obj.data.attributes.new('radius', 'FLOAT', 'POINT')
        radius.data.foreach_set('value', [span * .0003] * len(radius.data))
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.cycles.use_denoising = True
scene.render.resolution_x = scene.render.resolution_y = 768
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.world = bpy.data.worlds.new('PreviewWorld')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.12, .14, .18, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .7
for name, direction, energy in [('Key', (1,-2,3), 500), ('Fill',(-2,-1,1),250), ('Rim',(1,2,2),700)]:
    lamp = bpy.data.lights.new(name, 'AREA')
    lamp.energy = energy * (span / 2) ** 2
    lamp.shape = 'DISK'
    lamp.size = span * 1.4
    obj = bpy.data.objects.new(name, lamp)
    scene.collection.objects.link(obj)
    obj.location = center + Vector(direction).normalized() * span * 2
    obj.rotation_euler = (center - obj.location).to_track_quat('-Z','Y').to_euler()
camera = bpy.data.objects.new('PreviewCamera', bpy.data.cameras.new('PreviewCamera'))
scene.collection.objects.link(camera)
scene.camera = camera
camera.data.type = 'ORTHO'
camera.data.ortho_scale = span * 1.18
camera.data.clip_end = span * 20
for view, direction in [('front',(0,-1,0)),('left',(-1,0,0)),('right',(1,0,0)),('back',(0,1,0))]:
    camera.location = center + Vector(direction) * span * 3
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath = str(output / (view + '.png'))
    bpy.ops.render.render(write_still=True)
print('ASSETHIVE_GROOM_PREVIEW=' + json.dumps({'objects':len(objects),'views':4}))
