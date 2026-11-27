export function characterExportScope<T extends { key: string; kind?: string; dependencies?: string[] }>(rows: T[], includeStaticMeshes?: boolean): T[];
export function skipUnreadyCharacterEntries(rows: Array<{ key: string; status?: string; dependencies?: string[]; sharedEntryKey?: string }>, decisions?: Record<string, string>): Record<string, string>;
