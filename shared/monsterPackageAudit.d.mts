export type MonsterAuditIssue = { code: string; message: string; files: string[] };
export type MonsterModelAnalysis = { meshKind?: string; materialNames?: string[]; ok?: boolean; error?: string };
export type MonsterAudit = { ok: boolean; sourceName: string; formIds: string[]; issues: MonsterAuditIssue[]; problemFileCount: number; modelAliases: Record<string, string> };
export function normalizeMonsterSourceStem(value: string): string;
export function buildMonsterAssetName(name: string, formIds?: string[]): string;
export function displayMonsterFormNumbers(formIds?: string[]): string;
export function classifyMonsterSource(file: string): { role: string; folder: string };
export function splitMonsterPackage(files: string[]): { groups: { name: string; form: string; files: string[] }[]; unassigned: string[] };
export function auditMonsterPackage(files: string[], options?: { expectedName?: string; modelAnalyses?: Record<string, MonsterModelAnalysis> | Map<string, MonsterModelAnalysis> }): MonsterAudit;
