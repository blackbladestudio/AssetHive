export const CHARACTER_MODEL_EXTENSIONS: ReadonlySet<string>;
export const CHARACTER_TEXTURE_EXTENSIONS: ReadonlySet<string>;
export const CHARACTER_SOURCE_EXTENSIONS: ReadonlySet<string>;
export const CHARACTER_DATA_EXTENSIONS: ReadonlySet<string>;
export function characterPackageExtension(filePath: string): string;
export function isAllowedCharacterTextureFile(filePath: string): boolean;
export function isAllowedCharacterPackageFile(filePath: string): boolean;
export function characterRoleAllowsFile(role: string, filePath: string): boolean;
export function partitionCharacterPackageFiles(filePaths: unknown[]): { accepted: string[]; excluded: string[] };
