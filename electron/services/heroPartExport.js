const crypto = require('node:crypto');
const { heroPartName } = require('../../shared/heroPackageRules.mjs');
const { heroTextureChannel, heroMaterialRole } = require('../../shared/heroMaterialRules.mjs');
const { inspectCharacterModel } = require('./characterFileInspection');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ROOT = '/Game/Characters/Hero/Asset_PJZ';
const parents = { face: 'M_Char_Face', hair: 'M_Char_Hair', eyebrow: 'M_Char_EyeBrow', eye: 'M_Char_Eye_CustomIris' };

async function buildHeroPartExport(asset, options, analyze, managedFile) {
  const fields = asset.meta.character;
  const name = heroPartName(fields);
  if (!name) throw new Error('请确认脸部或头发的性别、体型和编号');
  const root = `${ROOT}/${fields.gender}_${fields.bodyCode}/Mesh/${fields.variant}`;
  const cardRoot = fields.variant === 'Hair' ? `${root}/HairCard` : root;
  const files = asset.meta.characterManifest?.files || [];
  const entries = [], materialRequests = [], groups = new Map();
  const models = files.filter(f => ['model', 'staticMesh', 'skeletalMesh'].includes(f.role));
  const hasCards = models.some(f => /\.fbx$/i.test(f.storedPath));
  for (const file of files.filter(f => f.role === 'texture' && hasCards)) {
    const sourceName = file.normalizedName || file.originalName || file.storedPath;
    const role = heroMaterialRole(sourceName, fields.variant);
    const channel = heroTextureChannel(sourceName);
    if (!channel || !parents[role]) throw new Error(`请核对脸部/头发贴图用途：${sourceName}`);
    if (!groups.has(role)) groups.set(role, {});
    if (groups.get(role)[channel]) throw new Error(`同材质组贴图类型重复：${role}/${channel}`);
    const suffix = role === 'face' || fields.variant === 'Hair' ? '' : '_' + role;
    const textureName = `T_${name}${suffix}_${channel}`;
    const key = `${asset.id}:texture:${role}:${channel}`;
    groups.get(role)[channel] = key;
    entries.push({ key, kind: 'texture', name: textureName, groupName: role, channel: channel === 'Opacity' ? 'A' : channel,
      targetPath: `${cardRoot}/Material/${name}/Texture/${textureName}`, ...await managedFile(asset, file.storedPath),
      config: { version: 1, family: 'suit', heroPart: fields.variant, virtualTexture: role !== 'eye', normalFormat: options.normalFormat || 'directx' } });
  }
  if (hasCards && !groups.has(fields.variant === 'Hair' ? 'hair' : 'face')) groups.set(fields.variant === 'Hair' ? 'hair' : 'face', {});
  for (const [role, textures] of groups) {
    const suffix = role === 'face' || fields.variant === 'Hair' ? '' : '_' + role;
    const materialName = `MI_${name}${suffix}`;
    entries.push({ key: `${asset.id}:material:${role}`, kind: 'material', name: materialName, groupName: role,
      targetPath: `${cardRoot}/Material/${name}/${materialName}`, textures,
      config: { version: 1, family: 'suit', heroPart: fields.variant, materialRole: 'hero_' + role,
        ...(role === 'hair' ? { hairDefaultsVersion: 1 } : {}),
        virtualTexture: role !== 'eye', parentPath: '/Game/MaterialLibrary/Character/Common/' + parents[role] } });
  }
  for (const file of models) {
    const source = await managedFile(asset, file.storedPath);
    const groom = /\.abc$/i.test(file.storedPath);
    if (groom && fields.variant !== 'Hair') throw new Error('Groom ABC 仅用于头发');
    if (!groom && !/\.fbx$/i.test(file.storedPath)) throw new Error('脸部和 HairCard 发送 UE 需要 FBX');
    const analysis = groom ? {} : await inspectCharacterModel(source.sourcePath, analyze);
    const kind = groom ? 'groom' : analysis.meshKind;
    if (!['groom','staticMesh','skeletalMesh'].includes(kind)) throw new Error('模型类型无法识别');
    if (kind === 'staticMesh' && !options.includeStaticMeshes) continue;
    const meshName = groom ? `${name}_Groom` : `${kind === 'skeletalMesh' ? 'SK' : 'SM'}_${name}`;
    const key = `${asset.id}:${kind}:main`;
    const materials = {}, heroSharedRoles = {}, unresolvedMaterials = [];
    for (const slot of analysis.materialNames || []) {
      const role = heroMaterialRole(slot, fields.variant);
      const known = fields.variant === 'Hair' || /head|face|hair|beard|mustache|eyebrow|eyelash|iris|eye|lacri|tearline|oral|teeth|mouth|skin|body|arm|hand|foot|leg/i.test(slot);
      const chosen = options.materialMappings?.[`${key}|${slot}`];
      if (chosen?.startsWith('group:') && groups.has(chosen.slice(6))) materials[slot] = `${asset.id}:material:${chosen.slice(6)}`;
      else if (known && groups.has(role)) materials[slot] = `${asset.id}:material:${role}`;
      else if (known && role !== 'face') heroSharedRoles[slot] = role;
      else {
        unresolvedMaterials.push(slot);
        materialRequests.push({ key: `${key}|${slot}`, meshName, slot, groups: [...groups.keys()].map(role => ({ key: role, name: role })) });
      }
    }
    entries.push({ key, kind, name: meshName, targetPath: `${groom ? root + '/Groom' : cardRoot}/${meshName}`, ...source, materials, externalMaterials: {},
      heroSharedRoles, unresolvedMaterials, bones: analysis.bones || [],
      ...(kind === 'skeletalMesh' ? { skeletonPath: options.skeletonPath || `${ROOT}/Common/SKEL_Character` } : {}),
      config: { version: 1, family: 'suit', heroPart: fields.variant, gender: fields.gender, bodyCode: fields.bodyCode,
        importAnimations: false, createPhysicsAsset: false, updateReferencePose: false } });
  }
  if (new Set(entries.map(e => e.key)).size !== entries.length) throw new Error('同类型主体模型存在多个候选');
  for (const entry of entries) entry.fingerprint = hash({ sourceHash: entry.sourceHash, config: entry.config, skeletonPath: entry.skeletonPath,
    materials: entry.materials, textures: entry.textures, heroSharedRoles: entry.heroSharedRoles });
  return { assetId: asset.id, name, family: 'suit', targetRoot: root, selectedSlot: '', entries, materialRequests, manifestHash: hash(entries) };
}
module.exports = { buildHeroPartExport };
