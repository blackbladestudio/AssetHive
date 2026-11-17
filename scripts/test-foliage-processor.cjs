"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Buffer } = require("node:buffer");
const { test } = require("node:test");
const sharp = require("sharp");
const { traceContours, simplifyLoops, ContourIndex, cutTriangle, area } = require("../electron/services/foliageOpaqueGeometry");
const { cleanupFaces, loadMask } = require("../electron/services/foliageOpaqueWorker");
const { foliageOpaqueStatus, generateFoliageOpaqueVariant } = require("../electron/services/foliageOpaque");

test("contours cut either UV winding and preserve a hole", () => {
  const width = 64, height = 64;
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const distance = Math.hypot(x - 31.5, y - 31.5);
    values[y * width + x] = distance < 22 && distance > 8 ? 1 : 0;
  }
  const loops = traceContours(values, width, height, 0.5);
  assert.equal(loops.length, 2);
  const index = new ContourIndex(simplifyLoops(loops, 0.5 / width, 0));
  assert.equal(index.pointInside(0.5, 0.5), false);
  assert.equal(index.pointInside(0.75, 0.5), true);
  const ccw = [[0, 0], [1, 0], [0, 1]];
  const cw = [ccw[0], ccw[2], ccw[1]];
  const first = cutTriangle(ccw, index).pieces.reduce((sum, polygon) => sum + Math.abs(area(polygon)), 0);
  const second = cutTriangle(cw, index).pieces.reduce((sum, polygon) => sum + Math.abs(area(polygon)), 0);
  assert.ok(first > 0 && first < 0.5);
  assert.ok(Math.abs(first - second) < 1e-8);
});

