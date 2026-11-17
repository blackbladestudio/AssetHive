const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const sharp = require("sharp");

async function loadService(name, overrides = {}) {
  const file = path.join(__dirname, "..", "electron", "services", name + ".js");
  const localRequire = createRequire(file);
  const context = { module: { exports: {} }, __dirname: path.dirname(file), process, console,
    require: id => id in overrides ? overrides[id] : id === "electron" ? { app: {}, nativeImage: {} } : localRequire(id) };
  vm.runInNewContext(await fs.readFile(file, "utf8"), context, { filename: file });
  return context.module.exports;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "assethive-blender-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const executable = path.join(root, "Blender", "blender.exe");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "fixture");
  const scripts = path.join(root, "user", "4.5", "scripts");
  const calls = [];
  const integration = await loadService("blenderIntegration", { "node:child_process": {
    execFile: (exe, args, options, callback) => {
      calls.push({ exe, args, options });
      callback(null, "ASSETHIVE_CONFIG=" + JSON.stringify({ version: [4, 5, 4], scripts }) + "\n", "");
    }
  } });
  return { root, executable, scripts, integration, calls };
}

test("installs the bundled add-on into the selected Blender version and preserves the bridge token on reinstall", async t => {
  const f = await fixture(t);
  const source = path.join(__dirname, "..", "BlenderPlugin", "assethive");
  const result = await f.integration.installBlenderPlugin(f.executable, source);
  assert.equal(result.path, path.join(f.scripts, "addons", "assethive"));
  assert.equal(await fs.readFile(path.join(result.path, "__init__.py"), "utf8"), await fs.readFile(path.join(source, "__init__.py"), "utf8"));
  const token = JSON.parse(await fs.readFile(path.join(result.path, "bridge.json"), "utf8")).token;
  assert.equal(token.length, 64);
  await f.integration.installBlenderPlugin(f.executable, source);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.path, "bridge.json"), "utf8")).token, token);
  assert.ok(f.calls.every(call => call.options.windowsHide));
  const enableCalls = f.calls.filter(call => call.args.some(arg => arg.includes("addon_utils.enable")));
  assert.equal(enableCalls.length, 2);
  assert.ok(enableCalls.every(call => !call.args.includes("--factory-startup")
    && !call.args.some(arg => arg.includes("read_userpref"))), "enable with normal startup to preserve preferences without the Blender 3.6 background crash");
  await assert.rejects(f.integration.getBlenderConfiguration(path.join(f.root, "other.exe")), /blender.exe/);
});

test("authenticates and routes to the selected Blender binary, receives progress and a per-asset receipt", async t => {
  const f = await fixture(t);
  await f.integration.installBlenderPlugin(f.executable, path.join(__dirname, "..", "BlenderPlugin", "assethive"));
  let dispatched = 0;
  let seenToken;
  let supportsDecimation = true;
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", bytes => {
      buffer += bytes;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        seenToken = request.token;
        if (request.type === "hello") socket.write(JSON.stringify({ type: "hello", protocolVersion: 1, executable: f.executable, version: "4.5.4",
          capabilities: supportsDecimation ? ["meshDecimation"] : [] }) + "\n");
        else {
          dispatched++;
          socket.write(JSON.stringify({ type: "progress", percent: 50 }) + "\n");
          socket.write(JSON.stringify({ type: "complete", results: [{ assetId: request.job.assets[0].id, status: "success" }] }) + "\n");
        }
      }
    });
  });
  // A user's running Blender may already own the first bridge port.
  for (let port = 13450; ; port++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || port === 13459) throw error;
    }
  }
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const status = await f.integration.getBlenderStatus(f.executable);
  assert.equal(status.connected, true);
  const progress = [];
  const receipt = await f.integration.sendToBlender(f.executable, { assets: [{ id: "rock", decimationRatio: 0.25 }] }, update => progress.push(update.percent));
  assert.equal(receipt.results[0].assetId, "rock");
  assert.deepEqual(progress, [50]);
  assert.equal(dispatched, 1);
  assert.equal(seenToken.length, 64);
  supportsDecimation = false;
  await assert.rejects(f.integration.sendToBlender(f.executable, { assets: [{ id: "rock", decimationRatio: 0.25 }] }), /重新安装 Blender 插件/);
  assert.equal(dispatched, 1, "older add-ons must refuse reduction before dispatch instead of silently ignoring it");
  await f.integration.sendToBlender(f.executable, { assets: [{ id: "rock", decimationRatio: 1 }] });
  assert.equal(dispatched, 2, "100% imports remain compatible with older add-ons");
  const other = path.join(f.root, "Other", "blender.exe");
  await fs.mkdir(path.dirname(other)); await fs.writeFile(other, "fixture");
  assert.equal((await f.integration.getBlenderStatus(other)).connected, false);
});

