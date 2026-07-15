const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function parseDepcheckJson(raw) {
  const text = String(raw || "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const start = line.indexOf("{");
    const candidate = start >= 0 ? line.slice(start) : "";
    if (!candidate || !candidate.endsWith("}")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function printList(title, list) {
  if (!Array.isArray(list) || list.length === 0) {
    return;
  }
  process.stdout.write(`\n${title}\n`);
  for (const item of list) {
    process.stdout.write(`- ${item}\n`);
  }
}

function main() {
  const root = process.cwd();
  const outputRoot = path.join(root, "Output");
  fs.mkdirSync(outputRoot, { recursive: true });
  const reportPath = path.join(outputRoot, "unused-deps-report.json");

  const run = spawnSync(
    "npx",
    ["--yes", "depcheck", "--json", "--skip-missing=true"],
    { cwd: root, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, shell: process.platform === "win32" }
  );
  if (run.error) {
    process.stdout.write(`unused-deps check skipped: ${run.error.message}\n`);
    process.exit(0);
  }

  const parsed = parseDepcheckJson(`${run.stdout || ""}\n${run.stderr || ""}`);
  if (!parsed) {
    process.stdout.write("unused-deps check skipped: depcheck output parse failed\n");
    process.exit(0);
  }

  const unusedDeps = Array.isArray(parsed.dependencies) ? parsed.dependencies : [];
  const unusedDevDeps = Array.isArray(parsed.devDependencies) ? parsed.devDependencies : [];
  const report = {
    generatedAt: new Date().toISOString(),
    unusedDependencies: unusedDeps,
    unusedDevDependencies: unusedDevDeps,
    using: "depcheck"
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

  process.stdout.write(`unused-deps report: ${reportPath}\n`);
  printList("Unused dependencies (affect package size):", unusedDeps);
  printList("Unused devDependencies:", unusedDevDeps);

  const strict = String(process.env.ASSETHIVE_STRICT_UNUSED_DEPS || "").trim() === "1";
  if (strict && unusedDeps.length > 0) {
    process.stdout.write("\nstrict mode: unused dependencies detected, aborting\n");
    process.exit(2);
  }
  process.exit(0);
}

main();
