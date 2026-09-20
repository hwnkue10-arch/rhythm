import { WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import fs from "fs";
import { PlayerState, RoomState, SongSlot, Timeline } from "./types";

/** 디스크 파일을 안전하게 삭제합니다. 존재하지 않거나 오류가 나도 서버는 멈추지 않습니다. */
async function safeDeleteFile(filePath: string | null | undefined): Promise<void> {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
      console.log(`[파일 정리] 삭제 완료: ${filePath}`);
    }
  } catch (err) {
    console.warn(`[파일 정리] 삭제 실패 (무시됨): ${filePath}`, err);
  }
}

const REVIVE_WINDOW_MS = 4000;
const REVIVE_DOWN_TIME_MS = 700; // 사망 직후 0.7초 동안은 쓰러짐 상태로 부활 불가 (겹침 무적 방지)
const REVIVER_COOLDOWN_MS = 2000; // 아군을 살린 플레이어의 부활 쿨다운
const INVULNERABLE_MS = 800; // 피격 무적 (0.8초)
const REVIVE_INVULNERABLE_MS = 1800; // 부활 직후 무적 (1.8초)
const MAX_LIVES = 3;
const PLAYER_COLORS = ["#3378DD", "#D85A30", "#0F9E75", "#D4537E"];
const DISCONNECT_GRACE_MS = 10000; // 일시적 새로고침/재접속 유예 시간 (10초)

interface RoomRuntime {
  state: RoomState;
  sockets: Map<string, WebSocket>;
  timelines: Map<number, Timeline>; // stage -> timeline (재시작 시 재사용)
  stageEndTimer: NodeJS.Timeout | null;
  failCheckTimer: NodeJS.Timeout | null;
  reviverCooldowns: Map<string, number>; // playerId -> cooldownUntil (ms)
  disconnectTimers: Map<string, NodeJS.Timeout>; // playerId -> timer
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

export interface RoomSummary {
  id: string;
  hostNickname: string;
  playerCount: number;
  maxPlayers: number;
  phase: string;
  isPlaying: boolean;
}

export class RoomManager {
  private rooms = new Map<string, RoomRuntime>();

  getRoomList(): RoomSummary[] {
    const list: RoomSummary[] = [];
    for (const [id, runtime] of this.rooms) {
      const host = runtime.state.players[runtime.state.hostId];
      const players = Object.values(runtime.state.players);
      list.push({
        id,
        hostNickname: host ? host.nickname : "알 수 없음",
        playerCount: players.length,
        maxPlayers: 4,
        phase: runtime.state.phase,
        isPlaying: runtime.state.phase !== "lobby",
      });
    }
    return list;
  }

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
      disconnectTimers: new Map(),
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
    // 이미 사용 중인 색상을 제외하고 남은 인덱스 중 가장 빠른 것을 배정 (퇴장 후 재입장 시 색상 중복 방지)
    const usedColors = new Set(Object.values(runtime.state.players).map((p) => p.color));
    const colorIndex = PLAYER_COLORS.findIndex((c) => !usedColors.has(c));
    const player = this.makePlayer(playerId, nickname, colorIndex >= 0 ? colorIndex : 0);
    runtime.state.players[playerId] = player;
    runtime.sockets.set(playerId, socket);
    return { room: runtime.state, playerId };
  }

  reconnect(roomId: string, playerId: string, socket: WebSocket): { room: RoomState } | { error: string } {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return { error: "존재하지 않는 방입니다." };
    const player = runtime.state.players[playerId];
    if (!player) return { error: "방에 존재하지 않는 플레이어입니다." };

    // 타이머가 돌고 있다면 취소
    const timer = runtime.disconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      runtime.disconnectTimers.delete(playerId);
    }

    player.connected = true;
    runtime.sockets.set(playerId, socket);
    return { room: runtime.state };
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
      stats: { hitCount: 0, deathCount: 0, reviveCount: 0 },
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

    // 새 파일로 교체 시 이전 커스텀 파일 즉시 삭제
    if (song.filePath && existing.filePath && existing.filePath !== song.filePath) {
      safeDeleteFile(existing.filePath);
    }

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
      p.stats = { hitCount: 0, deathCount: 0, reviveCount: 0 };
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

    // 플레이어별 통계 데이터 모음
    const playerStats: Record<string, { nickname: string; color: string; hitCount: number; deathCount: number; reviveCount: number }> = {};
    for (const [pid, p] of Object.entries(runtime.state.players)) {
      playerStats[pid] = {
        nickname: p.nickname,
        color: p.color,
        hitCount: p.stats?.hitCount || 0,
        deathCount: p.stats?.deathCount || 0,
        reviveCount: p.stats?.reviveCount || 0,
      };
      p.lives = MAX_LIVES;
      p.dead = false;
      p.diedAt = null;
    }