test("builds Blender materials without Unreal packing and counts only confirmed successful imports", async t => {
  const f = await fixture(t);
  const helpers = await loadService("unrealExporter");
  const { buildBlenderAsset, exportToBlender } = await loadService("blenderExporter", { "./unrealExporter": helpers });
  const color = path.join(f.root, "stone_ALO.png");
  const normal = path.join(f.root, "stone_N.png");
  await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 100, g: 150, b: 200, alpha: 0.5 } } }).png().toFile(color);
  await fs.copyFile(color, normal);
  const asset = { id: "surface", name: "Stone", assetType: "surface", path: f.root, modelFiles: [], textureFiles: [color, normal],
    meta: { normalMapFormat: "opengl", baseTiling: 2, textureEntries: [{ textureType: "AlbedoOpacityMasked", file: color, areaIndex: 1 }, { textureType: "Normal", file: normal, areaIndex: 1 }] } };
  const prepared = await buildBlenderAsset(asset);
  assert.equal(prepared.materials[0].normalMapFormat, "opengl");
  assert.equal(prepared.materials[0].textures[0].textureType, "AlbedoOpacityMasked");
  assert.equal(prepared.baseTiling, 2);
  assert.equal(prepared.decimationRatio, 1, "materials never receive mesh reduction");
  const unsupported = { id: "speedtree", name: "Tree", source: "custom", assetType: "3dplant", path: f.root, meta: {}, modelFiles: [path.join(f.root, "tree.st9")] };
  await assert.rejects(buildBlenderAsset(unsupported), /不支持此模型格式/);
  const result = await exportToBlender([asset, unsupported], {}, undefined, async (_exe, job) => {
    assert.equal(job.assets.length, 1);
    return { results: [{ assetId: "surface", status: "success", message: "Imported" }] };
  });
  assert.equal(result.partial, true);
  assert.equal(result.exportedAssetIds.join(), "surface");
  const lost = await exportToBlender([asset], {}, undefined, async () => { const error = new Error("Connection lost"); error.accepted = true; throw error; });
  assert.equal(lost.results[0].status, "unconfirmed");
  assert.equal(lost.exportedAssetIds.length, 0);
  const absent = await exportToBlender([asset], {}, undefined, async () => ({ results: [] }));
  assert.equal(absent.ok, false);
  assert.equal(absent.results[0].status, "unconfirmed");
});

test("3D Assets send only the original basecolor, roughness and normal files and use native UNC paths", async t => {
  const f = await fixture(t);
  const helpers = await loadService("unrealExporter");
  const { normalizeBlenderPath, normalizeBlenderDecimationRatio, buildBlenderAsset, exportToBlender } = await loadService("blenderExporter", { "./unrealExporter": helpers });
  assert.equal(normalizeBlenderPath("//fileshare/share/Artist/岩石/albedo.png", f.root), path.normalize("//fileshare/share/Artist/岩石/albedo.png"));
  const model = path.join(f.root, "stone.fbx");
  await fs.writeFile(model, "fixture");
  const types = ["Diffuse", "Roughness", "Normal", "AO", "Metalness", "Displacement", "Opacity"];
  const textures = [];
  for (const type of types) {
    const file = path.join(f.root, `stone_${type}.png`);
    await sharp({ create: { width: 4, height: 4, channels: 4, background: "#807fff" } }).png().toFile(file);
    textures.push({ textureType: type, file, areaIndex: 1 });
  }
  const asset = { id: "model", name: "Stone", assetType: "3d", source: "custom", path: f.root,
    modelFiles: [model], textureFiles: textures.map(item => item.file), meta: { textureEntries: textures, normalMapFormat: "opengl" } };
  const prepared = await buildBlenderAsset(asset);
  assert.equal(prepared.materials[0].textures.map(item => item.slot).sort().join(), "albedo,normal,roughness");
  assert.equal(prepared.materials[0].textures.find(item => item.slot === "albedo").textureType, "Basecolor");
  for (const item of prepared.materials[0].textures) assert.ok(textures.some(source => source.file === item.file), "must reference an original texture, without packing");
  assert.equal(prepared.materials[0].normalMapFormat, "opengl");
  assert.equal(prepared.decimationRatio, 1, "3D Assets default to the original mesh without reduction");
  for (const ratio of [1, 0.75, 0.5, 0.25, 0.1]) {
    const result = await exportToBlender([asset], { blenderDecimationRatio: ratio }, undefined, async (_exe, job) => {
      assert.equal(job.assets[0].decimationRatio, ratio, "the selected percentage must reach the add-on");
      return { results: [{ assetId: asset.id, status: "success" }] };
    });
    assert.equal(result.ok, true);
  }
  for (const invalid of [undefined, null, 0, -1, 2, 0.4, "invalid"]) assert.equal(normalizeBlenderDecimationRatio(invalid), 1);
  for (const assetType of ["surface", "decal", "3dplant"]) {
    const result = await buildBlenderAsset({ ...asset, assetType }, { blenderDecimationRatio: 0.1 });
    assert.equal(result.decimationRatio, 1, `${assetType} must retain the original mesh`);
  }
  for (const assetType of ["animation", "hdri"]) await assert.rejects(buildBlenderAsset({ ...asset, assetType }), /暂不支持资产类型/);
});
