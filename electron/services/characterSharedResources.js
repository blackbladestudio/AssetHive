const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeFileAtomic } = require('./atomicFile');
const { safePath, withRecycleLock } = require('./libraryRecycle');
const { transactionalFs, withFileTransaction } = require('./assetFileTransaction');

// Identity survives content changes. Hashes prove initial equivalence only.
const registryPath = root => path.join(root, '.assethive', 'CharacterResources.json');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const refKey = ref => JSON.stringify([ref.assetId, ref.localKey]);
const empty = () => ({ version: 1, revision: 0, resources: {} });
const normalizedEvidence = evidence => evidence.kind === 'texture'
  ? { ...evidence, sourceHash: evidence.sourceHash.toLowerCase() } : evidence;
const evidenceDigest = evidence => digest(normalizedEvidence(evidence));

function sameResourceContent(left, right) {
  if (left.kind !== right.kind) return false;
  return left.kind === 'texture'
    ? left.sourceHash.toLowerCase() === right.sourceHash.toLowerCase() && left.channel === right.channel
    : digest(left.textures) === digest(right.textures);
}

function validateEvidence(evidence) {
  if (!evidence || !['texture', 'material'].includes(evidence.kind)) throw new Error('共享资源只能是贴图或材质');
  if (!evidence.config || typeof evidence.config !== 'object' || Array.isArray(evidence.config)) throw new Error('缺少材质或贴图设置，请重新检查');
  if (evidence.kind === 'texture' && (!/^[a-f0-9]{64}$/i.test(evidence.sourceHash || '') || !evidence.channel)) throw new Error('贴图内容尚未核对，请重新检查');
  if (evidence.kind === 'material' && (!evidence.parentPath || !evidence.textures || typeof evidence.textures !== 'object' || Array.isArray(evidence.textures))) throw new Error('材质引用尚未核对，请重新检查');
}

function validateRef(ref) {
  if (!ref?.assetId || !ref.localKey || !ref.metadataPath || path.isAbsolute(ref.metadataPath)
    || /^[A-Za-z]:/.test(ref.metadataPath) || ref.metadataPath.replaceAll('\\', '/').split('/').some(part => part === '..' || part === '.assethive')) {
    throw new Error('共享资源所属资产记录无效，请刷新后重试');
  }
}

function validateTarget(target) {
  if (!target?.key || !/^\/Game\/[A-Za-z0-9_/]+$/.test(target.path || '')) throw new Error('共享资源缺少有效的引擎目标位置');
}

function validateRegistry(state) {
  if (state?.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !state.resources || typeof state.resources !== 'object' || Array.isArray(state.resources)) throw new Error('共享资源记录无法读取，请联系 TA；原记录未改动');
  const refs = new Set();
  const targets = new Set();
  const targetPaths = new Set();
  for (const [id, resource] of Object.entries(state.resources)) {
    if (resource.id !== id || !Number.isSafeInteger(resource.revision) || resource.revision < 1 || !Array.isArray(resource.references)) throw new Error('共享资源记录不完整，请联系 TA');
    validateEvidence(resource.evidence);
    validateTarget(resource.ueTarget);
    const targetPath = resource.ueTarget.path.toLowerCase();
    if (targets.has(resource.ueTarget.key) || targetPaths.has(targetPath)) throw new Error('不同共享资源使用了相同引擎目标，请联系 TA');
    targets.add(resource.ueTarget.key);
    targetPaths.add(targetPath);
    if (resource.evidence.kind === 'material' && Object.values(resource.evidence.textures).some(key => state.resources[key]?.evidence?.kind !== 'texture')) throw new Error('共享材质引用的贴图记录缺失，请联系 TA');
    for (const ref of resource.references) {
      validateRef(ref);
      const key = refKey(ref);
      if (refs.has(key)) throw new Error('同一文件关联了多个共享资源，请联系 TA');
      refs.add(key);
    }
  }
  return state;
}

