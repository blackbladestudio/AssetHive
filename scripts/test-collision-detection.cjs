const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/ui/modelCollision.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const compiledModule = { exports: {} };
new Function("exports", "module", "require", compiled)(compiledModule.exports, compiledModule, require);
const { analyzeCollisionNodes } = compiledModule.exports;

function makeObject({ name = "", userData = {}, geometryName = "", children = [] } = {}) {
  const object = {
    name,
    userData,
    geometry: geometryName ? { name: geometryName } : undefined,
    children
  };
  object.traverse = (callback) => {
    callback(object);
    for (const child of object.children) {
      child.traverse(callback);
    }
  };
  return object;
}

test("detects UE collision primitives from FBX node names and original names", () => {
  const root = makeObject({
    children: [
      makeObject({ name: "UCX_Box_01" }),
      makeObject({ userData: { originalName: "UBX_Cylinder_01" } }),
      makeObject({ geometryName: "USP_Capsule_01" }),
      makeObject({ name: "UCP_Sphere_01" }),
      makeObject({ name: "SM_UCX_NotACollisionNode" })
    ]
  });

  assert.deepEqual(analyzeCollisionNodes(root), {
    checked: true,
    hasCollision: true,
    nodeCount: 4
  });
});

test("reports a checked model with no collision nodes", () => {
  const root = makeObject({
    name: "SM_Rock_A",
    children: [makeObject({ name: "SM_Rock_A_LOD0" })]
  });

  assert.deepEqual(analyzeCollisionNodes(root), {
    checked: true,
    hasCollision: false,
    nodeCount: 0
  });
});
