const net = require("node:net");

const ASSETHIVE_UE_PORT = 13430;
const CONNECTION_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;

class AssetHiveTCPClient {
  constructor() {
    this.client = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.messageQueue = [];
    this.onMessageCallback = null;
    this.onConnectedCallback = null;
    this.onDisconnectedCallback = null;
    this.receiveBuffer = "";
  }

  connect(host = "127.0.0.1", port = ASSETHIVE_UE_PORT, options = {}) {
    const forceReconnect = Boolean(options && options.forceReconnect);
    if (this.reconnectTimer) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client && !this.client.destroyed) {
      if (this.connected) {
        return;
      }
      if (forceReconnect) {
        try {
          this.client.destroy();
        } catch {
          void 0;
        }
      } else {
        return;
      }
    }

    if (this.client && this.client.destroyed) {
      this.client = null;
    }

    if (this.client) {
      return;
    }

    const socket = new net.Socket();
    this.client = socket;
    socket.setTimeout(CONNECTION_TIMEOUT_MS);

    socket.on("connect", () => {
      if (this.client !== socket) {
        return;
      }
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log("[AssetHive] TCP connected to UE plugin");
      if (typeof this.onConnectedCallback === "function") {
        this.onConnectedCallback();
      }
      this.flushMessageQueue();
    });

    socket.on("data", (data) => {
      if (this.client !== socket) {
        return;
      }
      this.receiveBuffer += data.toString("utf-8");
      let idx = this.receiveBuffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.receiveBuffer.slice(0, idx).trim();
        this.receiveBuffer = this.receiveBuffer.slice(idx + 1);
        if (line && typeof this.onMessageCallback === "function") {
          this.onMessageCallback(line);
        }
        idx = this.receiveBuffer.indexOf("\n");
      }
    });

    socket.on("error", (error) => {
      if (this.client !== socket) {
        return;
      }
      console.warn("[AssetHive] TCP error:", error.message);
      this.connected = false;
    });

    socket.on("close", () => {
      if (this.client !== socket) {
        return;
      }
      this.connected = false;
      this.receiveBuffer = "";
      this.client = null;
      console.log("[AssetHive] TCP disconnected from UE plugin");
      if (typeof this.onDisconnectedCallback === "function") {
        this.onDisconnectedCallback();
      }
      this.scheduleReconnect(host, port);
    });

    socket.on("timeout", () => {
      if (this.client !== socket) {
        return;
      }
      console.warn("[AssetHive] TCP connection timeout");
      socket.destroy();
    });

    socket.connect(port, host);
  }

  scheduleReconnect(host, port) {
    if (this.reconnectTimer) {
      globalThis.clearTimeout(this.reconnectTimer);
    }

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn("[AssetHive] Max reconnect attempts reached");
      return;
    }

    this.reconnectAttempts += 1;
    const delay = RECONNECT_DELAY_MS * this.reconnectAttempts;
    console.log(`[AssetHive] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(host, port);
    }, delay);
  }

  waitForConnection(timeoutMs = CONNECTION_TIMEOUT_MS) {
    if (this.connected && this.client && !this.client.destroyed) {
      return Promise.resolve(true);
    }
    const timeout = Math.max(0, Number(timeoutMs) || CONNECTION_TIMEOUT_MS);
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const poll = () => {
        if (this.connected && this.client && !this.client.destroyed) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= timeout) {
          resolve(false);
          return;
        }
        globalThis.setTimeout(poll, 50);
      };
      poll();
    });
  }

  send(message) {
    if (this.connected && this.client && !this.client.destroyed) {
      this.client.write(message + "\n");
      return true;
    }
    this.messageQueue.push(message);
    return false;
  }

  flushMessageQueue() {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (!this.send(message)) {
        this.messageQueue.unshift(message);
        break;
      }
    }
  }

  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  onConnected(callback) {
    this.onConnectedCallback = callback;
  }

  onDisconnected(callback) {
    this.onDisconnectedCallback = callback;
  }

  disconnect() {
    if (this.reconnectTimer) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client && !this.client.destroyed) {
      this.client.destroy();
    }
    this.connected = false;
    this.messageQueue = [];
  }

  isConnected() {
    return this.connected;
  }
}

const tcpClient = new AssetHiveTCPClient();

module.exports = {
  AssetHiveTCPClient,
  tcpClient,
  connectToUE: (host, port, options) => tcpClient.connect(host, port, options),
  sendToUE: (message) => tcpClient.send(message),
  onUEMessage: (callback) => tcpClient.onMessage(callback),
  disconnectFromUE: () => tcpClient.disconnect(),
  isUEConnected: () => tcpClient.isConnected(),
  waitForUEConnection: (timeoutMs) => tcpClient.waitForConnection(timeoutMs)
};
