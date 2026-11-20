"""Synthetic art test assets, generated offline with Blender; no production data."""
import bpy
from pathlib import Path

root = Path('C:/assetHive/Assethive_Sourcecode/.tmp/paired-weapon-fixtures')
cases = [
    ('DualHands981_TwinAxes_同类双持测试', [('L_左斧', 'axe'), ('R_RightAxe', 'axe')]),
    ('PairedSwords982_CanCiJian_参差剑测试', [('L', 'sword'), ('R', 'shortsword')]),
    ('DualHands983_SharedAxe_同模型复用测试', [('', 'axe')]),
]
for folder, parts in cases:
    identity = '_'.join(folder.split('_')[:2])
    dest = root / folder
    dest.mkdir(parents=True, exist_ok=True)
    textures = dest / 'Texture'
    textures.mkdir(exist_ok=True)
    for channel, color in [('D', (.35, .55, .8, 1)), ('N', (.5, .5, 1, 1)), ('ORM', (1, .6, .15, 1))]:
        image = bpy.data.images.new(identity + channel, width=64, height=64)
        image.generated_color = color
        image.filepath_raw = str(textures / ('T_' + identity + '_' + channel + '.tga'))
        image.file_format = 'TARGA'
        image.save()
    for suffix, shape in parts:
        bpy.ops.object.select_all(action='SELECT')
        bpy.ops.object.delete(use_global=False)
        pieces = []
        def box(name, loc, scale):
            bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
            obj = bpy.context.object
            obj.name = name
            obj.scale = scale
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            pieces.append(obj)
        box('Handle', (0, 0, 35), (5, 5, 70))
        if shape == 'axe':
            box('AxeHead', (8, 0, 65), (24 if suffix.startswith('R') else 32, 7, 30 if suffix.startswith('R') else 22))
        elif shape == 'hammer':
            box('HammerHead', (0, 0, 68), (40, 16, 18))
        else:
            box('Blade', (0, 0, 65 if shape == 'shortsword' else 85), (9, 3, 35 if shape == 'shortsword' else 75))
            box('Guard', (0, 0, 46), (26, 6, 5))
        bpy.ops.object.select_all(action='DESELECT')
        for obj in pieces: obj.select_set(True)
        bpy.context.view_layer.objects.active = pieces[0]
        bpy.ops.object.join()
        mesh = bpy.context.object
        name = identity + ('_' + suffix if suffix else '')
        if identity.startswith('PairedSwords') and suffix in ('L', 'R'):
            category, english = identity.split('_', 1)
            name = category + '_' + suffix
        mesh.name = name
        material = bpy.data.materials.new('MI_' + identity)
        mesh.data.materials.clear()
        mesh.data.materials.append(material)
        bpy.context.scene.unit_settings.system = 'METRIC'
        bpy.context.scene.unit_settings.scale_length = .01
        bpy.ops.export_scene.fbx(filepath=str(dest / ('SM_' + name + '.fbx')), use_selection=True, add_leaf_bones=False, bake_anim=False)
        bpy.ops.object.armature_add()
        rig = bpy.context.object
        rig.name = 'Rig_' + name
        bone = rig.data.bones[0].name
        group = mesh.vertex_groups.new(name=bone)
        group.add(list(range(len(mesh.data.vertices))), 1, 'REPLACE')
        modifier = mesh.modifiers.new('Armature', 'ARMATURE')
        modifier.object = rig
        mesh.parent = rig
        bpy.ops.object.select_all(action='DESELECT')
        mesh.select_set(True)
        rig.select_set(True)
        bpy.context.view_layer.objects.active = rig
        bpy.ops.export_scene.fbx(filepath=str(dest / ('SK_' + name + '.fbx')), use_selection=True, add_leaf_bones=False, bake_anim=False)
print('PAIRED_WEAPON_FIXTURES_READY', root)
