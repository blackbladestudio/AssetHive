import { buildMonsterAssetName } from "./monsterPackageAudit.mjs";
import { heroPartKind, heroSuitPart } from "./heroPackageRules.mjs";
import { CHARACTER_MODEL_EXTENSIONS } from "./characterFilePolicy.mjs";

export const COMPONENT_SEPARATOR = "::part::";
const base = value => String(value || "").replace(/\\/g, "/").split("/").pop() || "";
const stem = value => base(value).replace(/\.[^.]+$/, "");
const modelKey = value => stem(value).replace(/_LOD\d+$/i, "").replace(/^(?:SK|SM)_/i, "").toLowerCase();
const modelRoles = new Set(["model", "skeletalMesh", "staticMesh"]);
const isModelFile = item => modelRoles.has(item?.role)
  && CHARACTER_MODEL_EXTENSIONS.has(`.${base(item?.normalizedName || item?.storedPath).split(".").pop()?.toLowerCase() || ""}`);
const isPrimaryModel = file => isModelFile(file) && !/_LOD[1-9]\d*(?=\.[^.]+$)/i.test(file.normalizedName || file.storedPath);
const suitPartOrder = new Map(["head", "upbody", "downbody", "arm"].map((part, index) => [part, index]));
const join = (root, file) => /^(?:[A-Za-z]:|[\\/]{1,2})/.test(file) ? file : `${root.replace(/[\\/]+$/, "")}/${file}`;

// A monster's budget covers its body, not carried weapons or both mesh variants.
export function monsterBodyMetrics(files) {
  const bodies = new Map();
  for (const file of files) {
    const name = file.normalizedName || file.storedPath || '';
    if (!isModelFile(file) || file.componentRole === 'weapon'
      || /(?:^|[_/\\])(?:WP|Weapon)(?:[_/\\]|\.)/i.test(name)
      || /_LOD[1-9]\d*(?=\.[^.]+$)/i.test(name)) continue;
    const key = modelKey(name);
    const previous = bodies.get(key);
    if (!previous || characterMeshKind(file) === 'skeletalMesh') bodies.set(key, file);
  }
  const models = [...bodies.values()];
  const known = models.filter(file => Number.isFinite(file.triangleCount) && file.triangleCount >= 0);
  const knownTriangleCount = known.reduce((sum, file) => sum + file.triangleCount, 0);
  const unknownModelCount = models.length - known.length;
  return { modelCount: models.length, knownTriangleCount, unknownModelCount,
    totalTriangleCount: unknownModelCount ? null : knownTriangleCount, overBudget: knownTriangleCount > 300000 };
}

export function characterMeshKind(file) {
  if (file?.role === "skeletalMesh") return "skeletalMesh";
  if (file?.role === "staticMesh") return "staticMesh";
  // Legacy outfit imports used the generic role and named every FBX with SK_.
  // They predate content analysis and represent the art/static source.
  return file?.role === "model" ? "staticMesh" : "";
}

// Each model kind owns its preview revision. Uploading SK must not invalidate SM.
const suitMaterialPreview = (files, kind) => kind === 'staticMesh' && files.some(file =>
  isPrimaryModel(file) && characterMeshKind(file) === 'staticMesh'
  && /^(?:SM|SK)_[MF]\d+_(?:Light|Medium|Heavy)\d+_/i.test(base(file.normalizedName || file.storedPath)));
export function characterMeshPreviewRevision(files, kind) {
  const weapon = files.some(file => /^(?:SM|SK)_(?:Bow|Arrow|Dagger|DualHands|DualAxe|GreatAxe|GreatSword|Jade|LongSword|PairedSwords|ShieldAxe|Spear|Sword)\d+_/i.test(file.normalizedName || ''));
  const suit = suitMaterialPreview(files, kind);
  return (suit ? 'suit-material-pool-v3:' : weapon ? 'weapon-material-joints-v2:' : '') + JSON.stringify(files.filter(file => isPrimaryModel(file) && characterMeshKind(file) === kind
    || kind === 'staticMesh' && file.role === 'texture').map(file => suit
      ? [file.role, file.sha256 || file.storedPath, base(file.normalizedName || file.storedPath)]
      : [file.role, file.sha256 || file.storedPath]).sort());
}

