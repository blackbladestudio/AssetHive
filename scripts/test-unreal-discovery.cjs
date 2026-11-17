const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { UnrealDiscovery } = require("../electron/services/unrealDiscovery");
const { AssetHiveTCPClient } = require("../electron/services/tcpClient");

async function editor(t, { project = "A", helloDelay = 0, protocolVersion = 2, onMessage, autoHello = true, pongBeforeHello = true, capabilities = [] } = {}) {
  const sockets = new Set();
  const messages = [];
  const info = { type: "hello", protocolVersion, sessionId: project, capabilities,
    projectPath: path.resolve(project, `${project}.uproject`), editorPath: path.resolve("Engine", "UnrealEditor.exe") };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let handshaken = false;
    socket.setEncoding("utf8");
    socket.on("data", data => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        messages.push(message);
        if (message.type === "hello" && autoHello) {
          void delay(helloDelay).then(() => {
            if (!socket.destroyed) {
              handshaken = true;
              socket.write(JSON.stringify(info) + "\n");
            }
          });
        }
        if (message.type === "ping" && (handshaken || pongBeforeHello)) socket.write('{"type":"pong"}\n');
        onMessage?.(message, socket, info);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, port: server.address().port, info, sockets, messages };
}

function discovery(t, ports, options = {}) {
  const client = new UnrealDiscovery({ ports, reconnectMs: 20, heartbeatMs: 15, ...options });
  t.after(() => client.disconnect());
  return client;
}

test("Atlas requires a capable plugin and preserves material-only jobs across mixed dispatch", async t => {
  const complete = (message, socket) => {
    if (message.type === "import") socket.write(JSON.stringify({ type: "complete", requestId: message.requestId }) + "\n");
  };
  const old = await editor(t, { onMessage: complete });
  const client = discovery(t, [old.port]);
  for (const assetType of ["atlas", "atlases"]) {
    await assert.rejects(client.importAssets({ assets: [{ assetType, modelFiles: [] }, { assetType: "decal" }] }),
      error => error.code === "ASSETHIVE_NOT_DISPATCHED" && /图集/.test(error.message));
  }
  assert.equal(old.messages.some(message => message.type === "import"), false);
  const job = { assets: [{ assetType: "atlas", modelFiles: [], textureSlots: [{ slot: "Opacity" }, { slot: "Displacement" }] }, { assetType: "decal" }] };
  const current = await editor(t, { capabilities: ["atlasTextureOnly"], onMessage: complete });
  await discovery(t, [current.port]).importAssets(job);
  assert.deepEqual(current.messages.find(message => message.type === "import").job, job);
});

test("cantilever layers require the native profile capability before dispatch", async t => {
  const complete = (message, socket) => {
    if (message.type === "import") socket.write(JSON.stringify({ type: "complete", requestId: message.requestId }) + "\n");
  };
  const job = { assets: [{ assetType: "3dplant", plantWindLayers: { hasCantileverWeights: true } }] };
  const old = await editor(t, { onMessage: complete });
  const client = discovery(t, [old.port]);
  await assert.rejects(client.importAssets(job), error =>
    error.code === "ASSETHIVE_NOT_DISPATCHED" && /长茎植被权重曲线/.test(error.message));
  assert.equal(old.messages.some(message => message.type === "import"), false);
  const current = await editor(t, { capabilities: ["plantCantileverWeights"], onMessage: complete });
  await discovery(t, [current.port]).importAssets(job);
  assert.equal(current.messages.filter(message => message.type === "import").length, 1);
});

test("mesh-only is never dispatched to an older plugin, full overwrite remains compatible", async t => {
  const complete = (message, socket) => {
    if (message.type === "import") socket.write(JSON.stringify({ type: "complete", requestId: message.requestId }) + "\n");
  };
  const old = await editor(t, { onMessage: complete });
  const client = discovery(t, [old.port]);
  const job = { assets: ["3d", "3dplant"].map(assetType => ({ assetType, meshOverwritePolicy: "meshOnly" })) };
  await assert.rejects(client.importAssets(job), error =>
    error.code === "ASSETHIVE_NOT_DISPATCHED" && /只覆盖网格体/.test(error.message));
  assert.equal(old.messages.filter(message => message.type === "import").length, 0);
  await client.importAssets({ assets: [{ assetType: "3d", meshOverwritePolicy: "all" }] });
  const current = await editor(t, { capabilities: ["meshOnlyOverwrite"], onMessage: complete });
  await discovery(t, [current.port]).importAssets(job);
  assert.deepEqual(current.messages.find(message => message.type === "import").job, job);
  const textures = { assets: [{ assetType: "3dplant", meshOverwritePolicy: ["texture"] }] };
  await assert.rejects(discovery(t, [current.port]).importAssets(textures), error =>
    error.code === "ASSETHIVE_NOT_DISPATCHED" && /按材质实例、纹理和网格体/.test(error.message));
  assert.equal(current.messages.filter(message => message.type === "import").length, 1);
  const selective = await editor(t, { capabilities: ["selectiveOverwrite"], onMessage: complete });
  await discovery(t, [selective.port]).importAssets(textures);
  assert.deepEqual(selective.messages.find(message => message.type === "import").job, textures);
});

