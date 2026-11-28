const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

// Exercise the actual submit handler with an isolated IPC bridge, without
// writing assets or modifying the user's library/settings.
const source = fs.readFileSync(path.join(__dirname, "../src/ui/App.tsx"), "utf8");
test("character save events update visible import progress independently of scan events", () => {
  const parsed = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  (function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'bridge.onCustomSaveProgress') callback = node.arguments[0].getText(parsed);
    ts.forEachChild(node, visit);
  })(parsed);
  assert.ok(callback);
  const js = ts.transpileModule(`const callback = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const updates = [];
  const state = { importSavingRef: { current: true }, characterBusyRef: { current: false }, bridge: {}, customSaveClearTimerRef: { current: {} },
    setSavingProgressMap() {}, setCharacterImportProgress: value => updates.push(value) };
  const run = new Function('state', `with (state) { ${js}; return callback; }`)(state);
  run({ assetId: 'suit', progress: 40, message: 'character:正在保存贴图 15/21' });
  assert.deepEqual(updates, [{ progress: 40, message: '正在保存贴图 15/21' }]);
  run({ assetId: 'environment', progress: 50, message: 'saving' });
  state.importSavingRef.current = false;
  run({ assetId: 'suit', progress: 60, message: 'character:正在整理文件信息' });
  assert.equal(updates.length, 1);
});

test("character package picker and drop zone inspect through the same flow without bubbling or overlapping work", async () => {
  const handlers = source.slice(source.indexOf("  async function pickCharacterPackageFolder("), source.indexOf("  async function confirmMixedCharacterPackageScopes("));
  const js = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = [];
  const state = {
    bridgeAvailable: true, bridge: { pickAssetFolder: async () => "C:/new-package" },
    quickDropBusy: false, characterPreviewGenerating: false, importModalLocked: false,
    importForm: { assetType: "suit", characterFields: {} },
    isCharacterAssetType: type => type === "suit", heroPartKind: () => "",
    applyQuickDropImport: async (...args) => calls.push(args),
    readDroppedPathsFromEvent: async event => event.paths
  };
  const { pick, drop } = new Function("state", `with (state) { ${js}; return { pick: pickCharacterPackageFolder, drop: dropCharacterPackage }; }`)(state);
  let stopped = 0;
  const event = { paths: ["C:/new-package"], preventDefault() { stopped++; }, stopPropagation() { stopped++; } };
  await pick();
  await drop(event);
  assert.deepEqual(calls, [[event.paths, "suit", ""], [event.paths, "suit", ""]]);
  assert.equal(stopped, 2);
  for (const key of ["quickDropBusy", "characterPreviewGenerating", "importModalLocked"]) {
    state[key] = true;
    await drop(event);
    state[key] = false;
  }
  assert.equal(calls.length, 2);
});

test("switching character import type clears the current package without changing its queue identity", () => {
  const handler = source.slice(source.indexOf("  function handleImportAssetTypeChange("), source.indexOf("  function handleEditAssetTypeChange("));
  const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const next of ["monster", "npc", "weapon", "Face", "suit"]) {
    let form = { queueId: "current", assetType: "suit", characterFields: { variant: "Hair", confirmed: true }, characterPackageFiles: ["SK_M01_Hair_Test.FBX"], previewImagePath: "old.png", destinationPath: "old", assetName: "old", modelSlots: { Mesh: "old.fbx" } };
    const fresh = type => ({ assetType: type, queueId: "new", characterFields: {}, characterPackageFiles: [], previewImagePath: "", destinationPath: "default", assetName: "New Asset", modelSlots: {} });
    const pendingScan = { current: 'previous-scan' };
    const run = new Function("importForm", "setImportForm", "setCharacterTypeAcknowledged", "heroPartKind", "isCharacterAssetType", "buildFreshImportForm", "setCharacterCollision", "quickDropRequestIdRef", "setQuickDropBusy", "setCharacterPreviewGenerating", `${js}; return handleImportAssetTypeChange;`)(form, update => { form = update(form); }, () => {}, fields => fields.variant || "", type => ["suit", "monster", "npc", "weapon"].includes(type), fresh, () => {}, pendingScan, () => {}, () => {});
    run(next);
    assert.equal(pendingScan.current, '');
    assert.equal(form.queueId, "current");
    assert.equal(form.assetType, next === "Face" ? "suit" : next);
    assert.deepEqual(form.characterPackageFiles, []);
    assert.deepEqual(form.modelSlots, {});
    assert.equal(form.previewImagePath, "");
    assert.equal(form.destinationPath, "");
    assert.equal(form.assetName, "");
    assert.equal(form.characterFields.confirmed, false);
    assert.equal(form.characterFields.variant, next === "Face" ? "Face" : "");
  }
});
test("family identity corrections belong to confirmation and invalidate derived data", () => {
  assert.equal((source.match(/renderFamilyIdentityEditor\(\)/g) || []).length, 2);
  const editor = source.slice(source.indexOf("  function renderFamilyIdentityEditor()"), source.indexOf("  function renderCharacterImportConfirmation()"));
  assert.ok(editor.includes("getSubCategoryOptions(importForm.assetType)"));
  assert.ok(editor.includes("getDefaultImportDestinationPath("));
  assert.ok(editor.includes("identityConfirmed"));
  assert.ok(editor.includes("serial: event.target.value"));
  assert.ok(editor.includes('readOnly placeholder='));
  assert.ok(editor.includes('gameplayUsesResourceId(importForm.subCategory)'));
  assert.ok(editor.includes('与资源 ID 同步'));
  assert.ok(editor.includes('与英文名同步'));
  assert.ok(editor.includes("readOnly"));
  assert.ok(source.includes('...patch, confirmed: false'));
  assert.ok(source.includes('assetName: isCharacterAssetType(form.assetType) ? composedName : form.assetName'));
});
test("character confirmation owns identity corrections without redundant hints", () => {
  assert.equal((source.match(/renderHeroIdentityEditor\(\)/g) || []).length, 2);
  assert.ok(source.includes('{form.assetType === "suit" && renderHeroIdentityEditor()}'));
  assert.ok(source.includes('characterFields.maturityConfirmed === true'));
  assert.ok(source.includes('maturityConfirmed: true'));
  assert.ok(source.includes('confirmSameValue'));
  assert.ok(!source.includes("用于卡片竖排展示，不改动模型文件名。"));
  assert.ok(!source.includes("源文件不会被修改；确认前只做扫描和命名预览。"));
});
const handlers = source.slice(source.indexOf("  function showImportSaveFailure("), source.indexOf("  async function deleteCustomAsset("));
const compiled = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(resolve) {
  const form = { assetName: "My asset", assetType: "3d", subCategory: "Other", textureEntries: [], modelSlots: { Mesh: "D:\\input.fbx" }, normalMapFormats: {}, normalMapFormat: "dx", previewImagePath: "", tagsText: "" };
  const state = {
    ...require("../shared/maskMaterials.mjs"),
    importForm: form, defaultImportForm: {}, importSaving: false, busy: false, bridgeAvailable: true, assetModalMode: "import", importDuplicateCheckEnabled: false,
    setCharacterTaskIds: () => {}, setImportSidebarCollapsed: () => {},
    finishCharacterImportTasks: require('../shared/characterImportTasks.mjs').finishCharacterImportTasks,
    liveImportDraftRef: { current: { form, tagInput: '' } },
    importDrafts: [], activeImportIndex: 0, importTagInput: "",
    importDraftsRef: { current: [] }, importSavingRef: { current: false },
    batchImportProgress: null, batchImportProgressClearTimerRef: { current: null },
    setBatchImportProgress: value => { state.batchImportProgress = value; },
    pendingImportAppendsRef: { current: [] }, quickDropRequestIdRef: { current: "" },
    activeBatchDraftsRef: { current: [] }, importQueue: { ready: true, flush: async () => {} },
    archiveCleanupPromiseRef: { current: null },
    selectedImportIndexes: new Set(),
    importSelectionAnchorRef: { current: null },
    batchDedupeDecisionRef: { current: null },
    importDedupeMapRef: { current: {} },
    importDedupeQueueRef: { current: [] },
    importDedupeRunningRef: { current: false },
    setImportDedupeMap: () => {},
    clearedProgress: [],
    clearSavingProgress: (assetId) => { state.clearedProgress.push(String(assetId || "")); },
    duplicateDecisionRef: { current: null },
    duplicateApplyToAll: false,
    duplicatePrompt: null,
    duplicatePromptHistory: [],
    autoDuplicateResponses: [],
    importCancelRef: { current: false }, importCancelling: false,
    setImportCancelling: value => { state.importCancelling = value; },
    setDuplicateApplyToAll: value => { state.duplicateApplyToAll = value; },
    setDuplicatePrompt: value => {
      state.duplicatePrompt = value;
      if (!value) return;
      state.duplicatePromptHistory.push(value);
      const response = state.autoDuplicateResponses.shift();
      if (!response) return;
      state.duplicateApplyToAll = Boolean(response.applyToAll);
      globalThis.queueMicrotask(() => state.resolveDuplicateDecision(response.action));
    },
    setImportDrafts: value => { state.importDrafts = value; },
    setActiveImportIndex: value => { state.activeImportIndex = value; },
    open: true, alert: null, statuses: [], calls: 0, backgroundActive: false, closeAfterCurrent: false,
    t: (zh) => zh,
    setModalAlert: value => { state.alert = value; },
    showStatus: message => state.statuses.push(message),
    setImportSaving: value => { state.importSaving = value; },
    setCharacterImportProgress: value => { state.characterImportProgress = value; },
    setBusy: value => { state.busy = value; },
    setImportOpen: value => { state.open = value; },
    setSelectedImportIndexes: value => { state.selectedImportIndexes = value; },
    setImportAssetMenu: () => {}, setImportDeleteIndex: () => {},
    setImportForm: value => { state.importForm = value; },
    setImportTagInput: value => { state.importTagInput = value; }, setAllAssets: () => {}, setAssets: () => {}, setSelectedAssetId: () => {},
    textureEntriesToSlots: () => ({}), normalizeTextureEntries: () => [], normalizeNormalMapFormatsByArea: () => ({}),
    preferPngDisplacementEntries: (entries) => entries,
    getTextureAreaIdList: () => [1], isModelAssetImportType: () => true, isAnimationAssetImportType: () => false, isCharacterAssetType: () => false, getAnimationAssetNameIssue: () => null, resolveAnimationTypeValue: () => "", isAnimationTypeValue: () => false, getTopCategoryForImportType: () => "environment", DEFAULT_ANIMATION_SKELETON_PATH: "", parseTagsText: () => [], getSelectedStandardAssetTags: () => [], getStandardAssetTagOptions: () => [], getSubCategoryOptions: () => [], isModelFileAcceptedForType: () => true, formatAcceptedModelExts: () => [".fbx"], normalizeBaseTilingValue: (value) => value, normalizeZionTag: (tag) => String(tag || "").trim(), isPathUnderLibrary: () => true, rememberImportDestination: () => {},
    settings: { customLibraryPath: "D:\\\\library" },
    // 后台导入期间"预排队编辑"状态：源码头部的 useState/useRef 不在切片范围内，
    // 这里补上同名桩，供 queuePrequeueDrafts 与导入收尾逻辑读写。
    prequeueEditing: false,
    setPrequeueEditing: value => { state.prequeueEditing = value; },
    prequeueEditingRef: { current: false },
    // 后台导入期间任务栏进度的基数/跨度：App 头部的 useRef 不在切片范围内，
    // 与 prequeueEditingRef 同理补同名桩，供导入循环读写。
    importTaskbarBaseRef: { current: 0 },
    importTaskbarSpanRef: { current: 1 },
    importModalLocked: false,
    rescan: async () => {},
    bridge: {
      setImportQueueActive: async (active) => {
        state.backgroundActive = active;
        return { ok: true };
      },
      shouldCloseAfterCurrentImport: async () => state.closeAfterCurrent,
      importCustomAsset: async (payload) => {
        if (payload?.dedupeAction === "inspect") {
          return { ok: true, duplicate: false };
        }
        state.calls++;
        state.payload = payload;
        return resolve();
      },
      getAssetIndex: async () => []
    }
  };
  const api = new Function("scope", `with (scope) { ${compiled}; return { submitImportAsset, resolveDuplicateDecision, buildImportDedupeSignature, applyImportBatchDedupeDecision }; }`)(state);
  state.resolveDuplicateDecision = api.resolveDuplicateDecision;
  const submit = api.submitImportAsset;
  const closeStart = source.indexOf("  const closeAssetModal = () => {");
  const closeSource = source.slice(closeStart, source.indexOf("\n  };", closeStart) + 5);
  const close = new Function("scope", `with (scope) { ${closeSource}; return closeAssetModal; }`)(state);
  return { state, form, submit, close, buildImportDedupeSignature: api.buildImportDedupeSignature, applyImportBatchDedupeDecision: api.applyImportBatchDedupeDecision };
}

test("cancel during an in-flight save stops the batch, retains remaining drafts, and allows resume", async () => {
  let finish;
  const { state, form, submit, close } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const second = { form: { ...form, assetName: "Second" }, tagInput: "pending" };
  state.importDrafts = [{ form, tagInput: "" }, second];
  const running = submit(0, [0, 1]);
  await new Promise(resolve => globalThis.setImmediate(resolve));
  close();
  assert.equal(state.importCancelling, true);
  assert.equal(state.importSaving, true);
  assert.match(state.statuses.at(-1), /正在取消/);
  finish({ ok: true, assetId: "saved" });
  await running;
  assert.equal(state.calls, 1);
  assert.deepEqual(state.importDrafts, [second]);
  assert.equal(state.open, false);
  assert.equal(state.importSaving, false);
  assert.equal(state.importCancelling, false);
  assert.deepEqual(state.batchImportProgress, { processed: 1, total: 2, active: false });
  assert.match(state.statuses.at(-1), /导入已停止.*1\/2/);
  const resumed = submit(0, [0, 1]);
  await new Promise(resolve => globalThis.setImmediate(resolve));
  finish({ ok: true });
  await resumed;
  assert.equal(state.calls, 2);
  assert.equal(state.open, false);
});

test("confirmed window close finishes the current asset without starting the next", async () => {
  let finish;
  const { state, form, submit } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const second = { form: { ...form, assetName: "Second" }, tagInput: "" };
  state.importDrafts = [{ form, tagInput: "" }, second];
  const running = submit(0, [0, 1]);
  await new Promise(resolve => globalThis.setImmediate(resolve));
  assert.equal(state.calls, 1);
  state.closeAfterCurrent = true;
  finish({ ok: true, assetId: "saved" });
  await running;
  assert.equal(state.calls, 1);
  assert.deepEqual(state.importDrafts, [second]);
  assert.equal(state.backgroundActive, false);
});

test("closing an edit modal during background batch import does not cancel the batch", async () => {
  let finish;
  const { state, form, submit, close } = fixture(() => new Promise(resolve => { finish = resolve; }));
  state.importDrafts = [{ form, tagInput: "" }, { form: { ...form, assetName: "Second" }, tagInput: "" }];
  const running = submit(0, [0, 1]);
  await new Promise(resolve => globalThis.setImmediate(resolve));
  state.assetModalMode = "edit";
  state.setEditOpen = value => { state.editOpen = value; };
  state.setEditTagInput = () => {};
  close();
  assert.equal(state.editOpen, false);
  assert.equal(state.importCancelRef.current, false);
  finish({ ok: true });
  await new Promise(resolve => globalThis.setImmediate(resolve));
  finish({ ok: true });
  await running;
  assert.equal(state.calls, 2);
  assert.deepEqual(state.batchImportProgress, { processed: 2, total: 2, active: false });
});

test("batch import skips duplicate inspection and saves each draft as new", async () => {
  const { state, form, submit } = fixture(() => ({ ok: true }));
  state.importDrafts = [{ form, tagInput: "" }, { form: { ...form, assetName: "Second" }, tagInput: "" }];
  const payloads = [];
  state.bridge.importCustomAsset = async payload => {
    payloads.push(payload);
    return { ok: true };
  };
  await submit(0, [0, 1]);
  assert.deepEqual(payloads.map(payload => payload.dedupeAction), ["new", "new"]);
  assert.ok(payloads.every(payload => payload.skipDuplicateCheck === true));
  assert.equal(state.duplicatePromptHistory.length, 0);
});

test("submit closes the import panel before image work finishes and tracks the background job", async () => {
  let finish;
  const { state, submit } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const running = submit();
  assert.equal(state.open, false);
  assert.equal(state.importSaving, true);
  assert.equal(state.busy, false);
  await new Promise(resolve => globalThis.setImmediate(resolve));
  assert.equal(state.backgroundActive, true);
  finish({ ok: true, assetId: "saved" });
  await running;
  assert.equal(state.backgroundActive, false);
});

test("batch progress stays visible through each asset and reaches the full count", async () => {
  const pending = [];
  const { state, form, submit } = fixture(() => new Promise(resolve => pending.push(resolve)));
  state.importDrafts = [form, { ...form, assetName: "Second" }].map(draftForm => ({ form: draftForm, tagInput: "" }));
  const running = submit(0, [0, 1]);
  assert.deepEqual(state.batchImportProgress, { processed: 0, total: 2, active: true });
  await new Promise(resolve => globalThis.setImmediate(resolve));
  pending.shift()({ ok: true, assetId: "first" });
  await new Promise(resolve => globalThis.setImmediate(resolve));
  assert.deepEqual(state.batchImportProgress, { processed: 1, total: 2, active: true });
  pending.shift()({ ok: true, assetId: "second" });
  await running;
  assert.deepEqual(state.batchImportProgress, { processed: 2, total: 2, active: false });
  globalThis.clearTimeout(state.batchImportProgressClearTimerRef.current);
});

test("cancel also stops after a failing save and keeps both failed and unattempted drafts", async () => {
  let finish;
  const { state, form, submit, close } = fixture(() => new Promise(resolve => { finish = resolve; }));
  state.importDrafts = [{ form, tagInput: "" }, { form: { ...form, assetName: "Second" }, tagInput: "" }];
  const running = submit(0, [0, 1]);
  await new Promise(resolve => globalThis.setImmediate(resolve));
  close();
  finish({ ok: false, message: "disk full" });
  await running;
  assert.equal(state.calls, 1);
  assert.equal(state.importDrafts.length, 2);
  assert.match(state.alert.message, /导入已停止/);
  assert.match(state.alert.message, /disk full/);
  assert.equal(state.busy, false);
});

test("saving one asset advances to another draft without losing its edits", async () => {
  const { state, form, submit } = fixture(() => ({ ok: true, assetId: "saved" }));
  const next = { ...form, assetName: "Edited second asset", tagsText: "stone" };
  state.importDrafts = [{ form, tagInput: "" }, { form: next, tagInput: "pending" }];
  await submit();
  assert.equal(state.importForm, next);
  assert.equal(state.importDrafts.length, 1);
  assert.equal(state.activeImportIndex, 0);
  assert.equal(state.open, false);
  await submit();
  assert.equal(state.importDrafts.length, 0);
  assert.equal(state.open, false);
});

test("failed save retains all drafts and the active selection", async () => {
  const { state, form, submit } = fixture(() => ({ ok: false, message: "disk full" }));
  const drafts = [{ form: { ...form, assetName: "First" } }, { form }];
  state.importDrafts = drafts;
  state.activeImportIndex = 1;
  await submit();
  assert.deepEqual(state.importDrafts, [{ ...drafts[0] }, { ...drafts[1], tagInput: "" }]);
  assert.equal(state.importForm, form);
  assert.equal(state.activeImportIndex, 1);
  assert.equal(state.open, false);
});

test("single-asset action saves only the right-clicked draft and preserves the active unsaved edits", async () => {
  const { state, form, submit } = fixture(() => ({ ok: true, assetId: "saved" }));
  const other = { ...form, assetName: "Right-clicked asset", modelSlots: { Mesh: "D:\\other.fbx" } };
  state.importDrafts = [{ form: { ...form, assetName: "Old name" }, tagInput: "" }, { form: other, tagInput: "" }];
  state.importTagInput = "unfinished tag";
  await submit(1);
  assert.equal(state.calls, 1);
  assert.equal(state.payload.assetName, other.assetName);
  assert.deepEqual(state.payload.modelSlots, other.modelSlots);
  assert.equal(state.importDrafts.length, 1);
  assert.equal(state.importDrafts[0].form, form);
  assert.equal(state.importDrafts[0].tagInput, "unfinished tag");
  assert.equal(state.importForm, form);
  assert.equal(state.open, false);
});

test("failed single-asset action keeps the targeted draft in the queue", async () => {
  const { state, form, submit } = fixture(() => ({ ok: false, message: "disk full" }));
  const other = { ...form, assetName: "Other" };
  const drafts = [{ form, tagInput: "" }, { form: other, tagInput: "" }];
  state.importDrafts = drafts;
  await submit(1);
  assert.equal(state.payload.assetName, "Other");
  assert.deepEqual(state.importDrafts, drafts);
  assert.equal(state.importForm, form);
  assert.equal(state.open, false);
});

test("Import selected saves only selected drafts and keeps unselected drafts for reopening", async () => {
  const { state, form, submit } = fixture(() => ({ ok: true }));
  const unselected = { form: { ...form, assetName: "Unselected" }, tagInput: "keep me" };
  state.importDrafts = [
    { form: { ...form, assetName: "First selected" }, tagInput: "" },
    unselected,
    { form: { ...form, assetName: "Third selected" }, tagInput: "" }
  ];
  state.importForm = state.importDrafts[0].form;
  const names = [];
  let refreshes = 0;
  state.bridge.importCustomAsset = async payload => {
    if (payload?.dedupeAction === "inspect") return { ok: true, duplicate: false };
    names.push(payload.assetName);
    return { ok: true };
  };
  state.bridge.getAssetIndex = async () => { refreshes++; return []; };
  await submit(0, [0, 2]);
  assert.deepEqual(names, ["First selected", "Third selected"]);
  assert.equal(refreshes, 1);
  assert.deepEqual(state.importDrafts, [unselected]);
  assert.equal(state.importForm, unselected.form);
  assert.equal(state.open, false);
  assert.equal(state.busy, false);
});

test("new drafts queued during a background import survive completion and keep archive sources", async () => {
  let finish;
  const { state, form, submit } = fixture(() => new Promise(resolve => { finish = resolve; }));
  const queued = { form: { ...form, assetName: "Queued later" }, tagInput: "new tag" };
  let archiveClears = 0;
  state.bridge.clearDroppedArchives = async () => { archiveClears++; };
  const running = submit();
  await new Promise(resolve => globalThis.setImmediate(resolve));
  assert.equal(state.importSavingRef.current, true);
  state.pendingImportAppendsRef.current.push(queued);
  finish({ ok: true, assetId: "saved" });
  await running;
  assert.equal(archiveClears, 0);
  assert.deepEqual(state.importDrafts, [queued]);
  assert.equal(state.importForm, queued.form);
  assert.equal(state.importTagInput, queued.tagInput);
  assert.equal(state.importSavingRef.current, false);
  assert.equal(state.importDedupeMapRef.current[0], undefined);
  const nextBatch = submit();
  await new Promise(resolve => globalThis.setImmediate(resolve));
  finish({ ok: true, assetId: "queued-saved" });
  await nextBatch;
  assert.equal(state.importDrafts.length, 0);
  assert.equal(archiveClears, 1);
});

test("an in-progress drop delays temporary archive cleanup", async () => {
  const { state, submit } = fixture(() => ({ ok: true, assetId: "saved" }));
  let archiveClears = 0;
  state.bridge.clearDroppedArchives = async () => { archiveClears++; };
  state.quickDropRequestIdRef.current = "pending-drop";
  await submit();
  assert.equal(archiveClears, 0);
});

test("Import selected continues past failures and leaves only failed or invalid drafts for retry", async () => {
  const { state, form, submit } = fixture(() => ({ ok: true }));
  const failure = { form: { ...form, assetName: "Failure" }, tagInput: "unfinished" };
  const invalid = { form: { ...form, assetName: "" }, tagInput: "" };
  state.importDrafts = [{ form, tagInput: "" }, failure, invalid, { form: { ...form, assetName: "Last" }, tagInput: "" }];
  const names = [];
  state.bridge.importCustomAsset = async payload => {
    if (payload?.dedupeAction === "inspect") return { ok: true, duplicate: false };
    names.push(payload.assetName);
    return payload.assetName === "Failure" ? { ok: false, message: "disk full" } : { ok: true };
  };
  await submit(0, [0, 1, 2, 3]);
  assert.deepEqual(names, [form.assetName, "Failure", "Last"]);
  assert.deepEqual(state.importDrafts, [failure, invalid]);
  assert.equal(state.importForm, failure.form);
  assert.ok(state.alert.message.includes("2/4") && state.alert.message.includes("disk full"));
  assert.equal(state.open, false);
  assert.equal(state.importSaving, false);
});
test("switching assets preserves each form and unfinished tag input and is locked while saving", () => {
  const start = source.indexOf("  function switchImportAsset(");
  const handler = source.slice(start, source.indexOf("\n  }", start) + 4);
  const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const first = { assetName: "First, edited", textureEntries: [{ filePath: "first.png" }] };
  const second = { assetName: "Second" };
  const state = {
    importSaving: false, activeImportIndex: 0, importForm: first, importTagInput: "new tag",
    characterPreviewGenerating: false, quickDropBusy: false, characterTaskWorkspace: false,
    importDrafts: [{ form: { assetName: "First" }, tagInput: "" }, { form: second, tagInput: "second tag" }],
    setImportDrafts: fn => { state.importDrafts = fn(state.importDrafts); },
    setImportForm: value => { state.importForm = value; },
    setImportTagInput: value => { state.importTagInput = value; },
    setActiveImportIndex: value => { state.activeImportIndex = value; }
  };
  // 源码里 importModalLocked = importSaving && !prequeueEditing，是随状态变化的派生值；
  // 这里用 getter 还原该联动，否则保存中禁止切资产的守卫恒为假，测不到真实行为。
  Object.defineProperty(state, "importModalLocked", {
    get: () => Boolean(state.importSaving) && !state.prequeueEditing,
    enumerable: true
  });
  const switchAsset = new Function("scope", `with (scope) { ${js}; return switchImportAsset; }`)(state);
  switchAsset(1);
  assert.equal(state.importForm, second);
  assert.equal(state.importTagInput, "second tag");
  state.importSaving = true;
  switchAsset(0);
  assert.equal(state.activeImportIndex, 1);
  state.importSaving = false;
  switchAsset(0);
  assert.equal(state.importForm, first);
  assert.equal(state.importTagInput, "new tag");
});

test("import delete confirmation stays above the import modal", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/ui/styles.css"), "utf8");
  const rule = css.match(/\.confirm-overlay\.import-delete-overlay\s*\{[^}]*z-index:\s*5100\s*;?[^}]*\}/);
  assert.ok(rule, "the delete confirmation needs higher specificity than .confirm-overlay so z-index 5100 survives the cascade");
});

test("returned failure displays its full reason and preserves the form for retry", async () => {
  const reason = "没有写入权限：" + "D:\\Library\\LongFolder".repeat(10);
  const { state, form, submit } = fixture(() => ({ ok: false, message: reason }));
  await submit();
  assert.equal(state.alert.title, "保存失败");
  assert.ok(state.alert.visible && state.alert.message.includes(reason));
  assert.equal(state.importForm, form);
  assert.equal(state.open, false);
  assert.equal(state.importSaving, false);
  assert.equal(state.busy, false);
  await submit();
  assert.equal(state.calls, 2);
});

test("rejected IPC, missing response, and empty error messages always produce a visible fallback", async () => {
  for (const resolve of [() => { throw new Error("ENOSPC: 磁盘空间不足"); }, () => undefined, () => ({ ok: false, message: "  " })]) {
    const { state, form, submit } = fixture(resolve);
    await submit();
    assert.equal(state.alert.title, "保存失败");
    assert.ok(state.alert.message.includes("磁盘空间不足") || state.alert.message.includes("未返回具体原因"));
    assert.equal(state.importForm, form);
    assert.equal(state.importSaving, false);
    assert.equal(state.busy, false);
  }
});

test("Surface imports can be saved without a standard tag after Tile is retired", async () => {
  const { state, form, submit } = fixture(() => ({ ok: true, assetId: "surface-saved" }));
  form.assetType = "surface";
  state.getStandardAssetTagOptions = () => ["ThirdParty"];
  await submit();
  assert.equal(state.calls, 1);
  assert.equal(state.alert, null);
  assert.equal(state.payload.standardAssetTags, undefined);
});

test("invalid input gets a visible explanation without issuing a save", async () => {
  const { state, submit } = fixture(() => { throw new Error("must not run"); });
  state.importForm.assetName = " ";
  await submit();
  assert.ok(state.alert.message.includes("请先填写资产名"));
  assert.equal(state.calls, 0);
});

test("missing animation gameplay identity blocks single and batch saves before closing the form", async () => {
  const rules = { exports: {} };
  const rulePath = path.join(__dirname, "../src/ui/animationRules.ts");
  new Function("exports", "require", ts.transpileModule(fs.readFileSync(rulePath, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText)(rules.exports, require('node:module').createRequire(rulePath));
  for (const batch of [false, true]) {
    const { state, form, submit } = fixture(() => { throw new Error("must not save"); });
    Object.assign(form, { assetType: "animation", assetName: "AS_ShangExecutor_Run_Stop", destinationPath: "D:/Library/Animation/Monster", animationAffiliation: "怪物", subCategory: "基础移动", animationLabelsText: "跑停", animationGameTag: null });
    Object.assign(state, {
      isAnimationAssetImportType: type => type === "animation", getMissingAnimationFields: rules.exports.getMissingAnimationFields, animationPlanningLabels: rules.exports.animationPlanningLabels,
      getFirstFbxPath: files => files.find(file => /\.fbx$/i.test(file)) || "",
      resolveAnimationAffiliationValue: value => value, resolveAnimationTypeValue: (_, category) => category,
      parseAnimationLabels: require('../shared/animationUnrealExport.mjs').parseAnimationLabels,
      switchImportAsset: index => { state.focusedImport = index; }
    });
    state.importDrafts = [{ form, tagInput: "" }, { form: { ...form, assetName: "AS_Other_Run" }, tagInput: "" }];
    await submit(0, batch ? [0, 1] : undefined);
    assert.match(state.alert.message, /请补齐必填项：怪物/);
    assert.equal(state.calls, 0);
    assert.equal(state.backgroundActive, false);
    assert.equal(state.open, true);
    assert.equal(state.importDrafts.length, 2);
    if (batch) assert.equal(state.focusedImport, 0);
  }
});

test("retry success clears the old error and resets the form only after saving", async () => {
  const { state, submit } = fixture(() => ({ ok: true, assetId: "saved" }));
  state.alert = { visible: true, title: "old failure" };
  await submit();
  assert.equal(state.alert, null);
  assert.equal(state.open, false);
  assert.equal(state.importForm, state.defaultImportForm);
  assert.equal(state.importSaving, false);
  assert.equal(state.busy, false);
});

test("refresh failure after a successful save does not report save failure or invite duplicate imports", async () => {
  const { state, submit } = fixture(() => ({ ok: true, assetId: "saved" }));
  state.bridge.getAssetIndex = async () => { throw new Error("refresh failed"); };
  state.rescan = async () => { throw new Error("rescan failed"); };
  await submit();
  assert.equal(state.alert.title, "资产已保存，列表刷新失败");
  assert.ok(state.alert.message.includes("无需重复添加资产"));
  assert.equal(state.open, false);
  assert.equal(state.importSaving, false);
  assert.equal(state.busy, false);
});

test("Zion Tag selection toggles all selected drafts on and off", () => {
  const start = source.indexOf("  // Zion Tags 单选");
  const end = source.indexOf("\n  function toggleEditZionTag(", start);
  const patchStart = source.indexOf("  function applyImportBatchPatch(");
  const patchEnd = source.indexOf("\n  // 多选时判断", patchStart);
  const js = ts.transpileModule(source.slice(start, end) + source.slice(patchStart, patchEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const state = {
    importForm: { assetName: "Current", zionTags: [] },
    importModalLocked: false,
    activeImportIndex: 1,
    importDrafts: [
      { form: { assetName: "First", zionTags: [] }, tagInput: "" },
      { form: { assetName: "Second", zionTags: ["Zion"] }, tagInput: "" }
    ],
    selectedImportIndexes: new Set([0, 1]),
    normalizeZionTag: (value) => String(value || "").trim(),
    isCharacterAssetType: (value) => ["suit", "monster", "npc", "weapon"].includes(value),
    isZionTagSelected: (tags, tag) => (tags || []).some((value) => String(value || "").toLowerCase() === String(tag || "").toLowerCase()),
    getMergedImportDrafts: () => state.importDrafts.map((draft, index) => index === state.activeImportIndex ? { ...draft, form: state.importForm } : draft),
    setImportDrafts: (value) => { state.importDrafts = typeof value === "function" ? value(state.importDrafts) : value; },
    setImportForm: (value) => { state.importForm = typeof value === "function" ? value(state.importForm) : value; }
  };
  const handlers = new Function("scope", `with (scope) { ${js}; return { toggleImportZionTag }; }`)(state);
  handlers.toggleImportZionTag("Zion");
  assert.deepEqual(state.getMergedImportDrafts().map((draft) => draft.form.zionTags), [["Zion"], ["Zion"]]);
  assert.deepEqual(state.importForm.zionTags, ["Zion"]);
  handlers.toggleImportZionTag("Zion");
  assert.deepEqual(state.getMergedImportDrafts().map((draft) => draft.form.zionTags), [[], []]);
  assert.deepEqual(state.importForm.zionTags, []);
  state.selectedImportIndexes = new Set([1]);
  state.importForm = { ...state.importForm, assetType: "suit", characterFields: { confirmed: true } };
  handlers.toggleImportZionTag("Zion");
  assert.equal(state.importForm.characterFields.confirmed, false);
});

test("duplicate handling picked in the import UI still works when re-enabled", async () => {
  const { state, form, submit, buildImportDedupeSignature } = fixture(() => ({ ok: true, assetId: "saved" }));
  state.importDuplicateCheckEnabled = true;
  state.importDedupeMapRef.current[0] = {
    signature: buildImportDedupeSignature(form),
    status: "ready",
    duplicate: true,
    matchKind: "source",
    candidateName: "My asset",
    candidateId: "w3bqun3",
    defaultAction: "update",
    decision: "update",
    contentIdentity: { contentFingerprint: "fingerprint" },
    message: ""
  };
  await submit();
  assert.equal(state.duplicatePromptHistory.length, 0, "no duplicate dialog once the import UI already asked");
  assert.equal(state.payload.dedupeAction, "update");
  assert.deepEqual(state.payload.contentIdentity, { contentFingerprint: "fingerprint" });
});

test("a selected single draft also skips duplicate inspection", async () => {
  const { state, form, submit, buildImportDedupeSignature } = fixture(() => ({ ok: true, assetId: "saved" }));
  state.importDrafts = [{ form, tagInput: "" }];
  state.importDedupeMapRef.current[0] = {
    signature: buildImportDedupeSignature(form), status: "ready", duplicate: true,
    candidateName: form.assetName, defaultAction: "update", decision: "update"
  };
  state.bridge.importCustomAsset = async payload => {
    assert.notEqual(payload.dedupeAction, "inspect");
    state.payload = payload;
    return { ok: true, assetId: "saved" };
  };
  await submit(0, [0]);
  assert.equal(state.payload.dedupeAction, "new");
  assert.equal(state.payload.skipDuplicateCheck, true);
  assert.equal(state.duplicatePromptHistory.length, 0);
});

test("a stale import-UI duplicate decision falls back to the dialog when re-enabled", async () => {
  const { state, form, submit } = fixture(() => ({ ok: true, assetId: "saved" }));
  state.importDuplicateCheckEnabled = true;
  state.importDedupeMapRef.current[0] = {
    signature: "stale-signature",
    status: "ready",
    duplicate: true,
    matchKind: "source",
    candidateName: "My asset",
    candidateId: "w3bqun3",
    defaultAction: "update",
    decision: "update",
    message: ""
  };
  state.bridge.importCustomAsset = async (payload) => {
    if (payload?.dedupeAction === "inspect") {
      return {
        ok: true,
        duplicate: true,
        matchKind: "source",
        defaultAction: "update",
        candidate: { id: "w3bqun3", name: "My asset" },
        contentIdentity: { contentFingerprint: "fingerprint" }
      };
    }
    if (payload?.dedupeAction === "skip") {
      return { ok: true, skipped: true, action: "skip", message: "skip" };
    }
    state.calls++;
    state.payload = payload;
    return { ok: true, assetId: "saved" };
  };
  state.autoDuplicateResponses.push({ action: "skip" });
  await submit();
  assert.equal(state.duplicatePromptHistory.length, 1);
  assert.equal(state.calls, 0, "skipped duplicates must not be written again");
});

test("a failed update clears the stuck saving progress when duplicate handling is re-enabled", async () => {
  const { state, form, submit, buildImportDedupeSignature } = fixture(() => ({ ok: false, message: "贴图复制失败：AO|billboard" }));
  state.importDuplicateCheckEnabled = true;
  state.importDedupeMapRef.current[0] = {
    signature: buildImportDedupeSignature(form),
    status: "ready",
    duplicate: true,
    matchKind: "source",
    candidateName: "My asset",
    candidateId: "w3bqun3",
    defaultAction: "update",
    decision: "update",
    message: ""
  };
  await submit();
  assert.ok(state.clearedProgress.includes("w3bqun3"), "failed update must clear the progress ring");
  assert.match(state.alert ? String(state.alert.message || "") : "", /贴图复制失败/);
});

test("every duplicate kind exposes Update existing in the import UI", () => {
  const dropdownStart = source.indexOf('className="import-dedupe-select"');
  assert.notEqual(dropdownStart, -1, "duplicate handling select should exist");
  const dropdown = source.slice(dropdownStart, source.indexOf("</select>", dropdownStart));
  assert.match(dropdown, /<option value="update">/);
  assert.doesNotMatch(dropdown, /matchKind === "source" && <option value="update">/);

  const promptStart = source.indexOf('aria-label={t("重复资产", "Duplicate asset")}');
  assert.notEqual(promptStart, -1, "duplicate confirmation dialog should exist");
  const promptEnd = source.indexOf("\n      )}", promptStart);
  const prompt = source.slice(promptStart, promptEnd);
  assert.match(prompt, /resolveDuplicateDecision\("update"\)/);
  assert.doesNotMatch(prompt, /duplicatePrompt\.matchKind === "source" &&/);
});

test("duplicate UI remains behind the disabled feature flag", () => {
  assert.match(source, /const importDuplicateCheckEnabled = false/);
  assert.match(source, /importDuplicateCheckEnabled && importDrafts\.length <= 1/);
  assert.match(source, /className="import-dedupe-main"/);

  assert.match(source, /importDrafts\.length <= 1 && !activeImportChecking && activeImportDedupe\?\.status === "ready" && activeImportDedupe\.signature === activeImportSignature && activeImportDedupe\.duplicate/);
  assert.match(source, /className=\{`import-batch-dedupe-select/);
  assert.match(source, /`Duplicates \(\$\{selectedDuplicateCount\}\)`/);
});