export function needsCharacterMeshPreview(part, kind) {
  if (!part.meshKinds?.[kind]) return false;
  const preview = part.meshPreviews?.[kind];
  if (['front', 'left', 'right', 'back'].every(view => preview?.previewImages?.some(image =>
    image.tags?.includes(`view:${view}`) && image.tags?.includes('origin:manual')))) return false;
  const complete = ['front', 'left', 'right', 'back'].every(view => preview?.previewImages?.some(image =>
    image.uri && image.tags?.includes(`view:${view}`)));
  if (!complete || !preview?.previewUri) return true;
  if (preview.previewRevision === characterMeshPreviewRevision(part.previewFiles || part.files, kind)) return false;
  if (suitMaterialPreview(part.files, kind)) return true;
  // Older desktop processes included artist LODs in this signature, although
  // the rendered view uses only LOD0. Accept the exact legacy signature only
  // while every recorded model and texture is still unchanged.
  const weapon = part.files.some(file => /^(?:SM|SK)_(?:Bow|Arrow|Dagger|DualHands|DualAxe|GreatAxe|GreatSword|Jade|LongSword|PairedSwords|ShieldAxe|Spear|Sword)\d+_/i.test(file.normalizedName || ''));
  const legacy = (weapon ? 'weapon-material-joints-v2:' : '') + JSON.stringify(part.files.filter(file => isModelFile(file) && characterMeshKind(file) === kind
    || kind === 'staticMesh' && file.role === 'texture').map(file => [file.role, file.sha256 || file.storedPath]).sort());
  return preview.previewRevision !== legacy;
}

export function characterSuitPendingPreviewViews(asset) {
  if (asset?.assetType !== 'suit' || asset.meta?.componentView) return [];
  const files = activeCharacterFiles(asset);
  const images = asset.meta.previews?.images || [];
  const staleMaterials = images.some(image => image.tags?.some(tag => tag.startsWith('view:')))
    && suitMaterialPreview(files, 'staticMesh') && files.some(file => file.role === 'texture')
    && asset.meta?.characterComponents?.suitMaterialPreviewRevision !== characterMeshPreviewRevision(files, 'staticMesh');
  if (!asset.meta?.characterComponents?.suitPreviewNeedsUpdate && !staleMaterials) return [];
  return ['front', 'left', 'right', 'back'].filter(view => !images.some(image =>
    image.tags?.includes(`view:${view}`) && image.tags?.includes('origin:manual')));
}

export function characterGroomPendingPreviewViews(asset) {
  if (asset?.assetType !== 'suit' || asset.meta?.character?.variant !== 'Hair' || asset.meta?.componentView) return [];
  const models = (asset.meta?.characterManifest?.files || []).filter(isModelFile);
  if (!models.length || !models.every(file => /\.abc$/i.test(file.storedPath || file.normalizedName))) return [];
  const pending = asset.meta?.characterComponents?.autoPreviewPendingViews;
  if (Array.isArray(pending) && pending.length) return pending;
  if (asset.meta?.previewImage || asset.previewImage || asset.preview || asset.meta?.previews?.images?.length) return [];
  return ['front', 'left', 'right', 'back'];
}

// Persist rig freshness with the model version so renames and preview/texture
// changes do not reopen rigging, and restoring a version restores its state.
export function applyCharacterRigUpdateState(files, changes) {
  const changed = new Set(changes.filter(item => ['added', 'changed'].includes(item.status)).map(item => item.name.toLowerCase()));
  const changedStatic = new Set(files.filter(file => isModelFile(file) && characterMeshKind(file) === 'staticMesh'
    && changed.has(file.normalizedName.toLowerCase())).map(file => modelKey(file.normalizedName)));
  return files.map(file => {
    if (!isModelFile(file) || characterMeshKind(file) !== 'skeletalMesh') return file;
    if (changed.has(file.normalizedName.toLowerCase())) return { ...file, rigNeedsUpdate: false, rigReviewPending: false, rigReviewDecision: '' };
    if (changedStatic.has(modelKey(file.normalizedName))) return { ...file, rigNeedsUpdate: true, rigReviewPending: true, rigReviewDecision: '' };
    return file;
  });
}

