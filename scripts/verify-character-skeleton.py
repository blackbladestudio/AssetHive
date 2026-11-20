"""Actual skeletal import and helper rename in the isolated acceptance project."""
import json
import os
import runpy
import uuid
import unreal

project = unreal.Paths.project_dir().replace('\\', '/').lower()
if '/.tmp/character-upgrade-acceptance/' not in project:
    raise RuntimeError('Use the isolated acceptance project')
repo = os.path.abspath(os.path.join(unreal.Paths.project_dir(), '../..'))
script = os.path.join(unreal.Paths.project_plugins_dir(), 'AssetHive/Content/Python/assethive_suit_import.py')
api = runpy.run_path(script)
run_id = uuid.uuid4().hex[:8]
root = '/Game/GameplayItems/Interactable/AcceptanceSkeleton_' + run_id + '/Mesh/SkeletalMesh'
entry = {'key': 'acceptance:skeletalMesh:' + run_id, 'name': 'SK_Acceptance', 'kind': 'skeletalMesh',
         'sourcePath': os.path.join(repo, '.tmp/upgrade-skeleton-fixture.fbx'),
         'targetPath': root + '/SK_Acceptance', 'skeletonPath': root + '/SKEL_Acceptance',
         'config': {'family': 'item', 'ownSkeleton': True, 'createPhysicsAsset': True,
                    'physicsAssetPath': root + '/SK_Acceptance_Physics'}}
mesh = api['import_file'](entry, entry['targetPath'])
api['save'](mesh, entry)
skeleton = mesh.get_editor_property('skeleton')
physics = mesh.get_editor_property('physics_asset')
assert skeleton and physics
renamed_root = root.replace('AcceptanceSkeleton', 'AcceptanceRenamed')
renamed = {**entry, 'targetPath': renamed_root + '/SK_Renamed', 'skeletonPath': renamed_root + '/SKEL_Renamed',
           'config': {**entry['config'], 'physicsAssetPath': renamed_root + '/SK_Renamed_Physics'}}
assert unreal.EditorAssetLibrary.rename_asset(entry['targetPath'], renamed['targetPath'])
api['synchronize_owned_helpers'](renamed, mesh)
assert mesh.get_editor_property('skeleton') == skeleton
assert mesh.get_editor_property('physics_asset') == physics
assert skeleton.get_path_name().split('.')[0] == renamed['skeletonPath']
assert physics.get_path_name().split('.')[0] == renamed['config']['physicsAssetPath']
assert unreal.AssetHiveModelCatalogLibrary.update_model_level(mesh, entry['key'])
custom = {**renamed, 'skeletonPath': renamed_root + '/SKEL_Custom',
          'config': {**renamed['config'], 'skeletonOverride': 'create'}}
original_skeleton_path = skeleton.get_path_name().split('.')[0]
mesh = api['import_file'](custom, custom['targetPath'])
assert unreal.EditorAssetLibrary.does_asset_exist(original_skeleton_path), 'Creating must preserve the original skeleton'
assert mesh.get_editor_property('skeleton') != skeleton, 'Create must create a distinct skeleton'
assert mesh.get_editor_property('physics_asset') == physics
reused = {**renamed, 'config': {**renamed['config'], 'ownSkeleton': False, 'skeletonOverride': 'existing'}}
mesh = api['import_file'](reused, reused['targetPath'])
assert mesh.get_editor_property('skeleton') == skeleton, 'Explicit existing skeleton must replace the previous assignment'
assert mesh.get_editor_property('physics_asset') == physics
result = {'ok': True, 'model': mesh.get_path_name(), 'skeleton': skeleton.get_path_name(), 'physics': physics.get_path_name()}
with open(os.path.join(unreal.Paths.project_saved_dir(), 'skeleton-verification.json'), 'w') as output:
    json.dump(result, output)
unreal.log('AssetHiveSkeletonVerification:' + json.dumps(result))