test("batch duplicate strategy applies only to selected ready duplicates", () => {
  const { state, form, buildImportDedupeSignature, applyImportBatchDedupeDecision } = fixture(() => ({ ok: true }));
  state.importDrafts = [form, ...["Second", "Third", "Fourth"].map((assetName) => ({ ...form, assetName }))].map((draftForm) => ({ form: draftForm, tagInput: "" }));
  const signatures = state.importDrafts.map((draft) => buildImportDedupeSignature(draft.form));

  state.selectedImportIndexes = new Set([0, 1, 2]);
  // 列表内的重复检测结果按索引携带签名，只有签名一致时才应用批量决策。
  const draftForms = [
    state.importForm,
    { ...state.importForm, assetName: "Second" },
    { ...state.importForm, assetName: "Third" }
  ];
  state.importDrafts = draftForms.map((form) => ({ form, tagInput: "" }));
  const signatureOf = (index) => buildImportDedupeSignature(draftForms[index]);
  state.importDedupeMapRef.current = {

    0: { status: "ready", signature: signatures[0], duplicate: true, decision: "skip" },
    1: { status: "ready", signature: signatures[1], duplicate: true, decision: "new" },
    2: { status: "ready", signature: signatures[2], duplicate: false, decision: "new" },
    3: { status: "ready", signature: signatures[3], duplicate: true, decision: "skip" }

  };
  applyImportBatchDedupeDecision("update");
  assert.equal(state.importDedupeMapRef.current[0].decision, "update");
  assert.equal(state.importDedupeMapRef.current[1].decision, "update");
  assert.equal(state.importDedupeMapRef.current[2].decision, "new");
  assert.equal(state.importDedupeMapRef.current[3].decision, "skip");
  assert.match(state.statuses.at(-1), /2 个重复资产/);
});