export function characterRigProgress(asset) {
  const groups = asset?.meta?.componentView ? [activeCharacterFiles(asset)]
    : characterModelGroups(asset).map(part => part.files);
  const uploaded = groups.filter(files => files.some(file => isModelFile(file) && characterMeshKind(file) === 'skeletalMesh')).length;
  const stale = groups.filter(files => files.some(file => isModelFile(file) && characterMeshKind(file) === 'skeletalMesh' && file.rigNeedsUpdate)).length;
  const pendingReview = groups.filter(files => files.some(file => isModelFile(file) && characterMeshKind(file) === 'skeletalMesh' && file.rigReviewPending)).length;
  const reviewedUnchanged = groups.filter(files => files.some(file => isModelFile(file) && characterMeshKind(file) === 'skeletalMesh' && !file.rigNeedsUpdate && file.rigReviewDecision === 'not-required')).length;
  const staticReady = Boolean(groups.length > 0
    && groups.every(files => files.some(file => isModelFile(file) && characterMeshKind(file) === 'staticMesh')));
  const complete = groups.length > 0 && uploaded === groups.length && stale === 0 && pendingReview === 0;
  return { total: groups.length, uploaded, stale, pendingReview, reviewedUnchanged,
    staticReady, complete, needsAttention: staticReady && !complete };
}

// Reject a decision made against an older model version.
export function characterRigReviewSignature(asset) {
  return JSON.stringify(activeCharacterFiles(asset).filter(isModelFile).map(file =>
    [file.storedPath, file.sha256 || '', Boolean(file.rigNeedsUpdate), Boolean(file.rigReviewPending)]).sort());
}

// Update/rigging identities include the root model of a face, NPC, weapon or
// monster. They do not create extra cards or apply outfit slot rules.
export function characterModelGroups(asset) {
  if (!asset || !['suit', 'monster', 'npc', 'weapon', 'item'].includes(asset.assetType)) return [];
  if (['weapon', 'monster', 'npc', 'item'].includes(asset.assetType) && !asset.meta?.componentView) return characterModelPreviewComponents(asset);
  const parts = listCharacterComponents(asset);
  const files = activeCharacterFiles(asset);
  const groups = new Map(parts.map(part => [part.slot, part]));
  for (const file of files.filter(isModelFile)) {
    if (asset.assetType === 'suit' && !heroPartKind(asset.meta?.character) && !heroSuitPart(file.normalizedName || file.storedPath)) continue;
    if (!/\.fbx$/i.test(file.normalizedName || file.storedPath) || /_LOD[1-9]\d*\./i.test(file.normalizedName)) continue;
    const slot = modelKey(file.normalizedName);
    if (groups.has(slot)) continue;
    const models = files.filter(item => isModelFile(item) && modelKey(item.normalizedName) === slot);
    groups.set(slot, { slot, name: stem(file.normalizedName), role: 'part', files: models,
      meshKinds: { staticMesh: models.some(item => characterMeshKind(item) === 'staticMesh'),
        skeletalMesh: models.some(item => characterMeshKind(item) === 'skeletalMesh') } });
  }
  return [...groups.values()];
}

export function characterDisplayName(asset) {
  if (asset.meta?.componentView) return asset.name;
  if (asset.assetType === "monster") {
    const fields = asset.meta?.character || {};
    return buildMonsterAssetName(fields.name || "", fields.formIds || []) || asset.name;
  }
  return asset.name;
}

// Missing outfit parts are upload destinations only; they must not enter the
// catalog, rig progress, previews or UE export until a model is actually saved.
export function characterModelUpdateGroups(asset) {
  const groups = characterModelGroups(asset);
  if (asset?.assetType !== 'suit' || asset.meta?.componentView || heroPartKind(asset.meta?.character)) return groups;
  const subject = characterDisplayName(asset).replace(/^(?:SM|SK)_/i, '');
  return ['Head', 'Upbody', 'Downbody', 'Arm'].map(part => groups.find(group => heroSuitPart(group.name + '.fbx') === part)
    || { slot: `${subject}_${part}`.toLowerCase(), name: `${subject}_${part}`, role: 'part', files: [], meshKinds: { staticMesh: false, skeletalMesh: false } });
}

export function componentParentId(id) { return String(id || "").split(COMPONENT_SEPARATOR)[0]; }

