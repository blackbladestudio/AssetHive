const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { URL, pathToFileURL } = require("node:url");
const ts = require("typescript");
const THREE = require("three");

function load(relative, dependencies = {}, globals = {}) {
  const file = path.resolve(__dirname, "..", relative);
  const source = fs.readFileSync(file, "utf8").replaceAll("import.meta.url", JSON.stringify(pathToFileURL(file).href));
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const output = { exports: {} };
  new Function("require", "exports", ...Object.keys(globals), compiled)(name => dependencies[name] || require(name), output.exports, ...Object.values(globals));
  return output.exports;
}

// Run the hook's actual effects, including cleanup before changed effects and
// state-driven renders. Worker delivery and debounce timers stay controllable.
function searchFixture() {
  let cursor = 0;
  let dirty = false;
  let pending = [];
  const slots = [];
  const timers = new Set();
  const workers = [];
  const react = {
    useRef: value => {
      const slot = cursor++;
      return slots[slot] ||= { current: value };
    },
    useState: initial => {
      const slot = cursor++;
      slots[slot] ||= { value: initial };
      return [slots[slot].value, update => {
        slots[slot].value = typeof update === "function" ? update(slots[slot].value) : update;
        dirty = true;
      }];
    },
    useEffect: (effect, dependencies) => {
      const slot = cursor++;
      const previous = slots[slot];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        pending.push({ slot, effect, dependencies });
      }
    }
  };
  class Worker {
    constructor(url) {
      assert.match(url.pathname, /assetSearchWorker\.ts$/);
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    deliver(data) { this.onmessage({ data }); }
  }
  const { useAssetSearch } = load("src/ui/hooks/useAssetSearch.ts", {
    react, "../assetSearchDocument": load("src/ui/assetSearchDocument.ts")
  }, {
    Worker, URL,
    setTimeout: callback => { timers.add(callback); return callback; },
    clearTimeout: callback => timers.delete(callback)
  });
  let args;
  const render = (...next) => {
    if (next.length) args = next;
    let result;
    let passes = 0;
    do {
      assert.ok(++passes < 10, "hook effects must settle");
      dirty = false;
      cursor = 0;
      pending = [];
      result = useAssetSearch(...args);
      for (const item of pending) slots[item.slot]?.cleanup?.();
      for (const item of pending) slots[item.slot] = { dependencies: item.dependencies, cleanup: item.effect() };
    } while (dirty);
    return result;
  };
  return { render, workers, flush: () => { for (const timer of [...timers]) { timers.delete(timer); timer(); } }, cleanup: () => slots.forEach(slot => slot.cleanup?.()) };
}

test("startup does not create a search worker or read searchable asset fields", () => {
  const f = searchFixture();
  const unreadable = { get name() { throw new Error("startup built the search index"); } };
  assert.equal(f.render([unreadable], "", []).ids, null);
  f.render([unreadable, unreadable], "  ", []);
  f.flush();
  assert.equal(f.workers.length, 0);
  f.cleanup();
});

test("first search synchronizes the whole library before querying and ignores stale results", () => {
  const f = searchFixture();
  const assets = [{ id: "a", name: "Rock", tags: ["forest"] }, { id: "b", name: "Tree" }];
  const tags = [];
  f.render(assets, "", tags);
  assert.equal(f.render(assets, "rock", tags).busy, true);
  const worker = f.workers[0];
  assert.deepEqual(worker.messages[0].upserts.map(doc => doc.id), ["a", "b"]);
  assert.equal(worker.messages.length, 1);
  f.flush();
  const older = worker.messages.at(-1).requestId;
  f.render(assets, "tree", tags);
  f.flush();
  const latest = worker.messages.at(-1).requestId;
  worker.deliver({ requestId: older, ids: ["a"] });
  assert.equal(f.render().busy, true);
  worker.deliver({ requestId: latest, ids: ["b"] });
  assert.deepEqual([...f.render().ids], ["b"]);
  assert.equal(f.workers.length, 1);
  f.cleanup();
});