function batchFieldFixture(forms, selected = [0, 1], active = 0) {
  const start = source.indexOf("  function getMergedImportDrafts(");
  const end = source.indexOf("  // 多选时判断", start);
  const typeStart = source.indexOf("  function handleImportAssetTypeChange(");
  const typeEnd = source.indexOf("  function handleEditAssetTypeChange(", typeStart);
  const normalFunctions = ["getTextureAreaIdList", "normalizeNormalMapFormatsByArea", "getNormalMapFormatForArea", "updateNormalMapFormatForArea", "hasImportNormalMapForArea", "getImportNormalMapFormatForArea", "changeImportNormalMapFormatForArea"];
  const parsed = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pieces = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && normalFunctions.includes(node.name?.text)) pieces.push(node.getText(parsed));
    ts.forEachChild(node, visit);
  })(parsed);
  assert.equal(pieces.length, normalFunctions.length);
  const js = ts.transpileModule(source.slice(start, end) + source.slice(typeStart, typeEnd) + pieces.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const state = {
    importForm: forms[active], importTagInput: "", activeImportIndex: active,
    importModalLocked: false,
    importDrafts: forms.map((form) => ({ form, tagInput: "" })),
    selectedImportIndexes: new Set(selected),
    setImportForm: (update) => { state.importForm = update(state.importForm); },
    setImportDrafts: (update) => { state.importDrafts = update(state.importDrafts); },
    quickDropRequestIdRef: { current: 'old-scan' },
    setQuickDropBusy() {}, setCharacterPreviewGenerating() {},
    heroPartKind: require("../shared/heroPackageRules.mjs").heroPartKind,
    isCharacterAssetType: type => ["suit", "monster", "npc", "weapon"].includes(type),
    buildFreshImportForm: assetType => ({ assetType, characterFields: { serial: "" }, characterPackageFiles: [], modelSlots: {}, textureEntries: [], previewImagePath: "" }),
    setCharacterCollision: () => {},
    updateCharacterFields: (form, patch) => ({ ...form, characterFields: { ...form.characterFields, ...patch } }),
    getSubCategoryOptions: () => ["Props"],
    withAnimationTypeFields: (form) => form,
    applyDestinationToImportForm: (form) => form,
    switchImportTextureEntriesForAssetType: (entries) => entries
  };
  const handlers = new Function("scope", `with (scope) { ${js}; return { getImportSelectionValue, getImportBatchInputProps, getImportBatchCheckboxProps, applyImportBatchPatch, getMergedImportDrafts, handleImportAssetTypeChange, getImportNormalMapFormatForArea, changeImportNormalMapFormatForArea }; }`)(state);
  return { state, ...handlers };
}

