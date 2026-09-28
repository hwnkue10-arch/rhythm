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
    try { sessionStorage.removeItem("last_result_stats"); } catch (_) {}
    lastResultStats = null;
    renderLobby();
    showScreen("lobby");
    return;
  }

  if (roomState.phase === "playing") {
    showScreen("game");
    if (!game) {
      game = new Game(net, document.getElementById("game-canvas"), document.getElementById("song-audio"), roomState);
      setControlMode(currentControlMode);
    }
    game.roomState = roomState;
    renderInGamePlayers();
    return;
  }

  if (roomState.phase === "game_clear") {
    if (game) game.stopStage();
    const stats = roomState.lastStats || buildStatsFromPlayers(roomState.players);
    showResult("ALL STAGES CLEAR!", "모든 스테이지를 클리어했습니다. 축하합니다!", { stats });
    return;
  }

  if (roomState.phase === "stage_clear") {
    if (game) game.stopStage();
    const stats = roomState.lastStats || buildStatsFromPlayers(roomState.players);
    showResult("STAGE CLEAR!", "스테이지를 완벽하게 돌파했습니다!", { next: true, nextStage: roomState.stage + 1, stats });
    return;
  }

  if (roomState.phase === "stage_failed") {
    if (game) game.stopStage();
    const stats = roomState.lastStats || buildStatsFromPlayers(roomState.players);
    showResult("STAGE FAILED", "전원이 쓰러졌습니다. 이 스테이지를 다시 시작할 수 있습니다.", { restart: true, stats });
    return;
  }
});

function buildStatsFromPlayers(players) {
  if (!players) return null;
  const result = {};
  for (const p of Object.values(players)) {
    result[p.id] = {
      nickname: p.nickname,
      color: p.color,
      hitCount: p.stats?.hitCount || 0,
      deathCount: p.stats?.deathCount || 0,
      reviveCount: p.stats?.reviveCount || 0,
      totalHitCount: p.totalStats?.hitCount ?? p.stats?.hitCount ?? 0,
      totalDeathCount: p.totalStats?.deathCount ?? p.stats?.deathCount ?? 0,
      totalReviveCount: p.totalStats?.reviveCount ?? p.stats?.reviveCount ?? 0,
    };
  }
  return result;
}

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

function renderInGamePlayers() {
  const list = document.getElementById("ingame-player-list");
  if (!list || !roomState) return;
  list.innerHTML = "";
  for (const p of Object.values(roomState.players)) {
    const row = document.createElement("div");
    row.className = `ingame-player-row${p.dead ? " dead" : ""}`;

    const dot = document.createElement("span");
    dot.className = "ingame-player-dot";
    dot.style.background = p.color;

    const name = document.createElement("span");
    name.className = "ingame-player-name";
    name.textContent = p.nickname;
    if (p.id === net.playerId) {
      name.title = `${p.nickname} (나)`;
    }

    const status = document.createElement("div");
    status.className = "ingame-player-status";

    const lives = p.dead ? 0 : Math.max(0, p.lives ?? 0);
    const hearts = Array.from({ length: 3 })
      .map((_, i) => `<span class="player-heart ${i < lives ? "alive" : "lost"}">❤</span>`)
      .join("");

    if (p.dead) {
      status.innerHTML = `<span class="player-hearts">${hearts}</span> <span class="player-down-badge">DOWN</span>`;
    } else {
      status.innerHTML = `<span class="player-hearts">${hearts}</span>`;
    }

    row.append(dot, name, status);
    list.appendChild(row);
  }
}