test("cleanup drops only a small detached part and keeps the largest part", () => {
  const face = (a, b, c) => ({ material: 0, corners: [a, b, c].map((position) => ({ position })) });
  const large = face([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const tiny = face([2, 0, 0], [2.001, 0, 0], [2, 0.001, 0]);
  const result = cleanupFaces([large, tiny], 0.01);
  assert.equal(result.faces.length, 1);
  assert.equal(result.faces[0], large);
  assert.equal(result.stats.islandsRemoved, 1);
  const allSmall = cleanupFaces([tiny], 1);
  assert.equal(allSmall.faces.length, 1);
});

test("TGA and BMP masks keep the FBX bottom-left UV origin", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-mask-test-"));
  try {
    const tga = Buffer.alloc(18 + 2 * 2 * 3);
    tga[2] = 2; // uncompressed true color
    tga.writeUInt16LE(2, 12);
    tga.writeUInt16LE(2, 14);
    tga[16] = 24;
    tga[17] = 0x20; // top-left origin
    // Top row black, bottom row white (BGR order).
    tga.fill(255, 18 + 6);
    const tgaPath = path.join(dir, "mask.tga");
    await fs.writeFile(tgaPath, tga);
    const bmp = Buffer.alloc(54 + 2 * 8);
    bmp.write("BM");
    bmp.writeUInt32LE(bmp.length, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(2, 18);
    bmp.writeInt32LE(2, 22); // bottom-up rows
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    bmp.fill(255, 54, 60); // bottom row white
    const bmpPath = path.join(dir, "mask.bmp");
    await fs.writeFile(bmpPath, bmp);
    for (const filePath of [tgaPath, bmpPath]) {
      const mask = await loadMask(filePath, "luminance", 0, []);
      assert.equal(mask.width, 2);
      assert.ok(mask.values[0] > 0.9, `${filePath}: V=0 should be the white bottom row`);
      assert.ok(mask.values[2] < 0.1, `${filePath}: V=1 should be the black top row`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("explicit alpha masks preserve fully opaque and fully transparent images", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-constant-alpha-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const alpha of [0, 1]) {
    const file = path.join(dir, `alpha-${alpha}.png`);
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 80, g: 80, b: 80, alpha } } }).png().toFile(file);
    const warnings = [];
    const mask = await loadMask(file, "alpha", 0, warnings);
    assert.equal(mask.resolvedChannel, "alpha");
    assert.ok(mask.values.every((value) => value === alpha), `constant alpha ${alpha} changed to RGB luminance`);
    assert.deepEqual(warnings, []);
    if (alpha === 0) assert.ok((await loadMask(file, "auto", 0, [])).values.every((value) => value === 0));
  }
});

test("FBX cut preserves packed UV2/UV3 differences across coincident wind seams", async (t) => {
  const THREE = await import("three");
  const { FBXExporter } = await import("@comfyorg/fbx-exporter-three");
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-wind-seam-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 2));
  for (const [name, first, second] of [["uv1", [0.3, 0.4], [0.3, 0.4]], ["uv2", [0.1234, 0.2343], [0.1235, 0.2344]], ["uv3", [0.6671, 0.7771], [0.6672, 0.7772]]]) {
    geometry.setAttribute(name, new THREE.Float32BufferAttribute([...Array(3).fill(first).flat(), ...Array(3).fill(second).flat()], 2));
  }
  geometry.computeVertexNormals();
  geometry.addGroup(0, 3, 0);
  geometry.addGroup(3, 3, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name: "Wind", transparent: true, opacity: 0.5 })));
  const source = new FBXExporter().parseSync(scene, { preset: "unreal", embedTextures: false });
  const input = path.join(dir, "input.fbx"), output = path.join(dir, "output.fbx"), mask = path.join(dir, "mask.png");
  await fs.writeFile(input, source);
  const maskPixels = Buffer.alloc(16 * 16 * 3);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 8; x += 1) maskPixels.fill(255, (y * 16 + x) * 3, (y * 16 + x) * 3 + 3);
  await sharp(maskPixels, { raw: { width: 16, height: 16, channels: 3 } }).png().toFile(mask);
  const parse = (bytes) => new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "").children.find((item) => item.isMesh);
  const original = parse(source).geometry;
  const result = await generateFoliageOpaqueVariant({ input, output, mask, traceStepTexels: 4, traceMaxFaces: 10000, cleanupPercent: 0 });
  assert.equal(result.ok, true, result.message);
  const actual = parse(await fs.readFile(output)).geometry;
  const counts = [0, 0];
  const uv2 = actual.getAttribute("uv2"), sourceUv2 = original.getAttribute("uv2");
  for (let offset = 0; offset < actual.getAttribute("position").count; offset += 3) {
    const expectedVertex = Math.abs(uv2.getX(offset) - sourceUv2.getX(0)) < 1e-5 ? 0 : 3;
    counts[expectedVertex === 0 ? 0 : 1] += 1;
    for (const name of ["uv1", "uv2", "uv3"]) {
      const attribute = actual.getAttribute(name), sourceAttribute = original.getAttribute(name);
      assert.equal(attribute?.itemSize, 2, name);
      assert.equal(attribute.count, actual.getAttribute("position").count, name);
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = actual.index ? actual.index.getX(offset + corner) : offset + corner;
        assert.ok(Math.abs(attribute.getX(vertex) - sourceAttribute.getX(expectedVertex)) < 1e-5,
          `${name}.x drifted across the coincident wind seam at ${offset}`);
        assert.ok(Math.abs(attribute.getY(vertex) - sourceAttribute.getY(expectedVertex)) < 1e-5,
          `${name}.y drifted across the coincident wind seam at ${offset}`);
      }
    }
  }
  assert.ok(counts.every((count) => count > 0), "both wind units must survive the cut");
});

test("a mixed-material FBX keeps solid bark and fully opaque faces while cutting leaves", async (t) => {
  const THREE = await import("three");
  const { FBXExporter } = await import("@comfyorg/fbx-exporter-three");
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-mixed-parts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    2, 0, 0, 2.1, 0, 0, 2, 0.1, 0,
    4, 0, 0, 5, 0, 0, 4, 1, 0
  ], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 0, 1, 0.1, 0.1, 0.2, 0.1, 0.1, 0.2, 0, 0, 1, 0, 0, 1
  ], 2));
  geometry.computeVertexNormals();
  geometry.addGroup(0, 3, 0);
  geometry.addGroup(3, 6, 1);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial({ name: "Bark" }),
    new THREE.MeshStandardMaterial({ name: "Leaf", transparent: true, opacity: 0.5 })]));
  const bytes = new FBXExporter().parseSync(scene, { preset: "unreal", embedTextures: false });
  const input = path.join(dir, "mixed.fbx"), output = path.join(dir, "mixed_OPAQUE.fbx"), mask = path.join(dir, "mask.png");
  await fs.writeFile(input, bytes);
  const pixels = Buffer.alloc(16 * 16 * 3);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 8; x += 1) pixels.fill(255, (y * 16 + x) * 3, (y * 16 + x) * 3 + 3);
  await sharp(pixels, { raw: { width: 16, height: 16, channels: 3 } }).png().toFile(mask);
  const parse = (data) => new FBXLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "").children.find((mesh) => mesh.isMesh).geometry;
  const original = parse(bytes);
  const result = await generateFoliageOpaqueVariant({ input, output, mask, traceStepTexels: 2, cleanupPercent: 95 });
  assert.equal(result.ok, true, result.message);
  const actual = parse(await fs.readFile(output));
  const bark = actual.groups.find((group) => group.materialIndex === 0);
  assert.equal(bark.count, 3, "the solid part must not be subdivided, clipped or cleaned up");
  for (let corner = 0; corner < 3; corner += 1) for (const name of ["position", "uv"]) {
    const before = original.getAttribute(name), after = actual.getAttribute(name);
    for (let c = 0; c < before.itemSize; c += 1) assert.ok(Math.abs(before.array[corner * before.itemSize + c] - after.array[(bark.start + corner) * after.itemSize + c]) < 1e-5);
  }
  const leaves = actual.groups.filter((group) => group.materialIndex === 1);
  let maxU = 0;
  for (const group of leaves) for (let i = group.start; i < group.start + group.count; i += 1) maxU = Math.max(maxU, actual.getAttribute("uv").getX(i));
  assert.ok(maxU < 0.55, "leaves must still be cut with the mask");
  const report = result.report.jobs[0].objects[0];
  assert.equal(report.preservedFaces, 2, "solid bark and the white leaf face remain untouched");
  assert.equal(report.materialParts.find((part) => part.name === "Bark").cutFacesIn, 0);
  assert.equal(report.materialParts.find((part) => part.name === "Leaf").cutFacesIn, 1);
  assert.ok(report.facesOut > 2);
});

