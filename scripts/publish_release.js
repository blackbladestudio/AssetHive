/**
 * AssetHive 自动发布脚本
 *
 * 流程：读取 package.json 版本号 → 检查远端 tag 是否已存在 → 输入更新内容
 *      → 创建 tag → 创建 GitHub Release → 上传安装包
 *
 * 说明：本脚本只负责发布 Release 与安装包，不提交/推送任何源码。
 *      仓库 Biscuits-Lab/Release 用于集中存放各产品（AssetHive/Omni/NeuralDraft…）的 Release，
 *      源码仓库见 git remote origin（Biscuits-Lab/Assethive_Sourcecode）。
 *
 * 认证：优先使用 Windows 凭据管理器中的 GitHub 凭据（git credential fill），
 *      若不可用则回退到 GITHUB_TOKEN 环境变量。
 *
 * 用法：node scripts/publish_release.js   （或用根目录 publish_release.bat 双击运行）
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

// ============================================================
// 配置
// ============================================================
const OWNER = "Biscuits-Lab";
const REPO = "Release";
const RELEASE_TAG_PREFIX = "AssetHive-";
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
    });
    const line = out
      .split("\n")
      .find((l) => l.startsWith("password="));
    return line ? line.slice("password=".length) : null;
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

async function tagExists(token, tag) {
  const r = await api("GET", `/repos/${OWNER}/${REPO}/git/refs/tags/${tag}`, token);
  return r.status === 200;
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

async function deleteTag(token, tag) {
  const r = await api("DELETE", `/repos/${OWNER}/${REPO}/git/refs/tags/${tag}`, token);
  if (r.status !== 204) {
    throw new Error("删除 tag 失败: HTTP " + r.status + " " + JSON.stringify(r.data));
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

async function deleteRelease(token, releaseId) {
  const r = await api("DELETE", `/repos/${OWNER}/${REPO}/releases/${releaseId}`, token);
  if (r.status !== 204) {
    throw new Error("删除 Release 失败: HTTP " + r.status + " " + JSON.stringify(r.data));
  }
}

async function createRelease(token, { tag, name, body }) {
  const r = await api("POST", `/repos/${OWNER}/${REPO}/releases`, token, {
    tag_name: tag,
    name,
    body,
    draft: false,
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

// ============================================================
// 主流程
// ============================================================
async function main() {
  log("");
  log("==============================================");
  log("   AssetHive 自动发布工具");
  log("==============================================");
  log("");

  // 1. 读取版本号
  if (!fs.existsSync(PACKAGE_PATH)) {
    err("找不到 package.json");
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  let version = String(pkg.version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    err(`package.json 中的版本号格式无效: "${version}"`);
    process.exit(1);
  }
  log(`  当前 package.json 版本: ${version}`);

  // 2. 认证
  const token = getToken();
  if (!token) {
    err("未找到 GitHub 凭据（凭据管理器或 GITHUB_TOKEN）");
    process.exit(1);
  }
  const valid = await verifyToken(token);
  if (!valid) {
    err("GitHub 凭据无效，请检查 Windows 凭据管理器中的 github.com 凭据");
    process.exit(1);
  }
  log("  GitHub 凭据验证通过");

  // 3. 检查远端 tag 是否已存在
  const prompt = makePrompt();
  const tag = RELEASE_TAG_PREFIX + version;
  let overwrite = false;

  if (await tagExists(token, tag)) {
    warn(`远端已存在 tag ${tag}`);
    const input = (await prompt.ask("  输入 [o] 覆盖重发该版本，或输入新版本号 (如 1.2.0): ")).trim();
    if (input === "o" || input === "overwrite") {
      overwrite = true;
      log("  将覆盖该版本的 tag 与 Release 后重新发布");
    } else if (/^\d+\.\d+\.\d+$/.test(input)) {
      version = input;
    } else {
      err("输入无效，已取消");
      prompt.close();
      process.exit(1);
    }
  } else {
    const input = (await prompt.ask(`  使用当前版本 v${version}？回车确认，或输入新版本号: `)).trim();
    if (/^\d+\.\d+\.\d+$/.test(input)) version = input;
  }

  const finalTag = RELEASE_TAG_PREFIX + version;
  const releaseName = `AssetHive v${version}`;
  log("");
  log(`  发布版本: ${finalTag}`);

  // 4. 输入更新内容
  log("");
  log("  请输入本次更新内容 (release notes)，每行一条，空行结束:");
  const notes = await prompt.readMultiLine();
  if (!notes) {
    warn("未输入更新内容");
  }

  // 5. 汇总确认
  log("");
  log("  --------------------------------------------");
  log(`  版本:       ${finalTag}`);
  log(`  更新内容:   ${notes ? notes.replace(/\n/g, " / ") : "(无)"}`);
  log(`  发布仓库:   ${API}/repos/${OWNER}/${REPO}`);
  log(`  说明:       仅发布 Release，不提交/推送源码`);
  if (overwrite) {
    err("  警告:       覆盖发布将删除远端该版本的旧 tag 与旧 Release 后重建");
  }
  log("  --------------------------------------------");
  log("");
  const confirm = (await prompt.ask("  确认发布？(y/N): ")).trim().toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    log("  已取消");
    prompt.close();
    process.exit(0);
  }

  // 6. 创建 tag（轻量 tag，指向发布仓库 main 分支最新提交）
  const branch = await getDefaultBranch(token);
  const headSha = await getBranchHeadSha(token, branch);
  log(`  在 ${branch} 分支最新提交上创建 tag ${finalTag} ...`);
  if (await tagExists(token, finalTag)) {
    if (overwrite) {
      log(`  覆盖发布: 删除远端 tag ${finalTag} 与对应 Release ...`);
      const rel = await findReleaseByTag(token, finalTag);
      if (rel) {
        await deleteRelease(token, rel.id);
        ok(`  已删除旧 Release: ${rel.html_url}`);
      } else {
        log("  未找到对应 Release，跳过删除");
      }
      await deleteTag(token, finalTag);
      await createLightweightTag(token, finalTag, headSha);
      ok(`tag ${finalTag} 已重新创建`);
    } else {
      err(`远端已存在 tag ${finalTag}，且未选择覆盖，无法创建 Release`);
      log("  请重新运行并选择覆盖 (输入 o) 或输入一个未发布过的新版本号");
      prompt.close();
      process.exit(1);
    }
  } else {
    await createLightweightTag(token, finalTag, headSha);
    ok(`tag ${finalTag} 已创建`);
  }

  // 7. 创建 GitHub Release
  log("  创建 GitHub Release ...");
  let release;
  try {
    release = await createRelease(token, {
      tag: finalTag,
      name: releaseName,
      body: notes || `AssetHive ${version}`,
    });
  } catch (e) {
    err(e.message);
    log("  提示：tag 已创建，可到 GitHub 网页手动补建 Release");
    process.exit(1);
  }
  ok(`Release 已创建: ${release.html_url}`);

  // 8. 上传安装包
  const exeName = `AssetHive-${version}-setup-win64.exe`;
  const exePath = path.join(OUTPUT_DIR, exeName);
  if (fs.existsSync(exePath)) {
    try {
      const asset = await uploadAsset(token, release.id, exePath, exeName);
      ok(`安装包已上传: ${asset.browser_download_url}`);
    } catch (e) {
      warn("上传安装包失败: " + e.message);
    }
  } else {
    warn(`未找到安装包 ${exeName}，请先运行 package_assethive_exe.bat 打包`);
    warn("Release 已发布，可稍后在网页上手动上传附件");
  }

  prompt.close();

  log("");
  log("==============================================");
  ok(`发布完成: ${finalTag}`);
  log("  " + `https://github.com/${OWNER}/${REPO}/releases/tag/${finalTag}`);
  log("==============================================");
}

main().catch((e) => {
  err("发布过程中发生错误: " + (e && e.message ? e.message : e));
  process.exit(1);
});
