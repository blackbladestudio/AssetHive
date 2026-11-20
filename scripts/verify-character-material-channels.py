"""Read back real master parameters and transient MI bindings; save no test assets."""
import json, runpy, unreal
api = runpy.run_path('C:/Users/wangyi.ewang/AssetHivePlugin/AssetHive/Content/Python/assethive_suit_import.py')
mel = unreal.MaterialEditingLibrary
root = '/Game/MaterialLibrary/Character/Common/'
opaque = unreal.load_asset(root + 'M_GamePlayItem_Base_VT')
masked = unreal.load_asset(root + 'M_GamePlayItem_Base_Masked_VT')
face = unreal.load_asset(root + 'M_Char_Face')
assert opaque.get_editor_property('blend_mode') == unreal.BlendMode.BLEND_OPAQUE
assert masked.get_editor_property('blend_mode') == unreal.BlendMode.BLEND_MASKED
report = []
for parent, channel, role, expected in [(masked, 'A', 'gameplayItem', 'OpacityMasked_VT'), (face, 'Scatter', 'hero_face', 'SSS_VT')]:
    entry = {'config': {'family': 'item' if channel == 'A' else 'suit', 'materialRole': role, 'parentPath': parent.get_path_name().split('.')[0], 'virtualTexture': True}, 'textures': {channel: 'fixture'}}
    mapping = api['material_parameters'](parent, entry)
    assert mapping[channel] == expected
    if channel == 'A': api['item_parent'](entry)
    instance = unreal.new_object(unreal.MaterialInstanceConstant)
    mel.set_material_instance_parent(instance, parent)
    texture = mel.get_material_default_texture_parameter_value(parent, expected)
    assert texture
    mel.set_material_instance_texture_parameter_value(instance, expected, texture)
    assert any(str(value.parameter_info.name) == expected and value.parameter_value == texture for value in instance.get_editor_property('texture_parameter_values'))
    assert mel.get_material_instance_texture_parameter_value(instance, expected) == texture
    report.append({'channel': channel, 'parent': parent.get_path_name(), 'parameter': expected, 'bindingReadback': True})
with open('C:/assetHive/Assethive_Sourcecode/.tmp/verified-character-material-channels.json', 'w') as output:
    json.dump(report, output, indent=2)
unreal.log('AssetHive character channels verified: ' + json.dumps(report))
