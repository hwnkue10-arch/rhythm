"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const ws_1 = require("ws");
const uuid_1 = require("uuid");
const roomManager_1 = require("./roomManager");
const audioAnalysis_1 = require("./audioAnalysis");
const youtube_1 = require("./youtube");
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const UPLOAD_DIR = path_1.default.join(__dirname, "..", "uploads");
if (!fs_1.default.existsSync(UPLOAD_DIR))
    fs_1.default.mkdirSync(UPLOAD_DIR, { recursive: true });
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.use("/uploads", express_1.default.static(UPLOAD_DIR));
app.use(express_1.default.static(path_1.default.join(__dirname, "..", "..", "client")));
const upload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) => {
            const songId = (0, uuid_1.v4)();
            cb(null, `${songId}${path_1.default.extname(file.originalname) || ".mp3"}`);
        },
    }),
    limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
});
// mp3 업로드: 파일을 저장하고 재생 가능한 URL을 돌려준다.
app.post("/api/upload-song", upload.single("file"), (req, res) => {
    if (!req.file)
        return res.status(400).json({ error: "파일이 없습니다." });
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
        const meta = await (0, youtube_1.fetchYoutubeMeta)(url);
        res.json(meta);
    }
    catch (err) {
        res.status(400).json({ error: "유튜브 정보를 가져오지 못했습니다: " + (err?.message ?? err) });
    }
});
// 확인이 끝난 유튜브 링크의 오디오를 실제로 추출한다.
app.post("/api/youtube-download", async (req, res) => {
    try {
        const { url } = req.body;
        const songId = (0, uuid_1.v4)();
        const filePath = await (0, youtube_1.downloadYoutubeAudio)(url, UPLOAD_DIR, songId);
        const publicUrl = `/uploads/${path_1.default.basename(filePath)}`;
        const meta = await (0, youtube_1.fetchYoutubeMeta)(url);
        res.json({ filePath, publicUrl, title: meta.title, fullDurationSec: meta.durationSec, verified: true });
    }
    catch (err) {
        res.status(400).json({ error: "오디오 추출에 실패했습니다: " + (err?.message ?? err) });
    }
});
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
function broadcastRoomList() {
    const list = roomManager_1.roomManager.getRoomList();
    const payload = JSON.stringify({ type: "room_list_update", rooms: list });
    for (const client of wss.clients) {
        if (client.readyState === ws_1.WebSocket.OPEN) {
            client.send(payload);
        }
    }
}
function stageEndHandler(roomId) {
    roomManager_1.roomManager.resolveStageTimeout(roomId);
    broadcastRoomList();
}
async function startStageWithAnalysis(roomId, stage) {
    const runtime = roomManager_1.roomManager.getRoom(roomId);
    if (!runtime)
        return;
    const song = runtime.state.songs[stage - 1];
    if (!song.filePath || !song.durationSec)
        return;
    const songId = `${roomId}-${stage}`;
    const timeline = await (0, audioAnalysis_1.analyzeSongToTimeline)(song.filePath, songId, stage, song.durationSec);
    roomManager_1.roomManager.beginStage(roomId, stage, timeline, stageEndHandler);
    broadcastRoomList();
}
wss.on("connection", (socket) => {
    // 클라이언트 접속 시 현재 방 목록 전송
    socket.send(JSON.stringify({ type: "room_list_update", rooms: roomManager_1.roomManager.getRoomList() }));
    socket.on("message", async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            return;
        }
        try {
            switch (msg.type) {
                case "create_room": {
                    const { room, playerId } = roomManager_1.roomManager.createRoom(socket, msg.nickname || "Player");
                    socket.send(JSON.stringify({ type: "joined", roomId: room.id, playerId }));
                    roomManager_1.roomManager.broadcastRoomState(room.id);
                    broadcastRoomList();
                    break;
                }
                case "join_room": {
                    const result = roomManager_1.roomManager.joinRoom(msg.roomId, socket, msg.nickname || "Player");
                    if ("error" in result) {
                        socket.send(JSON.stringify({ type: "error", message: result.error }));
                        return;
                    }
                    socket.send(JSON.stringify({ type: "joined", roomId: result.room.id, playerId: result.playerId }));
                    roomManager_1.roomManager.broadcastRoomState(result.room.id);
                    broadcastRoomList();
                    break;
                }
                case "set_song": {
                    roomManager_1.roomManager.setSong(msg.roomId, msg.playerId, msg.slot, msg.song);
                    break;
                }
                case "kick": {
                    roomManager_1.roomManager.kick(msg.roomId, msg.playerId, msg.targetId);
                    broadcastRoomList();
                    break;
                }
                case "transfer_host": {
                    roomManager_1.roomManager.transferHost(msg.roomId, msg.playerId, msg.targetId);
                    broadcastRoomList();
                    break;
                }
                case "input_pos": {
                    roomManager_1.roomManager.updatePosition(msg.roomId, msg.playerId, msg.x, msg.y);
                    break;
                }
                case "hit": {
                    roomManager_1.roomManager.handleHit(msg.roomId, msg.playerId, (roomId) => {
                        roomManager_1.roomManager.markAllFailed(roomId);
                        broadcastRoomList();
                    });
                    break;
                }
                case "revive_request": {
                    roomManager_1.roomManager.handleRevive(msg.roomId, msg.playerId, msg.targetId);
                    break;
                }
                case "start_game": {
                    const runtime = roomManager_1.roomManager.getRoom(msg.roomId);
                    if (!runtime || runtime.state.hostId !== msg.playerId)
                        return;
                    if (!roomManager_1.roomManager.canStart(runtime.state)) {
                        socket.send(JSON.stringify({ type: "error", message: "3개 스테이지의 노래를 모두 확인해야 시작할 수 있습니다." }));
                        return;
                    }
                    await startStageWithAnalysis(msg.roomId, 1);
                    break;
                }
                case "restart_stage": {
                    roomManager_1.roomManager.restartStage(msg.roomId, msg.playerId, stageEndHandler);
                    broadcastRoomList();
                    break;
                }
                case "advance_stage": {
                    // stage_clear 화면에서 호스트가 다음 스테이지로 진행
                    const runtime = roomManager_1.roomManager.getRoom(msg.roomId);
                    if (!runtime || runtime.state.hostId !== msg.playerId || runtime.state.phase !== "stage_clear")
                        return;
                    await startStageWithAnalysis(msg.roomId, runtime.state.stage + 1);
                    break;
                }
                case "give_up": {
                    roomManager_1.roomManager.giveUp(msg.roomId, msg.playerId);
                    broadcastRoomList();
                    break;
                }
                default:
                    break;
            }
        }
        catch (err) {
            console.error("메시지 처리 오류:", err);
            socket.send(JSON.stringify({ type: "error", message: "서버 오류가 발생했습니다." }));
        }
    });
    socket.on("close", () => {
        const found = roomManager_1.roomManager.findRoomIdBySocket(socket);
        if (found) {
            roomManager_1.roomManager.removePlayer(found.roomId, found.playerId);
            broadcastRoomList();
        }
    });
});
server.listen(PORT, '0.0.0.0', () => {
    console.log(`리듬 게임 서버가 http://0.0.0.0:${PORT} 에서 실행 중입니다. (외부 접속 허용)`);
});