function renderSongSlot(song, isHost) {
  const div = document.createElement("div");
  div.className = "song-slot";
  const isDefault = Boolean(song.isDefault);
  const status = song.verified
    ? isDefault
      ? `<span class="status" style="color: #06b6d4; font-weight: 700; background: rgba(6, 182, 212, 0.15); padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(6, 182, 212, 0.4); font-size: 12px;">기본곡</span>`
      : `<span class="status" style="font-size: 13px;">확인됨: ${escapeHtml(song.title)}</span>`
    : `<span class="status unset" style="font-size: 12px;">아직 노래가 설정되지 않았습니다</span>`;

  div.innerHTML = `
    <div class="song-slot-header">
      <div class="song-slot-title-group">
        <h3>스테이지 ${song.slot}</h3>
        ${status}
      </div>
    </div>
  `;

  if (song.verified && song.fullDurationSec) {
    const durRow = document.createElement("div");
    durRow.className = "duration-row";
    const label = document.createElement("span");

    if (isDefault) {
      // 기본곡은 전체 곡 길이로 고정 (슬라이더 제외, '전체 재생'으로만 표기)
      label.textContent = "재생 길이: 전체 재생";
      label.style.color = "#a5f3fc";
      label.style.fontWeight = "600";
      durRow.appendChild(label);
    } else {
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
          net.send("set_song", { slot: song.slot, song: { ...song, durationSec: Number(slider.value), isDefault: false } });
        });
        durRow.appendChild(slider);
      }
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
  checkBtn.onclick = () => handleYoutubeCheck(song.slot, ytInput.value.trim(), div, checkBtn);
  ytRow.appendChild(checkBtn);
  controls.appendChild(ytRow);

  const defaultRow = document.createElement("div");
  defaultRow.className = "row";
  defaultRow.style.marginTop = "6px";
  const defaultBtn = document.createElement("button");
  defaultBtn.textContent = "기본곡 적용";
  defaultBtn.className = "secondary";
  defaultBtn.style.fontSize = "12px";
  defaultBtn.onclick = () => net.send("reset_default_song", { roomId: roomState.id, playerId: net.playerId, slot: song.slot });
  defaultRow.appendChild(defaultBtn);
  controls.appendChild(defaultRow);

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
        isDefault: false,
      },
    });
  });
}