test("mixed import values display a placeholder without changing drafts", () => {
  const forms = [{ assetName: "First", subCategory: "Props" }, { assetName: "Second", subCategory: "Nature" }];
  const batch = batchFieldFixture(forms);
  assert.deepEqual(batch.getImportBatchInputProps("assetName", "Asset name"), { value: "", placeholder: "Multiple Value" });
  assert.equal(batch.getImportSelectionValue((form) => form.subCategory), null);
  assert.deepEqual(batch.getMergedImportDrafts().map((draft) => draft.form), forms);
});

test("switching independent Hair back to Suit clears subtype rules", () => {
  const batch = batchFieldFixture([{ assetType: "suit", characterFields: { variant: "Hair", serial: "017" } }], [0]);
  batch.handleImportAssetTypeChange("suit");
  const form = batch.getMergedImportDrafts()[0].form;
  assert.equal(form.characterFields.variant, "");
  assert.equal(form.characterFields.serial, "");
});

test("batch normal format unifies mixed selected drafts without changing paths or other areas", () => {
  const makeForm = (name, format) => ({
    assetName: name, assetType: "3d", normalMapFormat: format,
    normalMapFormats: { 1: format, 2: "dx" },
    modelSlots: { Mesh: `${name}.fbx` },
    textureEntries: [
      { id: `${name}-1`, textureType: "Normal", areaId: 1, filePath: `${name}-1.png` },
      { id: `${name}-2`, textureType: "NormalBump", areaId: 2, filePath: `${name}-2.png` }
    ]
  });
  const forms = [makeForm("First", "dx"), makeForm("Second", "opengl"), makeForm("Unselected", "dx")];
  const batch = batchFieldFixture(forms);
  assert.equal(batch.getImportNormalMapFormatForArea(1), null);
  batch.changeImportNormalMapFormatForArea(1, "opengl");
  assert.equal(batch.getImportNormalMapFormatForArea(1), "opengl");
  const changed = batch.getMergedImportDrafts().map(draft => draft.form);
  assert.deepEqual(changed.map(form => form.normalMapFormat), ["opengl", "opengl", "dx"]);
  changed.slice(0, 2).forEach((form, index) => {
    assert.deepEqual(form.normalMapFormats, { 1: "opengl", 2: "dx" });
    assert.strictEqual(form.textureEntries, forms[index].textureEntries);
    assert.strictEqual(form.modelSlots, forms[index].modelSlots);
  });
  assert.strictEqual(changed[2], forms[2]);
  batch.changeImportNormalMapFormatForArea(2, "opengl");
  batch.changeImportNormalMapFormatForArea(1, "dx");
  assert.deepEqual(batch.getMergedImportDrafts().slice(0, 2).map(draft => draft.form.normalMapFormats), [{ 1: "dx", 2: "opengl" }, { 1: "dx", 2: "opengl" }]);
  assert.deepEqual(forms[0].normalMapFormats, { 1: "dx", 2: "dx" });
});

