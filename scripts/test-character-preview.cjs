/* global Buffer */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");
const { runImageTask } = require("../electron/services/imageTasks");

test("角色透明贴图支持 8 位索引色 TGA 缩略图", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-character-preview-"));
  try {
    const input = path.join(directory, "opacity-indexed.tga");
    const output = path.join(directory, "opacity-indexed.png");
    const header = Buffer.alloc(18);
    header[1] = 1;
    header[2] = 1;
    header.writeUInt16LE(2, 5);
    header[7] = 24;
    header.writeUInt16LE(2, 12);
    header.writeUInt16LE(2, 14);
    header[16] = 8;
    header[17] = 0x20;
    const palette = Buffer.from([0, 0, 0, 255, 255, 255]);
    const indices = Buffer.from([0, 1, 1, 0]);
    await fs.writeFile(input, Buffer.concat([header, palette, indices]));
    await runImageTask("resizeTexture", [input, output, 512]);
    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height, info.channels], [2, 2, 3]);
    assert.deepEqual([...data], [0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('Groom import preview uses the actual ABC renderer branch and preserves a manual cover', async () => {
  const ts=require('typescript');
  const source=ts.createSourceFile('App.tsx',await fs.readFile(path.join(__dirname,'../src/ui/App.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let declaration;
  (function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='generateCharacterPreviewForForm')declaration=node.getText(source);ts.forEachChild(node,visit);})(source);
  const paths=Object.fromEntries(['front','left','right','back'].map(view=>[view,`C:/cache/${view}.png`]));
  const received=[];
  const scope={bridgeAvailable:true,setCharacterPreviewProgress:()=>{},quickDropRequestIdRef:{current:'current'},t:z=>z,bridge:{materializeDroppedFile:()=>{},renderGroomPreview:async file=>{received.push(file);return paths;}}};
  const js=ts.transpileModule(declaration,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const render=new Function('scope',`with(scope){${js};return generateCharacterPreviewForForm;}`)(scope);
  const draft={assetType:'suit',characterFields:{variant:'Hair'},modelSlots:{Mesh0:'C:/groom/hair.abc'},previewImagePath:'C:/manual.png'};
  const result=await render(draft,'current');
  assert.deepEqual(received,['C:/groom/hair.abc']);
  assert.deepEqual(result.characterPreviewPaths,paths);
  assert.equal(result.previewImagePath,'C:/manual.png');
});