test("Trace cutting applies mask erosion to the output geometry", async (t) => {
  const THREE = await import("three");
  const { FBXExporter } = await import("@comfyorg/fbx-exporter-three");
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-trace-erosion-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  geometry.computeVertexNormals();
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
  const input = path.join(dir, "input.fbx"), mask = path.join(dir, "mask.png");
  await fs.writeFile(input, new FBXExporter().parseSync(scene, { preset: "unreal", embedTextures: false }));
  const pixels = Buffer.alloc(32 * 32 * 3);
  for (let y = 0; y < 32; y += 1) for (let x = 0; x < 16; x += 1) pixels.fill(255, (y * 32 + x) * 3, (y * 32 + x) * 3 + 3);
  await sharp(pixels, { raw: { width: 32, height: 32, channels: 3 } }).png().toFile(mask);
  const maximum = [];
  for (const amount of [0, 2]) {
    const output = path.join(dir, `erode-${amount}.fbx`);
    const result = await generateFoliageOpaqueVariant({ input, output, mask, traceStepTexels: 2, maskErodeTexels: amount, cleanupPercent: 0 });
    assert.equal(result.ok, true, result.message);
    const bytes = await fs.readFile(output);
    const uv = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "").children.find((item) => item.isMesh).geometry.getAttribute("uv");
    let max = 0;
    for (let i = 0; i < uv.count; i += 1) max = Math.max(max, uv.getX(i));
    maximum.push(max);
  }
  assert.ok(maximum[0] - maximum[1] > 0.04, `erosion did not move the Trace edge: ${maximum}`);
});