test("batch normal format skips inapplicable groups and an active draft outside the selection", () => {
  const normal = { assetType: "3d", normalMapFormat: "dx", normalMapFormats: { 1: "dx" }, textureEntries: [{ id: "normal", textureType: "Normal", areaId: 1, filePath: "n.png" }] };
  const noNormal = { ...normal, textureEntries: [{ id: "color", textureType: "Diffuse", areaId: 1, filePath: "d.png" }] };
  const hdri = { ...normal, assetType: "hdri" };
  const otherArea = { ...normal, textureEntries: [{ ...normal.textureEntries[0], areaId: 2 }] };
  const forms = [normal, { ...normal }, noNormal, hdri, otherArea];
  const batch = batchFieldFixture(forms, [1, 2, 3, 4]);
  assert.equal(batch.getImportNormalMapFormatForArea(1), "dx");
  assert.equal(batch.getImportNormalMapFormatForArea(3), undefined);
  batch.changeImportNormalMapFormatForArea(1, "opengl");
  const changed = batch.getMergedImportDrafts().map(draft => draft.form);
  assert.strictEqual(changed[0], normal);
  assert.equal(changed[1].normalMapFormat, "opengl");
  for (const index of [2, 3, 4]) assert.strictEqual(changed[index], forms[index]);
});

