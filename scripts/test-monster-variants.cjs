const test = require('node:test');
const assert = require('node:assert/strict');
const { monsterVariantGroups, characterOwnedWeapons, monsterVariantModelGroups, monsterVariantModelEntries, monsterCardOccurrence } = require('../shared/monsterVariants.mjs');
const { buildFamilyPackagePlan, resolveMonsterAssociation } = require('../electron/services/characterFamilyRules');

const file = (name, role) => ({ normalizedName: name, storedPath: name, role, sha256: name });
function guard() {
  return { id: 'guard', assetType: 'monster', meta: { character: { name: 'Guard', monsterVariant: 'NormalShield' }, characterManifest: { files: [
    file('SK_Guard_01.fbx', 'skeletalMesh'), file('SM_WP_Guard_Shield.fbx', 'staticMesh'), file('SK_WP_Guard_Shield.fbx', 'skeletalMesh'),
    file('SM_WP_Guard_Shield_LOD1.fbx', 'lod'), file('SK_WP_Guard_BigShield.fbx', 'skeletalMesh')
  ] } } };
}
test('variant weapon inventory counts SM/SK together and excludes LODs and the body', () => {
  const asset = guard();
  assert.deepEqual(characterOwnedWeapons(asset).map(w => w.name).sort(), ['BigShield', 'Shield']);
  const parts = monsterVariantModelGroups(asset);
  const body = parts.find(p => p.role !== 'weapon').slot;
  const shield = parts.find(p => /_Shield$/.test(p.name)).slot;
  const big = parts.find(p => /_BigShield$/.test(p.name)).slot;
  asset.meta.monsterVariants = [
    { id: 'NormalShield', name: 'Normal Shield', assetIds: ['guard'], modelSlotsByAsset: { guard: [body, shield] } },
    { id: 'BigShield', name: 'Big Shield', assetIds: ['guard'], modelSlotsByAsset: { guard: [body, big] } }
  ];
  assert.deepEqual(characterOwnedWeapons(asset, 'NormalShield').map(w => w.name), ['Shield']);
  assert.deepEqual(characterOwnedWeapons(asset, 'BigShield').map(w => w.name), ['BigShield']);
  const groups = monsterVariantGroups([asset]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].assets[0], groups[1].assets[0], 'shared model uses the same asset');
  assert.equal(asset.meta.character.monsterVariant, 'NormalShield');
  asset.meta.monsterVariants.push({ id: 'Other', name: 'Other', assetIds: ['other'], modelSlotsByAsset: { other: ['body'] } });
  assert.deepEqual(characterOwnedWeapons(asset, 'Other'), [], 'a variant cannot inherit unrelated weapons');
});
test('the same form ID is allowed in different variants of one monster but not the same variant', () => {
  const plan = buildFamilyPackagePlan('monster', '', ['C:/art/SK_Guard_01.fbx'], { assetName: 'Guard', category: '3_Elite', monsterVariant: 'BigShield' });
  assert.equal(plan.ok, true, plan.errors.join(';'));
  const records = [{ id: 'guard', assetType: 'monster', meta: { category: '3_Elite', character: { name: 'Guard', entityKey: 'guard-family', formIds: ['01'], monsterVariant: 'NormalShield' } } }];
  assert.deepEqual(resolveMonsterAssociation(plan, 'guard', records), { ok: true, entityKey: 'guard-family' });
  records[0].meta.character.monsterVariant = 'BigShield';
  assert.equal(resolveMonsterAssociation(plan, 'guard', records).ok, false);
});
test('shared weapon follows the assigned variant and retains its real source owner', () => {
  const owner = guard();
  const shield = monsterVariantModelGroups(owner).find(p => /_Shield$/.test(p.name));
  const body = { id: 'other-body', assetType: 'monster', meta: { character: { name: 'Guard', monsterVariant: 'Thrower' }, characterManifest: { files: [file('SK_Guard_02.fbx', 'skeletalMesh')] } } };
  const slot = monsterVariantModelGroups(body)[0].slot;
  body.meta.monsterVariants = [
    { id: 'Thrower', assetIds: ['other-body'], modelSlotsByAsset: { 'other-body': [slot] } },
    { id: 'Shield', assetIds: ['other-body'], modelSlotsByAsset: { 'other-body': [slot], guard: [shield.slot] } }
  ];
  assert.deepEqual(characterOwnedWeapons(body, 'Thrower', [owner]), []);
  assert.deepEqual(characterOwnedWeapons(body, 'Shield', [owner]).map(w => w.name), ['Shield']);
  const entries = monsterVariantModelEntries(body, 'Shield', [owner]);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].asset, owner, 'editing the shared weapon must target its original owner');
  assert.notEqual(monsterCardOccurrence(body.id, 'Thrower'), monsterCardOccurrence(body.id, 'Shield'));
});
