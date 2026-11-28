export const MASK_CHANNELS = Object.freeze(["R", "G", "B", "A"]);

export function isMaskAsset(tags) {
  if (tags && typeof tags === "object" && !Array.isArray(tags)) {
    if (tags.assetType && tags.assetType !== "3d") return false;
    if (tags.textureGroupMode) return tags.textureGroupMode === "channel";
    return isMaskAsset(tags.standardAssetTags || tags.tags || tags.tagsText);
  }
  return (Array.isArray(tags) ? tags : String(tags || "").split(/[,，;；\n]+/))
    .some(tag => /^(mask|mega)$/i.test(String(tag).trim()));
}

export function hasMaskFolderLayout(files) {
  return files.some(file => /[\\/](?:base|mask)[\\/][^\\/]+\.(?:png|jpe?g|tga|tiff?|bmp|webp)$/i.test(file));
}

export function maskParentSuffix(channels) {
  const last = Math.max(-1, ...channels.map(channel => MASK_CHANNELS.indexOf(channel)));
  return last < 0 ? "Base" : MASK_CHANNELS.slice(0, last + 1).join("");
}

function uvSet(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 7) throw new Error("UV 集索引须为 0–7");
  return number;
}

function textureReference(value) {
  const reference = String(value || "").trim().replace(/^(?:\/Script\/Engine\.)?(?:Texture2D|Texture)'(.+)'$/i, "$1");
  if (reference && !/^\/Game\/(?:[\p{L}\p{N}_]+\/)*[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)?$/u.test(reference)) {
    throw new Error(`纹理引用须为项目内 /Game/ 路径：${reference}`);
  }
  return reference;
}

export function defaultMaskGroup() {
  return { baseUvSet: 0, maskUvSet: 1, channels: Object.fromEntries(MASK_CHANNELS.map(channel =>
    [channel, { uvSet: 1, bcr: "", normal: "", metallicEnabled: false, metallic: "" }])) };
}

export function normalizeMaskGroups(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("通道组配置无效");
  return Object.fromEntries(Object.entries(value).map(([area, group]) => {
    if (!/^[1-9]\d*$/.test(area) || Number(area) > 9999 || !group || typeof group !== "object") {
      throw new Error(`通道组编号无效：${area}`);
    }
    return [area, {
      baseUvSet: uvSet(group.baseUvSet, 0), maskUvSet: uvSet(group.maskUvSet, 1),
      channels: Object.fromEntries(MASK_CHANNELS.map(channel => {
        const input = group.channels?.[channel] || {};
        return [channel, { uvSet: uvSet(input.uvSet, 1), bcr: textureReference(input.bcr),
          normal: textureReference(input.normal), metallicEnabled: input.metallicEnabled === true,
          metallic: textureReference(input.metallic) }];
      }))
    }];
  }));
}