test("editing a mixed field unifies only that field on selected imports", () => {
  const forms = [{ assetName: "First", subCategory: "Props", previewImagePath: "first.png" }, { assetName: "Second", subCategory: "Nature", previewImagePath: "second.png" }, { assetName: "Third", subCategory: "Food" }];
  const batch = batchFieldFixture(forms);
  batch.applyImportBatchPatch((form) => ({ ...form, subCategory: "Industrial" }));
  assert.equal(batch.getImportSelectionValue((form) => form.subCategory), "Industrial");
  assert.deepEqual(batch.getMergedImportDrafts().map((draft) => draft.form), forms.map((form, i) => i < 2 ? { ...form, subCategory: "Industrial" } : form));
  assert.equal(batch.getImportSelectionValue((form) => form.assetName), null);
});

test("batch edits exclude an active import outside the selection and show common selected values", () => {
  const forms = [{ assetName: "Unselected" }, { assetName: "Shared" }, { assetName: "Shared" }];
  const batch = batchFieldFixture(forms, [1, 2]);
  assert.equal(batch.getImportSelectionValue((form) => form.assetName), "Shared");
  batch.applyImportBatchPatch((form) => ({ ...form, assetName: "New" }));
  assert.deepEqual(batch.getMergedImportDrafts().map((draft) => draft.form.assetName), ["Unselected", "New", "New"]);
});

