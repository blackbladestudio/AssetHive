export type CharacterLodFile = { name: string; sourcePath?: string; sourceHash?: string; kind?: string; status?: string; inspection?: 'pending' | 'failed' | 'ready'; inspectionMessage?: string };
export type CharacterLodGroup = { key: string; name: string; files: (CharacterLodFile & { index: number })[]; automatic: number[]; missingBase: boolean; duplicate: boolean };
export function characterLodReview(files: CharacterLodFile[]): CharacterLodGroup[];
export function characterLodReviewToken(files: CharacterLodFile[]): string;
