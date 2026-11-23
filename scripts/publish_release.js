/**
 * AssetHive 自动发布脚本
 *
 * 流程：校验当前版本的发布物与校验和 → 确认更新内容 → 上传草稿 → 全部成功后发布。
 * 桌面更新发布到 blackbladestudio/AssetHive，与客户端更新源保持一致。
 * 不修改版本号，不提交源码，不覆盖已有 Release 或标签。
 * 用法：node scripts/publish_release.js --notes-file docs/release-notes-2.3.5.md
 *       添加 --dry-run 只校验本地发布物，不读取凭据或操作 GitHub。
 *
 * 认证：优先使用 Windows 凭据管理器中的 GitHub 凭据（git credential fill），
 *      若不可用则回退到 GITHUB_TOKEN 环境变量。
 *
 * 用法：node scripts/publish_release.js   （或用根目录 publish_release.bat 双击运行）
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { createHash } = require("node:crypto");
const { Buffer } = require('node:buffer');
const { execFileSync } = require("child_process");
const { getSourceProof, assertSourceMatches, isReleaseInput } = require('./release-source.cjs');

// ============================================================
// 配置
// ============================================================
const OWNER = "blackbladestudio";
const REPO = "AssetHive";
const RELEASE_TAG_PREFIX = "v";
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

const ROOT = path.resolve(__dirname, "..");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const OUTPUT_DIR = path.join(ROOT, "Output");

// ============================================================
// 工具函数
// ============================================================
function log(msg) {
  console.log(msg);
}

function warn(msg) {
  console.log("\x1b[33m[警告]\x1b[0m " + msg);
}

function err(msg) {
  console.log("\x1b[31m[错误]\x1b[0m " + msg);
}

function ok(msg) {
  console.log("\x1b[32m[成功]\x1b[0m " + msg);
}

// ============================================================
// GitHub 认证
// ============================================================
function getTokenFromCredentialManager() {
  try {
    const out = execFileSync("git", ["credential", "fill"], {
      encoding: "utf8",
      input: "protocol=https\nhost=github.com\n\n",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    });
    const line = out
      .split("\n")
      .find((l) => l.startsWith("password="));
    return line ? line.slice("password=".length).trim() : null;
  } catch {
    return null;
  }
}

function getToken() {
  // 优先凭据管理器（已实测有效）
  const fromCred = getTokenFromCredentialManager();
  if (fromCred) return fromCred;
  // 回退到环境变量
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return null;
}

// ============================================================
// GitHub API
// ============================================================
async function api(method, urlPath, token, body, headers = {}) {
  const res = await fetch(urlPath.startsWith("http") ? urlPath : API + urlPath, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function verifyToken(token) {
  const r = await api("GET", "/user", token);
  return r.status === 200;
}

async function getDefaultBranch(token) {
  const r = await api("GET", `/repos/${OWNER}/${REPO}`, token);
  if (r.status !== 200) throw new Error("获取仓库信息失败: HTTP " + r.status);
  return r.data.default_branch;
}

async function getBranchHeadSha(token, branch) {
  const r = await api("GET", `/repos/${OWNER}/${REPO}/branches/${branch}`, token);
  if (r.status !== 200) throw new Error("获取分支信息失败: HTTP " + r.status);
  return r.data.commit.sha;
}

async function createLightweightTag(token, tag, sha) {
  const r = await api("POST", `/repos/${OWNER}/${REPO}/git/refs`, token, {
    ref: "refs/tags/" + tag,
    sha,
  });
  if (r.status !== 201) {
    throw new Error("创建 tag 失败: HTTP " + r.status + " " + JSON.stringify(r.data));
  }
}

async function findReleaseByTag(token, tag) {
  const r = await api("GET", `/repos/${OWNER}/${REPO}/releases/tags/${tag}`, token);
  if (r.status === 404) return null;
  if (r.status !== 200) {
    throw new Error("查询 Release 失败: HTTP " + r.status + " " + JSON.stringify(r.data));
  }
  return r.data;
}

async function createRelease(token, { tag, name, body }) {
  const r = await api("POST", `/repos/${OWNER}/${REPO}/releases`, token, {
    tag_name: tag,
    name,
    body,
    draft: true,
    prerelease: false,
  });
  if (r.status !== 201) {
    throw new Error("创建 Release 失败: HTTP " + r.status + " " + JSON.stringify(r.data));
  }
  return r.data;
}

async function uploadAsset(token, releaseId, filePath, assetName) {
  const fileSize = fs.statSync(filePath).size;
  log(`  上传 ${assetName} (${(fileSize / 1048576).toFixed(1)} MB)...`);
  const buffer = fs.readFileSync(filePath);
  const url = `${UPLOADS}/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(fileSize),
      "Accept": "application/vnd.github+json",
    },
    body: buffer,
  });
  const text = await res.text();
  if (res.status !== 201) {
    throw new Error("上传附件失败: HTTP " + res.status + " " + text.slice(0, 200));
  }
  return JSON.parse(text);
}

// ============================================================
// 交互输入（统一基于 line 事件队列，兼容交互与管道模式）
// ============================================================
function makePrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const buffer = []; // 已到达但尚未被消费的行
  const waiters = []; // 等待行的解析器队列
  let started = false;

  function ensureStarted() {
    if (started) return;
    started = true;
    rl.on("line", (line) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        buffer.push(line);
      }
    });
    rl.resume();
  }

  function nextLine(promptText) {
    ensureStarted();
    return new Promise((resolve) => {
      if (buffer.length > 0) {
        resolve(buffer.shift());
      } else {
        waiters.push(resolve);
        if (promptText) process.stdout.write(promptText);
      }
    });
  }

  return {
    async ask(question) {
      const line = await nextLine(question);
      return (line || "").trim();
    },
    async readMultiLine() {
      const lines = [];
      if (process.stdin.isTTY) log("  (输入空行结束，回车确认)");
      while (true) {
        const line = await nextLine("");
        const trimmed = (line || "").trim();
        if (!trimmed) break;
        lines.push(trimmed);
      }
      return lines.join("\n");
    },
    close() {
      rl.close();
    },
  };
}

// 发布物在读取凭据之前检查，避免创建缺少附件或版本不匹配的 Release。
async function createReleasePlan(version, directory = OUTPUT_DIR, sourceRoot = ROOT) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("版本号格式无效");
  const names = [`AssetHive-${version}-Windows.msi`, `AssetHive-${version}-Windows-setup.exe`, `AssetHive-${version}-setup-win64.exe`];
  const assets = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    const size = fs.statSync(filePath).size;
    if (size < 1048576) throw new Error(`安装包为空或不完整: ${name}`);
    const checksumPath = filePath + ".sha256";
    const checksum = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/);
    if (!/^[a-f0-9]{64}$/i.test(checksum[0]) || checksum[1] !== name) throw new Error(`校验和文件格式或文件名不匹配: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    if (hash.digest("hex") !== checksum[0].toLowerCase()) throw new Error(`SHA-256 不一致: ${name}`);
    assets.push({ name, filePath, size, sha256: checksum[0].toLowerCase() });
    assets.push({ name: name + ".sha256", filePath: checksumPath, size: fs.statSync(checksumPath).size });
  }
  return { repository: `${OWNER}/${REPO}`, version, tag: RELEASE_TAG_PREFIX + version, assets, source: getSourceProof(version, sourceRoot) };
}

// 同时检查版本和完整应用源码，在创建任何标签或草稿之前拒绝旧源码。
async function verifyRemoteSource(plan, token) {
  const reference = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/tags/${plan.tag}`, token);
  let sha;
  const createTag = reference.status === 404;
  if (createTag) {
    sha = await getBranchHeadSha(token, await getDefaultBranch(token));
  } else {
    if (reference.status !== 200) throw new Error(`无法读取发布标签: HTTP ${reference.status}`);
    let object = reference.data.object;
    while (object.type === 'tag') {
      const annotated = await api('GET', `/repos/${OWNER}/${REPO}/git/tags/${object.sha}`, token);
      if (annotated.status !== 200) throw new Error(`无法解析发布标签: HTTP ${annotated.status}`);
      object = annotated.data.object;
    }
    sha = object.sha;
  }
  const descriptor = await api('GET', `/repos/${OWNER}/${REPO}/contents/package.json?ref=${sha}`, token);
  if (descriptor.status !== 200) throw new Error(`无法读取发布仓库版本: HTTP ${descriptor.status}`);
  const version = JSON.parse(Buffer.from(descriptor.data.content, 'base64').toString('utf8')).version;
  const tree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${sha}?recursive=1`, token);
  if (tree.status !== 200 || tree.data.truncated) throw new Error('无法读取完整发布源码目录');
  const files = Object.fromEntries(tree.data.tree.filter(entry => entry.type === 'blob' && isReleaseInput(entry.path)).map(entry => [entry.path, entry.sha]));
  assertSourceMatches(plan.source, version, files);
  return { sha, createTag };
}

// 附件上传失败时保留草稿，客户端只能发现附件齐全的正式版本。
async function publishPlan(plan, token, notes) {
  const existing = await findReleaseByTag(token, plan.tag);
  if (existing) throw new Error(`Release ${plan.tag} 已存在，不覆盖；请检查现有发布状态`);
  const source = await verifyRemoteSource(plan, token);
  if (source.createTag) await createLightweightTag(token, plan.tag, source.sha);
  const release = await createRelease(token, { tag: plan.tag, name: `AssetHive v${plan.version}`, body: notes });
  for (const asset of plan.assets) await uploadAsset(token, release.id, asset.filePath, asset.name);
  const result = await api("PATCH", `/repos/${OWNER}/${REPO}/releases/${release.id}`, token, { draft: false });
  if (result.status !== 200) throw new Error(`草稿转为正式发布失败: HTTP ${result.status}`);
  return result.data;
}

async function main() {
  const version = String(JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8")).version || "").trim();
  const plan = await createReleasePlan(version);
  const notesIndex = process.argv.indexOf("--notes-file");
  let notes = notesIndex < 0 ? "" : fs.readFileSync(path.resolve(process.argv[notesIndex + 1]), "utf8").trim();
  log(`发布仓库: ${plan.repository}，版本: ${plan.tag}`);
  for (const asset of plan.assets) log(`  ${asset.name} (${asset.size} bytes)`);
  if (process.argv.includes("--dry-run")) {
    log(notes || "尚未提供更新说明");
    ok("本地发布物与 SHA-256 校验通过；未读取凭据、创建标签或发布");
    return;
  }
  const prompt = makePrompt();
  try {
    if (!notes) {
      log("请输入更新内容，每行一条，空行结束:");
      notes = await prompt.readMultiLine();
    }
    if (!notes) throw new Error("更新说明不能为空");
    log(notes);
    const confirm = (await prompt.ask("确认发布当前版本？(y/N): ")).toLowerCase();
    if (confirm !== "y" && confirm !== "yes") { log("已取消"); return; }
    const token = getToken();
    if (!token || !await verifyToken(token)) throw new Error("未找到有效 GitHub 凭据");
    const release = await publishPlan(plan, token, notes);
    ok(`发布完成: ${release.html_url}`);
  } finally { prompt.close(); }
}

module.exports = { createReleasePlan, publishPlan, verifyRemoteSource };
if (require.main === module) main().catch((e) => {
  err("发布过程中发生错误: " + (e && e.message ? e.message : e));
  process.exit(1);
});
