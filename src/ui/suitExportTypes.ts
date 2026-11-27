export type SkeletonSelection = { mode: 'auto' | 'existing' | 'create'; path?: string };
export type SuitExportOptions = {
  materialMode?: 'formal' | 'blockout';
  linkOnly?: boolean;
  skeletonSelection?: SkeletonSelection;
  skeletonOverrides?: Record<string, SkeletonSelection>;
  inspectAllMeshes?: boolean;
  includeStaticMeshes?: boolean;
  associationSync?: boolean;
  normalFormat?: string;
  skeletonPath?: string;
  materialMappings?: Record<string, string>;
  monsterMaterialTypes?: Record<string, 'cloth' | 'skin'>;
};
export type SuitExportRow = {
  assetId: string; key: string; name: string; kind?: string; targetPath?: string; path?: string;
  status: string; action: string; message?: string;
  partSlot?: string; groupName?: string; oldKey?: string;
  lodReport?: { policy?: string; skinTransferVersion?: number; waitingForRig?: boolean; count: number; levels?: { index: number; triangles: number; source: string }[]; missing?: number[]; pending?: number[]; missingManual?: number[] };
  lodCheckedAt?: string;
  dependencies?: string[];
  sharedEntryKey?: string;
  skeletonSelection?: SkeletonSelection;
  skeletonPath?: string;
  skeletonAddedBones?: string[];
};
export type SuitExportResult = {
  materialMode?: 'formal' | 'blockout';
  entries: SuitExportRow[]; inspectToken: string; manifestHash: string; projectPath: string;
  phase: 'inspect' | 'apply';
  sharedAffectedAssets?: { assetId: string; name: string }[];
  monsterMaterialGroups?: { key: string; name: string; assetName: string; type: '' | 'cloth' | 'skin' }[];
  materialRequests: { key: string; meshName: string; slot: string; groups: { key: string; name: string }[] }[];
};
export type SuitExportRequest = {
  suitPhase?: 'inspect' | 'apply'; suitOptions?: SuitExportOptions;
  suitManifestHash?: string; suitInspectToken?: string; suitDecisions?: Record<string, string>;
};
