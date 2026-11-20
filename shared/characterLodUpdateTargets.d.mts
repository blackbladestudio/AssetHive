type ModelFile = { role: string; storedPath: string; normalizedName?: string };
export type CharacterLodUpdateTarget = {
  storedPath: string; fileName: string; role: 'staticMesh' | 'skeletalMesh';
  lod: number; modelName: string; isNew: boolean;
};
export function characterLodUpdateTargets(groups: { slot: string; files: ModelFile[] }[]): CharacterLodUpdateTarget[];
