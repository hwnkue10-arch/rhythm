import { WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { PlayerState, RoomState, SongSlot, Timeline } from "./types";

const REVIVE_WINDOW_MS = 3000;
const REVIVE_DOWN_TIME_MS = 700; // 사망 직후 0.7초 동안은 쓰러짐 상태로 부활 불가 (겹침 무적 방지)
const REVIVER_COOLDOWN_MS = 2000; // 아군을 살린 플레이어의 부활 쿨다운
const INVULNERABLE_MS = 800; // 0.5~1초 범위 내 값
const MAX_LIVES = 3;
const PLAYER_COLORS = ["#3378DD", "#D85A30", "#0F9E75", "#D4537E"];

interface RoomRuntime {
  state: RoomState;
  sockets: Map<string, WebSocket>;
  timelines: Map<number, Timeline>; // stage -> timeline (재시작 시 재사용)
  stageEndTimer: NodeJS.Timeout | null;
  failCheckTimer: NodeJS.Timeout | null;
  reviverCooldowns: Map<string, number>; // playerId -> cooldownUntil (ms)
}

function emptySong(slot: 1 | 2 | 3): SongSlot {
  return {
    slot,
    sourceType: null,
    title: null,
    filePath: null,
    publicUrl: null,
    fullDurationSec: null,
    durationSec: null,
    verified: false,
  };
}

export class RoomManager {
  private rooms = new Map<string, RoomRuntime>();

  createRoom(hostSocket: WebSocket, nickname: string): { room: RoomState; playerId: string } {
    const roomId = uuid().slice(0, 6).toUpperCase();
    const playerId = uuid();
    const player = this.makePlayer(playerId, nickname, 0);
    const state: RoomState = {
      id: roomId,
      hostId: playerId,
      phase: "lobby",
      stage: 1,
      songs: [emptySong(1), emptySong(2), emptySong(3)],
      players: { [playerId]: player },
    };
    const runtime: RoomRuntime = {
      state,
      sockets: new Map([[playerId, hostSocket]]),
      timelines: new Map(),
      stageEndTimer: null,
      failCheckTimer: null,
      reviverCooldowns: new Map(),
    };
    this.rooms.set(roomId, runtime);
    return { room: state, playerId };
  }

  joinRoom(roomId: string, socket: WebSocket, nickname: string): { room: RoomState; playerId: string } | { error: string } {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return { error: "존재하지 않는 방입니다." };
    if (runtime.state.phase !== "lobby") return { error: "이미 게임이 진행 중인 방입니다." };
    if (Object.keys(runtime.state.players).length >= 4) return { error: "방 인원이 가득 찼습니다." };

    const playerId = uuid();
    const colorIndex = Object.keys(runtime.state.players).length;
    const player = this.makePlayer(playerId, nickname, colorIndex);
    runtime.state.players[playerId] = player;
    runtime.sockets.set(playerId, socket);
    return { room: runtime.state, playerId };
  }

  private makePlayer(id: string, nickname: string, colorIndex: number): PlayerState {
    return {
      id,
      nickname,
      color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
      connected: true,
      lives: MAX_LIVES,
      dead: false,
      diedAt: null,
      x: 0.5,
      y: 0.8,
      invulnerableUntil: 0,
    };
  }

  getRoom(roomId: string): RoomRuntime | undefined {
    return this.rooms.get(roomId);
  }

  broadcast(roomId: string, payload: unknown, exceptPlayerId?: string) {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    const msg = JSON.stringify(payload);
    for (const [pid, sock] of runtime.sockets) {
      if (pid === exceptPlayerId) continue;
      if (sock.readyState === WebSocket.OPEN) sock.send(msg);
    }
  }

  broadcastRoomState(roomId: string) {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    this.broadcast(roomId, { type: "room_state", room: runtime.state });
  }

  setSong(roomId: string, playerId: string, slot: 1 | 2 | 3, song: Partial<SongSlot>) {
    const runtime = this.rooms.get(roomId);
    if (!runtime || runtime.state.hostId !== playerId) return;
    if (runtime.state.phase !== "lobby") return;
    const existing = runtime.state.songs[slot - 1];
    runtime.state.songs[slot - 1] = { ...existing, ...song, slot };
    this.broadcastRoomState(roomId);
  }

  kick(roomId: string, hostId: string, targetId: string) {
    const runtime = this.rooms.get(roomId);
    if (!runtime || runtime.state.hostId !== hostId || hostId === targetId) return;
    const sock = runtime.sockets.get(targetId);
    delete runtime.state.players[targetId];
    runtime.sockets.delete(targetId);
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: "kicked" }));
      sock.close();
    }
    this.broadcastRoomState(roomId);
  }

  transferHost(roomId: string, hostId: string, targetId: string) {
    const runtime = this.rooms.get(roomId);
    if (!runtime || runtime.state.hostId !== hostId) return;
    if (!runtime.state.players[targetId]) return;
    runtime.state.hostId = targetId;
    this.broadcastRoomState(roomId);
  }

  updatePosition(roomId: string, playerId: string, x: number, y: number) {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    const p = runtime.state.players[playerId];
    if (!p || p.dead) return;
    p.x = x;
    p.y = y;
    this.broadcast(roomId, { type: "player_moved", id: playerId, x, y }, playerId);
  }

  canStart(room: RoomState): boolean {
    return room.songs.every((s) => s.filePath && s.durationSec && s.verified);
  }

  /**
   * 스테이지 시작. timeline은 이미 분석되어 전달된다(index.ts에서 오디오 분석 후 호출).
   */
  beginStage(roomId: string, stage: number, timeline: Timeline, onStageEnd: (roomId: string) => void) {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    runtime.state.phase = "playing";
    runtime.state.stage = stage;
    runtime.timelines.set(stage, timeline);
    runtime.reviverCooldowns.clear();
    for (const p of Object.values(runtime.state.players)) {
      p.lives = MAX_LIVES;
      p.dead = false;
      p.diedAt = null;
      p.invulnerableUntil = 0;
    }
    const serverStartTime = Date.now() + 1500; // 클라이언트가 준비할 시간 버퍼
    this.broadcast(roomId, {
      type: "stage_start",
      stage,
      songUrl: runtime.state.songs[stage - 1].publicUrl,
      timeline,
      themeId: timeline.themeId || "neon_pulse",
      serverStartTime,
    });
    this.broadcastRoomState(roomId);

    if (runtime.stageEndTimer) clearTimeout(runtime.stageEndTimer);
    const untilEnd = serverStartTime - Date.now() + timeline.durationSec * 1000 + 300;
    runtime.stageEndTimer = setTimeout(() => onStageEnd(roomId), Math.max(untilEnd, 0));
  }

  getTimeline(roomId: string, stage: number): Timeline | undefined {
    return this.rooms.get(roomId)?.timelines.get(stage);
  }

  /** 스테이지 시간이 다 됐을 때: 생존자가 있으면 클리어, 아니면 이미 실패 처리되어 있어야 정상 */
  resolveStageTimeout(roomId: string): "cleared" | "already_resolved" | "failed" {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return "already_resolved";
    if (runtime.state.phase !== "playing") return "already_resolved";
    const anyAlive = Object.values(runtime.state.players).some((p) => !p.dead);
    if (anyAlive) {
      this.handleStageClear(roomId);
      return "cleared";
    }
    runtime.state.phase = "stage_failed";
    this.broadcastRoomState(roomId);
    this.broadcast(roomId, { type: "stage_failed", stage: runtime.state.stage });
    return "failed";
  }

  private handleStageClear(roomId: string) {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    const wasLastStage = runtime.state.stage >= 3;
    for (const p of Object.values(runtime.state.players)) {
      p.lives = MAX_LIVES;
      p.dead = false;
      p.diedAt = null;
    }
    if (wasLastStage) {
      runtime.state.phase = "game_clear";
      this.broadcastRoomState(roomId);
      this.broadcast(roomId, { type: "game_clear" });
    } else {
      runtime.state.phase = "stage_clear";
      this.broadcastRoomState(roomId);
      this.broadcast(roomId, { type: "stage_clear", nextStage: runtime.state.stage + 1 });
    }
  }

  handleHit(roomId: string, playerId: string, onAllDead: (roomId: string) => void) {
    const runtime = this.rooms.get(roomId);
    if (!runtime || runtime.state.phase !== "playing") return;
    const p = runtime.state.players[playerId];
    if (!p || p.dead) return;
    const now = Date.now();
    if (now < p.invulnerableUntil) return; // 무적 시간 중 판정 무시

    p.lives -= 1;
    if (p.lives <= 0) {
      p.lives = 0;
      p.dead = true;
      p.diedAt = now;
    } else {
      p.invulnerableUntil = now + INVULNERABLE_MS;
    }
    this.broadcast(roomId, {
      type: "life_update",
      id: playerId,
      lives: p.lives,
      dead: p.dead,
      invulnerableUntil: p.invulnerableUntil,
    });

    const allDead = Object.values(runtime.state.players).every((pl) => pl.dead);
    if (allDead) {
      if (runtime.failCheckTimer) clearTimeout(runtime.failCheckTimer);
      runtime.failCheckTimer = setTimeout(() => {
        const stillAllDead = Object.values(runtime.state.players).every((pl) => pl.dead);
        if (stillAllDead && runtime.state.phase === "playing") {
          onAllDead(roomId);
        }
      }, REVIVE_WINDOW_MS + 100);
    }
  }

  handleRevive(roomId: string, reviverId: string, targetId: string): boolean {
    const runtime = this.rooms.get(roomId);
    if (!runtime || runtime.state.phase !== "playing") return false;
    const reviver = runtime.state.players[reviverId];
    const target = runtime.state.players[targetId];
    if (!reviver || !target || reviver.dead || !target.dead || !target.diedAt) return false;

    const now = Date.now();
    // 1. 사망 직후 다운 상태(0.7초)에는 즉시 부활 불가 -> 겹침 무한 무적 루프 방지!
    if (now - target.diedAt < REVIVE_DOWN_TIME_MS) return false;
    // 2. 3초 경과 시 부활 기회 상실
    if (now - target.diedAt > REVIVE_WINDOW_MS) return false;

    // 3. 살려주는 플레이어의 부활 쿨다운(2초) 검사
    const reviverCd = runtime.reviverCooldowns.get(reviverId) || 0;
    if (now < reviverCd) return false;

    const dx = reviver.x - target.x;
    const dy = reviver.y - target.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 0.06) return false; // 정규화 좌표(0~1) 기준 근접 판정

    // 부활 성공: 살려준 사람에게 2초 쿨다운 부여
    runtime.reviverCooldowns.set(reviverId, now + REVIVER_COOLDOWN_MS);

    target.dead = false;
    target.lives = 1;
    target.diedAt = null;
    target.invulnerableUntil = now + INVULNERABLE_MS;

    // 겹쳐서 또 바로 맞거나 비비는 것을 막기 위해 살짝 바깥으로 분리
    const pushAngle = dist > 0.001 ? Math.atan2(dy, dx) : Math.random() * Math.PI * 2;
    target.x = Math.max(0.04, Math.min(0.96, target.x - Math.cos(pushAngle) * 0.03));
    target.y = Math.max(0.04, Math.min(0.96, target.y - Math.sin(pushAngle) * 0.03));

    this.broadcast(roomId, {
      type: "player_revived",
      id: targetId,
      by: reviverId,
      lives: 1,
      x: target.x,
      y: target.y,
    });
    return true;
  }

  markAllFailed(roomId: string) {
    const runtime = this.rooms.get(roomId);
    if (!runtime || runtime.state.phase !== "playing") return;
    runtime.state.phase = "stage_failed";
    this.broadcastRoomState(roomId);
    this.broadcast(roomId, { type: "stage_failed", stage: runtime.state.stage });
  }

  restartStage(roomId: string, hostId: string, onStageEnd: (roomId: string) => void) {
    const runtime = this.rooms.get(roomId);
    if (!runtime || runtime.state.hostId !== hostId || runtime.state.phase !== "stage_failed") return;
    const timeline = runtime.timelines.get(runtime.state.stage);
    if (!timeline) return;
    this.beginStage(roomId, runtime.state.stage, timeline, onStageEnd);
  }

  giveUp(roomId: string, hostId: string) {
    const runtime = this.rooms.get(roomId);
    if (!runtime || runtime.state.hostId !== hostId) return;
    if (runtime.stageEndTimer) clearTimeout(runtime.stageEndTimer);
    if (runtime.failCheckTimer) clearTimeout(runtime.failCheckTimer);
    runtime.state.phase = "lobby";
    runtime.state.stage = 1;
    runtime.timelines.clear();
    for (const p of Object.values(runtime.state.players)) {
      p.lives = MAX_LIVES;
      p.dead = false;
      p.diedAt = null;
    }
    this.broadcastRoomState(roomId);
  }

  advanceToNextStage(roomId: string, onStageEnd: (roomId: string) => void, timeline: Timeline) {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    this.beginStage(roomId, runtime.state.stage + 1, timeline, onStageEnd);
  }

  removePlayer(roomId: string, playerId: string): { deleted: boolean; newHostId?: string } {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return { deleted: false };
    delete runtime.state.players[playerId];
    runtime.sockets.delete(playerId);
    this.broadcast(roomId, { type: "player_removed", id: playerId });

    if (Object.keys(runtime.state.players).length === 0) {
      if (runtime.stageEndTimer) clearTimeout(runtime.stageEndTimer);
      if (runtime.failCheckTimer) clearTimeout(runtime.failCheckTimer);
      this.rooms.delete(roomId);
      return { deleted: true };
    }

    let newHostId: string | undefined;
    if (runtime.state.hostId === playerId) {
      newHostId = Object.keys(runtime.state.players)[0];
      runtime.state.hostId = newHostId;
    }
    this.broadcastRoomState(roomId);
    return { deleted: false, newHostId };
  }

  findRoomIdBySocket(socket: WebSocket): { roomId: string; playerId: string } | null {
    for (const [roomId, runtime] of this.rooms) {
      for (const [pid, s] of runtime.sockets) {
        if (s === socket) return { roomId, playerId: pid };
      }
    }
    return null;
  }
}

export const roomManager = new RoomManager();
