"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const sharp = require("sharp");
const { MASK_SOURCE_PRIORITY, foliageOpaqueStatus, resolveFoliageMaskSource,
  generateFoliageOpaqueTasks } = require("../electron/services/foliageOpaque");
const { buildFoliageOpaqueVariants, opaqueVariantKeyFor, isOpaqueVariantKey } = require("../electron/services/foliageOpaqueVariants");

// 遮罩来源规则（2026-10-15）：
//   1) OpacityMasked 系，同档取**分辨率最高**的一张；
//   2) 没有 OpacityMasked 时退到 Albedo/Diffuse/Basecolor 的 alpha —— 且必须真的有 alpha；
//   3) 两者都没有 ⇒ 不可用（返回 null）。
// 读不出尺寸/alpha 的文件（损坏、测试替身）不参与上述判定，按类型优先级兜底。
test("foliage mask priority uses material, area, resolution and alpha presence", async () => {
  // 1) 不可读文件：按类型优先级兜底，仍然跳过 billboard 与 area>1。
  const entries = [
    { textureType: "Albedo", path: "albedo.png", areaIndex: 1 },
    { textureType: "OpacityMasked", path: "billboard.png", materialRole: "billboard" },
    { textureType: "OpacityMasked", path: "area2.png", areaIndex: 2 },
    { textureType: "OpacityMasked", path: "opacity.png", areaIndex: 1 }
  ];
  const fallback = await resolveFoliageMaskSource(entries);
  assert.equal(fallback.textureType, "Opacity");
  assert.equal(fallback.filePath, "opacity.png");
  assert.equal(fallback.channel, "auto");
  assert.equal(fallback.probed, false);
  assert.ok(fallback.skipped.includes("Opacity:billboard"));
  assert.ok(fallback.skipped.includes("Opacity:area2"));

  // 真实图片下的判定 —— 用 sharp 现造 fixture，避免"假文件"掩盖真规则。
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "assethive-mask-priority-"));
  const white = { r: 255, g: 255, b: 255 };
  const makeImage = async (file, { size, channels, format }) => {
    const image = sharp({ create: { width: size, height: size, channels, background: channels === 4 ? { ...white, alpha: 1 } : white } });
    await (format === "jpeg" ? image.jpeg() : image.png()).toFile(file);
  };
  try {
    // 2) 同档取分辨率最高者。
    const small = path.join(dir, "T_small_OpacityMasked.png");
    const big = path.join(dir, "T_big_OpacityMasked.png");
    await makeImage(small, { size: 8, channels: 3 });
    await makeImage(big, { size: 64, channels: 3 });
    const picked = await resolveFoliageMaskSource([
      { textureType: "OpacityMasked", path: small, areaIndex: 1 },
      { textureType: "Opacity", path: big, areaIndex: 1 }
    ]);
    assert.equal(picked.filePath, big, "同档多份取分辨率最高的那份");
    assert.equal(picked.width, 64);
    assert.equal(picked.probed, true);
    assert.equal(picked.textureType, "Opacity");

    // 3) 无 OpacityMasked → 退到 albedo 的 alpha；没有 alpha 的不能顶替。
    const rgbAlbedo = path.join(dir, "T_a_Albedo.jpg");
    const rgbaAlbedo = path.join(dir, "T_a_Albedo.png");
    await makeImage(rgbAlbedo, { size: 16, channels: 3, format: "jpeg" });
    await makeImage(rgbaAlbedo, { size: 16, channels: 4 });
    assert.equal(await resolveFoliageMaskSource([{ textureType: "Albedo", path: rgbAlbedo, areaIndex: 1 }]), null,
      "没有 alpha 通道的 Albedo 不能当遮罩（否则得到全不透明遮罩）");
    const alphaMask = await resolveFoliageMaskSource([{ textureType: "Albedo", path: rgbaAlbedo, areaIndex: 1 }]);
    assert.equal(alphaMask.channel, "alpha");
    assert.equal(alphaMask.textureType, "Albedo");
    assert.equal(alphaMask.probed, true);

    // 4) 两类来源都没有 → 不可用。
    assert.equal(await resolveFoliageMaskSource([{ textureType: "Roughness", path: "rough.png" }]), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }

  const ranks = MASK_SOURCE_PRIORITY.map((item) => item.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("opaque variant identities keep the source variant", () => {
  assert.equal(opaqueVariantKeyFor("01"), "01OPAQUE");
  assert.equal(opaqueVariantKeyFor("a3"), "A3OPAQUE");
  assert.equal(isOpaqueVariantKey("03OPAQUE"), true);
  assert.equal(isOpaqueVariantKey("03"), false);
});

test("missing mask and unavailable processor leave the source import intact", async () => {
  const destinationDir = path.join(__dirname, "..", ".cache", "foliage-test-output");
  const result = await buildFoliageOpaqueVariants({
    destinationDir,
    modelEntries: [{ suffix: "Mesh", path: "D:/not-exists/plant.fbx", variantKey: "01" }],
    textureEntries: []
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.added, []);
  assert.match(result.message, /透贴/);
  const unavailable = await generateFoliageOpaqueTasks([{ input: "in.fbx", output: "out.fbx" }], {
    mask: "mask.png", runtime: { available: false, message: "处理器缺失" }
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.message, "处理器缺失");
  assert.equal(typeof foliageOpaqueStatus().available, "boolean");
});
