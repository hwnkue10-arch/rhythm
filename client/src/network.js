export class Network {
  constructor() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}`);
    this.handlers = {};
    this.roomId = localStorage.getItem("rhythm_roomId") || null;
    this.playerId = localStorage.getItem("rhythm_playerId") || null;

    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "joined") {
        this.roomId = msg.roomId;
        this.playerId = msg.playerId;
        localStorage.setItem("rhythm_roomId", this.roomId);
        localStorage.setItem("rhythm_playerId", this.playerId);
      } else if (msg.type === "left_room" || msg.type === "kicked" || msg.type === "reconnect_failed") {
        this.clearSession();
      }
      const list = this.handlers[msg.type] || [];
      for (const fn of list) fn(msg);
    });
  }

  clearSession() {
    this.roomId = null;
    this.playerId = null;
    localStorage.removeItem("rhythm_roomId");
    localStorage.removeItem("rhythm_playerId");
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

  joinRoom(roomId, nickname) {
    this.send("join_room", { roomId, nickname });
  }

  leaveRoom() {
    this.send("leave_room");
    this.clearSession();
  }

  tryReconnect() {
    if (this.roomId && this.playerId) {
      this.send("reconnect", { roomId: this.roomId, playerId: this.playerId });
      return true;
    }
    return false;
  }
}
