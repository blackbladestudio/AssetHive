"""Skeletal-only catalog acceptance in the isolated project."""
import json
import os
import uuid
import unreal
project = unreal.Paths.project_dir().replace('\\', '/').lower()
if '/.tmp/character-upgrade-acceptance/' not in project:
    raise RuntimeError('Requires isolated acceptance project')
library = unreal.EditorAssetLibrary
api = unreal.AssetHiveModelCatalogLibrary
run_id = uuid.uuid4().hex[:8]
catalog = library.load_asset('/Game/Characters/Data/DA_ModelPolycountLevels')
before = len(catalog.get_editor_property('models'))
assert not api.update_model_level(library.load_asset('/Engine/BasicShapes/Cube'), 'acceptance:staticMesh:' + run_id)
assert len(catalog.get_editor_property('models')) == before
with open(os.path.join(unreal.Paths.project_saved_dir(), 'skeleton-verification.json')) as source:
    source_model = json.load(source)['model']
original = '/Game/Acceptance/SK_Polycount_' + run_id
renamed = '/Game/Acceptance/Renamed/SK_Polycount_' + run_id
model = library.duplicate_asset(source_model, original)
identity = 'acceptance:skeletalMesh:' + run_id
assert api.update_model_level(model, identity)
assert library.rename_asset(original, renamed)
model = library.load_asset(renamed)
assert api.update_model_level(model, identity)
rows = catalog.get_editor_property('models')
assert len(rows) == before + 1, 'Rename must update the same entry'
actual_count = rows[-1].get_editor_property('triangle_count')
assert actual_count > 0
assert len(catalog.get_models_by_family()) == len(rows), 'All catalog rows must pass the skeletal-only filter'
assert isinstance(rows[-1].get_editor_property('model'), unreal.SkeletalMesh)
suit_id = 'legacy_suit_' + run_id
for part in ('head', 'upbody', 'downbody', 'arm'):
    target = f'/Game/Acceptance/{suit_id}/Mesh/SkeletalMesh/SK_{part}'
    piece = library.duplicate_asset(source_model, target)
    key = f'{suit_id}:skeletalMesh:{part}'
    library.set_metadata_tag(piece, 'AssetHive.SuitReceipt', json.dumps({'key': key, 'targetPath': target, 'config': {'family': 'suit'}}))
    assert library.save_loaded_asset(piece)
    assert api.update_model_level(piece, key)
summary = next(row for row in catalog.get_suit_summaries() if row.get_editor_property('suit_id') == suit_id)
assert summary.get_editor_property('triangle_count') == actual_count * 4
assert len(summary.get_editor_property('parts')) == 4
assert api.update_model_level(piece, key, suit_id, 'ExplicitSuitName', 'arm')
family_results = {}
for family, hero_part in [('suit', 'Face'), ('suit', 'Hair'), ('monster', ''), ('npc', ''), ('weapon', ''), ('item', '')]:
    kind_name = hero_part or family
    count_before = len(catalog.get_models_by_family(family))
    target = f'/Game/Acceptance/Family_{run_id}/SK_{kind_name}'
    piece = library.duplicate_asset(source_model, target)
    key = f'{run_id}_{kind_name}:skeletalMesh:head'
    library.set_metadata_tag(piece, 'AssetHive.SuitReceipt', json.dumps({'key': key, 'targetPath': target, 'config': {'family': family, 'heroPart': hero_part}}))
    assert library.save_loaded_asset(piece)
    assert api.update_model_level(piece, key)
    filtered = catalog.get_models_by_family(family)
    assert len(filtered) == count_before + 1
    assert filtered[-1].get_editor_property('model') == piece
    if hero_part:
        assert not filtered[-1].get_editor_property('suit_id'), 'Face/hair must not become four-piece suit members'
    family_results[kind_name] = True
result = {'ok': True, 'staticRejected': True, 'allRowsSkeletal': True, 'modelTriangles': actual_count, 'suitTriangles': actual_count * 4, 'legacyMembership': True, 'families': family_results}
with open(os.path.join(unreal.Paths.project_saved_dir(), 'polycount-verification.json'), 'w') as output:
    json.dump(result, output)
unreal.log('AssetHivePolycountVerification:' + json.dumps(result))
