const { Buffer } = require("node:buffer");
const { setTimeout, clearTimeout, setInterval, clearInterval } = require("node:timers");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

function notDispatched(message) {
  return Object.assign(new Error(message), { code: "ASSETHIVE_NOT_DISPATCHED" });
}

class AssetHiveTCPClient extends EventEmitter {
  constructor({ host = "127.0.0.1", port = 13430, reconnectMs = 1000,
    heartbeatMs = 2000, handshakeTimeoutMs = 60000, receiveTimeoutMs = 30000, ackTimeoutMs = 15000, importTimeoutMs = 30 * 60 * 1000 } = {}) {
    super();
    Object.assign(this, { host, port, reconnectMs, heartbeatMs, ackTimeoutMs, importTimeoutMs });
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.receiveTimeoutMs = receiveTimeoutMs;
    this.diagnostic = { state: "disconnected", port };
    this.client = null;
    this.editorInfo = null;
    this.pending = new Map();
    this.stopped = true;
  }

  connect() {
    this.stopped = false;
    if (this.client) return;
    clearTimeout(this.reconnectTimer);
    const socket = new net.Socket();
    this.client = socket;
    let buffer = "";
    socket.setEncoding("utf8"); // Preserve characters split across TCP packets.
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.setTimeout(this.handshakeTimeoutMs);
    this.diagnostic = { state: "connecting", port: this.port };
    socket.on("connect", () => {
      // A reconnect can pick the server port as its ephemeral source port while
      // the editor is down. TCP can then connect to itself on loopback.
      if (socket.localPort === socket.remotePort && socket.localAddress === socket.remoteAddress) {
        socket.destroy();
        return;
      }
      this.lastReceived = Date.now();
      this.diagnostic = { state: "handshaking", port: this.port };
      this.handshakeTimer = setTimeout(() => {
        this.diagnostic = { state: "handshake-timeout", port: this.port };
        socket.destroy();
      }, this.handshakeTimeoutMs);
      this.send({ type: "hello", protocolVersion: 2 });
      this.heartbeatTimer = setInterval(() => {
        if (this.editorInfo && Date.now() - this.lastReceived > this.receiveTimeoutMs) {
          this.diagnostic = { state: "heartbeat-timeout", port: this.port };
          socket.destroy();
        }
        else this.send({ type: "ping" });
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    });
    socket.on("data", data => {
      this.lastReceived = Date.now();
      buffer += data;
      if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch {
          this.diagnostic = { state: "invalid-message", port: this.port };
          socket.destroy(); return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          this.diagnostic = { state: "invalid-message", port: this.port };
          socket.destroy(); return;
        }
        this.handleMessage(message);
      }
    });
    socket.on("timeout", () => {
      this.diagnostic = { state: this.editorInfo ? "heartbeat-timeout" : "handshake-timeout", port: this.port };
      socket.destroy();
    });
    socket.on("error", error => {
      this.diagnostic = { state: "socket-error", port: this.port, code: error.code };
    });
    socket.on("close", () => {
      if (this.client !== socket) return;
      clearInterval(this.heartbeatTimer);
      clearTimeout(this.handshakeTimer);
      this.client = null;
      this.editorInfo = null;
      if (this.diagnostic.state === "ready") this.diagnostic = { state: "disconnected", port: this.port };
      this.emit("diagnostic", this.diagnostic);
      this.emit("disconnected");
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
        this.reconnectTimer.unref?.();
      }
    });
    socket.connect(this.port, this.host);
  }

