export function validCharacterChineseName(value) {
  const name = String(value || "").trim();
  return name.length <= 32 && /\p{Script=Han}/u.test(name) && !/[<>/\\]/u.test(name)
    && !Array.from(name).some(char => char.charCodeAt(0) < 32);
}

export function normalizeCharacterNames(fields = {}) {
  const displayNameZh = String(fields.displayNameZh || "").trim();
  const displayNameEn = String(fields.displayNameEn || "").trim();
  return { displayNameZh, displayNameEn };
}

// Planned export destinations are not evidence that an asset has reached UE.
export function hasCharacterEnginePath(meta = {}) {
  const paths = [meta.enginePath, meta.unrealPath, meta.uePath, meta.unrealAssetPath, meta.engineAssetPath,
    meta.exportInfo?.unrealPath, meta.exportInfo?.assetPath, meta.unreal?.assetPath];
  return paths.some(value => typeof value === 'string' && value.trim().startsWith('/Game/'))
    || Object.values(meta.characterUnrealExports || {}).some(receipt =>
      Object.values(receipt?.entries || {}).some(entry => String(entry?.lastSuccessPath || '').startsWith('/Game/')));
}

// Monster identity uses the same English name shown in the name editor.
// A detected source name is only a seed when neither display name is available.
export function normalizeMonsterNames(fields = {}) {
  return syncCharacterNames('monster', fields);
}

export function validCharacterEnglishName(value) {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(String(value || '').trim());
}

// Source identity can seed a missing field. An explicitly cleared English field
// stays empty, so editing Chinese never restores or generates an English name.
export function syncCharacterNames(family, fields = {}) {
  const key = family === 'suit' ? 'suitName' : 'name';
  const source = fields.displayNameEn === undefined ? fields[key] : fields.displayNameEn;
  const names = normalizeCharacterNames({ ...fields, displayNameEn: source });
  return { ...names, [key]: names.displayNameEn };
}

export function inferCharacterChineseName(values = []) {
  const generic = /^(?:角色|人物|模型|贴图|材质|预览|资源|套装|头发|脸部|武器|怪物|场景|工程|绑定|已绑定|未绑定|骨骼|蒙皮)$/;
  for (const value of values) {
    const parts = String(value || "").replace(/\\/g, "/").split("/").reverse();
    for (const part of parts) {
      const matches = part.replace(/\.[^.]+$/, "").match(/[\p{Script=Han}]{2,32}/gu) || [];
      const candidate = matches.find(name => !generic.test(name));
      if (candidate && validCharacterChineseName(candidate)) return candidate;
    }
  }
  return "";
}