// Explicitly related import batches may share proven equal resources. A name,
// an empty group, or identical bytes with different settings is insufficient.
function registerResource(input, { reference, evidence, scopeId, ueTarget, resourceId }) {
  const state = globalThis.structuredClone(validateRegistry(input));
  validateRef(reference); validateEvidence(evidence);
  const existing = Object.values(state.resources).find(resource => resource.references.some(ref => refKey(ref) === refKey(reference)));
  if (existing) {
    if (evidenceDigest(existing.evidence) !== evidenceDigest(evidence)) throw new Error('这份共享资源已变化，请使用更新入口查看影响范围');
    const index = existing.references.findIndex(ref => refKey(ref) === refKey(reference));
    if (digest(existing.references[index]) !== digest(reference)) {
      existing.references[index] = globalThis.structuredClone(reference);
      state.revision++;
      return { state: validateRegistry(state), resource: existing, changed: true };
    }
    return { state: input, resource: existing, changed: false };
  }
  if (evidence.kind === 'material') {
    for (const id of Object.values(evidence.textures)) {
      if (state.resources[id]?.evidence.kind !== 'texture') throw new Error('材质引用的共享贴图尚未登记');
    }
  }
  let resource = scopeId && Object.values(state.resources).find(candidate => candidate.scopeId === scopeId && evidenceDigest(candidate.evidence) === evidenceDigest(evidence));
  if (!resource) {
    validateTarget(ueTarget);
    const id = resourceId || randomUUID();
    if (state.resources[id]) throw new Error('共享资源身份已变化，请重新检查');
    resource = { id, scopeId: scopeId || null, revision: 1, evidence: globalThis.structuredClone(normalizedEvidence(evidence)), ueTarget: globalThis.structuredClone(ueTarget), references: [] };
    state.resources[id] = resource;
  }
  resource.references.push(globalThis.structuredClone(reference));
  state.revision++;
  validateRegistry(state);
  return { state, resource, changed: true };
}

function planResourceUpdate(state, id, evidence) {
  validateRegistry(state); validateEvidence(evidence);
  const resource = state.resources[id];
  if (!resource || resource.evidence.kind !== evidence.kind) throw new Error('共享资源已变化，请重新检查');
  if (evidence.kind === 'material' && Object.values(evidence.textures).some(key => state.resources[key]?.evidence.kind !== 'texture')) throw new Error('材质引用的共享贴图尚未登记');
  const affected = new Set([id]);
  for (const candidate of Object.values(state.resources)) {
    if (candidate.evidence.kind === 'material' && Object.values(candidate.evidence.textures).includes(id)) affected.add(candidate.id);
  }
  const references = [...new Map([...affected].flatMap(key => state.resources[key].references).map(ref => [refKey(ref), ref])).values()];
  const plan = { resourceId: id, registryRevision: state.revision, resourceRevision: resource.revision,
    evidence: globalThis.structuredClone(normalizedEvidence(evidence)), references, affectedResourceIds: [...affected].sort(),
    unchanged: evidenceDigest(resource.evidence) === evidenceDigest(evidence) };
  return { ...plan, token: digest(plan) };
}

function applyResourceUpdate(input, plan) {
  const current = planResourceUpdate(input, plan.resourceId, plan.evidence);
  if (current.token !== plan.token) throw new Error('共享资源或使用它的资产已变化，请重新检查影响范围');
  if (current.unchanged) return input;
  const state = globalThis.structuredClone(input);
  state.resources[plan.resourceId].evidence = globalThis.structuredClone(current.evidence);
  state.resources[plan.resourceId].revision++;
  state.revision++;
  return state;
}

function removeOwnerReferences(input, assetId) {
  const state = globalThis.structuredClone(validateRegistry(input));
  let changed = false;
  for (const resource of Object.values(state.resources)) {
    const remaining = resource.references.filter(ref => ref.assetId !== assetId);
    if (remaining.length !== resource.references.length) {
      resource.references = remaining;
      changed = true;
    }
  }
  if (changed) state.revision++;
  return changed ? validateRegistry(state) : input;
}