export function characterComponentLabel(part, language = "zh") {
  const suffix = part.name.split("_").at(-1) || part.name;
  if (part.role === "weapon") return part.label || suffix;
  const labels = { arm: ["臂部", "Arms"], hand: ["手部", "Hands"], hands: ["手部", "Hands"], upbody: ["上装", "Upper Body"], upperbody: ["上装", "Upper Body"],
    downbody: ["下装", "Lower Body"], head: ["头部", "Head"], shoe: ["鞋靴", "Footwear"], foot: ["鞋靴", "Footwear"], feet: ["鞋靴", "Footwear"] };
  return labels[suffix.toLowerCase()]?.[language === "en" ? 1 : 0] || suffix;
}

export function listCharacterComponents(asset) {
  if (heroPartKind(asset?.meta?.character)) return [];
  return characterModelPreviewComponents(asset).filter(part => ['monster', 'npc'].includes(asset.assetType)
    ? part.role === 'weapon' || part.slot !== modelKey(characterDisplayName(asset) + '.fbx')
    : asset.assetType !== 'weapon'
    || (part.slot !== modelKey(characterDisplayName(asset) + '.fbx')
      && part.files.some(file => file.componentRole === 'part' || /_Part_/i.test(file.normalizedName))));
}

// Monster, NPC and weapon model records live inside the owner detail panel.
export function characterModelPreviewComponents(asset) {
  if (!asset || asset.meta?.componentView || !["monster", "suit", "npc", "weapon", "item"].includes(asset.assetType)) return [];
  const manifest = asset.meta?.characterManifest?.files || [];
  const candidates = manifest.filter(file => isModelFile(file) && !/\.abc$/i.test(file.storedPath || file.normalizedName));
  const groups = new Map();
  for (const model of candidates) {
    const name = model.normalizedName || base(model.storedPath);
    if (asset.assetType === 'suit' && !heroPartKind(asset.meta?.character) && !heroSuitPart(name)) continue;
    const slot = modelKey(name);
    if (!groups.has(slot)) groups.set(slot, { models: [], name: stem(name).replace(/_LOD\d+$/i, "") });
    groups.get(slot).models.push(model);
  }
  const components = [...groups].map(([slot, { models, name }]) => {
    const subject = slot;
    const initialFiles = manifest.filter(item => {
      const token = stem(item.normalizedName || item.storedPath).replace(/^(?:SK|SM|SKEL|MI|T)_/i, "").toLowerCase();
      if (token !== subject && !token.startsWith(subject + "_")) return false;
      // A body's prefix also matches its owned weapon. Assign each resource to
      // the most specific model identity so previews/updates stay independent.
      return !['monster', 'npc'].includes(asset.assetType) || ![...groups.keys()].some(other =>
        other.length > subject.length && (token === other || token.startsWith(other + '_')));
    });
    const saved = asset.meta?.characterComponents?.slots?.[slot];
    const initial = { id: asset.meta?.characterComponents?.baseRevision || "initial", files: initialFiles, createdAt: asset.createdAt || "", name, previewUri: "", previewRevision: "" };
    const revisions = [initial, ...(saved?.revisions || [])];
    const current = revisions.find(item => item.id === saved?.activeRevision) || initial;
    const previewUri = saved?.previewUri || current.previewUri || "";
    const previewImages = Array.isArray(saved?.previewImages) && saved.previewImages.length
      ? saved.previewImages
      : (previewUri ? [{ uri: previewUri, tags: ["preview", "view:front", "cover"] }] : []);
    const previewRevision = saved?.previewRevision || current.previewRevision || "";
    const meshFiles = current.files.filter(isModelFile);
    const meshKinds = {
      staticMesh: meshFiles.some(file => characterMeshKind(file) === "staticMesh"),
      skeletalMesh: meshFiles.some(file => characterMeshKind(file) === "skeletalMesh")
    };
    const savedMeshPreviews = saved?.meshPreviews || {};
    const legacyPreviewKind = meshKinds.staticMesh ? "staticMesh" : meshKinds.skeletalMesh ? "skeletalMesh" : "";
    const meshPreviews = Object.fromEntries(["staticMesh", "skeletalMesh"].map(kind => [kind, {
      ...savedMeshPreviews[kind],
      previewUri: savedMeshPreviews[kind]?.previewUri || (kind === legacyPreviewKind ? previewUri : ""),
      previewRevision: savedMeshPreviews[kind]?.previewRevision || (kind === legacyPreviewKind && previewRevision === current.id ? characterMeshPreviewRevision(current.files, kind) : ""),
      previewOrigin: savedMeshPreviews[kind]?.previewOrigin || (kind === legacyPreviewKind ? saved?.previewOrigin || 'manual' : 'rendered'),
      previewImages: savedMeshPreviews[kind]?.previewImages || (kind === legacyPreviewKind ? previewImages : [])
    }]));
    const model = models.find(item => characterMeshKind(item) === "skeletalMesh") || models[0];
    return { id: `${asset.id}${COMPONENT_SEPARATOR}${encodeURIComponent(slot)}`, parentId: asset.id, slot,
      name: current.name || name, label: model.componentName || name.replace(/^(?:SK|SM)_/i, ""),
      role: model.componentRole === "weapon" || (["monster", "npc"].includes(asset.assetType) && /_WP_/i.test(name)) ? "weapon" : "part", sharedAcrossForms: model.sharedAcrossForms === true,
      currentRevision: current.id, updatedAt: saved?.updatedAt || current.createdAt, files: current.files, revisions, previewUri, previewImages, previewRevision,
      meshKinds, meshPreviews,
      previewGalleryRevision: saved?.previewGalleryRevision || "",
      previewOrigin: saved?.previewOrigin || "manual",
      previewState: !previewUri ? "missing" : previewRevision !== current.id ? "stale" : "current" };
  });
  // A suit part can use another material group (for example a cape). Its preview
  // signature must include the same active texture pool used by the renderer.
  // Keep the owned file inventory unchanged for versioning and updates.
  if (asset.assetType === 'suit') {
    let active = [...manifest];
    for (const part of components) {
      if (part.currentRevision === part.revisions[0].id) continue;
      const replaced = new Set(part.revisions[0].files.map(file => file.storedPath));
      active = [...active.filter(file => !replaced.has(file.storedPath)), ...part.files];
    }
    const textures = [...new Map(active.filter(file => file.role === 'texture').map(file => [file.storedPath, file])).values()];
    for (const part of components) part.previewFiles = [...part.files.filter(file => file.role !== 'texture'), ...textures];
  }
  // Presentation only: stable slot IDs, ownership and stored files are unchanged.
  if (asset.assetType === "suit") components.sort((a, b) =>
    (suitPartOrder.get(heroSuitPart(a.name + '.fbx').toLowerCase()) ?? suitPartOrder.size)
    - (suitPartOrder.get(heroSuitPart(b.name + '.fbx').toLowerCase()) ?? suitPartOrder.size));
  return components;
}

