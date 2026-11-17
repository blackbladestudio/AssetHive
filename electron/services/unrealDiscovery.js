const { EventEmitter } = require("node:events");
const { setTimeout, clearTimeout } = require("node:timers");
const { AssetHiveTCPClient, notDispatched } = require("./tcpClient");
const { matchesUnrealConnection } = require("./unrealConnection");

const UNREAL_PORTS = Array.from({ length: 10 }, (_, index) => 13430 + index);

// Each editor owns one port. Keep its session and pending jobs on that socket;
// changing the selected project must never move or resubmit an existing job.
class UnrealDiscovery extends EventEmitter {
  constructor({ ports = UNREAL_PORTS, ...options } = {}) {
    super();
    this.target = {};
    this.clients = ports.map(port => {
      const client = new AssetHiveTCPClient({ reconnectMs: 2000, ...options, port });
      client.on("ready", info => {
        this.emit("diagnostic", { ...client.diagnostic, editorPath: info.editorPath });
        this.emit("changed");
      });
      client.on("disconnected", () => this.emit("changed"));
      client.on("diagnostic", diagnostic => this.emit("diagnostic", diagnostic));
      return client;
    });
  }

  setTarget({ unrealProjectPath = "", unrealEditorPath = "" } = {}) {
    this.target = { projectPath: unrealProjectPath, editorPath: unrealEditorPath };
  }

  connect() { for (const client of this.clients) client.connect(); }
  disconnect() { for (const client of this.clients) client.disconnect(); }

  findClient(target = this.target) {
    return this.clients.find(client => client.editorInfo && client.client && !client.client.destroyed
      && matchesUnrealConnection(client.editorInfo, target.projectPath, target.editorPath));
  }

  async getEditorInfo(timeoutMs = 2500, target = this.target) {
    this.connect();
    const current = this.findClient(target);
    if (current || timeoutMs <= 0) return current?.editorInfo || null;
    return new Promise(resolve => {
      const finish = info => {
        clearTimeout(timer);
        this.off("changed", changed);
        resolve(info);
      };
      const changed = () => {
        const client = this.findClient(target);
        if (client) finish(client.editorInfo);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.on("changed", changed);
    });
  }

  getDiagnostics(target = this.target) {
    const selected = this.findClient(target);
    if (selected) return { ...selected.diagnostic, connected: true };
    const other = this.clients.find(client => client.editorInfo && !client.client?.destroyed);
    if (other) return { state: "target-mismatch", connected: false, port: other.port,
      projectPath: other.editorInfo.projectPath, editorPath: other.editorInfo.editorPath };
    const diagnostic = this.clients.find(client => ["incompatible", "handshake-timeout", "heartbeat-timeout", "handshaking"].includes(client.diagnostic.state))?.diagnostic;
    return { ...(diagnostic || { state: "unavailable" }), connected: false };
  }

  async importAssets(job, { projectPath = "", onProgress } = {}) {
    const target = projectPath ? { projectPath } : this.target;
    const info = await this.getEditorInfo(2500, target);
    const client = this.findClient(target);
    if (!info || !client) throw notDispatched("未连接到目标项目的 AssetHive 插件，请打开目标项目并确认插件已启用");
    return client.importAssets(job, { projectPath: info.projectPath, onProgress });
  }
}

const tcpClient = new UnrealDiscovery();
module.exports = { UnrealDiscovery, UNREAL_PORTS, tcpClient };
