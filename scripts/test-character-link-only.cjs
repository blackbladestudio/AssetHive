const test = require('node:test');
const { Buffer } = require('node:buffer');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { compareLinkContent } = require('../electron/services/characterLinkContent');
const { hasCharacterCapability } = require('../electron/services/characterPluginCapabilities');

test('shared project receipt survives colleague workspace changes but isolates another project', () => {
  const identity = require('../electron/services/characterProjectIdentity');
  const a = {projectId:'7F05BEA04BEEA3EDC16ECFB2A7E5E1D0',projectPath:'D:/Project/ZionGame.uproject'};
  const b = {...a,projectPath:'F:/Colleague/ZionGame.uproject'};
  const receipt = {options:{includeStaticMeshes:true},entries:{model:{path:'/Game/Model'}}};
  const meta = {characterUnrealExports:{[identity.projectKey(a)]:receipt}};
  assert.equal(identity.projectKey(a),identity.projectKey(b));
  assert.deepEqual(identity.projectReceipt(meta,b),receipt);
  assert.equal(identity.projectReceipt(meta,{...b,projectId:'8F05BEA04BEEA3EDC16ECFB2A7E5E1D0'}),undefined);
});

test('texture comparison retains low bits of 16-bit source pixels', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'link-pixels16-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5}));
  const files=[path.join(dir,'a.png'),path.join(dir,'b.png')];
  for(let i=0;i<2;i++) await sharp(new Uint16Array([10000+i,20000,30000,65535]),{raw:{width:1,height:1,channels:4}}).toColourspace('rgb16').png().toFile(files[i]);
  assert.equal((await compareLinkContent(files[0],files[0],'texture')).equal,true);
  assert.equal((await compareLinkContent(files[0],files[1],'texture')).equal,false);
});

test('all character families link complete owners and reject component selections', async t => {
  const {sendCharacterLinkJob} = require('../electron/services/characterLinkOnly');
  const exporter = require('../electron/services/characterSuitExport');
  const original = exporter.buildSuitExport;
  t.after(() => { exporter.buildSuitExport = original; });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'all-character-links-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true, maxRetries:5, retryDelay:100}));
  const image = path.join(dir, 'source.png');
  await sharp({create:{width:2,height:2,channels:4,background:'#123456'}}).png().toFile(image);
  const sourceHash = require('node:crypto').createHash('sha256').update(await fs.readFile(image)).digest('hex');
  for (const category of ['suit', 'monster', 'npc', 'weapon', 'item', 'Hair', 'Face']) {
    const asset = {id:category, assetType:['Hair','Face'].includes(category) ? 'suit' : category, name:category,
      meta:{character:{variant:category}}, metaPath:path.join(dir, category + '.json')};
    await fs.writeFile(asset.metaPath, JSON.stringify({id:category}));
    const entry = {key:category + ':texture:main', kind:'texture', name:'T_Test', sourcePath:image, sourceHash, targetPath:'/Game/Test/T_' + category};
    exporter.buildSuitExport = async (received, options) => {
      assert.equal(received.id, category); assert.equal(options.includeStaticMeshes, true);
      return {assetId:category, targetRoot:'/Game/Test', entries:[entry]};
    };
    let applied;
    const client = {getEditorInfo:async()=>({projectPath:'D:/Test.uproject',capabilities:['characterLinkOnlyV2']}),
      importAssets:async ({characterSuit:job}) => {
        if (job.phase === 'linkInspect') return {suitResult:{inspectToken:category, entries:[{...entry, assetId:category,status:'checking',exportedPath:image,alreadyLinked:Boolean(applied),path:entry.targetPath}]}};
        applied = job;
        return {suitResult:{entries:[{...entry,assetId:category,status:'success',path:entry.targetPath}]}};
      }};
    const inspected = await sendCharacterLinkJob([asset], {}, null, client);
    assert.equal(inspected.suitResult.entries[0].status, 'ready');
    await sendCharacterLinkJob([asset], {suitPhase:'apply',suitInspectToken:category,suitManifestHash:inspected.suitResult.manifestHash}, null, client);
    assert.equal(applied.phase, 'linkApply');
    assert.deepEqual(applied.verifiedKeys, [entry.key]);
    const meta = JSON.parse(await fs.readFile(asset.metaPath, 'utf8'));
    assert.equal(Object.values(meta.characterUnrealExports)[0].entries[entry.key].linkOnly, true);
    const repeated = await sendCharacterLinkJob([asset], {}, null, client);
    assert.equal(repeated.suitResult.entries[0].status, 'linked');
    const inspectedMeta = JSON.parse(await fs.readFile(asset.metaPath, 'utf8'));
    assert.equal(Object.values(inspectedMeta.characterUnrealExports)[0].entries[entry.key].associationPending, false);
    await assert.rejects(sendCharacterLinkJob([{...asset,id:category + '::part::head'}], {}, null, client), /完整资产/);
  }
});