test("mixed asset types can be unified while keeping each import's files", () => {
  const forms = [{ assetType: "3d", subCategory: "Props", textureEntries: ["first.png"], modelSlots: { Mesh: "first.fbx" } }, { assetType: "surface", subCategory: "Rock", textureEntries: ["second.png"] }];
  const batch = batchFieldFixture(forms);
  batch.handleImportAssetTypeChange("3dplant");
  assert.equal(batch.getImportSelectionValue((form) => form.assetType), "3dplant");
  assert.deepEqual(batch.getMergedImportDrafts().map((draft) => draft.form.textureEntries), [["first.png"], ["second.png"]]);
  assert.equal(batch.getMergedImportDrafts()[0].form.modelSlots.Mesh, "first.fbx");
});

test("mixed checkboxes are indeterminate until explicitly unified", () => {
  const batch = batchFieldFixture([{ foliageOpaque: false }, { foliageOpaque: true }]);
  const props = batch.getImportBatchCheckboxProps((form) => form.foliageOpaque);
  const input = {};
  props.ref(input);
  assert.equal(input.indeterminate, true);
  assert.equal(props["aria-checked"], "mixed");
  batch.applyImportBatchPatch((form) => ({ ...form, foliageOpaque: true }));
  assert.equal(batch.getImportBatchCheckboxProps((form) => form.foliageOpaque).checked, true);
});

