export interface GameplayCategoryNode { code: string; zh: string; tier: string; aliases?: string[]; children?: GameplayCategoryNode[] }
export const tree: GameplayCategoryNode[];
export const entries: { value: string; label: string; leaf: boolean; prefix: string; legacy: string }[];
export const categories: string[];
export function inferCategory(values: string[]): string;
export function normalizeCategory(value: unknown): string;
export function selectionLevels(value: string): {value: string; options: {value: string; label: string; code: string}[]}[];
export function filterLevels(value: string): {value: string; allValue: string; disabled: boolean; terminal: boolean; options: {value: string; label: string; code: string}[]}[];
