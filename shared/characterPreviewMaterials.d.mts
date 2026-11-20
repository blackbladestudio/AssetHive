export type CharacterPreviewChannel = "d" | "n" | "orm" | "a";
export function characterPreviewTextureKey(stem: string, channel: CharacterPreviewChannel, textureKeys: Iterable<string>): string;
export function heroPreviewMaterialRole(materialName: string, heroPart?: string): string;
export function characterPreviewMaterialPlan(materialName: string, textureKeys: Iterable<string>, heroPart?: string, allowWeaponFallback?: boolean): {
  stem: string;
  role: string;
  hasTextures: boolean;
  neutralWhite: boolean;
};
