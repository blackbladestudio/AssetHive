const { defaultMaskGroup, maskParentSuffix } = require("../../shared/maskMaterials.mjs");
const { runImageTask } = require("./imageTasks");
const { namedTextureMetadata, textureMaterial, materialKey } = require("./zion3dMaterials");
const path = require("node:path");

async function buildMaskMaterial(group, configuration = defaultMaskGroup()) {
  const mask = group.bySlot.get("mask");
  const activeChannels = mask ? (await runImageTask("detectMaskChannels", [mask])).channels : [];
  return {
    baseUvSet: configuration.baseUvSet,
    maskUvSet: configuration.maskUvSet,
    fullUv2Ao: group.bySlot.has("uv2ao"),
    activeChannels,
    parentSuffix: maskParentSuffix(activeChannels),
    texelsPerMeter: 768,
    channels: Object.fromEntries(activeChannels.map(channel => {
      const layer = configuration.channels[channel];
      return [channel, { ...layer, metallic: layer.metallicEnabled ? layer.metallic : "" }];
    }))
  };
}

function maskTextureMetadata(files) {
  const textures = files.filter(file => /\.(png|jpe?g|tga|tiff?|bmp|webp)$/i.test(file));
  const baseFiles = textures.filter(file => /[\\/]base[\\/]/i.test(file));
  const base = namedTextureMetadata(baseFiles.length ? baseFiles : textures);
  const slots = [...base.textureSlots];
  const names = Object.entries(base.materialNames);
  for (const file of textures) {
    if (slots.some(slot => slot.filePath === file)) continue;
    const filename = path.basename(file);
    const type = /uv2[ _-]?ao/i.test(filename) ? "UV2AO"
      : /[\\/]mask[\\/]/i.test(file) || /(?:^|_)mask(?:_|\.)/i.test(filename) ? "Mask" : "";
    if (!type) continue;
    const parsed = textureMaterial(file);
    const rawKey = materialKey(path.basename(file, path.extname(file)));
    const match = names.find(([, name]) => materialKey(name) === rawKey || (parsed && materialKey(name) === parsed.key)) || (names.length === 1 ? names[0] : null);
    if (match) slots.push({ filePath: file, textureType: type, areaId: Number(match[0]) });
  }
  return { materialNames: base.materialNames, textureSlots: slots };
}

module.exports = { buildMaskMaterial, maskTextureMetadata };