test("a mixed dropdown allows choosing the current asset's value to unify selection", () => {
  const React = require("react");
  const start = source.indexOf("const DarkSelect = memo(");
  const end = source.indexOf("\nfunction normalizeThemeToken", start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const Select = new Function("React", "memo", "useState", "useRef", "useEffect", `${js}; return DarkSelect;`)(React, (fn) => fn, () => [true, () => {}], () => ({ current: null }), () => {});
  let changed;
  const tree = Select({ value: "Props", mixed: true, options: [{ value: "Props", label: "Props" }, { value: "Nature", label: "Nature" }], ariaLabel: "Category", onChange: (value) => { changed = value; } });
  assert.equal(tree.props.children[0].props.children.props.children, "Multiple Value");
  const listbox = React.Children.toArray(tree.props.children[1].props.children).find(child => child.props?.role === 'listbox');
  const options = React.Children.toArray(listbox.props.children).filter(child => child.props?.role === 'option');
  assert.ok(options.every((option) => option.props["aria-selected"] === false));
  options[0].props.onClick();
  assert.equal(changed, "Props");
});

test('searchable animation dropdown filters Chinese names and row IDs without changing its selection', () => {
  const React = require('react');
  const start = source.indexOf('const DarkSelect = memo(');
  const end = source.indexOf('\nfunction normalizeThemeToken', start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const render = query => {
    let state = 0;
    const Select = new Function('React', 'memo', 'useState', 'useRef', 'useEffect', `${js}; return DarkSelect;`)(React, fn => fn, () => [state++ === 0 ? true : query, () => {}], () => ({ current: null }), () => {});
    return Select({ value: 'Monster_ShangSoldier', options: [
      { value: 'Monster_ShangExecutor', label: '行刑官' }, { value: 'Monster_ShangSoldier', label: '商士兵' }
    ], ariaLabel: '怪物', searchPlaceholder: '搜索怪物名称或编号', emptySearchLabel: '没有匹配项', onChange: () => {} });
  };
  for (const query of ['行刑', 'shangexecutor']) {
    const tree = render(query);
    const menu = tree.props.children[1];
    const listbox = React.Children.toArray(menu.props.children).find(child => child.props?.role === 'listbox');
    const options = React.Children.toArray(listbox.props.children).filter(child => child.props?.role === 'option');
    assert.equal(options.length, 1);
    assert.ok(React.Children.toArray(options[0].props.children).includes('行刑官'));
    assert.equal(options[0].props['aria-selected'], false);
    assert.equal(React.Children.toArray(menu.props.children)[0].props['aria-label'], '搜索怪物名称或编号');
  }
});

test("normal format buttons switch both conventions and keep UDIM groups independent", () => {
  const React = require("react");
  const parsed = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["getTextureAreaIdList", "normalizeNormalMapFormatsByArea", "getNormalMapFormatForArea", "updateNormalMapFormatForArea"];
  const pieces = [];
  (function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) pieces.push(node.getText(parsed));
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name?.getText(parsed) === "TextureEntryRow")) pieces.push(node.getText(parsed));
    ts.forEachChild(node, visit);
  })(parsed);
  assert.equal(pieces.length, names.length + 1);
  const js = ts.transpileModule(pieces.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const { Row, update, read } = new Function("React", "memo", "DarkSelect", "Icon", "getTextureTypeDisplayLabel", `${js}; return { Row: TextureEntryRow, update: updateNormalMapFormatForArea, read: getNormalMapFormatForArea };`)(React, (fn) => fn, () => null, () => null, (value) => value);
  function findButton(node) {
    if (!React.isValidElement(node)) return null;
    if (node.type === "button" && node.props.className?.includes("flip-inline-btn")) return node;
    return React.Children.toArray(node.props.children).map(findButton).find(Boolean);
  }
  for (const textureType of ["Normal", "NormalBump"]) {
    const original = {
      assetName: "Keep name", modelSlots: { Mesh: "mesh.fbx" },
      textureEntries: [{ id: "a", textureType, areaId: 1, filePath: "normal.png" }, { id: "b", textureType, areaId: 2, filePath: "normal2.png" }],
      normalMapFormat: "dx", normalMapFormats: {}
    };
    let form = original;
    const render = (areaId) => findButton(Row({
      t: (zh) => zh, entry: form.textureEntries[areaId - 1], usedByOthers: new Set(), textureTypeOptions: [textureType],
      normalMapFormat: read(form, areaId), isPathMissing: () => false,
      onNormalMapFormatChange: (format) => { form = update(form, areaId, format); }
    }));
    const event = { preventDefault() {}, stopPropagation() {} };
    assert.equal(render(1).props.type, "button");
    assert.equal(render(1).props.children, "DX");
    render(1).props.onClick(event);
    assert.equal(render(1).props.children, "OpenGL");
    assert.equal(form.normalMapFormat, "opengl");
    assert.deepEqual(form.normalMapFormats, { 1: "opengl", 2: "dx" });
    render(2).props.onClick(event);
    render(1).props.onClick(event);
    assert.equal(form.normalMapFormat, "dx");
    assert.deepEqual(form.normalMapFormats, { 1: "dx", 2: "opengl" });
    assert.strictEqual(form.textureEntries, original.textureEntries);
    assert.strictEqual(form.modelSlots, original.modelSlots);
    assert.equal(form.assetName, original.assetName);
    assert.deepEqual(original.normalMapFormats, {});
  }
});

test("failed animation naming and motion rules do not block single or batch imports", async () => {
  for (const batch of [false, true]) for (const invalidName of [false, true]) {
    const { state, form, submit } = fixture(() => ({ ok: true, assetId: "saved" }));
    Object.assign(form, { assetType: "animation", assetName: invalidName ? "walk" : "AS_Executor_Alert_Walk", destinationPath: "D:/Library/Animation/Monster", animationAffiliation: "怪物", subCategory: "基础移动", animationLabelsText: "走", animationGameTag: { kind: "monster", id: "Executor" } });
    Object.assign(state, {
      isAnimationAssetImportType: type => type === "animation", getMissingAnimationFields: () => [], animationPlanningLabels: () => [],
      getAnimationAssetNameIssue: () => invalidName ? ({ zh: "命名不符合规范", en: "Invalid naming" }) : null,
      getFirstFbxPath: files => files.find(file => /\.fbx$/i.test(file)) || "",
      resolveAnimationAffiliationValue: value => value, resolveAnimationTypeValue: (_, category) => category, isAnimationTypeValue: () => true,
      parseAnimationLabels: require('../shared/animationUnrealExport.mjs').parseAnimationLabels,
      animationGameTagKind: affiliation => affiliation === '怪物' ? 'monster' : 'weapon',
      allAssets: [], loadAnimationFbxStats: async () => ({ frameRate: 30 }), loadAnimationRuleReference: async () => ({}),
      evaluateAnimationImportRules: () => [{ id: 'fps', status: 'fail', zh: '帧率不符合规范' }], getAnimationRuleErrors: rows => rows.filter(row => row.status === 'fail'),
      switchImportAsset: index => { state.focusedImport = index; }
    });
    state.importDrafts = [{ form, tagInput: "" }, { form: { ...form, assetName: "walk2" }, tagInput: "" }];
    await submit(0, batch ? [0, 1] : undefined);
    assert.equal(state.calls, batch ? 2 : 1, JSON.stringify(state.alert));
    assert.equal(state.alert, null);
  }
  assert.match(source, /importAnimationRuleChecks\.map/);
});
