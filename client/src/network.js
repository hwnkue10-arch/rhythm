export class Network {
  constructor() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}`);
    this.handlers = {};
    this.roomId = null;
    this.playerId = null;

    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "joined") {
        this.roomId = msg.roomId;
        this.playerId = msg.playerId;
      }
      const list = this.handlers[msg.type] || [];
      for (const fn of list) fn(msg);
    });
  }

  on(type, fn) {
    if (!this.handlers[type]) this.handlers[type] = [];
    this.handlers[type].push(fn);
  }

  ready() {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.addEventListener("open", () => resolve(), { once: true });
    });
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify({ type, roomId: this.roomId, playerId: this.playerId, ...payload }));
  }
}