async function handleYoutubeCheck(slot, url, slotDiv, checkBtn) {
  if (!url) return;
  if (checkBtn) {
    checkBtn.disabled = true;
    checkBtn.textContent = "조회 중...";
  }
  document.getElementById("lobby-error").textContent = "";

  try {
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

    // 기존에 열려 있는 확인창이 있다면 제거
    const oldConfirm = slotDiv.querySelector(".youtube-confirm-box");
    if (oldConfirm) oldConfirm.remove();

    // 확인 절차: 제목/썸네일을 보여주고 맞는지 확인받는다.
    const confirmBox = document.createElement("div");
    confirmBox.className = "youtube-confirm-box";
    confirmBox.innerHTML = `<p style="margin-top: 8px;">이 노래가 맞나요? <b>${escapeHtml(meta.title)}</b> (${meta.durationSec}초)</p>`;
    const yesBtn = document.createElement("button");
    yesBtn.textContent = "맞습니다, 사용하기";
    yesBtn.onclick = async () => {
      yesBtn.disabled = true;
      yesBtn.textContent = "오디오 추출 중...";
      try {
        const dl = await fetch("/api/youtube-download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        }).then((r) => r.json());
        if (dl.error) {
          document.getElementById("lobby-error").textContent = dl.error;
          yesBtn.disabled = false;
          yesBtn.textContent = "맞습니다, 사용하기";
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
            isDefault: false,
          },
        });
        confirmBox.remove();
      } catch (err) {
        document.getElementById("lobby-error").textContent = "오디오 다운로드 실패: " + (err?.message || err);
        yesBtn.disabled = false;
        yesBtn.textContent = "맞습니다, 사용하기";
      }
    };
    confirmBox.appendChild(yesBtn);
    slotDiv.appendChild(confirmBox);
  } catch (err) {
    document.getElementById("lobby-error").textContent = "유튜브 정보 조회 실패: " + (err?.message || err);
  } finally {
    if (checkBtn) {
      checkBtn.disabled = false;
      checkBtn.textContent = "확인";
    }
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("btn-start").addEventListener("click", () => net.send("start_game"));

// ---------- 게임 진행 ----------
net.on("stage_start", (msg) => {
  try { sessionStorage.removeItem("last_result_stats"); } catch (_) {}
  lastResultStats = null;
  showScreen("game");
  if (!game) {
    game = new Game(net, document.getElementById("game-canvas"), document.getElementById("song-audio"), roomState);
    setControlMode(currentControlMode); // UI 상태와 게임 객체의 조작 모드 동기화
  }
  game.roomState = roomState;
  renderInGamePlayers();
  game.startStage(msg.stage, msg.songUrl, msg.timeline, msg.serverStartTime, msg.themeId);
});

net.on("life_update", (msg) => {
  const p = roomState?.players[msg.id];
  if (!p) return;
  const prevLives = p.lives;
  p.lives = msg.lives;
  p.dead = msg.dead;
  p.invulnerableUntil = msg.invulnerableUntil || 0;
  if (msg.lastHitAt) {
    p.lastHitAt = msg.lastHitAt;
  } else if (msg.lives < prevLives) {
    p.lastHitAt = Date.now();
  }
  if (p.dead && !p.diedAt) p.diedAt = Date.now();
  if (!p.dead) p.diedAt = null;
  renderInGamePlayers();

  // 내 캐릭터의 목숨이 변경되었을 때 처리
  if (msg.id === net.playerId && game) {
    if (msg.lastHitAt) game.localLastHitAt = msg.lastHitAt;
    if (msg.lives < prevLives) {
      game.triggerHitFX();
    } else if (msg.lives > prevLives) {
      game.triggerHealFX(); // 체력 회복 효과
    }
    if (msg.invulnerableDurationMs || msg.invulnerableUntil) {
      const invulnDurSec = msg.invulnerableDurationMs
        ? msg.invulnerableDurationMs / 1000
        : Math.min(1.6, Math.max(0, (msg.invulnerableUntil - net.now()) / 1000));
      game.localInvulnerableUntil = Math.max(game.localInvulnerableUntil, (performance.now() / 1000) + invulnDurSec);
    }
  }
});

net.on("player_revived", (msg) => {
  const p = roomState?.players[msg.id];
  if (!p) return;
  p.dead = false;
  p.lives = msg.lives;
  p.diedAt = null;
  // 부활 직후 1.8초 무적 시간 반영 (서버 동기화 시간 기준)
  p.invulnerableUntil = msg.invulnerableUntil || (net.now() + 1800);
  if (msg.id === net.playerId && game) {
    const reviveDurSec = msg.invulnerableDurationMs ? msg.invulnerableDurationMs / 1000 : 1.8;
    game.localInvulnerableUntil = Math.max(game.localInvulnerableUntil, (performance.now() / 1000) + reviveDurSec);
  }
  if (typeof msg.x === "number") p.x = msg.x;
  if (typeof msg.y === "number") p.y = msg.y;
  renderInGamePlayers();
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
  renderInGamePlayers();
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
net.on("stage_failed", (msg) => {
  if (game) game.stopStage();
  showResult("STAGE FAILED", "전원이 쓰러졌습니다. 이 스테이지를 다시 시작할 수 있습니다.", { restart: true, stats: msg?.stats });
});
net.on("game_clear", (msg) => {
  if (game) game.stopStage();
  showResult("ALL STAGES CLEAR!", "모든 스테이지를 클리어했습니다. 축하합니다!", { stats: msg.stats });
});

let lastResultStats = null;

function showResult(title, desc, { next, restart, stats, nextStage } = {}) {
  showScreen("result");
  document.getElementById("result-title").textContent = title;
  document.getElementById("result-desc").textContent = desc;

  // 통계 데이터 캐싱 및 복원
  if (stats && Object.keys(stats).length > 0) {
    lastResultStats = stats;
    try {
      sessionStorage.setItem("last_result_stats", JSON.stringify(stats));
    } catch (_) {}
  } else if (!stats) {
    if (lastResultStats) {
      stats = lastResultStats;
    } else {
      try {
        const saved = sessionStorage.getItem("last_result_stats");
        if (saved) stats = JSON.parse(saved);
      } catch (_) {}
    }
  }

  // 통계 테이블 렌더링
  const statsContainer = document.getElementById("result-stats-container");
  statsContainer.innerHTML = "";

  if (stats && Object.keys(stats).length > 0) {
    const table = document.createElement("table");
    table.className = "stats-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th class="section-end">플레이어</th>
          <th>피격 횟수</th>
          <th class="cum-header section-end">누적</th>
          <th>죽은 횟수</th>
          <th class="cum-header section-end">누적</th>
          <th>살린 횟수</th>
          <th class="cum-header">누적</th>
        </tr>
      </thead>
      <tbody>
        ${Object.values(stats)
        .map(
          (p) => `
          <tr>
            <td class="section-end"><span class="dot" style="background:${p.color}"></span><b>${escapeHtml(p.nickname)}</b></td>
            <td><span class="stat-badge hit">${p.hitCount}회</span></td>
            <td class="section-end"><span class="stat-badge hit">${p.totalHitCount ?? p.hitCount}회</span></td>
            <td><span class="stat-badge death">${p.deathCount}회</span></td>
            <td class="section-end"><span class="stat-badge death">${p.totalDeathCount ?? p.deathCount}회</span></td>
            <td><span class="stat-badge revive">${p.reviveCount}회</span></td>
            <td><span class="stat-badge revive">${p.totalReviveCount ?? p.reviveCount}회</span></td>
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
  try { sessionStorage.removeItem("last_result_stats"); } catch (_) {}
  lastResultStats = null;
  net.send("give_up");
  showScreen("lobby");
});

// ---------- 방 나가기 기능 ----------
function handleLeaveRoom() {
  if (game) game.stopStage();
  net.leaveRoom(); // 서버에 퇴장 요청 전송
  // 클라이언트 세션을 완전 초기화 후 즉시 새로고침
  window.location.reload();
}

const leaveLobbyBtn = document.getElementById("btn-leave-lobby");
if (leaveLobbyBtn) leaveLobbyBtn.addEventListener("click", handleLeaveRoom);

const leaveGameBtn = document.getElementById("btn-leave-game");
if (leaveGameBtn) leaveGameBtn.addEventListener("click", handleLeaveRoom);

// ---------- 조작 모드 전환 UI (좌우 슬라이드 단추) ----------
let currentControlMode = "KEYBOARD";

function setControlMode(mode) {
  currentControlMode = mode;
  const switchEl = document.getElementById("mode-sliding-switch");
  const btnKeyboard = document.getElementById("tab-mode-keyboard");
  const btnMouse = document.getElementById("tab-mode-mouse");

  if (switchEl) switchEl.setAttribute("data-mode", mode);
  if (btnKeyboard) {
    btnKeyboard.classList.toggle("active", mode === "KEYBOARD");
    btnKeyboard.setAttribute("aria-checked", String(mode === "KEYBOARD"));
  }
  if (btnMouse) {
    btnMouse.classList.toggle("active", mode === "MOUSE");
    btnMouse.setAttribute("aria-checked", String(mode === "MOUSE"));
  }

  document.getElementById("controls-keyboard")?.classList.toggle("hidden", mode !== "KEYBOARD");
  document.getElementById("controls-mouse")?.classList.toggle("hidden", mode !== "MOUSE");

  if (game) {
    game.setControlMode(mode);
  }
}

document.getElementById("tab-mode-keyboard")?.addEventListener("click", (e) => {
  e.stopPropagation();
  setControlMode("KEYBOARD");
});

document.getElementById("tab-mode-mouse")?.addEventListener("click", (e) => {
  e.stopPropagation();
  setControlMode("MOUSE");
});

document.getElementById("mode-sliding-switch")?.addEventListener("click", () => {
  const nextMode = currentControlMode === "KEYBOARD" ? "MOUSE" : "KEYBOARD";
  setControlMode(nextMode);
});

net.on("left_room", () => {
  // 서버가 left_room을 응답하면 새로고침 (handleLeaveRoom이 이미 reload하므로 fallback 용도)
  window.location.reload();
});

net.on("reconnect_failed", () => {
  net.clearSession();
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
