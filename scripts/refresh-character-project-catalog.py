"""Refresh only existing AssetHive catalog rows; never import or scan unrelated models."""
import json
import os
import unreal

catalog = unreal.EditorAssetLibrary.load_asset('/Game/Characters/Data/DA_ModelPolycountLevels')
if not catalog:
    raise RuntimeError('Expected existing model catalog')
report = {'models': [], 'suits': []}
for row in catalog.get_editor_property('models'):
    model = row.get_editor_property('model')
    if not model:
        raise RuntimeError('Catalog contains an unresolved model reference')
    identity = unreal.EditorAssetLibrary.get_metadata_tag(model, 'AssetHive.SuitKey')
    if not identity:
        raise RuntimeError('Model has no AssetHive receipt identity: ' + model.get_path_name())
    if not unreal.AssetHiveModelCatalogLibrary.update_model_level(model, identity):
        raise RuntimeError('Could not refresh or save catalog: ' + model.get_path_name())
for row in catalog.get_editor_property('models'):
    model = row.get_editor_property('model')
    report['models'].append({'model': model.get_path_name(), 'triangles': row.get_editor_property('triangle_count'), 'level': str(row.get_editor_property('level')), 'family': str(row.get_editor_property('family')), 'heroPart': str(row.get_editor_property('hero_part'))})
for row in catalog.get_suit_summaries():
    report['suits'].append({'name': row.get_editor_property('suit_name'), 'triangles': row.get_editor_property('triangle_count'), 'parts': len(row.get_editor_property('parts')), 'level': str(row.get_editor_property('level'))})
path = os.path.join(unreal.Paths.project_saved_dir(), 'AssetHive', 'polycount-refresh.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w', encoding='utf-8') as output:
    json.dump(report, output, ensure_ascii=False, indent=2)
unreal.log('AssetHiveCatalogRefresh:' + json.dumps(report, ensure_ascii=False))