    if (wasLastStage) {
      runtime.state.phase = "game_clear";
      this.broadcastRoomState(roomId);
      this.broadcast(roomId, { type: "game_clear", stats: playerStats });
    } else {
      runtime.state.phase = "stage_clear";
      this.broadcastRoomState(roomId);
      this.broadcast(roomId, { type: "stage_clear", nextStage: runtime.state.stage + 1, stats: playerStats });
    }
  }

  handleHit(roomId: string, playerId: string, onAllDead: (roomId: string) => void) {
    const runtime = this.rooms.get(roomId);
    if (!runtime || runtime.state.phase !== "playing") return;
    const p = runtime.state.players[playerId];
    if (!p || p.dead) return;
    const now = Date.now();
    if (now < p.invulnerableUntil) return; // 무적 시간 중 판정 무시

    if (!p.stats) p.stats = { hitCount: 0, deathCount: 0, reviveCount: 0 };
    p.stats.hitCount += 1;

    p.lives -= 1;
    if (p.lives <= 0) {
      p.lives = 0;
      p.dead = true;
      p.diedAt = now;
      p.stats.deathCount += 1;
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

    // 부활 성공: 살려준 사람에게 2초 쿨다운 부여 및 통계 카운트
    runtime.reviverCooldowns.set(reviverId, now + REVIVER_COOLDOWN_MS);
    if (!reviver.stats) reviver.stats = { hitCount: 0, deathCount: 0, reviveCount: 0 };
    reviver.stats.reviveCount += 1;

    target.dead = false;
    target.lives = 1;
    target.diedAt = null;
    target.invulnerableUntil = now + REVIVE_INVULNERABLE_MS;

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
      invulnerableUntil: target.invulnerableUntil,
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

  deleteRoom(roomId: string) {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    if (runtime.stageEndTimer) clearTimeout(runtime.stageEndTimer);
    if (runtime.failCheckTimer) clearTimeout(runtime.failCheckTimer);
    for (const t of runtime.disconnectTimers.values()) clearTimeout(t);
    runtime.disconnectTimers.clear();

    // 방 삭제 시 모든 스테이지 슬롯의 오디오 파일 정리
    for (const song of runtime.state.songs) {
      safeDeleteFile(song.filePath);
    }

    this.rooms.delete(roomId);
    console.log(`[방 정리] 방 ${roomId} 삭제 및 파일 정리 완료`);
  }

  handleDisconnect(roomId: string, playerId: string, onRemoved: () => void) {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    const player = runtime.state.players[playerId];
    if (!player) return;

    player.connected = false;
    runtime.sockets.delete(playerId);
    this.broadcastRoomState(roomId);

    // 이미 타이머가 있으면 정리
    const existing = runtime.disconnectTimers.get(playerId);
    if (existing) clearTimeout(existing);

    // 다른 플레이어가 없으면 즉시 방 삭제 (잔재 방 방지)
    const connectedPlayers = Object.values(runtime.state.players).filter((p) => p.connected);
    if (connectedPlayers.length === 0) {
      this.deleteRoom(roomId);
      onRemoved();
      return;
    }

    // 10초 유예 후에도 안 돌아오면 퇴장 처리
    const timer = setTimeout(() => {
      runtime.disconnectTimers.delete(playerId);
      this.removePlayer(roomId, playerId);
      onRemoved();
    }, DISCONNECT_GRACE_MS);

    runtime.disconnectTimers.set(playerId, timer);
  }

  leaveRoom(roomId: string, playerId: string): { deleted: boolean; newHostId?: string } {
    const runtime = this.rooms.get(roomId);
    if (runtime) {
      const timer = runtime.disconnectTimers.get(playerId);
      if (timer) {
        clearTimeout(timer);
        runtime.disconnectTimers.delete(playerId);
      }
    }
    return this.removePlayer(roomId, playerId);
  }

  removePlayer(roomId: string, playerId: string): { deleted: boolean; newHostId?: string } {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return { deleted: false };
    delete runtime.state.players[playerId];
    runtime.sockets.delete(playerId);
    const timer = runtime.disconnectTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      runtime.disconnectTimers.delete(playerId);
    }
    this.broadcast(roomId, { type: "player_removed", id: playerId });

    if (Object.keys(runtime.state.players).length === 0) {
      this.deleteRoom(roomId);
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