test('link content compares decoded pixels, not filenames or encoded container bytes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-content-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.png'), b = path.join(dir, 'renamed.png'), changed = path.join(dir, 'changed.png');
  const base = sharp({create:{width:8,height:8,channels:4,background:'#123456'}});
  await base.clone().png({compressionLevel:0}).toFile(a);
  await base.clone().png({compressionLevel:9}).toFile(b);
  await sharp({create:{width:8,height:8,channels:4,background:'#123457'}}).png().toFile(changed);
  assert.equal((await compareLinkContent(a,b,'texture')).equal, true);
  assert.equal((await compareLinkContent(a,changed,'texture')).equal, false);
});

test('identical 8-bit TGA and PNG pixels have the same association signature', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-cross-format-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tga = path.join(dir, 'source.tga'), png = path.join(dir, 'export.png');
  const header = Buffer.alloc(18);
  header[2] = 2; header.writeUInt16LE(2, 12); header.writeUInt16LE(1, 14);
  header[16] = 32; header[17] = 0x28;
  await fs.writeFile(tga, Buffer.concat([header, Buffer.from([86,52,18,255, 17,128,254,127])]));
  await sharp(Buffer.from([18,52,86,255, 254,128,17,127]), {raw:{width:2,height:1,channels:4}}).png().toFile(png);
  assert.equal((await compareLinkContent(tga, png, 'texture')).equal, true);
});

test('old plugins are probed only through read-only status, never unknown apply-like phases', async () => {
  const calls=[];
  const client={importAssets:async job=>{calls.push(job);return {suitResult:{entries:[]}};}};
  const editor={projectPath:'D:/Test.uproject',capabilities:['characterSuitV1']};
  assert.equal(await hasCharacterCapability(client,editor,'characterLinkOnlyV1'),false);
  assert.equal(calls[0].characterSuit.phase,'status');
  assert.deepEqual(calls[0].characterSuit.suits,[]);
  client.importAssets=async()=>({suitResult:{capabilities:['characterLinkOnlyV1']}});
  assert.equal(await hasCharacterCapability(client,editor,'characterLinkOnlyV1'),true);
});

test('link apply requires the exact inspected project, selection and token before dispatch', async () => {
  const {sendCharacterLinkJob}=require('../electron/services/characterLinkOnly');
  let dispatched=false;
  const client={getEditorInfo:async()=>({projectPath:'D:/Test.uproject',capabilities:['characterLinkOnlyV2']}),importAssets:async()=>{dispatched=true;}};
  await assert.rejects(sendCharacterLinkJob([], {suitPhase:'apply',suitInspectToken:'invented'}, null, client), /失效/);
  assert.equal(dispatched,false);
});

test('whole suit inspection persists missing and unresolved states only for the connected project', async t => {
  const { recordLinkInspection } = require('../electron/services/characterLinkOnly');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-inspection-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const metaPath = path.join(dir, 'asset_info.json');
  const old = {projectPath:'E:/Other.uproject',targetRoot:'/Game/Old',entries:{}};
  await fs.writeFile(metaPath, JSON.stringify({id:'suit',characterManifest:{contentUpdatedAt:'original'},characterUnrealExports:{old}}));
  await recordLinkInspection([{id:'suit',metaPath}],[{assetId:'suit',targetRoot:'/Game/Suit'}],[
    {assetId:'suit',key:'suit:staticMesh:head',kind:'staticMesh',status:'missing'},
    {assetId:'suit',key:'suit:skeletalMesh:head',kind:'skeletalMesh',status:'blocked',message:'Different dependencies'}
  ],'D:/Current.uproject');
  const meta=JSON.parse(await fs.readFile(metaPath,'utf8'));
  assert.deepEqual(meta.characterUnrealExports.old,old);
  assert.equal(meta.characterManifest.contentUpdatedAt,'original');
  const receipt=Object.values(meta.characterUnrealExports).find(r=>r.projectPath==='D:/Current.uproject');
  assert.equal(receipt.entries['suit:staticMesh:head'].missingInUE,true);
  assert.equal(receipt.entries['suit:staticMesh:head'].livePath,'');
  assert.equal(receipt.entries['suit:skeletalMesh:head'].associationPending,true);
});
