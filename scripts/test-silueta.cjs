// 验证 silueta.onnx 模型接口：加载、输入/输出名与 shape、一次前向推理。
const path = require("node:path");
const ort = require("onnxruntime-node");

(async () => {
  const modelPath = path.join(__dirname, "..", "electron", "models", "silueta.onnx");
  const session = await ort.InferenceSession.create(modelPath);
  console.log("loaded:", modelPath);
  console.log("inputNames:", session.inputNames);
  console.log("outputNames:", session.outputNames);

  const meta = session.inputMetadata || session._inputMetadata || null;
  if (meta) {
    for (const name of session.inputNames) console.log("input meta", name, meta[name]);
  }

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const N = 320;
  const data = new Float32Array(1 * 3 * N * N); // 全零输入，仅验证 shape 与推理通路
  const tensor = new ort.Tensor("float32", data, [1, 3, N, N]);
  const results = await session.run({ [inputName]: tensor });
  const out = results[outputName];
  console.log("output dims:", out.dims, "type:", out.type, "length:", out.data.length);
  console.log("OK");
})().catch((err) => {
  console.error("FAILED:", err?.message || err);
  process.exit(1);
});