test("named Zion 3D export is rejected before dispatch to an older plugin", async t => {
  const target = await editor(t);
  const client = discovery(t, [target.port]);
  const job = { assets: [{ materialMatching: "name" }] };
  await assert.rejects(client.importAssets(job), error =>
    error.code === "ASSETHIVE_NOT_DISPATCHED" && /材质名称匹配/.test(error.message));
  assert.equal(target.messages.filter((message) => message.type === "import").length, 0);
});

test("named Zion 3D export is dispatched to a capable plugin", async t => {
  const target = await editor(t, { capabilities: ["zion3dMaterialNames"], onMessage(message, socket) {
    if (message.type === "import") socket.write(JSON.stringify({ type: "complete", requestId: message.requestId }) + "\n");
  } });
  const client = discovery(t, [target.port]);
  await client.importAssets({ assets: [{ materialMatching: "name" }] });
  assert.equal(target.messages.filter((message) => message.type === "import").length, 1);
});

test("named plant reuse requires its own capability and cannot reach a 3D-assets-only plugin", async t => {
  const target = await editor(t, { capabilities: ["zion3dMaterialNames"] });
  const client = discovery(t, [target.port]);
  await assert.rejects(client.importAssets({ assets: [{ assetType: "3dplant", materialMatching: "name" }] }), error =>
    error.code === "ASSETHIVE_NOT_DISPATCHED" && /植被.*复用/.test(error.message));
  assert.equal(target.messages.filter((message) => message.type === "import").length, 0);
});

test("plant export v2 requires Diffuse Alpha and Foliage naming support before dispatch", async t => {
  const job = { assets: [{ assetType: "3dplant", plantExportVersion: 2 }] };
  const old = await editor(t, { capabilities: ["zionPlantMaterialReuse"] });
  await assert.rejects(discovery(t, [old.port]).importAssets(job), error =>
    error.code === "ASSETHIVE_NOT_DISPATCHED" && /Diffuse Alpha/.test(error.message));
  assert.ok(!old.messages.some((message) => message.type === "import"));
  const current = await editor(t, { capabilities: ["plantExportV2"], onMessage(message, socket) {
    if (message.type === "import") socket.write(JSON.stringify({ type: "complete", requestId: message.requestId }) + "\n");
  } });
  await discovery(t, [current.port]).importAssets(job);
  assert.equal(current.messages.filter((message) => message.type === "import").length, 1);
});

test("named plant reuse is dispatched when the editor declares UV3-safe reuse support", async t => {
  const target = await editor(t, { capabilities: ["zionPlantMaterialReuse"], onMessage(message, socket) {
    if (message.type === "import") socket.write(JSON.stringify({ type: "complete", requestId: message.requestId }) + "\n");
  } });
  const client = discovery(t, [target.port]);
  await client.importAssets({ assets: [{ assetType: "3dplant", materialMatching: "name" }] });
  assert.equal(target.messages.filter((message) => message.type === "import").length, 1);
});

test("legacy UV3-remapped plants also require the variant-safe capability", async t => {
  const target = await editor(t, { capabilities: ["zion3dMaterialNames"] });
  const client = discovery(t, [target.port]);
  await assert.rejects(client.importAssets({ assets: [{ assetType: "3dplant", nativePlantWind: { useRemappedUV3: true } }] }),
    error => error.code === "ASSETHIVE_NOT_DISPATCHED" && /植被.*复用/.test(error.message));
  assert.equal(target.messages.filter((message) => message.type === "import").length, 0);
});

test("finds the selected project on a backup port even when the first editor responds sooner", async t => {
  const a = await editor(t);
  const b = await editor(t, { project: "B", helloDelay: 70 });
  const client = discovery(t, [a.port, b.port]);
  assert.equal((await client.getEditorInfo(1000, { projectPath: b.info.projectPath })).sessionId, "B");
  assert.equal(client.getDiagnostics({ projectPath: b.info.projectPath }).port, b.port);
  assert.equal((await client.getEditorInfo(0, { projectPath: path.dirname(b.info.projectPath) })).sessionId, "B");
  assert.equal(await client.getEditorInfo(30, { projectPath: path.resolve("Missing.uproject") }), null);
  assert.equal(client.getDiagnostics({ projectPath: path.resolve("Missing.uproject") }).state, "target-mismatch");
});

