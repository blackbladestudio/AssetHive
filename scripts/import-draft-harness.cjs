const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const characterImport = require("../electron/services/characterImport");
const characterUiFile = path.resolve(__dirname, "../src/ui/characterImport.ts");
const characterUiCompiled = ts.transpileModule(fs.readFileSync(characterUiFile, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText;
const characterUiModule = { exports: {} };
new Function("require", "module", "exports", characterUiCompiled)(require("node:module").createRequire(characterUiFile), characterUiModule, characterUiModule.exports);
const characterUi = characterUiModule.exports;

// Shared harness for import-side tests: it runs the *real* drag/batch import
// draft builder (applyQuickDropImport) from src/ui/App.tsx with an isolated
// bridge, so behaviour can be asserted without Electron, a library or any user
// settings being touched.
const FUNCTIONS = [
  "setCharacterPackageFileIncluded",
  "pruneCharacterImportFiles",
  "characterPackageModelSlots",
  "filterCharacterTextureEntries",
  "characterImportLodFiles",
  "characterImportLodsConfirmed",
  "buildImportPayload",
  "getAcceptedModelExtsForAssetType",
  "isModelFileAcceptedForType",
  "formatAcceptedModelExts",
  "textureEntriesToSlots",
  "normalizeNormalMapFormatsByArea",
  "getTextureAreaIdList",
  "normalizeZionTag",
  "applyQuickDropImport",
  "resolveImportSubCategory",
  "detectTextureTypeFromFileName",
  "getTextureTypeDisplayLabel",
  "normalizeOpacityTextureType",
  "parseTextureSlotToken",
  "normalizeTextureEntries",
  "getMissingRequiredTextureTypes",
  "getRequiredTextureTypesForAssetType",
  "isTextureTypeName",
  "inferTextureTypeFromPath",
  "inferAreaIdFromFileName",
  "guessAssetNameFromFileName",
  "getFileExt",
  "getFileBaseName",
  "stripExt",
  "normalizeLocalPath",
  "normalizeAssetTag",
  "normalizeThemeToken",
  "normalizeTagKey",
  "buildTaxonomyTagKeys",
  "isTaxonomyTag",
  "getAssetTypeLabel",
  "parseTagsText",
  "preferPngDisplacementEntries",
  "parseTextureResolutionPixels",
  "isTextureWithinImportResolutionLimit",
  "pickPreferredTexturePathWithinImportLimit",
  "normalizeTextureMaterialRole",
  "isThumbsFolderPath",
  "makeTextureEntry",
  "getFileStemFromPath",
  "getModelLodOrder",
  "isModelLodPath",
  "normalizeImportModelVariantKey",
  "parseImportModelVariantKey",
  "stripImportModelLodKey",
  "buildImportModelLodFiles",
  "normalizeStandardAssetTagSearchText",
  "normalizeStandardAssetTag",
  "getSelectedStandardAssetTags",
  "standardAssetTagMatchesSearchText",
  "stripStandardAssetTagFolderPrefix",
  "stripZionSurfaceFolderTypePrefix",
  "hasPbrMaxDecalNameToken",
  "isPbrMaxAutoDetectAssetType",
  "getStandardAssetTagOptionsForAssetType",
  "detectStandardAssetTagForImport",
  "detectStandardAssetTagFromFolderPrefix",
  "detectStandardAssetTagFromFolderPrefixAcrossAssetTypes",
  "getStandardAssetTagOptions",
  "getDefaultTextureTypesForAssetType",
  "switchImportTextureEntriesForAssetType",
  "isAnimationTypeValue",
  "resolveAnimationTypeValue",
  "isAnimationAffiliationValue",
  "resolveAnimationAffiliationValue",
  "withAnimationTypeFields"
];
const CONSTANTS = ["importDuplicateCheckEnabled", "IMPORT_TEXTURE_MAX_RESOLUTION_PIXELS", "subCategoryOptionsByAssetType", "textureTypeOptions", "textureTypeAbbreviations", "standardAssetTagsByAssetType", "standardAssetTagAssetTypeByTag", "standardAssetTagSearchAliases", "assetTypeFolderAliases", "DEFAULT_ANIMATION_SKELETON_PATH", "ANIMATION_TYPE_OPTIONS", "ANIMATION_TYPE_SET", "ANIMATION_AFFILIATION_OPTIONS", "ANIMATION_AFFILIATION_SET"];

const appSource = path.join(__dirname, "../src/ui/App.tsx");
const parsed = ts.createSourceFile("App.tsx", fs.readFileSync(appSource, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pieces = [];
(function visit(node) {
  if (ts.isFunctionDeclaration(node) && FUNCTIONS.includes(node.name?.text)) {
    pieces.push(node.getText(parsed));
  }
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => CONSTANTS.includes(item.name?.getText(parsed)))) {
    pieces.push(node.getText(parsed));
  }
  ts.forEachChild(node, visit);
})(parsed);
assert.equal(pieces.length, FUNCTIONS.length + CONSTANTS.length, "import helpers must stay declared in src/ui/App.tsx");
const compiled = ts.transpileModule(pieces.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const defaultImportForm = {
  assetName: "", assetType: "3d", subCategory: "", modelSlots: {}, modelVariantKeys: {}, modelLodFiles: {}, enabledModelTypes: [],
  textureEntries: [], previewImagePath: "", destinationPath: "", skeletonPath: "", skeletalMeshPath: "", tagsText: "", zionTags: [], baseTiling: "1", normalMapFormat: "dx", normalMapFormats: { 1: "dx" },
  characterFields: { family: "", gender: "", bodyCode: "", suitClass: "", suitName: "", serial: "", variant: "", maturity: "wip", confirmed: false },
  characterPackageFiles: [], characterModelAnalysis: {}, characterExcludedFiles: [], characterFileScopes: {}, characterScopesConfirmed: false,
  characterPreviewPaths: { front: "", left: "", right: "", back: "" }
};

function buildScope(files, options = {}) {
  const state = { busy: false, progress: 0, statuses: [], drafts: options.existingDrafts || [], dedupeChecks: [], quickDropRequestIdRef: { current: "" }, importSelectionAnchorRef: { current: null } };
  state.importDraftsRef = { current: state.drafts };
  state.importSavingRef = { current: Boolean(options.importSaving) };
  state.pendingImportAppendsRef = { current: [] };
  state.archiveCleanupPromiseRef = { current: null };
  // 后台导入期间拖入资产会进入"预排队编辑"：源码头部的 useState/useRef 不在切片范围内，
  // 这里补上同名桩，并让 importDraftsRef 与 state.drafts 保持同一数组引用。
  state.prequeueEditingRef = { current: false };
  state.prequeueEditing = false;
  state.importModalLocked = false;
  const heroRules = require("../shared/heroPackageRules.mjs");
  const scope = {
    settings: {},
    isAnimationAssetImportType: type => type === 'animation',
    isModelAssetImportType: type => ['suit','monster','npc','weapon','3d','3dplant'].includes(type),
    getTopCategoryForImportType: () => '角色',
    ...require('../shared/characterNames.mjs'),
    buildMonsterAssetName: require('../shared/monsterPackageAudit.mjs').buildMonsterAssetName,
    characterTaskWorkspace: Boolean(options.characterTaskWorkspace),
    liveImportDraftRef: { current: options.currentDraft || state.drafts[0] },
    ...require('../shared/weaponRules.mjs'),
    bridgeAvailable: true,
    bridge: {
      deduplicateCharacterTextures: async files => ({ files, duplicates: [] }),
      resolveDroppedItems: async () => ({
        assets: options.resolvedAssets || [{
          files,
          preferredName: options.preferredName || "",
          folderName: options.folderName || (files[0] ? path.basename(path.dirname(files[0])) : ""),
          metadata: options.metadata || null
        }]
      }),
      analyzeCharacterModels: async paths => ({ ok: true, analyses: Object.fromEntries(paths.map(file => [file, Object.entries(options.modelAnalyses || {}).find(([key]) => key.replaceAll('\\', '/').toLowerCase() === file.replaceAll('\\', '/').toLowerCase())?.[1] || {
        ok: true, meshKind: "staticMesh", hasSkeleton: false, hasSkin: false, boneCount: 0, skinnedMeshCount: 0
      }])) })
    },
    defaultImportForm,
    importForm: { assetType: "3d" },
    activeMenu: "environment",
    mapNodeIdToAssetTypes: () => [],
    isCharacterAssetType: assetType => ["suit", "monster", "npc", "weapon", "item"].includes(String(assetType || "").trim().toLowerCase()),
    classifyFamilyPackageFile: characterUi.classifyFamilyPackageFile,
    classifyCharacterPackageFile: characterUi.classifyCharacterPackageFile,
    inferCharacterAssetType: () => "suit",
    inferCharacterFields: characterImport.inferCharacterFields,
    buildCharacterAssetName: characterUi.buildCharacterAssetName,
    auditHeroPackage: heroRules.auditHeroPackage,
    auditMonsterPackage: require('../shared/monsterPackageAudit.mjs').auditMonsterPackage,
    inferHeroPackageFileScopes: heroRules.inferHeroPackageFileScopes,
    heroPackageModelFiles: heroRules.heroPackageModelFiles,
    heroPackageNeedsScopeReview: heroRules.heroPackageNeedsScopeReview,
    setModalAlert: () => {},
    inferFamilyPackageIdentity: characterUi.inferFamilyPackageIdentity,
    characterCategoryOptions: characterUi.characterCategoryOptions,
    inferCharacterSourcePackageName: characterImport.inferCharacterSourcePackageName,
    inferCharacterTextureGroup: characterImport.inferCharacterTextureGroup,
    inferCharacterTextureType: characterImport.inferCharacterTextureType,
    partitionCharacterPackageFiles: require("../shared/characterFilePolicy.mjs").partitionCharacterPackageFiles,
    heroPartKind: heroRules.heroPartKind,
    heroModelStem: heroRules.heroModelStem,
    previewFamilyFileName: characterUi.previewFamilyFileName,
    characterLodReviewToken: require('../shared/characterLodReview.mjs').characterLodReviewToken,
    partitionHeroSuitFiles: heroRules.partitionHeroSuitFiles,
    generateCharacterPreviewForForm: async draft => draft,
    getCharacterCategoryFromFields: characterImport.getCharacterCategoryFromFields,
    importSelectionAnchorRef: state.importSelectionAnchorRef,
    quickDropRequestIdRef: state.quickDropRequestIdRef,
    importDraftsRef: state.importDraftsRef,
    importSavingRef: state.importSavingRef,
    pendingImportAppendsRef: state.pendingImportAppendsRef,
    archiveCleanupPromiseRef: state.archiveCleanupPromiseRef,
    prequeueEditingRef: state.prequeueEditingRef,
    setPrequeueEditing: value => { state.prequeueEditing = value; state.prequeueEditingRef.current = Boolean(value); },
    setQuickDropBusy: value => { state.busy = value; },
    setQuickDropProgress: value => { state.progress = value; },
    setQuickDropProgressKnown: () => {},
    setQuickDropStage: () => {},
    setCharacterPreviewGenerating: () => {},
    showStatus: message => state.statuses.push(message),
    setImportDrafts: value => {
      state.drafts = typeof value === "function" ? value(state.drafts) : value;
      // 源码在预排队路径里直接赋值 importDraftsRef.current，组件侧靠 setImportDrafts 同步；
      // 这里让两者始终指向同一数组，避免断言读到旧快照。
      state.importDraftsRef.current = state.drafts;
    },
    setActiveImportIndex: () => {},
    setImportSidebarCollapsed: () => {},
    setImportForm: value => { state.form = value; },
    setImportTagInput: () => {},
    setSelectedImportIndexes: () => {},
    setImportOpen: value => { state.open = value; },
    t: zh => zh,
    getSubCategoryOptions: () => ["Nature"],
    getNextMeshSlotKey: slots => `Mesh${Object.keys(slots).length + 1}`,
    readAnimationPreviewRig: () => ({ skeletonPath: "", skeletalMeshPath: "" }),
    // 重复检测在界面里执行：这里只记录进入导入界面时排队检测的草稿索引。
    resetImportDedupeState: () => {
      state.dedupeChecks = [];
    },
    queueImportDedupeCheck: (index) => {
      state.dedupeChecks.push(index);
    },
    resolveImportDestinationForType: () => ""
  };
  const api = new Function("scope", `with (scope) { ${compiled}; return { buildImportPayload, isModelFileAcceptedForType, applyQuickDropImport, detectTextureTypeFromFileName, getTextureTypeDisplayLabel, detectStandardAssetTagFromFolderPrefix, getStandardAssetTagOptions, getSelectedStandardAssetTags, switchImportTextureEntriesForAssetType, buildTaxonomyTagKeys, isTaxonomyTag, textureTypeOptions, parseTextureSlotToken, normalizeTextureEntries, getMissingRequiredTextureTypes }; }`)(scope);
  const selectionApi = new Function("scope", `with (scope) { ${compiled}; return {setCharacterPackageFileIncluded, pruneCharacterImportFiles}; }`)(scope);
  return { state, ...api, ...selectionApi };
}

async function buildDrafts(files, options) {
  const scope = buildScope(files, options);
  await scope.applyQuickDropImport([files[0] ? path.dirname(files[0]) : ""]);
  return { state: scope.state, drafts: scope.state.drafts };
}

module.exports = { buildScope, buildDrafts, defaultImportForm };
