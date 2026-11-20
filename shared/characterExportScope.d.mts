export function characterExportScope<T extends { key: string; kind?: string; dependencies?: string[] }>(rows: T[], includeStaticMeshes?: boolean): T[];
