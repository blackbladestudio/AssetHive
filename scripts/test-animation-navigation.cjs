const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const moduleShim = { exports: {} };
new Function('exports', 'require', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/ui/animationNavigation.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText)(moduleShim.exports, createRequire(path.join(__dirname, '../src/ui/animationNavigation.ts')));
const { animationNavigationNodes, matchesAnimationNavigation, animationNodeForAsset, getAnimationNavigationSelection } = moduleShim.exports;
const options = [{ kind: 'weapon', id: 'Unarmed01', name: '空手', group: 'UnArmed' }, { kind: 'weapon', id: 'Unarmed02', name: '空手', group: 'UnArmed' }, { kind: 'weapon', id: 'Bow01', name: '弓', group: 'Bow' }];
const asset = (affiliation, tag) => ({ assetType: 'animation', animationAffiliation: affiliation, animationGameTag: tag, meta: {}, tags: [], zionTags: [], themes: [] });

test('owner type leaves separate locomotion and attacks without using action labels', () => {
 const owner = { kind: 'monster', id: 'Monster_ShangExecutor', name: '行刑官' };
 const locomotion = { ...asset('怪物', owner), zionTags: ['基础移动'], animationLabels: ['警戒', '走', '起步'] };
 const attack = { ...asset('怪物', owner), meta: { category: '攻击' } };
 const nodes = animationNavigationNodes('animation-monster', [locomotion, attack], []);
 assert.equal(nodes.length, 1);
 assert.deepEqual(nodes[0].children.map(node => node.label), ['基础移动', '攻击']);
 const leaf = nodes[0].children[0].id;
 assert.equal(getAnimationNavigationSelection(leaf).animationType, '基础移动');
 assert.equal(matchesAnimationNavigation(locomotion, leaf, []), true);
 assert.equal(matchesAnimationNavigation(attack, leaf, []), false);
 assert.equal(animationNodeForAsset(locomotion, []), leaf);
});

test('monster leaf identity uses table ID and retains unassigned legacy clips', () => {
 const a = asset('怪物', { kind: 'monster', id: 'Monster_ShangExecutor', name: '行刑官' });
 const b = asset('怪物', { kind: 'monster', id: 'Monster_Other', name: '行刑官' });
 const legacy = { ...asset('', null), path: '//share/Artist/AssetLibrary/Animation/Monster' };
 const nodes = animationNavigationNodes('animation-monster', [a,b,legacy], []);
 assert.equal(nodes.length,3);
 assert.equal(nodes.at(-1).label,'未指定');
 assert.equal(nodes.filter(n => n.label === '行刑官').length,2);
 const selected = animationNodeForAsset(a, []);
 assert.equal(matchesAnimationNavigation(a,selected,[]),true);
 assert.equal(matchesAnimationNavigation(b,selected,[]),false);
 assert.equal(matchesAnimationNavigation(a,'animation-monster',[]),true);
 assert.ok(nodes.every(n => n.children.length === 1 && n.children[0].label === '未分类'));
});

test('hero rows share weapon category while keeping other weapons and affiliations separate', () => {
 const clips = options.map(option => asset('主角', option));
 const monster = asset('怪物',{kind:'monster',id:'Unarmed01',name:'怪物'});
 const nodes = animationNavigationNodes('animation-hero', [...clips,monster], options);
 assert.equal(nodes.length,2);
 const unarmed = nodes.find(n => n.label === '空手');
 assert.deepEqual(clips.map(clip => matchesAnimationNavigation(clip,unarmed.id,options)),[true,true,false]);
 assert.equal(matchesAnimationNavigation(monster,unarmed.id,options),false);
 assert.equal(animationNodeForAsset(clips[0],[]),animationNodeForAsset(clips[0],options));
});

test('navigation preserves encoded IDs, metadata-only identities, and mismatched old tags', () => {
 const clip = { ...asset('怪物',null), meta: { animationGameTag:{kind:'monster',id:'Monster:A/B',name:'怪物'} } };
 const node = animationNodeForAsset(clip,[]);
 assert.equal(getAnimationNavigationSelection(node).key,'Monster:A/B');
 assert.equal(matchesAnimationNavigation(clip,node,[]),true);
 const mismatch = asset('主角',{kind:'monster',id:'Monster_A',name:'怪物'});
 assert.equal(animationNavigationNodes('animation-hero',[mismatch],[])[0].label,'未指定');
 assert.equal(getAnimationNavigationSelection('animation-monster:%GG'),null);
 assert.equal(getAnimationNavigationSelection('character-monster'),null);
 assert.deepEqual(animationNavigationNodes('animation-npc',[asset('NPC',null)],[]),[]);
});