function removeResourceReferences(input, resourceId, references) {
  const state = globalThis.structuredClone(validateRegistry(input));
  const resource = state.resources[resourceId];
  if (!resource) throw new Error('共享贴图已变化，请重新检查');
  const keys = new Set(references.map(refKey));
  const next = resource.references.filter(ref => !keys.has(refKey(ref)));
  if (resource.references.length - next.length !== keys.size) throw new Error('共享贴图引用已变化，请重新检查');
  resource.references = next;
  state.revision++;
  return validateRegistry(state);
}

function renameOwnerReferences(input, assetId, oldName, newName, renamedFiles) {
  const state = globalThis.structuredClone(validateRegistry(input));
  const token = value => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const before = token(oldName), after = token(newName);
  let changed = false;
  for (const resource of Object.values(state.resources)) for (const ref of resource.references) {
    if (ref.assetId !== assetId) continue;
    const nextName = renamedFiles.get(String(ref.sourceName || '').toLowerCase());
    if (nextName && nextName !== ref.sourceName) { ref.sourceName = nextName; changed = true; }
    // Export group keys are normalized tokens; owner IDs and channel names are
    // not renamed. The shared UE identity remains stable for every other user.
    const prefix = `${assetId}:${resource.evidence.kind}:`;
    if (before && ref.localKey.startsWith(prefix)) {
      const suffix = ref.localKey.slice(prefix.length).split(':');
      const next = suffix[0].replaceAll(before, after);
      if (next !== suffix[0]) { suffix[0] = next; ref.localKey = prefix + suffix.join(':'); changed = true; }
    }
  }
  if (changed) state.revision++;
  return changed ? validateRegistry(state) : input;
}

async function readRegistry(root) {
  const file = await safePath(root, registryPath(root), { allowPrivate: true, missing: true });
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  return validateRegistry(JSON.parse(text));
}

// Caller must already hold the library lock and a file transaction.
async function writeRegistryInTransaction(root, state) {
  validateRegistry(state);
  const file = await safePath(root, registryPath(root), { allowPrivate: true, missing: true });
  await transactionalFs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(state, null, 2));
}

// The caller's asset file/metadata writes participate in this same journal.
// Never call while already holding the library lock.
async function mutateRegistry(root, mutate) {
  return withRecycleLock(root, () => withFileTransaction({ root, owner: 'character-shared-resources', key: registryPath(root) }, async () => {
    const before = await readRegistry(root);
    const result = await mutate(globalThis.structuredClone(before));
    validateRegistry(result.state);
    if (digest(before) !== digest(result.state)) {
      const file = await safePath(root, registryPath(root), { allowPrivate: true, missing: true });
      await transactionalFs.mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, JSON.stringify(result.state, null, 2));
    }
    return result;
  }));
}

