const SKIP_DIRECTORY_NAMES = new Set([
  "$recycle.bin",
  "system volume information",
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "appdata",
  "node_modules",
  ".git",
  ".svn",
  ".assethive",
  "plugins",
  "support",
  ".bridge",
  "uassets",
  "thumb",
  "thumbs",
  "thumbnail",
  "thumbnails"
]);
const SKIP_FILE_NAMES = new Set(["desktop.ini", "thumbs.db", "assetsdata.json", "arkhive_data.json", "index.json", "custom-index.json"]);

module.exports = { SKIP_DIRECTORY_NAMES, SKIP_FILE_NAMES };
