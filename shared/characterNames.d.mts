export function validCharacterChineseName(value: unknown): boolean;
export function validCharacterEnglishName(value: unknown): boolean;
export function syncCharacterNames(family: string, fields?: { displayNameZh?: unknown; displayNameEn?: unknown; name?: unknown; suitName?: unknown }): { displayNameZh: string; displayNameEn: string; name?: string; suitName?: string };
export function normalizeCharacterNames(fields?: { displayNameZh?: unknown; displayNameEn?: unknown }): { displayNameZh: string; displayNameEn: string };
export function normalizeMonsterNames(fields?: { displayNameZh?: unknown; displayNameEn?: unknown; name?: unknown }): { displayNameZh: string; displayNameEn: string; name: string };
export function inferCharacterChineseName(values?: unknown[]): string;
