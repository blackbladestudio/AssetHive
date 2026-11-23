const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inferAnimationGameTag, syncAnimationGameTag } = require('../shared/animationGameTags.mjs');

const weapons = [
  { kind: 'weapon', id: 'Unarmed01', name: '空手', group: 'UnArmed' },
  { kind: 'weapon', id: 'Sword01', name: '单手剑', group: 'Sword' },
  { kind: 'weapon', id: 'GreatSword01', name: '大剑', group: 'GreatSword' }
];
const monsters = [
  { kind: 'monster', id: 'Monster_ShangExecutor', name: '行刑官', group: 'Elite' },
  { kind: 'monster', id: 'Monster_ShangGiantThrower', name: '巨型投掷者', group: 'Elite' }
];
const options = { weapons, monsters };

test('filename identity matches weapon aliases and monster table prefixes', () => {
  assert.equal(inferAnimationGameTag('AS_Unarm01_M01_RunF.fbx', '主角', weapons)?.id, 'Unarmed01');
  assert.equal(inferAnimationGameTag('AS_GreatSword01_M01_Walk', '主角', weapons)?.id, 'GreatSword01');
  assert.equal(inferAnimationGameTag('AS_ShangExecutor_Alert_Walk_Start', '怪物', monsters)?.name, '行刑官');
  assert.equal(inferAnimationGameTag('AS_ShangGiantThrower_Battle_RunF', '怪物', monsters)?.id, 'Monster_ShangGiantThrower');
  assert.equal(inferAnimationGameTag('AS_Unknown_Attack_Sword', '主角', weapons), undefined);
});

test('ambiguous identities require selection instead of guessing a row', () => {
  const variants = [...weapons, { kind: 'weapon', id: 'Unarmed02', name: '空手', group: 'UnArmed' }];
  assert.equal(inferAnimationGameTag('AS_Unarm_M01_RunF', '主角', variants), undefined);
  assert.equal(inferAnimationGameTag('AS_Unarm01_M01_RunF', '主角', variants)?.id, 'Unarmed01');
});

test('auto matching refreshes after rename or table load, preserving manual selections and clearing', () => {
  const draft = { assetType: 'animation', assetName: 'AS_Unarm01_M01_RunF', animationAffiliation: '主角', animationGameTag: null };
  const pending = syncAnimationGameTag(draft, { weapons: [], monsters: [] });
  const matched = syncAnimationGameTag(pending, options);
  assert.equal(matched.animationGameTag.id, 'Unarmed01');
  assert.equal(syncAnimationGameTag(matched, options), matched);
  const renamed = syncAnimationGameTag({ ...matched, assetName: 'AS_GreatSword01_M01_RunF' }, options);
  assert.equal(renamed.animationGameTag.id, 'GreatSword01');
  const manual = { ...matched, animationGameTagManual: true, assetName: 'AS_GreatSword01_M01_RunF' };
  assert.equal(syncAnimationGameTag(manual, options), manual);
  const cleared = { ...manual, animationGameTag: null };
  assert.equal(syncAnimationGameTag(cleared, options), cleared);
  const legacy = { ...draft, animationGameTag: weapons[1] };
  assert.equal(syncAnimationGameTag(legacy, options).animationGameTag, weapons[1]);
});