test("FBX opaque processor cuts the mask, keeps UVs, and writes a readable FBX", async () => {
  const THREE = await import("three");
  const { FBXExporter } = await import("@comfyorg/fbx-exporter-three");
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  assert.equal(foliageOpaqueStatus().available, true);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-foliage-test-"));
  try {
    const input = path.join(dir, "input.fbx");
    const output = path.join(dir, "opaque.fbx");
    const mask = path.join(dir, "mask.png");
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 1, 1, 0,
      0, 0, 0, 1, 1, 0, 0, 1, 0
    ], 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute([
      0, 0, 1, 0, 1, 1,
      0, 0, 1, 1, 0, 1
    ], 2));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(Array(6).fill([0, 0, 1]).flat(), 3));
    geometry.setAttribute("uv1", new THREE.Float32BufferAttribute([
      0, 0, 0.5, 0, 0.5, 0.5,
      0, 0, 0.5, 0.5, 0, 0.5
    ], 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(Array(6).fill([0.2, 0.4, 0.6]).flat(), 3));
    geometry.addGroup(0, 3, 0);
    geometry.addGroup(3, 3, 1);
    const scene = new THREE.Scene();
    const sourceMesh = new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial({ name: "LeavesA", transparent: true, opacity: 0.5 }), new THREE.MeshStandardMaterial({ name: "LeavesB", transparent: true, opacity: 0.5 })]);
    sourceMesh.position.set(2, 3, 4);
    scene.add(sourceMesh);
    const sourceBytes = new FBXExporter().parseSync(scene, { preset: "unreal", embedTextures: false });
    await fs.writeFile(input, sourceBytes);
    const loadedSource = new FBXLoader().parse(sourceBytes.buffer.slice(sourceBytes.byteOffset,
      sourceBytes.byteOffset + sourceBytes.byteLength), "");
    const sourceBounds = new THREE.Box3().setFromObject(loadedSource);
    const pixels = Buffer.alloc(64 * 64 * 4);
    for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) {
      const offset = (y * 64 + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = x < 32 ? 255 : 0;
      pixels[offset + 3] = 255;
    }
    await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toFile(mask);
    const result = await generateFoliageOpaqueVariant({ input, output, mask, cleanupPercent: 0 });
    assert.equal(result.ok, true, result.message);
    assert.ok(result.outputSize > 1000);
    const bytes = await fs.readFile(output);
    const model = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    const mesh = model.children.find((item) => item.isMesh);
    assert.ok(mesh);
    const position = mesh.geometry.getAttribute("position");
    const uv = mesh.geometry.getAttribute("uv");
    assert.ok(position.count > 0);
    assert.equal(position.count, uv.count);
    assert.equal(mesh.geometry.getAttribute("uv1")?.count, uv.count);
    // 顶点色按设计剔除：不透明裁切材质不消费顶点色，而颜色层占产物约两成体积
    // （见 foliageOpaqueWorker 的 EXPORT_EXCLUDED_ATTRIBUTES）。
    assert.equal(mesh.geometry.getAttribute("color"), undefined);
    assert.equal(Array.isArray(mesh.material), true);
    assert.equal(mesh.material.length, 2);
    const outputBounds = new THREE.Box3().setFromObject(model);
    for (const axis of ["x", "y", "z"]) {
      assert.ok(Math.abs(outputBounds.min[axis] - sourceBounds.min[axis]) < 1e-4,
        `${axis} minimum moved when rewriting the FBX`);
    }
    loadedSource.updateMatrixWorld(true);
    model.updateMatrixWorld(true);
    const originalMesh = loadedSource.children.find((item) => item.isMesh);
    const originalPosition = originalMesh.geometry.getAttribute("position");
    const originalUv = originalMesh.geometry.getAttribute("uv");
    let worstUvError = 0;
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const point = new THREE.Vector3().fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld);
      let found = false;
      for (let sourceIndex = 0; sourceIndex + 2 < originalPosition.count; sourceIndex += 3) {
        const vertices = [0, 1, 2].map((corner) => new THREE.Vector3()
          .fromBufferAttribute(originalPosition, sourceIndex + corner).applyMatrix4(originalMesh.matrixWorld));
        const v0 = vertices[1].clone().sub(vertices[0]);
        const v1 = vertices[2].clone().sub(vertices[0]);
        const v2 = point.clone().sub(vertices[0]);
        const d00 = v0.dot(v0), d01 = v0.dot(v1), d11 = v1.dot(v1);
        const d20 = v2.dot(v0), d21 = v2.dot(v1);
        const denominator = d00 * d11 - d01 * d01;
        if (Math.abs(denominator) < 1e-12) continue;
        const w1 = (d11 * d20 - d01 * d21) / denominator;
        const w2 = (d00 * d21 - d01 * d20) / denominator;
        const weights = [1 - w1 - w2, w1, w2];
        if (weights.some((weight) => weight < -1e-4)) continue;
        const expectedU = weights.reduce((sum, weight, corner) => sum + weight * originalUv.getX(sourceIndex + corner), 0);
        const expectedV = weights.reduce((sum, weight, corner) => sum + weight * originalUv.getY(sourceIndex + corner), 0);
        worstUvError = Math.max(worstUvError, Math.abs(expectedU - uv.getX(vertex)), Math.abs(expectedV - uv.getY(vertex)));
        found = true;
        break;
      }
      assert.equal(found, true, "cut vertex moved off the source surface");
    }
    assert.ok(worstUvError < 1e-4, `UV0 drifted after FBX round-trip: ${worstUvError}`);
    let maxU = 0;
    for (let i = 0; i < uv.count; i += 1) maxU = Math.max(maxU, uv.getX(i));
    assert.ok(maxU < 0.55, `mask did not remove the opaque mesh's right half: maxU=${maxU}`);
    assert.equal(result.report.jobs[0].objects[0].skipped, "");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
