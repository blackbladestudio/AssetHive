type Group = { key: string; name: string };
export function suitMaterialChoiceKey(part: string, slot: string): string;
export function isSharedSuitMaterialSlot(slot: string): boolean;
export function matchSuitMaterialSlot(slot: string, groups: Group[], part?: string, choice?: string): { key: string; corrected: boolean };
export function reviewSuitMaterialSlots(models: Array<{ file: string; part: string; slots?: string[] }>, groups: string[], choices?: Record<string, string>): Array<{ id: string; file: string; slot: string; key: string; corrected: boolean; groupName: string; groups: Group[] }>;
