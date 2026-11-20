"""Exercise the complete inspection/apply path in the isolated acceptance project."""
import copy
import hashlib
import json
import os
import runpy
import uuid
import unreal

if '/.tmp/character-upgrade-acceptance/' not in unreal.Paths.project_dir().replace('\\', '/').lower():
    raise RuntimeError('Isolated verification project required')
repo = os.path.abspath(os.path.join(unreal.Paths.project_dir(), '../..'))
api = runpy.run_path(os.path.join(unreal.Paths.project_plugins_dir(), 'AssetHive/Content/Python/assethive_suit_import.py'))
with open(os.path.join(repo, '.tmp/item-job-template.json'), encoding='utf-8') as source:
    suit = json.load(source)
token = uuid.uuid4().hex[:8]
old_root = suit['targetRoot']
old_owner = suit['assetId']
root = old_root + '_JobAcceptance_' + token
owner = 'jobacceptance_' + token
def remap(value):
    if isinstance(value, str):
        return value.replace(old_root, root) if value.startswith(old_root) else owner + value[len(old_owner):] if value.startswith(old_owner + ':') else value
    if isinstance(value, list):
        return [remap(item) for item in value]
    if isinstance(value, dict):
        return {key: remap(item) for key, item in value.items()}
    return value
suit = remap(suit)
suit['assetId'] = owner
for entry in suit['entries']:
    entry['name'] += '_' + token
    entry['targetPath'] = entry['targetPath'].rsplit('/', 1)[0] + '/' + entry['name']
    if entry['kind'] == 'skeletalMesh':
        entry['targetBones'] = copy.deepcopy(entry['bones'])
report = []
def run(label):
    job = {'version': 1, 'suits': [suit]}
    checked = api['inspect'](job)
    assert all(row['status'] in ('ready', 'unchanged') for row in checked['entries']), checked
    job['inspectToken'] = checked['inspectToken']
    result = api['apply_job'](job)
    assert all(row['status'] in ('success', 'unchanged') for row in result['entries']), result
    report.append({'name': label, 'timings': result['timings'], 'entries': result['entries']})
    return result
run('first')
repeat = run('unchanged')
assert all(row['status'] == 'unchanged' for row in repeat['entries'])
assert repeat['timings']['importMs'] == 0 and repeat['timings']['saveMs'] == 0
new_root = root + '_Renamed'
suit['targetRoot'] = new_root
for entry in suit['entries']:
    entry['targetPath'] = entry['targetPath'].replace(root, new_root)
    if 'skeletonPath' in entry:
        entry['skeletonPath'] = entry['skeletonPath'].replace(root, new_root)
    if 'physicsAssetPath' in entry['config']:
        entry['config']['physicsAssetPath'] = entry['config']['physicsAssetPath'].replace(root, new_root)
run('rename')
run('renamed-unchanged')
for entry in suit['entries']:
    obj = api['load'](entry['targetPath'])
    assert obj
    if entry['kind'] == 'skeletalMesh':
        assert api['object_path'](obj.get_editor_property('skeleton')).split('.')[0] == entry['skeletonPath']
        assert api['object_path'](obj.get_editor_property('physics_asset')).split('.')[0] == entry['config']['physicsAssetPath']
with open(os.path.join(unreal.Paths.project_saved_dir(), 'item-job-verification.json'), 'w', encoding='utf-8') as output:
    json.dump({'ok': True, 'runs': report}, output, ensure_ascii=False, indent=2)
unreal.log('AssetHiveItemJobVerification: success')
