export type SuitExportOptions = {
  includeStaticMeshes?: boolean;
  normalFormat?: string;
  skeletonPath?: string;
  materialMappings?: Record<string, string>;
  monsterMaterialTypes?: Record<string, 'cloth' | 'skin'>;
};
export type SuitExportRow = {
  assetId: string; key: string; name: string; kind?: string; targetPath?: string; path?: string;
  status: string; action: string; message?: string;
  partSlot?: string; groupName?: string; oldKey?: string;
};
export type SuitExportResult = {
  entries: SuitExportRow[]; inspectToken: string; manifestHash: string; projectPath: string;
  phase: 'inspect' | 'apply';
  monsterMaterialGroups?: { key: string; name: string; assetName: string; type: '' | 'cloth' | 'skin' }[];
  materialRequests: { key: string; meshName: string; slot: string; groups: { key: string; name: string }[] }[];
};
export type SuitExportRequest = {
  suitPhase?: 'inspect' | 'apply'; suitOptions?: SuitExportOptions;
  suitManifestHash?: string; suitInspectToken?: string; suitDecisions?: Record<string, string>;
};
