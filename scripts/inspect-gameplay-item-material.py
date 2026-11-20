"""Read the approved Item master without editing or saving project assets."""
import json
import unreal

path = '/Game/MaterialLibrary/Character/Common/M_GamePlayItem_Base_VT'
material = unreal.EditorAssetLibrary.load_asset(path)
if not isinstance(material, unreal.Material):
    raise RuntimeError('Gameplay Item master material not found')
mel = unreal.MaterialEditingLibrary
result = {'path': path, 'textures': {}, 'switches': {}, 'scalars': {}, 'samplers': [], 'blendMode': str(material.get_editor_property('blend_mode'))}
for name in mel.get_texture_parameter_names(material):
    texture = mel.get_material_default_texture_parameter_value(material, name)
    result['textures'][str(name)] = texture.get_path_name() if texture else None
for name in mel.get_static_switch_parameter_names(material):
    result['switches'][str(name)] = mel.get_material_default_static_switch_parameter_value(material, name)
for name in mel.get_scalar_parameter_names(material):
    result['scalars'][str(name)] = mel.get_material_default_scalar_parameter_value(material, name)
seen = set()
def visit(expressions):
    for expr in expressions:
        if expr.get_path_name() in seen:
            continue
        seen.add(expr.get_path_name())
        if isinstance(expr, unreal.MaterialExpressionTextureSampleParameter):
            result['samplers'].append({'parameter': str(expr.get_editor_property('parameter_name')), 'sampler': str(expr.get_editor_property('sampler_type')), 'class': expr.get_class().get_name()})
        if isinstance(expr, unreal.MaterialExpressionMaterialFunctionCall):
            function = expr.get_editor_property('material_function')
            if function:
                visit(mel.get_material_function_expressions(function))
visit(mel.get_material_expressions(material))
registry = unreal.AssetRegistryHelpers.get_asset_registry()
options = unreal.AssetRegistryDependencyOptions(include_soft_package_references=True, include_hard_package_references=True)
pending = [path]
packages = set()
while pending:
    package = pending.pop()
    if package in packages or not package.startswith('/Game/'):
        continue
    packages.add(package)
    pending.extend(str(value) for value in registry.get_dependencies(package, options))
result['dependencies'] = sorted(packages)
with open('C:/assetHive/Assethive_Sourcecode/.tmp/gameplay-item-material.json', 'w', encoding='utf-8') as output:
    json.dump(result, output, ensure_ascii=False, indent=2)
unreal.log('AssetHiveItemMaterialInspection:' + json.dumps(result))
