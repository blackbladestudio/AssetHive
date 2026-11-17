#!/usr/bin/env node
/*
 * 清理仓库内残留的 Electron / AssetHive 进程。
 *
 * 预览（preview_assethive.bat）异常退出、直接关闭终端、或打包过程中被中断时，
 * 上一次启动的 electron.exe 有可能仍然存活：它会占用 node_modules\electron\dist
 * 下的可执行文件、持有单实例锁与用户数据目录，导致下一次预览出现
 * “Electron download or runtime validation failed”、窗口不出现或打包失败。
 *
 * 预览脚本、`npm run dev`、打包脚本共用本脚本，保证任意入口启动前都会先清理残留。
 * 只结束可执行路径或命令行指向本仓库的进程，不会影响已安装的 AssetHive 或其它程序。
 */
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const quiet = process.argv.includes("--quiet");
const isWindows = process.platform === "win32";

function log(message) {
  if (!quiet) console.log(message);
}

function selectPreviewTargets(processes, repoRoot) {
  const normalize = value => String(value || '').replaceAll('\\', '/').toLowerCase();
  const prefix = `${normalize(path.resolve(repoRoot)).replace(/\/$/, '')}/`;
  const protectedPids = new Set(processes.filter(entry => {
    const command = normalize(entry.commandLine);
    return /(?:^|[/\s"])(?:megascans-monitor|quixel-login|download-megascans|megascans-runner|fab-megascans-runner|fab-session-electron|fab-login)\.cjs(?:[\s"]|$)/.test(command);
  }).map(entry => entry.pid));
  // Keep helper renderers, login/network children, and the downloader's isolated
  // import worker alive even though they share this repository's Electron exe.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) if (protectedPids.has(entry.parentPid) && !protectedPids.has(entry.pid)) {
      protectedPids.add(entry.pid); changed = true;
    }
  }
  return processes.filter(entry => !protectedPids.has(entry.pid)
    && /^(?:electron|assethive)(?:\.exe)?$/i.test(entry.name)
    && entry.commandLine
    && (normalize(entry.executablePath).startsWith(prefix) || normalize(entry.commandLine).includes(prefix)));
}

function listProcesses() {
  if (isWindows) {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$procs=@(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parentPid';e={$_.ParentProcessId}},@{n='name';e={$_.Name}},@{n='executablePath';e={$_.ExecutablePath}},@{n='commandLine';e={$_.CommandLine}})",
      "ConvertTo-Json -InputObject $procs -Compress"
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    if (result.error) return [];
    try { return selectPreviewTargets(JSON.parse(result.stdout || '[]'), root); }
    catch { return []; }
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,comm=,args="], { encoding: "utf8" });
  if (result.error) return [];
  const processes = String(result.stdout || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) return null;
    const [, pid, parentPid, name, commandLine] = match;
    return { pid: Number(pid), parentPid: Number(parentPid), name: path.basename(name), commandLine, executablePath: "" };
  }).filter(Boolean);
  return selectPreviewTargets(processes, root);
}

function isRunning(pid) {
  if (isWindows) {
    // HasExited 能区分“已终止但进程表条目尚未回收”的进程：这类条目会让
    // Get-Process -Id / taskkill 误报，但实际上不再占用任何文件或锁。
    const probe = `try { $p = Get-Process -Id ${pid} -ErrorAction Stop; if ($p.HasExited) { '0' } else { '1' } } catch { '0' }`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", probe], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    return String(result.stdout || "").trim() === "1";
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killProcess(pid) {
  if (isWindows) {
    // /T 一并结束渲染进程与 GPU 进程，/F 强制结束。
    const result = spawnSync("taskkill.exe", ["/F", "/T", "/PID", String(pid)], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    // 已终止但进程表条目未回收的进程会让 taskkill 返回非 0（提示文案随语言变化，
    // 不能按文本判断），因此失败时再用 HasExited 确认一次。
    return result.status === 0 || !isRunning(pid);
  }
  try { process.kill(pid, "SIGKILL"); return true; } catch { return true; }
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function waitForExit(pids, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let remaining = pids;
  while (remaining.length && Date.now() < deadline) {
    sleepSync(200);
    remaining = remaining.filter(pid => isRunning(pid));
  }
  return remaining;
}

function main() {
  const targets = listProcesses();
  if (!targets.length) {
    log("[OK] No stale AssetHive preview process found.");
    return 0;
  }
  log(`[INFO] Cleaning ${targets.length} stale preview process(es): ${targets.map(target => `${target.pid} (${target.name})`).join(", ")}`);
  const unresolved = targets.filter(target => !killProcess(target.pid)).map(target => target.pid);
  const remaining = waitForExit(unresolved);
  if (remaining.length) {
    console.error(`[WARN] Could not terminate stale process(es): ${remaining.join(", ")}. Continuing without blocking preview.`);
  }
  log("[OK] Stale preview process(es) cleaned.");
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { selectPreviewTargets, listProcesses };