// Produce one UE entry per shared resource while retaining every local receipt
// alias. Callers must persist receipts for all aliases, not only the first owner.
function projectSharedEntries(state, suits) {
  validateRegistry(state);
  const byReference = new Map();
  for (const resource of Object.values(state.resources)) {
    for (const ref of resource.references) byReference.set(refKey(ref), resource);
  }
  const remap = new Map();
  const aliases = {};
  const resourceByTarget = new Map();
  const projected = globalThis.structuredClone(suits);
  for (const suit of projected) {
    for (const entry of suit.entries) {
      const resource = byReference.get(refKey({ assetId: suit.assetId, localKey: entry.key }));
      if (!resource) continue;
      const expectedKind = resource.evidence.kind;
      if (entry.kind !== expectedKind) throw new Error('共享资源类型已变化，请重新检查');
      const evidence = entry.kind === 'texture'
        ? { kind: entry.kind, sourceHash: entry.sourceHash, channel: entry.channel, config: entry.config }
        : { kind: entry.kind, parentPath: entry.config?.parentPath, config: entry.config,
          textures: Object.fromEntries(Object.entries(entry.textures || {}).map(([slot, key]) => {
            const dependency = byReference.get(refKey({ assetId: suit.assetId, localKey: key }));
            if (dependency?.evidence.kind !== 'texture') throw new Error('共享材质引用的贴图尚未登记，请重新检查');
            return [slot, dependency.id];
          })) };
      validateEvidence(evidence);
      if (evidenceDigest(evidence) !== evidenceDigest(resource.evidence)) throw new Error('共享资源的内容或设置不一致，请先更新共享资源');
      if (entry.kind === 'texture') entry.sourceHash = entry.sourceHash.toLowerCase();
      const target = resource.ueTarget;
      resourceByTarget.set(target.key, resource);
      if (remap.has(entry.key) && remap.get(entry.key) !== target.key) throw new Error('资源引用不一致，请联系 TA');
      remap.set(entry.key, target.key);
      (aliases[target.key] ||= []).push({ assetId: suit.assetId, localKey: entry.key, name: entry.name });
      entry.key = target.key;
      entry.targetPath = target.path;
      if (entry.associationNames) {
        entry.associationReferenceKeys = resource.references.map(ref => ref.localKey);
      }
    }
  }
  const emitted = new Map();
  for (const suit of projected) {
    suit.entries = suit.entries.filter(entry => {
      for (const field of ['materials', 'textures']) {
        if (entry[field]) entry[field] = Object.fromEntries(Object.entries(entry[field]).map(([slot, key]) => [slot, remap.get(key) || key]));
      }
      if (!aliases[entry.key]) return true;
      // Local source locations and labels may differ; the payload must agree.
      const { sourcePath, name, partSlot, groupName, fingerprint, sourceHash, associationNames, associationReferenceKeys, ...proof } = entry;
      if (entry.kind === 'texture') proof.sourceHash = sourceHash;
      const resource = resourceByTarget.get(entry.key);
      if (entry.kind === 'material') entry.sourceHash = evidenceDigest(resource.evidence);
      entry.fingerprint = digest({ resourceId: resource.id, revision: resource.revision, ...proof });
      const signature = digest(proof);
      if (emitted.has(entry.key)) {
        if (emitted.get(entry.key) !== signature) throw new Error('共享资源的内容或设置不一致，请先更新共享资源');
        const first = projected.flatMap(value => value.entries).find(value => value.key === entry.key);
        if (associationNames && first) first.associationNames = [...new Set([...(first.associationNames || []), ...associationNames])];
        return false;
      }
      emitted.set(entry.key, signature);
      return true;
    });
  }
  return { suits: projected, aliases };
}

// Shared choices must agree before a request reaches UE; a skipped alias must
// never silently overwrite another owner's explicit update choice.
function projectSharedDecisions(decisions, aliases) {
  const result = { ...decisions };
  for (const [key, owners] of Object.entries(aliases)) {
    const choices = [...new Set(owners.map(owner => decisions[owner.localKey]).filter(Boolean))];
    if (choices.length > 1) throw new Error('同一共享资源选择了不同处理方式，请统一后再发送');
    for (const owner of owners) delete result[owner.localKey];
    if (choices.length) result[key] = choices[0];
  }
  return result;
}

function expandSharedReceipts(rows, aliases) {
  const result = [];
  const seen = new Set();
  for (const row of rows) {
    const owners = aliases[row.key] || [{ assetId: row.assetId, localKey: row.key }];
    for (const owner of owners) {
      const identity = refKey(owner);
      if (seen.has(identity)) throw new Error('引擎返回了重复的资源结果，请重新检查');
      seen.add(identity);
      result.push({ ...globalThis.structuredClone(row), assetId: owner.assetId, key: owner.localKey,
        ...(owner.name ? { name: owner.name } : {}),
        ...(aliases[row.key] ? { sharedEntryKey: row.key } : {}) });
    }
  }
  return result;
}

module.exports = { empty, evidenceDigest, sameResourceContent, registerResource, planResourceUpdate, applyResourceUpdate, removeOwnerReferences, removeResourceReferences, renameOwnerReferences, readRegistry, writeRegistryInTransaction, mutateRegistry, projectSharedEntries, projectSharedDecisions, expandSharedReceipts };
