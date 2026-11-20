export function heroTextureChannel(source: string): string;
export function heroMaterialRole(source: string, variant: string): string;
export function heroTextureSuffix(source: string, variant: string): string;
export function heroTextureGroup(source: string, variant: string): {key: string; part: string; role: string};
export function heroMaterialGroupForSlot(slot: string, variant: string, groups: {key: string; part: string; role: string}[]): string;