test("active search updates changed/deleted assets and clearing then searching rebuilds the index", () => {
  const f = searchFixture();
  f.render([{ id: "a", name: "Rock" }, { id: "b", name: "Tree" }], "rock", []);
  f.flush();
  const worker = f.workers[0];
  const changed = [{ id: "a", name: "Marble", zionTags: ["forest"] }];
  f.render(changed, "marble", []);
  assert.deepEqual(worker.messages.at(-1).removed, ["b"]);
  assert.equal(worker.messages.at(-1).upserts[0].name, "Marble");
  f.flush();
  assert.equal(f.render(changed, "", []).ids, null);
  assert.equal(worker.terminated, true);
  f.render(changed, "", ["forest"]);
  assert.equal(f.workers.length, 2);
  assert.deepEqual(f.workers[1].messages[0].upserts.map(doc => doc.id), ["a"]);
  f.flush();
  assert.deepEqual(f.workers[1].messages[1].tags, ["forest"]);
  f.cleanup();
  assert.equal(f.workers[1].terminated, true);
});

function modelFixture() {
  let request;
  let cleanup;
  let imports = 0;
  const replies = [];
  const loads = [];
  const object = new THREE.Group();
  object.add(new THREE.Mesh(new THREE.BoxGeometry(100, 200, 300)));
  const collision = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
  collision.name = "UCX_Test_01";
  object.add(collision);
  const loader = gltf => class {
    load(url, onLoad) { loads.push(url); onLoad(gltf ? { scene: object } : object); }
  };
  const { analyzeCollisionNodes } = load("src/ui/modelCollision.ts");
  const analysis = load("src/ui/modelAnalysis.ts", {
    "three": THREE,
    "three/examples/jsm/loaders/OBJLoader.js": { OBJLoader: loader(false) },
    "three/examples/jsm/loaders/FBXLoader.js": { FBXLoader: loader(false) },
    "three/examples/jsm/loaders/GLTFLoader.js": { GLTFLoader: loader(true) },
    "./modelCollision": { analyzeCollisionNodes }
  });
  const { ModelProcessor } = load("src/ui/ModelProcessor.tsx", {
    "react": { useEffect: effect => { cleanup = effect(); } },
    get "./modelAnalysis"() { imports++; return analysis; }
  }, {
    window: { arkhive: {
      onCalculateBoundsRequest: callback => { request = callback; return () => { request = null; }; },
      respondBounds: async reply => replies.push(reply)
    } }, console: { log() {}, error() {} }
  });
  ModelProcessor();
  return { object, replies, loads, get imports() { return imports; }, get request() { return request; }, cleanup: () => cleanup() };
}

test("bounds IPC is immediately subscribed while model analysis waits for its first request", async () => {
  const f = modelFixture();
  assert.equal(typeof f.request, "function");
  assert.equal(f.imports, 0);
  await f.request({ requestId: "first", filePath: "D:\\Models\\test.fbx" });
  assert.equal(f.imports, 1);
  assert.deepEqual(f.replies[0], { requestId: "first", bounds: { x: 1, y: 2, z: 3 }, collision: { checked: true, hasCollision: true, nodeCount: 1 }, triangleCount: 24,
    meshKind: "staticMesh", hasSkeleton: false, hasSkin: false, boneCount: 0, skinnedMeshCount: 0 });
  assert.equal(f.loads[0], "file://D:/Models/test.fbx");
  f.cleanup();
  assert.equal(f.request, null);
});

test("deferred analysis preserves FBX units, OBJ guessing, glTF metres and failure replies", async () => {
  const f = modelFixture();
  f.object.userData.unitScaleFactor = 2;
  for (const [ext, size] of [["fbx", 2], ["obj", 1], ["gltf", 100], ["glb", 100]]) {
    await f.request({ requestId: ext, filePath: `file:///model.${ext}` });
    assert.equal(f.replies.at(-1).bounds.x, size);
    assert.equal(f.replies.at(-1).collision.hasCollision, true);
  }
  await f.request({ requestId: "invalid", filePath: "model.txt" });
  assert.deepEqual(f.replies.at(-1), { requestId: "invalid", bounds: null, collision: null, triangleCount: null });
  f.cleanup();
});
