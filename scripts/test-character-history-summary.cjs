const test = require('node:test');
const assert = require('node:assert/strict');
const { characterHistorySummary, characterHistoryAction, characterHistoryGroupAction, groupCharacterHistoryEntries } = require('../shared/characterHistorySummary.mjs');

test('history header collects original folders across updates without derived previews or UE paths', () => {
  const { characterImportSourceFolders }=require('../shared/characterHistorySummary.mjs');
  assert.deepEqual(characterImportSourceFolders({characterManifest:{files:[{originalPath:'C:/source/Body.fbx'},{originalPath:'C:/source/T_D.tga'}]},characterUpdateHistory:[
    {label:'更新资源',sourcePaths:['D:/rig/SK.fbx','c:/source/Body.fbx']},
    {label:'自动预览图更新',sourcePaths:['C:/Temp/preview.png']},
    {label:'发送到 UE',files:[{sourcePath:'/Game/Characters/Mesh'}]}
  ]}).map(s=>s.toLowerCase()),['c:\\source','d:\\rig']);
  assert.deepEqual(characterImportSourceFolders({}),[]);
});

test('automatic model views are previews, not material textures; manual images stay distinct', () => {
  for (const kind of ['SM', 'SK']) {
    const summary = characterHistorySummary({ label: `头部 ${kind} 四视图更新`, files: [{ name: 'front.png' }] });
    assert.match(summary, /自动更新预览图/);
    assert.equal(characterHistoryAction(summary), '自动更新预览图');
    assert.doesNotMatch(summary, /贴图/);
  }
  assert.equal(characterHistoryAction(characterHistorySummary({ label: '自动预览图更新' })), '自动更新预览图');
  assert.equal(characterHistoryAction(characterHistorySummary({ label: '头部自动预览图更新' })), '自动更新预览图');
  assert.equal(characterHistoryAction(characterHistorySummary({ label: '预览图库更新', files: [{ name: 'front.png' }] })), '更新预览图');
  assert.equal(characterHistoryAction(characterHistorySummary({ label: '更换主图' })), '更换主图');
  assert.equal(characterHistorySummary({ label: '资源更新', files: [{ name: 'T_Arm_D.png' }] }), '更新贴图');
});

const entry = (id, second, extra = {}) => ({ id, at: new Date(Date.UTC(2026, 10, 16, 15, 0, second)).toISOString(), note: '', automaticPreview: true, files: [{ sourceIndex: 0, sourcePath: `${id}.png` }], ...extra });

test('one render round is folded once without losing original records or source identities', () => {
  const source = [entry('update', 0, { automaticPreview: false, note: '调整袖口' }), ...['head', 'upbody', 'downbody', 'arm', 'suit'].map((name, i) => entry(name, i + 1))];
  const before = JSON.stringify(source);
  const groups = groupCharacterHistoryEntries(source);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].entries.map(item => item.id), ['head', 'upbody', 'downbody', 'arm', 'suit']);
  assert.equal(groups[0].entries[2], source[3]);
  assert.equal(groups[0].entries[2].files[0].sourcePath, 'downbody.png');
  assert.equal(JSON.stringify(source), before);
});

test('manual edits, sends, notes and later rounds are never merged across a boundary', () => {
  const entries = [entry('first', 0), entry('send', 1, { automaticPreview: false }), entry('second', 2), entry('manual', 3, { automaticPreview: false }), entry('note', 4, { note: '手动确认' }), entry('third', 5), entry('later', 126)];
  assert.equal(groupCharacterHistoryEntries(entries).length, entries.length);
  assert.equal(groupCharacterHistoryEntries([entry('bad', 0, { at: '' }), entry('valid', 1)]).length, 2);
});

test('automatic previews belong under the preceding resource update and preserve its note and time', () => {
  const update = entry('update', 0, { label: '更新模型和贴图', automaticPreview: false, note: '调整袖口' });
  const groups = groupCharacterHistoryEntries([update, entry('head', 10), entry('arm', 11), entry('send', 15, { label: '发送模型到 UE', automaticPreview: false }), entry('later', 16)]);
  assert.equal(groups.length, 3);
  assert.equal(groups[2].at, update.at);
  assert.deepEqual(groups[2].entries.map(item => item.id), ['update', 'head', 'arm']);
  assert.equal(groups[2].entries[0].note, '调整袖口');
  assert.equal(groups[0].entries.length, 1);
  assert.equal(groupCharacterHistoryEntries([entry('restore', 0, { label: '重新导入贴图到 UE', automaticPreview: false }), entry('preview', 1)]).length, 2);
});

test('manual preview edits and cover selection form one image operation, separate from automatic renders', () => {
  const source = [entry('gallery', 0, { label: '更新预览图', automaticPreview: false }), entry('cover', 10, { label: '更换主图', automaticPreview: false }), entry('render', 11, { label: '自动更新预览图' })];
  const groups = groupCharacterHistoryEntries(source);
  assert.equal(groups.length, 2);
  assert.equal(characterHistoryGroupAction(groups[1].entries), '更新预览图');
  assert.deepEqual(groups[1].entries.map(item => item.id), ['gallery', 'cover']);
  assert.equal(characterHistoryGroupAction(groups[0].entries), '自动更新预览图');
});

test('operation stays readable when a user note exists; failed sends remain apparent', () => {
  const record = { label: '上装资源更新', note: 'test2', files: [{ name: 'SM_Upbody.fbx' }] };
  assert.equal(characterHistorySummary(record), '上装 · 更新模型');
  assert.equal(characterHistoryAction(characterHistorySummary(record)), '更新资产');
  assert.equal(record.note, 'test2');
  assert.equal(characterHistoryAction(characterHistorySummary({ label: '发送到 UE', changes: [{ status: 'failed', name: 'SK_Head' }] })), '发送到 UE 未完成');
  assert.equal(characterHistoryAction('发送模型到 UE（部分未完成）'), '发送到 UE（部分未完成）');
  assert.equal(characterHistoryAction('自动更新预览图', 'en'), 'Automatically update previews');
});

test('source folder summary hides descendants but keeps sibling folders', () => {
  const {characterImportSourceFolders}=require('../shared/characterHistorySummary.mjs');
  assert.deepEqual(characterImportSourceFolders({characterManifest:{files:[
    {originalPath:'C:/Art/scenes/Textures/T_D.tga'}, {originalPath:'C:/Art/scenes/body.fbx'},
    {originalPath:'C:/Art/scenes2/rig.fbx'}
  ]}}), ['C:\\Art\\scenes','C:\\Art\\scenes2']);
});