test("discovers a target editor started after AssetHive and after an occupied endpoint closes", async t => {
  const server = await editor(t, { autoHello: false });
  const port = server.port;
  const client = discovery(t, [port], { handshakeTimeoutMs: 60 });
  assert.equal(await client.getEditorInfo(30), null);
  for (const socket of server.sockets) socket.destroy();
  await new Promise(resolve => server.server.close(resolve));
  const replacement = net.createServer(socket => {
    server.sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", () => socket.write(JSON.stringify(server.info) + "\n"));
  });
  replacement.listen(port, "127.0.0.1");
  await once(replacement, "listening");
  t.after(() => { for (const socket of server.sockets) socket.destroy(); replacement.close(); });
  assert.equal((await client.getEditorInfo(1000)).sessionId, "A");
});

test("waits for a busy editor beyond the former fifteen-second handshake and heartbeat limit", async t => {
  const server = await editor(t, { helloDelay: 16000, pongBeforeHello: false });
  const client = discovery(t, [server.port], { heartbeatMs: 200, receiveTimeoutMs: 3000 });
  assert.equal((await client.getEditorInfo(19000)).sessionId, "A");
  assert.equal(server.messages.filter(message => message.type === "hello").length, 1);
});

test("rejects incompatible plugins and malformed JSON values without crashing", async t => {
  const server = await editor(t, { protocolVersion: 1 });
  const client = discovery(t, [server.port], { reconnectMs: 1000 });
  assert.equal(await client.getEditorInfo(50), null);
  assert.equal(client.getDiagnostics().state, "incompatible");
  const raw = new AssetHiveTCPClient({ port: server.port, reconnectMs: 1000 });
  t.after(() => raw.disconnect());
  const closed = once(raw, "disconnected");
  raw.connect();
  await once(raw.client, "connect");
  for (const socket of server.sockets) socket.write("null\n");
  await closed;
  assert.equal(raw.editorInfo, null);
});

test("routes import to the selected editor and reconnects by querying instead of submitting twice", async t => {
  const a = await editor(t);
  const b = await editor(t, { project: "B", onMessage(message, socket) {
    if (message.type === "import") {
      client.setTarget({ unrealProjectPath: a.info.projectPath });
      socket.destroy();
    }
    if (message.type === "query") socket.write(JSON.stringify({ type: "complete", requestId: message.requestId }) + "\n");
  } });
  const client = discovery(t, [a.port, b.port], { ackTimeoutMs: 500, importTimeoutMs: 2000 });
  client.setTarget({ unrealProjectPath: b.info.projectPath });
  const result = await client.importAssets({ assets: [] });
  assert.equal(result.type, "complete");
  assert.equal(a.messages.filter(message => message.type === "import").length, 0);
  assert.equal(b.messages.filter(message => message.type === "import").length, 1);
  assert.equal(b.messages.filter(message => message.type === "query").length, 1);
});

test("an editor restart rejects the old session's pending job without resubmitting it", async t => {
  const server = await editor(t, { onMessage(message, socket, info) {
    if (message.type === "import") {
      info.sessionId = "restarted";
      socket.destroy();
    }
  } });
  const client = discovery(t, [server.port], { importTimeoutMs: 2000 });
  await assert.rejects(client.importAssets({ assets: [] }), /编辑器已重启/);
  assert.equal(server.messages.filter(message => message.type === "import").length, 1);
  assert.equal(server.messages.filter(message => message.type === "query").length, 0);
});

test("engine selection follows the live matching engine instead of an old project setting", async t => {
  const server = await editor(t);
  const client = discovery(t, [server.port]);
  client.setTarget({ unrealEditorPath: server.info.editorPath, unrealProjectPath: path.resolve("Old.uproject") });
  assert.equal((await client.getEditorInfo(1000)).projectPath, server.info.projectPath);
});

test("never imports to a different project when the selected editor is unavailable", async t => {
  const a = await editor(t);
  const client = discovery(t, [a.port]);
  await client.getEditorInfo(1000);
  await assert.rejects(client.importAssets({}, { projectPath: path.resolve("Missing.uproject") }), /目标项目/);
  assert.equal(a.messages.filter(message => message.type === "import").length, 0);
});
