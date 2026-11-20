export function gameplayPrefix(category: string): string;
export function gameplayUsesResourceId(category: string): boolean;
export function gameplayIdentity(category: string, value: unknown): {prefix: string; name: string; assetName: string};
export function gameplayCategoryFromName(value: string): string;
export function gameplayFileStem(assetName: string, role: string, sourceStem: string, aliases?: string[]): string;
