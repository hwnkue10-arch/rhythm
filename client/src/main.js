import { Network } from "./network.js";
import { Game } from "./game.js";

const screens = {
  landing: document.getElementById("screen-landing"),
  lobby: document.getElementById("screen-lobby"),
  game: document.getElementById("screen-game"),
  result: document.getElementById("screen-result"),
};
function showScreen(name) {
  for (const k in screens) screens[k].classList.toggle("hidden", k !== name);
}

const net = new Network();
let roomState = null;
let game = null;

// ---------- 랜딩 ----------
document.getElementById("btn-create").addEventListener("click", async () => {
  await net.ready();
  net.send("create_room", { nickname: nicknameOrDefault() });
});

function nicknameOrDefault() {
  const v = document.getElementById("nickname").value.trim();
  return v || `player${Math.floor(Math.random() * 1000)}`;
}

net.on("room_list_update", (msg) => {
  renderRoomList(msg.rooms || []);
});

function renderRoomList(rooms) {
  const container = document.getElementById("roomList");
  if (!container) return;
  container.innerHTML = "";

  if (rooms.length === 0) {
    container.innerHTML = `<p style="color: #888; font-size: 14px;">현재 생성된 방이 없습니다.</p>`;
    return;
  }

  for (const r of rooms) {
    const card = document.createElement("div");
    card.className = "room-card";
    card.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      margin-bottom: 8px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      cursor: ${r.isPlaying || r.playerCount >= r.maxPlayers ? "not-allowed" : "pointer"};
      opacity: ${r.isPlaying || r.playerCount >= r.maxPlayers ? "0.6" : "1"};
      border: 1px solid rgba(255, 255, 255, 0.15);
      transition: background 0.2s;
    `;

    const statusText = r.isPlaying
      ? "게임 진행 중"
      : r.playerCount >= r.maxPlayers
        ? "인원 초과"
        : "입장 가능";

    card.innerHTML = `
      <div>
        <div style="font-weight: bold; font-size: 15px;">${escapeHtml(r.hostNickname)}의 방</div>
        <div style="font-size: 12px; color: #aaa;">ID: ${r.id} | 인원: ${r.playerCount}/${r.maxPlayers}</div>
      </div>
      <div style="font-size: 13px; font-weight: 600; color: ${r.isPlaying ? '#ff6b6b' : r.playerCount >= r.maxPlayers ? '#f59f00' : '#51cf66'};">
        ${statusText}
      </div>
    `;

    if (!r.isPlaying && r.playerCount < r.maxPlayers) {
      card.addEventListener("mouseenter", () => {
        card.style.background = "rgba(255, 255, 255, 0.18)";
      });
      card.addEventListener("mouseleave", () => {
        card.style.background = "rgba(255, 255, 255, 0.08)";
      });
      card.addEventListener("click", async () => {
        await net.ready();
        net.joinRoom(r.id, nicknameOrDefault());
      });
    }

    container.appendChild(card);
  }
}

net.on("error", (msg) => {
  document.getElementById("landing-error").textContent = msg.message;
  document.getElementById("lobby-error").textContent = msg.message;
});
net.on("kicked", () => {
  alert("방장에 의해 추방되었습니다.");
  location.reload();
});

// ---------- 방 상태 동기화 ----------
net.on("room_state", (msg) => {
  roomState = msg.room;
  if (game) game.roomState = roomState;
  if (roomState.phase === "lobby") {
    renderLobby();
    showScreen("lobby");
  }
});

function renderLobby() {
  document.getElementById("room-code-display").textContent = roomState.id;
  const isHost = roomState.hostId === net.playerId;

  const list = document.getElementById("player-list");
  list.innerHTML = "";
  for (const p of Object.values(roomState.players)) {
    const chip = document.createElement("div");
    chip.className = "player-chip";
    const isMeHost = roomState.hostId === p.id;
    chip.innerHTML = `<span class="dot" style="background:${p.color}"></span>${p.nickname}${isMeHost ? " (방장)" : ""}`;
    if (isHost && p.id !== net.playerId) {
      const kickBtn = document.createElement("button");
      kickBtn.textContent = "추방";
      kickBtn.className = "secondary";
      kickBtn.onclick = () => net.send("kick", { targetId: p.id });
      chip.appendChild(kickBtn);
      const hostBtn = document.createElement("button");
      hostBtn.textContent = "방장 위임";
      hostBtn.className = "secondary";
      hostBtn.onclick = () => net.send("transfer_host", { targetId: p.id });
      chip.appendChild(hostBtn);
    }
    list.appendChild(chip);
  }

  const slotsEl = document.getElementById("song-slots");
  slotsEl.innerHTML = "";
  roomState.songs.forEach((song) => {
    slotsEl.appendChild(renderSongSlot(song, isHost));
  });

  document.getElementById("btn-start").disabled = !(isHost && roomState.songs.every((s) => s.verified));
  document.getElementById("btn-start").classList.toggle("hidden", !isHost);
}

function renderSongSlot(song, isHost) {
  const div = document.createElement("div");
  div.className = "song-slot";
  const status = song.verified
    ? `<span class="status">확인됨: ${song.title}</span>`
    : `<span class="status unset">아직 노래가 설정되지 않았습니다</span>`;
  div.innerHTML = `<h3>스테이지 ${song.slot}</h3>${status}`;

  if (song.verified && song.fullDurationSec) {
    const durRow = document.createElement("div");
    durRow.className = "duration-row";
    const label = document.createElement("span");
    label.textContent = `재생 길이: ${song.durationSec}초`;
    durRow.appendChild(label);
    if (isHost) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "15";
      slider.max = String(song.fullDurationSec);
      slider.value = String(song.durationSec);
      slider.addEventListener("input", () => {
        label.textContent = `재생 길이: ${slider.value}초`;
      });
      slider.addEventListener("change", () => {
        net.send("set_song", { slot: song.slot, song: { ...song, durationSec: Number(slider.value) } });
      });
      durRow.appendChild(slider);
    }
    div.appendChild(durRow);
  }

  if (!isHost) return div;

  const controls = document.createElement("div");

  const fileRow = document.createElement("div");
  fileRow.className = "row";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "audio/mp3,audio/mpeg";
  fileRow.appendChild(fileInput);
  const uploadBtn = document.createElement("button");
  uploadBtn.textContent = "mp3 업로드";
  uploadBtn.onclick = () => handleUpload(song.slot, fileInput.files[0]);
  fileRow.appendChild(uploadBtn);
  controls.appendChild(fileRow);

  const ytRow = document.createElement("div");
  ytRow.className = "row";
  const ytInput = document.createElement("input");
  ytInput.type = "text";
  ytInput.placeholder = "유튜브 링크 붙여넣기";
  ytRow.appendChild(ytInput);
  const checkBtn = document.createElement("button");
  checkBtn.textContent = "확인";
  checkBtn.onclick = () => handleYoutubeCheck(song.slot, ytInput.value.trim(), div);
  ytRow.appendChild(checkBtn);
  controls.appendChild(ytRow);

  div.appendChild(controls);
  return div;
}

const DEFAULT_CAP_SEC = 120;

async function handleUpload(slot, file) {
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload-song", { method: "POST", body: form });
  const data = await res.json();
  if (data.error) {
    document.getElementById("lobby-error").textContent = data.error;
    return;
  }
  // 재생 길이는 브라우저에서 직접 측정
  const tmpAudio = new Audio(data.publicUrl);
  tmpAudio.addEventListener("loadedmetadata", () => {
    const fullDurationSec = Math.round(tmpAudio.duration);
    net.send("set_song", {
      slot,
      song: {
        sourceType: "upload",
        title: data.title,
        filePath: data.filePath,
        publicUrl: data.publicUrl,
        fullDurationSec,
        durationSec: Math.min(fullDurationSec, DEFAULT_CAP_SEC),
        verified: true,
      },
    });
  });
}

async function handleYoutubeCheck(slot, url, slotDiv) {
  if (!url) return;
  const res = await fetch("/api/youtube-meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const meta = await res.json();
  if (meta.error) {
    document.getElementById("lobby-error").textContent = meta.error;
    return;
  }
  // 확인 절차: 제목/썸네일을 보여주고 맞는지 확인받는다.
  const confirmBox = document.createElement("div");
  confirmBox.innerHTML = `<p>이 노래가 맞나요? <b>${escapeHtml(meta.title)}</b> (${meta.durationSec}초)</p>`;
  const yesBtn = document.createElement("button");
  yesBtn.textContent = "맞습니다, 사용하기";
  yesBtn.onclick = async () => {
    yesBtn.disabled = true;
    yesBtn.textContent = "오디오 추출 중...";
    const dl = await fetch("/api/youtube-download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).then((r) => r.json());
    if (dl.error) {
      document.getElementById("lobby-error").textContent = dl.error;
      return;
    }
    net.send("set_song", {
      slot,
      song: {
        sourceType: "youtube",
        title: dl.title,
        filePath: dl.filePath,
        publicUrl: dl.publicUrl,
        fullDurationSec: dl.fullDurationSec,
        durationSec: Math.min(dl.fullDurationSec, DEFAULT_CAP_SEC),
        verified: true,
      },
    });
    confirmBox.remove();
  };
  confirmBox.appendChild(yesBtn);
  slotDiv.appendChild(confirmBox);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("btn-start").addEventListener("click", () => net.send("start_game"));

// ---------- 게임 진행 ----------
net.on("stage_start", (msg) => {
  showScreen("game");
  if (!game) {
    game = new Game(net, document.getElementById("game-canvas"), document.getElementById("song-audio"), roomState);
  }
  game.roomState = roomState;
  game.startStage(msg.stage, msg.songUrl, msg.timeline, msg.serverStartTime, msg.themeId);
});

net.on("life_update", (msg) => {
  const p = roomState?.players[msg.id];
  if (!p) return;
  const prevLives = p.lives;
  p.lives = msg.lives;
  p.dead = msg.dead;
  p.invulnerableUntil = msg.invulnerableUntil || 0;
  if (p.dead && !p.diedAt) p.diedAt = Date.now();
  if (!p.dead) p.diedAt = null;

  // 내 캐릭터의 목숨이 감소했을 때 화면 피격 FX 트리거
  if (msg.id === net.playerId && msg.lives < prevLives && game) {
    game.triggerHitFX();
  }
});

net.on("player_revived", (msg) => {
  const p = roomState?.players[msg.id];
  if (!p) return;
  p.dead = false;
  p.lives = msg.lives;
  p.diedAt = null;
  // 부활 직후 1.8초 무적 시간 반영
  p.invulnerableUntil = msg.invulnerableUntil || (Date.now() + 1800);
  if (msg.id === net.playerId && game) {
    game.localInvulnerableUntil = (performance.now() / 1000) + 1.8;
  }
  if (typeof msg.x === "number") p.x = msg.x;
  if (typeof msg.y === "number") p.y = msg.y;
});

net.on("player_moved", (msg) => {
  const p = roomState?.players[msg.id];
  if (!p) return;
  p.x = msg.x;
  p.y = msg.y;
});

net.on("player_removed", (msg) => {
  if (!roomState) return;
  delete roomState.players[msg.id];
});

document.getElementById("volume-slider").addEventListener("input", (e) => {
  const audio = document.getElementById("song-audio");
  audio.volume = e.target.value / 100;
});

// ---------- 스테이지 결과 ----------
net.on("stage_clear", (msg) => {
  if (game) game.stopStage();
  showResult(
    "STAGE CLEAR!",
    msg.nextStage <= 3 ? `스테이지를 완벽하게 돌파했습니다!` : "",
    { next: true, stats: msg.stats, nextStage: msg.nextStage }
  );
});
net.on("stage_failed", () => {
  if (game) game.stopStage();
  showResult("STAGE FAILED", "전원이 쓰러졌습니다. 이 스테이지를 다시 시작할 수 있습니다.", { restart: true });
});
net.on("game_clear", (msg) => {
  if (game) game.stopStage();
  showResult("ALL STAGES CLEAR!", "모든 스테이지를 클리어했습니다. 축하합니다!", { stats: msg.stats });
});

function showResult(title, desc, { next, restart, stats, nextStage } = {}) {
  showScreen("result");
  document.getElementById("result-title").textContent = title;
  document.getElementById("result-desc").textContent = desc;

  // 통계 테이블 렌더링
  const statsContainer = document.getElementById("result-stats-container");
  statsContainer.innerHTML = "";

  if (stats && Object.keys(stats).length > 0) {
    const table = document.createElement("table");
    table.className = "stats-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>플레이어</th>
          <th>피격 횟수</th>
          <th>죽은 횟수</th>
          <th>살린 횟수</th>
        </tr>
      </thead>
      <tbody>
        ${Object.values(stats)
        .map(
          (p) => `
          <tr>
            <td><span class="dot" style="background:${p.color}"></span><b>${escapeHtml(p.nickname)}</b></td>
            <td><span class="stat-badge hit">${p.hitCount}회</span></td>
            <td><span class="stat-badge death">${p.deathCount}회</span></td>
            <td><span class="stat-badge revive">${p.reviveCount}회</span></td>
          </tr>`
        )
        .join("")}
      </tbody>
    `;
    statsContainer.appendChild(table);
  }

  const isHost = roomState?.hostId === net.playerId;
  const nextBtn = document.getElementById("btn-next-stage");
  const restartBtn = document.getElementById("btn-restart");
  const giveUpBtn = document.getElementById("btn-giveup");
  const waitMsg = document.getElementById("result-wait-msg");

  // 방장에게만 모든 액션 버튼(다음 스테이지, 재시작, 처음으로) 노출
  if (isHost) {
    nextBtn.classList.toggle("hidden", !next);
    restartBtn.classList.toggle("hidden", !restart);
    giveUpBtn.classList.remove("hidden");
    waitMsg.classList.add("hidden");
  } else {
    // 일반 팀원에게는 버튼을 숨기고 '방장의 선택을 기다리는 중...' 표시
    nextBtn.classList.add("hidden");
    restartBtn.classList.add("hidden");
    giveUpBtn.classList.add("hidden");
    waitMsg.classList.remove("hidden");
  }
}

document.getElementById("btn-next-stage").addEventListener("click", () => net.send("advance_stage"));
document.getElementById("btn-restart").addEventListener("click", () => net.send("restart_stage"));
document.getElementById("btn-giveup").addEventListener("click", () => {
  net.send("give_up");
  showScreen("lobby");
});

// ---------- 방 나가기 기능 ----------
function handleLeaveRoom() {
  if (game) game.stopStage();
  net.leaveRoom();
  roomState = null;
  showScreen("landing");
}

const leaveLobbyBtn = document.getElementById("btn-leave-lobby");
if (leaveLobbyBtn) leaveLobbyBtn.addEventListener("click", handleLeaveRoom);

const leaveGameBtn = document.getElementById("btn-leave-game");
if (leaveGameBtn) leaveGameBtn.addEventListener("click", handleLeaveRoom);

net.on("left_room", () => {
  if (game) game.stopStage();
  roomState = null;
  showScreen("landing");
});

// ---------- 새로고침 세션 자동 복원 (Reconnect) ----------
window.addEventListener("DOMContentLoaded", async () => {
  await net.ready();
  const reconnected = net.tryReconnect();
  if (!reconnected) {
    showScreen("landing");
  }
});