export function needsCharacterComponentPreview(part) {
  return !part.previewUri || (part.previewOrigin === "rendered-front" && part.previewRevision !== part.currentRevision);
}

export function characterPreviewState(asset) {
  const view = asset.meta?.componentView;
  if (view) {
    const kind = view.visibleMeshKind || (view.meshKinds?.staticMesh ? 'staticMesh' : 'skeletalMesh');
    return view.meshSlots?.[kind]?.previewState || view.previewState;
  }
  if (!asset.previewImage && !asset.preview && !asset.detailImage) return "missing";
  // Suit jobs are driven by affected static views, not the revision of every
  // resource. SK-only uploads and manual direction images need no owner render.
  if (asset.assetType === 'suit' && !heroPartKind(asset.meta?.character)) return characterSuitPendingPreviewViews(asset).length ? 'stale' : 'current';
  const state = asset.meta?.characterComponents;
  if (Array.isArray(state?.autoPreviewPendingViews)) return state.autoPreviewPendingViews.length ? 'stale' : 'current';
  return state?.contentRevision && state.contentRevision !== state.previewRevision ? "stale" : "current";
}

export function activeCharacterFiles(asset) {
  let files = [...(asset.meta?.characterManifest?.files || [])];
  for (const part of characterModelPreviewComponents(asset)) {
    const initial = part.revisions[0];
    if (part.currentRevision === initial.id) continue;
    const originalPaths = new Set(initial.files.map(file => file.storedPath));
    files = [...files.filter(file => !originalPaths.has(file.storedPath)), ...part.files];
  }
  return files;
}

