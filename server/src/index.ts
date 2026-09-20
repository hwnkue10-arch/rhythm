import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import multer from "multer";
import { WebSocketServer, WebSocket } from "ws";
import { v4 as uuid } from "uuid";
import { roomManager } from "./roomManager";
import { analyzeSongToTimeline } from "./audioAnalysis";
import { fetchYoutubeMeta, downloadYoutubeAudio } from "./youtube";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "..", "..", "client")));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req: any, file: any, cb: (err: any, filename: string) => void) => {
      const songId = uuid();
      cb(null, `${songId}${path.extname(file.originalname) || ".mp3"}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
});

// mp3 업로드: 파일을 저장하고 재생 가능한 URL을 돌려준다.
app.post("/api/upload-song", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "파일이 없습니다." });
  const filePath = req.file.path;
  const publicUrl = `/uploads/${req.file.filename}`;
  // 길이는 클라이언트에서 <audio> 메타데이터로 재확인하지만, 우선 확인 완료로 표시
  res.json({
    filePath,
    publicUrl,
    title: req.file.originalname,
    verified: true,
  });
});

// 유튜브 링크 확인: 실제 다운로드 전에 제목/썸네일을 보여줘서 방장이 맞는 노래인지 확인.
app.post("/api/youtube-meta", async (req, res) => {
  try {
    const { url } = req.body;
    const meta = await fetchYoutubeMeta(url);
    res.json(meta);
  } catch (err: any) {
    res.status(400).json({ error: "유튜브 정보를 가져오지 못했습니다: " + (err?.message ?? err) });
  }
});

// 확인이 끝난 유튜브 링크의 오디오를 실제로 추출한다.
app.post("/api/youtube-download", async (req, res) => {
  try {
    const { url } = req.body;
    const songId = uuid();
    const filePath = await downloadYoutubeAudio(url, UPLOAD_DIR, songId);
    const publicUrl = `/uploads/${path.basename(filePath)}`;
    const meta = await fetchYoutubeMeta(url);
    res.json({ filePath, publicUrl, title: meta.title, fullDurationSec: meta.durationSec, verified: true });
  } catch (err: any) {
    res.status(400).json({ error: "오디오 추출에 실패했습니다: " + (err?.message ?? err) });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcastRoomList() {
  const list = roomManager.getRoomList();
  const payload = JSON.stringify({ type: "room_list_update", rooms: list });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function stageEndHandler(roomId: string) {
  roomManager.resolveStageTimeout(roomId);
  broadcastRoomList();
}

async function startStageWithAnalysis(roomId: string, stage: number) {
  const runtime = roomManager.getRoom(roomId);
  if (!runtime) return;
  const song = runtime.state.songs[stage - 1];
  if (!song.filePath || !song.durationSec) return;
  const songId = `${roomId}-${stage}`;
  const timeline = await analyzeSongToTimeline(song.filePath, songId, stage, song.durationSec);
  roomManager.beginStage(roomId, stage, timeline, stageEndHandler);
  broadcastRoomList();
}

wss.on("connection", (socket: WebSocket) => {
  // 클라이언트 접속 시 현재 방 목록 전송
  socket.send(JSON.stringify({ type: "room_list_update", rooms: roomManager.getRoomList() }));

  socket.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    try {
      switch (msg.type) {
        case "create_room": {
          const { room, playerId } = roomManager.createRoom(socket, msg.nickname || "Player");
          socket.send(JSON.stringify({ type: "joined", roomId: room.id, playerId }));
          roomManager.broadcastRoomState(room.id);
          broadcastRoomList();
          break;
        }
        case "join_room": {
          const result = roomManager.joinRoom(msg.roomId, socket, msg.nickname || "Player");
          if ("error" in result) {
            socket.send(JSON.stringify({ type: "error", message: result.error }));
            return;
          }
          socket.send(JSON.stringify({ type: "joined", roomId: result.room.id, playerId: result.playerId }));
          roomManager.broadcastRoomState(result.room.id);
          broadcastRoomList();
          break;
        }
        case "set_song": {
          roomManager.setSong(msg.roomId, msg.playerId, msg.slot, msg.song);
          break;
        }
        case "kick": {
          roomManager.kick(msg.roomId, msg.playerId, msg.targetId);
          broadcastRoomList();
          break;
        }
        case "transfer_host": {
          roomManager.transferHost(msg.roomId, msg.playerId, msg.targetId);
          broadcastRoomList();
          break;
        }
        case "input_pos": {
          roomManager.updatePosition(msg.roomId, msg.playerId, msg.x, msg.y);
          break;
        }
        case "hit": {
          roomManager.handleHit(msg.roomId, msg.playerId, (roomId) => {
            roomManager.markAllFailed(roomId);
            broadcastRoomList();
          });
          break;
        }
        case "revive_request": {
          roomManager.handleRevive(msg.roomId, msg.playerId, msg.targetId);
          break;
        }
        case "start_game": {
          const runtime = roomManager.getRoom(msg.roomId);
          if (!runtime || runtime.state.hostId !== msg.playerId) return;
          if (!roomManager.canStart(runtime.state)) {
            socket.send(JSON.stringify({ type: "error", message: "3개 스테이지의 노래를 모두 확인해야 시작할 수 있습니다." }));
            return;
          }
          await startStageWithAnalysis(msg.roomId, 1);
          break;
        }
        case "restart_stage": {
          roomManager.restartStage(msg.roomId, msg.playerId, stageEndHandler);
          broadcastRoomList();
          break;
        }
        case "advance_stage": {
          // stage_clear 화면에서 호스트가 다음 스테이지로 진행
          const runtime = roomManager.getRoom(msg.roomId);
          if (!runtime || runtime.state.hostId !== msg.playerId || runtime.state.phase !== "stage_clear") return;
          await startStageWithAnalysis(msg.roomId, runtime.state.stage + 1);
          break;
        }
        case "leave_room": {
          roomManager.leaveRoom(msg.roomId, msg.playerId);
          socket.send(JSON.stringify({ type: "left_room" }));
          broadcastRoomList();
          break;
        }
        case "reconnect": {
          const result = roomManager.reconnect(msg.roomId, msg.playerId, socket);
          if ("error" in result) {
            socket.send(JSON.stringify({ type: "reconnect_failed", message: result.error }));
            return;
          }
          socket.send(JSON.stringify({ type: "joined", roomId: result.room.id, playerId: msg.playerId }));
          roomManager.broadcastRoomState(result.room.id);
          broadcastRoomList();

          // 만약 플레이 중이었다면 스테이지 시작 이벤트도 재전송하여 게임 복귀 지원
          const runtime = roomManager.getRoom(msg.roomId);
          if (runtime && runtime.state.phase === "playing") {
            const stage = runtime.state.stage;
            const timeline = runtime.timelines.get(stage);
            const song = runtime.state.songs[stage - 1];
            if (timeline && song && song.publicUrl) {
              socket.send(JSON.stringify({
                type: "stage_start",
                stage,
                songUrl: song.publicUrl,
                timeline,
                themeId: timeline.themeId || "neon_pulse",
                serverStartTime: Date.now(), // 클라이언트 자체 보정
              }));
            }
          }
          break;
        }
        case "give_up": {
          roomManager.giveUp(msg.roomId, msg.playerId);
          broadcastRoomList();
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("메시지 처리 오류:", err);
      socket.send(JSON.stringify({ type: "error", message: "서버 오류가 발생했습니다." }));
    }
  });

  socket.on("close", () => {
    const found = roomManager.findRoomIdBySocket(socket);
    if (found) {
      roomManager.handleDisconnect(found.roomId, found.playerId, () => {
        broadcastRoomList();
      });
      broadcastRoomList();
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`리듬 게임 서버가 http://0.0.0.0:${PORT} 에서 실행 중입니다. (외부 접속 허용)`);
});
