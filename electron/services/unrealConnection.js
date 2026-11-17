const path = require("node:path");

function normalizeUnrealPath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return path.resolve(text).replaceAll("\\", "/").toLowerCase();
}

function matchesUnrealConnection(info, targetProjectPath, targetEditorPath) {
  if (!info?.projectPath) {
    return false;
  }

  // The settings UI treats the editor path as the active target when both
  // legacy fields are populated. Keep connection detection consistent with
  // that behavior and let the connected plugin identify the current project.
  const editorTarget = normalizeUnrealPath(targetEditorPath);
  if (editorTarget) {
    return editorTarget === normalizeUnrealPath(info.editorPath);
  }

  const projectTarget = normalizeUnrealPath(targetProjectPath);
  return !projectTarget || projectTarget === normalizeUnrealPath(info.projectPath)
    || (path.extname(projectTarget) !== ".uproject" && projectTarget === normalizeUnrealPath(path.dirname(info.projectPath)));
}

module.exports = { matchesUnrealConnection, normalizeUnrealPath };