export function componentAssetRecord(parent, part) {
  // Related cards and generic detail consumers use the same prepared mesh
  // previews as the SM/SK cards, including immediately after first import.
  const primaryKind = part.meshKinds?.staticMesh ? 'staticMesh' : 'skeletalMesh';
  const primary = part.meshPreviews?.[primaryKind];
  const previewUri = primary?.previewUri || part.previewUri;
  const images = primary?.previewUri ? primary.previewImages || [] : part.previewImages || [];
  const preview = previewUri ? join(parent.path, previewUri) : null;
  const previewImages = images.map(item => ({ path: join(parent.path, item.uri), tags: item.tags || [] }));
  const meshSlots = Object.fromEntries(["staticMesh", "skeletalMesh"].map(kind => [kind, {
    hasModel: Boolean(part.meshKinds?.[kind]),
    previewState: !part.meshPreviews?.[kind]?.previewUri ? 'missing' : needsCharacterMeshPreview(part, kind) ? 'stale' : 'current',
    modelFiles: part.files.filter(file => isPrimaryModel(file) && characterMeshKind(file) === kind).map(file => join(parent.path, file.storedPath)),
    previewPath: part.meshPreviews?.[kind]?.previewUri ? join(parent.path, part.meshPreviews[kind].previewUri) : "",
    previewGalleryRevision: part.meshPreviews?.[kind]?.previewGalleryRevision || part.meshPreviews?.[kind]?.previewRevision || part.currentRevision,
    images: part.meshPreviews?.[kind]?.previewImages || [],
    previewImages: (part.meshPreviews?.[kind]?.previewImages || []).map(item => ({ path: join(parent.path, item.uri), tags: item.tags || [] }))
  }]));
  return { ...parent, id: part.id, assetID: part.id, name: part.name,
    modelFiles: part.files.filter(isPrimaryModel).map(file => join(parent.path, file.storedPath)),
    textureFiles: part.files.filter(file => file.role === "texture").map(file => join(parent.path, file.storedPath)),
    preview, previewImage: preview, detailImage: preview, previewImages,
    meta: { ...parent.meta, componentView: { parentId: parent.id, slot: part.slot, role: part.role, sharedAcrossForms: part.sharedAcrossForms, currentRevision: part.currentRevision, previewGalleryRevision: part.previewGalleryRevision, previewState: part.previewState, meshKinds: part.meshKinds, meshSlots,
      missingTextures: Boolean(part.meshKinds.staticMesh && !(part.previewFiles || part.files).some(file => file.role === 'texture')) },
      previews: { images, relativeSize: "1x1" },
      characterManifest: { ...parent.meta?.characterManifest, contentUpdatedAt: part.updatedAt, lastUpdateSummary: "", files: part.files, fileCount: part.files.length } } };
}

// Select a model for an owner's detail viewer without changing catalog ownership.
export function characterMeshAssetRecord(parent, part, kind) {
  const card = componentAssetRecord(parent, part);
  const view = card.meta.componentView;
  const mesh = view.meshSlots[kind];
  const preview = mesh.previewPath || null;
  return { ...card, name: card.name.replace(/^(?:SM|SK)_/i, kind === 'staticMesh' ? 'SM_' : 'SK_'),
    modelFiles: mesh.modelFiles, preview, previewImage: preview, detailImage: preview, previewImages: mesh.previewImages,
    meta: { ...card.meta, previews: { images: mesh.images, relativeSize: '1x1' },
      componentView: { ...view, visibleMeshKind: kind, previewGalleryRevision: mesh.previewGalleryRevision } } };
}

// Incoming parent order is already grouped by Monster identity. Emit all forms
// first, then their components; parts never enter the form-counting collection.
export function expandCharacterCards(assets) {
  const result = [];
  for (let i = 0; i < assets.length;) {
    const first = assets[i];
    const familyKey = first.assetType === "monster" ? (first.meta?.character?.entityKey || first.id) : first.id;
    const parents = [first];
    i += 1;
    while (first.assetType === "monster" && i < assets.length && assets[i].assetType === "monster"
      && (assets[i].meta?.character?.entityKey || assets[i].id) === familyKey) parents.push(assets[i++]);
    result.push(...parents.map(asset => ({ ...asset, name: characterDisplayName(asset) })));
    for (const parent of parents) if (!['monster', 'npc'].includes(parent.assetType)) {
      for (const part of listCharacterComponents(parent)) result.push(componentAssetRecord(parent, part));
    }
  }
  return result;
}
