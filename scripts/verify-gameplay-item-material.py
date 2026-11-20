"""Verify real Item master, texture policy, mesh binding and legacy upgrades in isolation."""
import copy
import json
import os
import runpy
import uuid
import unreal

if '/.tmp/character-upgrade-acceptance/' not in unreal.Paths.project_dir().replace('\\', '/').lower():
    raise RuntimeError('Requires isolated acceptance project')
api = runpy.run_path(os.path.join(unreal.Paths.project_plugins_dir(), 'AssetHive/Content/Python/assethive_suit_import.py'))
with open('C:/assetHive/Assethive_Sourcecode/.tmp/item-material-template.json', encoding='utf-8') as source:
    template = json.load(source)
mel = unreal.MaterialEditingLibrary
eal = unreal.EditorAssetLibrary
report = {'cases': []}

def sample():
    token = uuid.uuid4().hex[:8]
    root = template['targetRoot'] + '_' + token
    owner = 'item_material_' + token
    def remap(value):
        if isinstance(value, str):
            return value.replace(template['targetRoot'], root) if value.startswith(template['targetRoot']) else value.replace(template['assetId'] + ':', owner + ':', 1) if value.startswith(template['assetId'] + ':') else value
        if isinstance(value, list):
            return [remap(v) for v in value]
        if isinstance(value, dict):
            return {k: remap(v) for k, v in value.items()}
        return value
    suit = remap(template)
    suit['assetId'] = owner
    for entry in suit['entries']:
        entry['name'] += '_' + token
        entry['targetPath'] = entry['targetPath'].rsplit('/', 1)[0] + '/' + entry['name']
        if entry['kind'] == 'skeletalMesh':
            entry['targetBones'] = copy.deepcopy(entry['bones'])
    return suit

def run(suit, label, decision=None):
    job = {'version': 1, 'suits': [suit]}
    checked = api['inspect'](job)
    conflicts = [r for r in checked['entries'] if r['status'] == 'conflict']
    assert all(r['status'] in ('ready', 'unchanged', 'conflict') for r in checked['entries']), checked
    if conflicts:
        assert decision
        job['decisions'] = {r['key']: decision for r in conflicts}
    job['inspectToken'] = checked['inspectToken']
    result = api['apply_job'](job)
    assert all(r['status'] in ('success', 'unchanged') for r in result['entries']), result
    report['cases'].append({'name': label, 'timings': result['timings'], 'conflicts': len(conflicts)})
    return result

def objects(suit):
    material = next(e for e in suit['entries'] if e['kind'] == 'material')
    mesh = next(e for e in suit['entries'] if e['kind'] == 'skeletalMesh')
    return api['load'](material['targetPath']), api['load'](mesh['targetPath']), material

def verify(suit):
    instance, mesh, entry = objects(suit)
    assert instance.get_editor_property('parent').get_path_name().split('.')[0] == api['ITEM_TEMPLATE']
    assert all(slot.material_interface == instance for slot in mesh.get_editor_property('materials'))
    channels = api['material_parameters'](instance, entry)
    for texture_entry in (e for e in suit['entries'] if e['kind'] == 'texture'):
        channel = texture_entry['channel']
        texture = api['load'](texture_entry['targetPath'])
        assert mel.get_material_instance_texture_parameter_value(instance, channels[channel]) == texture
        assert texture.get_editor_property('virtual_texture_streaming')
        assert texture.get_editor_property('max_texture_size') == 2048
        assert texture.get_editor_property('srgb') == (channel in ('D', 'E'))
        assert texture.get_editor_property('lod_group') == (unreal.TextureGroup.TEXTUREGROUP_WORLD_NORMAL_MAP if channel == 'N' else unreal.TextureGroup.TEXTUREGROUP_WORLD)
    return instance

fresh = sample()
run(fresh, 'new-item')
instance = verify(fresh)
assert mel.get_material_instance_static_switch_parameter_value(instance, 'UseEmissive')
mel.set_material_instance_static_switch_parameter_value(instance, 'UseEmissive', False)
mel.set_material_instance_scalar_parameter_value(instance, 'Diffuse_Brightness', 1.125)
eal.save_loaded_asset(instance)
repeat = run(fresh, 'unchanged-preserves-manual-values')
assert repeat['timings']['importMs'] == 0 and repeat['timings']['saveMs'] == 0
assert not mel.get_material_instance_static_switch_parameter_value(instance, 'UseEmissive')
assert abs(mel.get_material_instance_scalar_parameter_value(instance, 'Diffuse_Brightness') - 1.125) < 0.001
bad = copy.deepcopy(next(e for e in fresh['entries'] if e['kind'] == 'material'))
bad['textures']['A'] = bad['textures']['D']
try:
    api['item_parent'](bad)
    raise AssertionError('Unsupported opacity must be rejected')
except RuntimeError as error:
    assert '不支持' in str(error)

for choice in (None, 'keepUE', 'applyMapping'):
    modern = sample()
    legacy = copy.deepcopy(modern)
    legacy['entries'] = [e for e in legacy['entries'] if e['kind'] != 'material']
    for entry in legacy['entries']:
        entry['config'].pop('itemMaterialVersion', None)
        if entry['kind'] == 'skeletalMesh':
            entry['config']['deferMaterials'] = True
            entry['materials'] = {}
        entry['fingerprint'] = 'legacy_' + entry['fingerprint']
    run(legacy, 'legacy-' + str(choice))
    mesh_entry = next(e for e in modern['entries'] if e['kind'] == 'skeletalMesh')
    mesh = api['load'](mesh_entry['targetPath'])
    custom = eal.load_asset('/Engine/BasicShapes/BasicShapeMaterial')
    if choice:
        assert custom
        slots = mesh.get_editor_property('materials')
        for index, slot in enumerate(slots):
            slot.material_interface = custom
            slots[index] = slot
        mesh.set_editor_property('materials', slots)
        eal.save_loaded_asset(mesh)
    run(modern, 'upgrade-' + str(choice), choice)
    if choice == 'keepUE':
        assert all(slot.material_interface == custom for slot in mesh.get_editor_property('materials'))
    else:
        verify(modern)

report['ok'] = True
with open(os.path.join(unreal.Paths.project_saved_dir(), 'item-material-verification.json'), 'w', encoding='utf-8') as output:
    json.dump(report, output, ensure_ascii=False, indent=2)
unreal.log('AssetHiveItemMaterialVerification: success')