  send(message) {
    if (!this.client || this.client.destroyed || this.client.readyState !== "open") return false;
    const payload = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(payload, "utf8") > MAX_MESSAGE_BYTES) throw new Error("导入消息过大，请分批导入");
    this.client.write(payload);
    return true; // write(false) means backpressure, not rejection; never enqueue twice.
  }

  handleMessage(message) {
    if (message.type === 'busy' && !this.editorInfo) {
      this.diagnostic = { state: 'editor-busy', port: this.port };
      clearTimeout(this.handshakeTimer);
      this.client?.destroy();
      return;
    }
    if (message.type === "hello") {
      if (message.protocolVersion !== 2 || typeof message.sessionId !== "string" || !message.sessionId
        || typeof message.projectPath !== "string" || !message.projectPath) {
        this.editorInfo = null;
        this.diagnostic = { state: "incompatible", port: this.port, protocolVersion: message.protocolVersion };
        this.emit("incompatible");
        this.client?.destroy();
        return;
      }
      this.editorInfo = message;
      clearTimeout(this.handshakeTimer);
      this.client?.setTimeout(this.receiveTimeoutMs);
      this.diagnostic = { state: "ready", port: this.port, projectPath: message.projectPath, pid: message.pid, sessionId: message.sessionId };
      this.emit("ready", message);
      for (const [requestId, pending] of this.pending) {
        if (pending.sessionId !== message.sessionId) {
          pending.finish(new Error("Unreal 编辑器已重启，原任务结果无法确认，请先检查已导入资产"));
        } else {
          this.send({ type: "query", requestId }); // Reconnect queries only; never resubmit.
        }
      }
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (["accepted", "progress", "complete", "error"].includes(message.type)) clearTimeout(pending.ackTimer);
    if (message.type === "accepted" || message.type === "progress") {
      pending.onProgress?.({ percent: Math.max(0, Math.min(99, Number(message.percent) || 0)),
        message: message.stage || "Unreal 已接收任务，正在导入..." });
    } else if (message.type === "complete") {
      pending.finish(null, message);
    } else if (message.type === "error") {
      const error = new Error(message.message || "Unreal 导入失败");
      error.code = message.rejectedBeforeImport ? "ASSETHIVE_NOT_DISPATCHED" : "ASSETHIVE_IMPORT_FAILED";
      error.requestId = message.requestId;
      error.assetResults = message.assetResults;
      pending.finish(error);
    } else if (message.type === "unknown") {
      pending.finish(new Error(message.message || "无法确认原任务状态，请检查 Unreal 中的导入结果"));
    }
  }

  async getEditorInfo(timeoutMs = 2500) {
    if (this.editorInfo && this.client && !this.client.destroyed) return this.editorInfo;
    this.connect();
    return new Promise(resolve => {
      const finish = info => {
        clearTimeout(timer);
        this.off("ready", ready);
        this.off("incompatible", incompatible);
        resolve(info);
      };
      const ready = info => finish(info);
      const incompatible = () => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.on("ready", ready);
      this.on("incompatible", incompatible);
    });
  }

  async importAssets(job, { projectPath = "", onProgress } = {}) {
    const info = await this.getEditorInfo();
    if (!info) throw notDispatched("未连接到兼容的 AssetHive 插件，请更新插件并打开 Unreal 项目");
    if (job?.assets?.some(asset => asset.plantAssetType === "naniteFoliage") && !info.capabilities?.includes("naniteFoliage")) {
      throw notDispatched("当前 Unreal 插件不支持 Nanite Foliage，请更新插件并重启编辑器");
    }
    if (job?.assets?.some(asset => asset.materialGroups?.some(group => group.maskMaterial))
      && !info.capabilities?.includes("maskMaterials")) {
      throw notDispatched("当前 Unreal 插件不支持 Mask 多通道 tiling，请更新插件后重新导出");
    }
    if (job?.assets?.some(asset => /^(atlas|atlases)$/i.test(String(asset.assetType || "").trim()))
      && !info.capabilities?.includes("atlasTextureOnly")) {
      throw notDispatched("当前 Unreal 插件不支持图集材质与贴图导入，请更新并重新编译插件后重启编辑器");
    }
    if (job?.assets?.some(asset => Array.isArray(asset.meshOverwritePolicy))
      && !info.capabilities?.includes("selectiveOverwrite")) {
      throw notDispatched("当前 Unreal 插件不支持按材质实例、纹理和网格体选择覆盖，请更新并重新编译插件后重启编辑器");
    }
    if (job?.assets?.some(asset => asset.meshOverwritePolicy === "meshOnly")
      && (!Array.isArray(info.capabilities) || !info.capabilities.includes("meshOnlyOverwrite"))) {
      throw notDispatched("当前 Unreal 插件不支持只覆盖网格体，请更新并重新编译插件后重启编辑器");
    }
    if (job?.assets?.some((asset) => asset.plantExportVersion === 2)
      && (!Array.isArray(info.capabilities) || !info.capabilities.includes("plantExportV2"))) {
      throw notDispatched("当前 Unreal 插件不支持植被 Diffuse Alpha 和 Foliage 命名，请更新并重新编译插件后重启编辑器");
    }
    if (job?.assets?.some(asset => asset.plantWindLayers?.hasCantileverWeights)
      && !info.capabilities?.includes("plantCantileverWeights")) {
      throw notDispatched("当前 Unreal 插件不支持长茎植被权重曲线，请更新并重新编译插件后重启编辑器");
    }
    if (job?.assets?.some((asset) => asset.materialMatching === "name" && asset.assetType !== "3dplant")
      && (!Array.isArray(info.capabilities) || !info.capabilities.includes("zion3dMaterialNames"))) {
      throw notDispatched("当前 Unreal 插件不支持 Zion 3D 材质名称匹配，请更新并重新编译插件后重启编辑器");
    }
    if (job?.assets?.some((asset) => asset.assetType === "3dplant" && (asset.materialMatching === "name"
      || asset.nativePlantWind?.useRemappedUV3 === true
      || asset.nativePlantWind?.useRemappedUV3 !== false && (asset.nativePlantWind?.staticSwitchParameters?.["Use Remapped UV3"] === true
        || asset.nativePlantWind?.materials?.some((material) => material.staticSwitchParameters?.["Use Remapped UV3"] === true))))
      && (!Array.isArray(info.capabilities) || !info.capabilities.includes("zionPlantMaterialReuse"))) {
      throw notDispatched("当前 Unreal 插件不支持 Zion 植被材质与纹理复用校验，请更新并重新编译插件后重启编辑器");
    }
    const normalize = value => String(value).replaceAll("\\", "/").toLowerCase();
    if (projectPath && normalize(projectPath) !== normalize(info.projectPath)) {
      throw notDispatched("当前连接的 Unreal 项目与目标项目不一致");
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const pending = {
        sessionId: info.sessionId, onProgress,
        finish: (error, result) => {
          clearTimeout(pending.ackTimer);
          clearTimeout(pending.resultTimer);
          this.pending.delete(requestId);
          if (error) reject(error); else resolve(result);
        }
      };
      pending.ackTimer = setTimeout(() => {
        // A busy editor may not have processed the queued request yet. Query only.
        this.send({ type: "query", requestId });
        onProgress?.({ percent: 0, message: "等待 Unreal 确认任务，编辑器可能正在忙碌..." });
      }, this.ackTimeoutMs);
      pending.resultTimer = setTimeout(() => pending.finish(new Error(
        "等待导入结果超时，Unreal 中的任务可能仍在执行，请检查结果后再操作"
      )), this.importTimeoutMs);
      this.pending.set(requestId, pending);
      try {
        if (!this.send({ type: "import", protocolVersion: 2, requestId,
          projectPath: info.projectPath, job })) pending.finish(notDispatched("连接已断开，任务未发送"));
      } catch (error) { pending.finish(error); }
    });
  }

  disconnect() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.handshakeTimer);
    for (const pending of this.pending.values()) pending.finish(new Error("AssetHive 已断开连接"));
    this.editorInfo = null;
    this.client?.destroy();
  }
}

module.exports = { AssetHiveTCPClient, notDispatched };
