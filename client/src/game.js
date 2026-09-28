import { renderObstacle, checkCollision, isEventVisible } from "./obstacles.js";
import { themeRegistry } from "./themes/ThemeRegistry.js";

// --- 조작 속도 및 모드 설정 ---
const SPEED = {
  base: 0.63,              // 기본 이동 속도 (원래 수치 0.63)
  shiftMult: 0.6,          // Shift 정밀 이동 배율
  dashMaxDist: 0.37,       // 최대 대시 거리 (공통 최대 사거리)
  keyboardDashSpeed: 1.35, // 키보드 대시 속도 (홀드 조작감 유지)
  mouseDashSpeed: 1.35,    // 마우스 대시 속도를 키보드 대시 속도에 맞춤
};
const DASH_COOLDOWN = 0.1;  // 대시 쿨다운 (0.1초)
const PLAYER_RADIUS = 0.011; // 캐릭터 크기
const DEATH_FADE_SEC = 0.7;  // 0.7초 동안 다운 연출
const TRAIL_LIFETIME = 0.32;
const REVIVE_WINDOW_SEC = 4.0; // 부활 제한 시간 4초
const REVIVE_INVULN_SEC = 1.8; // 부활 직후 1.8초 무적

export class Game {
  constructor(net, canvas, audioEl, roomState) {
    this.net = net;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.audioEl = audioEl;
    this.roomState = roomState;

    this.keys = new Set();
    this.isDashing = false;
    this.dashStartTime = 0;
    this.dashCooldownUntil = 0;
    this.dashDir = { x: 0, y: 0 };
    this.dashDistTraveled = 0;  // 이번 대시에서 이동한 총 거리
    this.dashTargetDist = SPEED.dashMaxDist; // 이번 대시 목표 이동 거리
    this.baseDashSpeed = SPEED.keyboardDashSpeed;
    this.currentDashSpeed = SPEED.keyboardDashSpeed;
    this.localInvulnerableUntil = 0;
    this.consumedHitEvents = new Set();
    this._facing = -Math.PI / 2; // 마지막으로 바라본 방향 (대시에 사용)
    this.localLastHitAt = 0; // 마지막 피격 시점 (자동 회복 10초 타이머용)

    // 피격/회복 FX
    this.damageFlashTimer = 0;
    this.healFlashTimer = 0;
    this.screenShakeTimer = 0;
    this.shakeIntensity = 0;

    this.timeline = null;
    this.stage = 1;
    this.serverStartTime = 0;
    this.currentTheme = themeRegistry.get("neon_pulse");
    this.beatIntensity = 0; // 0.0 ~ 1.0 (비트 강도)
    this.lastReviveSendTime = 0;

    this.running = false;
    this._lastFrameTime = 0;
    this._lastCollisionCheckElapsed = null;
    this._lastBgTickTime = 0;
    this.controlMode = "KEYBOARD"; // "KEYBOARD" | "MOUSE"
    this.mouseX = 0.5;
    this.mouseY = 0.5;
    this.mouseInCanvas = false;

    this.anim = new Map(); // playerId -> { facing, trail:[], dashParticles:[], deathT, wasDead, prevX, prevY }
    this.logoShatterParticles = [];
    this.logoShatterShockwave = null;
    this._logoShattered = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._loop = this._loop.bind(this);

    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    this.canvas.addEventListener("mousemove", this._onMouseMove);
    this.canvas.addEventListener("mouseleave", this._onMouseLeave);
    this.canvas.addEventListener("mousedown", this._onMouseDown);

    // 창 최소화(내림) / 백그라운드 탭 전환 시에도 물리 및 피격 판정을 유지하기 위한 백그라운드 워커
    this._bgWorker = null;
    try {
      const workerCode = `
        let timer = null;
        self.onmessage = function(e) {
          if (e.data === 'start') {
            if (!timer) timer = setInterval(() => self.postMessage('tick'), 40);
          } else if (e.data === 'stop') {
            if (timer) { clearInterval(timer); timer = null; }
          }
        };
      `;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      this._bgWorker = new Worker(URL.createObjectURL(blob));
      this._bgWorker.onmessage = () => {
        if (this.running && document.hidden) {
          const nowTs = performance.now();
          const dt = Math.min(0.1, (nowTs - (this._lastBgTickTime || nowTs)) / 1000);
          this._lastBgTickTime = nowTs;
          this._lastFrameTime = nowTs;
          this._update(dt || 0.04);
        }
      };
    } catch (_) {
      this._bgWorker = null;
    }

    this._onVisibilityChange = () => {
      if (document.hidden) {
        this._lastBgTickTime = performance.now();
      } else {
        this._lastFrameTime = performance.now();
      }
    };
    document.addEventListener("visibilitychange", this._onVisibilityChange);
  }

  destroy() {
    this.running = false;
    if (this._bgWorker) {
      try {
        this._bgWorker.postMessage("stop");
        this._bgWorker.terminate();
      } catch (_) { }
      this._bgWorker = null;
    }
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    this.canvas.removeEventListener("mousemove", this._onMouseMove);
    this.canvas.removeEventListener("mouseleave", this._onMouseLeave);
    this.canvas.removeEventListener("mousedown", this._onMouseDown);
  }

  setControlMode(mode) {
    this.controlMode = mode;
    this.keys.clear();
    if (this.isDashing) {
      this._stopDash();
    }

    // 마우스 모드일 때는 기본 커서를 숨기고 커스텀 렌더링으로 처리
    this.canvas.style.cursor = mode === "MOUSE" ? "none" : "default";
  }

  _tryDash(now, isMouseMode = false) {
    if (now < this.dashCooldownUntil || this.isDashing) return;
    const me = this.roomState?.players[this.net.playerId];
    if (me && !me.dead) {
      let dir = { x: 0, y: 0 };
      const targetDist = SPEED.dashMaxDist;

      // Shift 키 누름 여부에 따라 대시 속도 비율 감속 (최종 이동 거리는 동일)
      const isShift = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      const speedMult = isShift ? SPEED.shiftMult : 1;
      this.baseDashSpeed = isMouseMode ? SPEED.mouseDashSpeed : SPEED.keyboardDashSpeed;
      const dashSpeed = this.baseDashSpeed * speedMult;

      if (isMouseMode) {
        // 마우스 클릭 위치 방향으로 대시
        const dx = (this.mouseX - me.x) * this.canvas.width;
        const dy = (this.mouseY - me.y) * this.canvas.height;
        const pxDist = Math.hypot(dx, dy);

        if (pxDist < 5) {
          dir = { x: Math.cos(this._facing), y: Math.sin(this._facing) };
        } else {
          dir = { x: dx / pxDist, y: dy / pxDist };
        }
      } else {
        const inputDir = this._inputDirection();
        if (inputDir.x !== 0 || inputDir.y !== 0) {
          dir = inputDir;
        } else {
          dir = { x: Math.cos(this._facing), y: Math.sin(this._facing) };
        }
      }

      this.isDashing = true;
      this.dashStartTime = now;
      this.dashDistTraveled = 0;
      this.dashTargetDist = targetDist;
      this.currentDashSpeed = dashSpeed;
      this.dashDir = dir;
      this._facing = Math.atan2(dir.y, dir.x);

      // 대시 중 무적 보장 (Shift 감속 시에도 전체 대시 시간을 넉넉히 커버)
      this.localInvulnerableUntil = now + (targetDist / (this.baseDashSpeed * SPEED.shiftMult)) + 0.05;
      this._spawnDashParticles(me, dir);
    }
  }

  _onKeyDown(e) {
    if (e.code === "Space") {
      e.preventDefault();
      const now = performance.now() / 1000;
      if (!this.keys.has("Space")) {
        if (this.controlMode === "KEYBOARD") {
          this._tryDash(now, false);
        }
      }
    }
    this.keys.add(e.code);
  }

  _onKeyUp(e) {
    if (e.code === "Space") {
      if (this.controlMode === "KEYBOARD") {
        // 키보드 모드: 스페이스를 떼면 대시 즉시 정지 (누르고 있던 시간만큼만 이동)
        this._stopDash();
      }
    }
    this.keys.delete(e.code);
  }

  _onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = (e.clientX - rect.left) / rect.width;
    this.mouseY = (e.clientY - rect.top) / rect.height;
    this.mouseInCanvas = true;
  }

  _onMouseLeave() {
    this.mouseInCanvas = false;
  }

  _onMouseDown(e) {
    if (this.controlMode !== "MOUSE" || e.button !== 0 || !this.mouseInCanvas) return;
    e.preventDefault();
    this._tryDash(performance.now() / 1000, true);
  }

  _stopDash() {
    if (!this.isDashing) return;
    const now = performance.now() / 1000;
    this.isDashing = false;
    this.dashCooldownUntil = now + DASH_COOLDOWN; // 0.1초 쿨다운 시작
    // 대시 종료 직후 무적을 0.02초로 축소하여 광클 시 무적 악용 차단
    this.localInvulnerableUntil = now + 0.05;
  }

  _spawnDashParticles(me, dir) {
    const anim = this._getAnim(me.id);
    for (let i = 0; i < 14; i++) {
      const a = Math.atan2(-dir.y, -dir.x) + (Math.random() - 0.5) * 1.2;
      const spd = 0.3 + Math.random() * 0.45;
      anim.dashParticles.push({
        x: me.x,
        y: me.y,
        vx: Math.cos(a) * spd,
        vy: Math.sin(a) * spd,
        life: 0.35,
        age: 0,
        size: 0.007 + Math.random() * 0.008,
        rot: Math.random() * Math.PI * 2,
      });
    }
  }

  _spawnLogoShatterParticles(W, H) {
    this.logoShatterParticles = [];
    const cx = W / 2;
    const cy = H / 2;

    // 강력한 화면 흔들림 효과 연동 (드랍 임팩트와 동기화)
    this.screenShakeTimer = Math.max(this.screenShakeTimer, 0.35);
    this.shakeIntensity = Math.max(this.shakeIntensity, 16);

    // 충격파 링 생성
    this.logoShatterShockwave = {
      cx,
      cy,
      age: 0,
      maxLife: 0.6,
      maxRadius: Math.max(W, H) * 1.1,
    };

    // 렉 방지 및 가벼운 렌더링을 위해 파티클 수를 45개로 적정화
    const particleCount = 45;
    const maxDim = Math.max(W, H);

    for (let i = 0; i < particleCount; i++) {
      // 텍스트 영역(중심부) 주변에서 시작 위치 분산
      const offsetX = (Math.random() - 0.5) * (W * 0.38);
      const offsetY = (Math.random() - 0.5) * (H * 0.22);
      const px = cx + offsetX;
      const py = cy + offsetY;

      // 중심점으로부터 외곽으로 방사형 폭발 각도 + 분산
      const baseAngle = Math.atan2(py - cy, px - cx);
      const angle = (Math.hypot(offsetX, offsetY) < 10)
        ? Math.random() * Math.PI * 2
        : baseAngle + (Math.random() - 0.5) * 0.8;

      // 맵 밖으로 시원하게 퍼져나가도록 높은 사출 속도 부여 (초당 800px ~ 2200px)
      const speed = maxDim * (0.8 + Math.random() * 1.0);
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;

      // 파편 형태 (0: 삼각형 파편, 1: 날카로운 바늘 파편, 2: 코어 스파크)
      const randType = Math.random();
      const type = randType < 0.6 ? "triangle" : (randType < 0.85 ? "needle" : "spark");

      // 색상: 마젠타, 시안, 화이트 코어
      const randColor = Math.random();
      let color;
      if (randColor < 0.45) {
        color = "#ff007f";
      } else if (randColor < 0.85) {
        color = "#00f0ff";
      } else {
        color = "#ffffff";
      }

      const size = type === "spark"
        ? Math.random() * 4 + 3
        : (type === "needle" ? Math.random() * 12 + 10 : Math.random() * 16 + 10);

      this.logoShatterParticles.push({
        x: px,
        y: py,
        vx,
        vy,
        drag: 0.982 + Math.random() * 0.008,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * (8 + Math.random() * 10),
        life: 1.1 + Math.random() * 0.6,
        age: 0,
        type,
        color,
        size,
      });
    }
  }

  _drawLogoShatterParticles(ctx, W, H) {
    ctx.save();

    // 1. 충격파 링 연출 (shadowBlur 제거로 렉 없는 순수 벡터 스트로크)
    if (this.logoShatterShockwave) {
      const sw = this.logoShatterShockwave;
      const progress = Math.min(1, sw.age / sw.maxLife);
      const ringAlpha = Math.max(0, (1 - progress) ** 1.8);
      const curRadius = sw.maxRadius * (progress ** 0.65);

      // 시안 외곽 링
      ctx.beginPath();
      ctx.arc(sw.cx, sw.cy, curRadius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0, 240, 255, ${ringAlpha * 0.85})`;
      ctx.lineWidth = Math.max(1, (1 - progress) * 6);
      ctx.stroke();

      // 마젠타 내부 링
      if (curRadius * 0.85 > 0) {
        ctx.beginPath();
        ctx.arc(sw.cx, sw.cy, curRadius * 0.85, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 0, 127, ${ringAlpha * 0.75})`;
        ctx.lineWidth = Math.max(1, (1 - progress) * 4);
        ctx.stroke();
      }
    }

    // 2. 사출 파편 파티클 렌더링 (블렌드 모드로 가볍고 선명한 네온 발광 구현)
    ctx.globalCompositeOperation = "lighter";

    for (const pt of this.logoShatterParticles) {
      // 화면 밖으로 멀리 벗어난 파티클은 렌더링 건너뜀 (컬링)
      if (pt.x < -100 || pt.x > W + 100 || pt.y < -100 || pt.y > H + 100) continue;

      const prog = Math.min(1, pt.age / pt.life);
      const alpha = Math.max(0, Math.min(1, 1 - Math.pow(prog, 1.6)));
      if (alpha <= 0.01) continue;

      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pt.rot);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = pt.color;

      if (pt.type === "triangle") {
        ctx.beginPath();
        ctx.moveTo(0, -pt.size);
        ctx.lineTo(pt.size * 0.75, pt.size * 0.75);
        ctx.lineTo(-pt.size * 0.75, pt.size * 0.75);
        ctx.closePath();
        ctx.fill();
      } else if (pt.type === "needle") {
        ctx.beginPath();
        ctx.moveTo(0, -pt.size * 1.3);
        ctx.lineTo(pt.size * 0.3, 0);
        ctx.lineTo(0, pt.size * 1.3);
        ctx.lineTo(-pt.size * 0.3, 0);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, pt.size * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    ctx.restore();
  }

  triggerHitFX() {
    // 화면 흔들림(screenShake) 및 붉은 비넷 플래시 효과 제거 - 깔끔한 UI 유지
    // (damageFlashTimer, screenShakeTimer 미사용)
  }

  triggerHealFX() {
    this.healFlashTimer = 0.5; // 0.5초 동안 초록색 치유 효과
  }

  _inputDirection() {
    let x = 0, y = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) x -= 1;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) x += 1;
    if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) y -= 1;
    if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) y += 1;
    const len = Math.hypot(x, y);
    if (len > 0) { x /= len; y /= len; }
    return { x, y };
  }

  _screenUnit() {
    return Math.min(this.canvas.width || 1, this.canvas.height || 1);
  }

  _moveByScreenDistance(player, dir, distance) {
    const unit = this._screenUnit();
    player.x += (dir.x * distance * unit) / (this.canvas.width || unit);
    player.y += (dir.y * distance * unit) / (this.canvas.height || unit);
  }

  _getAnim(id) {
    if (!this.anim.has(id)) {
      this.anim.set(id, {
        facing: -Math.PI / 2,
        trail: [],
        dashParticles: [],
        deathT: null,
        wasDead: false,
        prevX: null,
        prevY: null,
      });
    }
    return this.anim.get(id);
  }

  startStage(stage, songUrl, timeline, serverStartTime, themeId) {
    this.stage = stage;
    this.timeline = timeline;
    this.serverStartTime = serverStartTime;
    this.stageStartPerfNow = performance.now() - (this.net.now() - serverStartTime);
    const tid = themeId || (timeline && timeline.themeId) || "neon_pulse";
    this.currentTheme = themeRegistry.get(tid);
    if (this.currentTheme && this.currentTheme.setTimeline) {
      this.currentTheme.setTimeline(timeline);
    }

    // 구체에서 발사되는 킥 충격파(shockwave with side)의 중심 좌표를
    // 발사 순간(ev.t)의 실제 구체 오브젝트 위치로 정확하게 동기화
    if (this.timeline?.events) {
      for (const ev of this.timeline.events) {
        if (ev.type === "shockwave" && ev.params?.side) {
          const orbsAtT = this.getGrooveOrbs(ev.t);
          if (orbsAtT) {
            const orb = ev.params.side === "left" ? orbsAtT.left : orbsAtT.right;
            if (orb) {
              ev.params.x = orb.x;
              ev.params.y = orb.y;
            }
          }
        }
      }
    }

    this.dashCooldownUntil = 0;
    this.isDashing = false;
    this.dashDistTraveled = 0;
    this.localInvulnerableUntil = 0;
    this.consumedHitEvents = new Set();
    this.localLastHitAt = serverStartTime || Date.now();
    this.beatIntensity = 0;
    this.lastReviveSendTime = 0;
    this.anim.clear();
    this.logoShatterParticles = [];
    this.logoShatterShockwave = null;
    this._logoShattered = false;

    const fullSongUrl = new URL(songUrl, window.location.href).href;
    if (this.audioEl.src !== fullSongUrl) {
      this.audioEl.src = songUrl;
    }
    this.audioEl.volume = (document.getElementById("volume-slider")?.value || 70) / 100;

    clearTimeout(this._audioStopTimer);
    clearTimeout(this._audioStartTimer);

    this._audioSessionId = (this._audioSessionId || 0) + 1;
    const currentSession = this._audioSessionId;

    const playAudioAt = (targetSec) => {
      if (currentSession !== this._audioSessionId) return;
      const duration = this.timeline?.durationSec || 9999;
      const clampedSec = Math.max(0, Math.min(duration, targetSec));

      const enforceSync = () => {
        try {
          if (Math.abs(this.audioEl.currentTime - clampedSec) > 0.3) {
            this.audioEl.currentTime = clampedSec;
          }
        } catch (err) {
          console.warn("[Audio] currentTime 설정 실패:", err);
        }
      };

      enforceSync();
      this.audioEl.play().then(() => {
        // 재생 시작 직후 다시 동기화 강제 (Chrome 버그로 인해 0초부터 재생되는 현상 방지)
        enforceSync();
      }).catch((err) => {
        console.warn("[Audio] 자동 재생 차단 또는 실패 감지:", err);
        const resumeOnInteract = () => {
          window.removeEventListener("pointerdown", resumeOnInteract);
          window.removeEventListener("keydown", resumeOnInteract);
          if (this.running && currentSession === this._audioSessionId) {
            const currentSec = this.stageElapsed();
            if (currentSec >= 0 && currentSec < duration) {
              try { this.audioEl.currentTime = currentSec; } catch (_) { }
              this.audioEl.play().catch(() => { });
            }
          }
        };
        window.addEventListener("pointerdown", resumeOnInteract, { once: true });
        window.addEventListener("keydown", resumeOnInteract, { once: true });
      });
    };

    const delay = serverStartTime - this.net.now();
    const duration = timeline?.durationSec || 0;

    if (delay > 0) {
      // 1. 신규 스테이지 카운트다운/대기 상태 (0초부터 시작)
      this.audioEl.pause();
      try { this.audioEl.currentTime = 0; } catch (_) { }
      this._updateProgress(0);

      this._audioStartTimer = setTimeout(() => {
        if (currentSession === this._audioSessionId) {
          playAudioAt(0);
        }
      }, delay);

      this._audioStopTimer = setTimeout(() => {
        if (currentSession === this._audioSessionId) {
          this.audioEl.pause();
        }
      }, delay + duration * 1000 + 50);

      const me = this.roomState.players[this.net.playerId];
      if (me) { me.x = 0.5; me.y = 0.85; }
    } else {
      // 2. 이미 게임이 진행 중인 상태에서 진입 (새로고침 / 재접속)
      const elapsed = -delay / 1000;
      this._updateProgress(Math.max(0, elapsed));

      const me = this.roomState.players[this.net.playerId];
      if (me && (typeof me.x !== "number" || typeof me.y !== "number")) {
        me.x = 0.5;
        me.y = 0.85;
      }

      if (elapsed < duration) {
        if (this.audioEl.readyState >= 1) { // HAVE_METADATA 이상
          playAudioAt(elapsed);
        } else {
          // 메타데이터 로딩 중일 때는 로드 완료 시점의 최신 경과 시간으로 재생
          this.audioEl.addEventListener("loadedmetadata", () => {
            if (currentSession === this._audioSessionId) {
              const freshElapsed = this.stageElapsed();
              if (freshElapsed < duration) {
                playAudioAt(Math.max(0, freshElapsed));
              }
            }
          }, { once: true });
        }

        const remainingMs = (duration - elapsed) * 1000 + 50;
        this._audioStopTimer = setTimeout(() => {
          if (currentSession === this._audioSessionId) {
            this.audioEl.pause();
          }
        }, Math.max(0, remainingMs));
      } else {
        // 이미 노래 재생 시간이 종료된 경우
        this.audioEl.pause();
        try { this.audioEl.currentTime = duration; } catch (_) { }
      }
    }

    if (!this.running) {
      this.running = true;
      this._lastFrameTime = performance.now();
      this._lastCollisionCheckElapsed = null;
      if (this._bgWorker) this._bgWorker.postMessage("start");
      requestAnimationFrame(this._loop);
    }
  }

  stopStage() {
    this.running = false;
    if (this._bgWorker) this._bgWorker.postMessage("stop");
    this._audioSessionId = (this._audioSessionId || 0) + 1;
    clearTimeout(this._audioStopTimer);
    clearTimeout(this._audioStartTimer);
    this.audioEl.pause();
  }

  stageElapsed() {
    if (this.stageStartPerfNow != null) {
      const perfElapsed = (performance.now() - this.stageStartPerfNow) / 1000;
      const netElapsed = (this.net.now() - this.serverStartTime) / 1000;
      if (Math.abs(perfElapsed - netElapsed) > 0.08) {
        this.stageStartPerfNow = performance.now() - netElapsed * 1000;
        return netElapsed;
      }
      return perfElapsed;
    }
    return (this.net.now() - this.serverStartTime) / 1000;
  }

  _formatTime(sec) {
    const safe = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(safe / 60);
    const s = String(safe % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  _loop(ts) {
    if (!this.running) return;
    const dt = Math.min(0.05, (ts - this._lastFrameTime) / 1000 || 1 / 60);
    this._lastFrameTime = ts;
    this._update(dt);
    this._render();
    requestAnimationFrame(this._loop);
  }

  _update(dt) {
    const me = this.roomState.players[this.net.playerId];
    const now = performance.now() / 1000;

    // 스크린 셰이크 & 대미지/치유 플래시 타이머 감소
    if (this.damageFlashTimer > 0) this.damageFlashTimer = Math.max(0, this.damageFlashTimer - dt);
    if (this.healFlashTimer > 0) this.healFlashTimer = Math.max(0, this.healFlashTimer - dt);
    if (this.screenShakeTimer > 0) this.screenShakeTimer = Math.max(0, this.screenShakeTimer - dt);

    if (me && !me.dead) {
      // 1. 이동 및 대시 처리
      if (this.isDashing) {
        let reachedMouse = false;

        if (this.controlMode === "MOUSE") {
          // 마우스 모드: 대시 도중 마우스 위치를 실시간 추적하여 대시 방향 전환
          const dx = (this.mouseX - me.x) * this.canvas.width;
          const dy = (this.mouseY - me.y) * this.canvas.height;
          const pxDist = Math.hypot(dx, dy);
          if (pxDist <= 5) {
            reachedMouse = true;
          } else {
            this.dashDir = { x: dx / pxDist, y: dy / pxDist };
            this._facing = Math.atan2(dy, dx);
          }
        } else {
          // 키보드 모드: 대시 도중 WASD 8방향 실시간 전환
          const inputDir = this._inputDirection();
          if (inputDir.x !== 0 || inputDir.y !== 0) {
            this.dashDir = inputDir;
            this._facing = Math.atan2(inputDir.y, inputDir.x);
          }
        }

        // Shift 키를 누르면 이동 속도와 동일한 비율(SPEED.shiftMult)로 대시 속도 감속 (최종 이동 거리는 dashMaxDist로 동일)
        const isShift = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
        const speedMult = isShift ? SPEED.shiftMult : 1;
        const currentSpeed = (this.baseDashSpeed || SPEED.keyboardDashSpeed) * speedMult;
        this.currentDashSpeed = currentSpeed;

        const remaining = this.dashTargetDist - this.dashDistTraveled;
        let step = Math.min(currentSpeed * dt, remaining);

        // 마우스 모드: 대시 중 마우스 위치까지 도달하면 즉시 대시 종료
        if (this.controlMode === "MOUSE" && !reachedMouse) {
          const dx = (this.mouseX - me.x) * this.canvas.width;
          const dy = (this.mouseY - me.y) * this.canvas.height;
          const pxDist = Math.hypot(dx, dy);
          const unit = this._screenUnit();
          const distToMouse = pxDist / unit;
          if (step >= distToMouse) {
            step = distToMouse;
            reachedMouse = true;
          }
        }

        this._moveByScreenDistance(me, this.dashDir, step);
        this.dashDistTraveled += step;

        if (reachedMouse || this.dashDistTraveled >= this.dashTargetDist) {
          this._stopDash();
        }
      } else {
        const dir = this._inputDirection();
        if (this.controlMode === "MOUSE" && this.mouseInCanvas) {
          const dx = (this.mouseX - me.x) * this.canvas.width;
          const dy = (this.mouseY - me.y) * this.canvas.height;
          if (Math.hypot(dx, dy) > 0.001) {
            this._facing = Math.atan2(dy, dx);
          }
        } else if (dir.x !== 0 || dir.y !== 0) {
          this._facing = Math.atan2(dir.y, dir.x);
        }
        const speed = SPEED.base * (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? SPEED.shiftMult : 1);
        this._moveByScreenDistance(me, dir, speed * dt);
      }
      me.x = Math.max(0.02, Math.min(0.98, me.x));
      me.y = Math.max(0.02, Math.min(0.98, me.y));

      // 2. 살아있는 플레이어끼리 부드러운 분리 척력 (완전 겹침 방지)
      for (const p of Object.values(this.roomState.players)) {
        if (p.id === me.id || p.dead) continue;
        const dx = me.x - p.x;
        const dy = me.y - p.y;
        const dist = Math.hypot(dx, dy);
        const minDist = PLAYER_RADIUS * 2.2;
        if (dist < minDist && dist > 0.0001) {
          const push = (minDist - dist) * 0.4;
          me.x += (dx / dist) * push;
          me.y += (dy / dist) * push;
        }
      }

      this.net.send("input_pos", { x: me.x, y: me.y });

      // 3. 쓰러진 팀원 부활 상호작용 (사망 후 0.7초 경과 및 0.5초 스로틀링 적용)
      for (const p of Object.values(this.roomState.players)) {
        if (p.id === me.id || !p.dead) continue;
        const dist = Math.hypot(me.x - p.x, me.y - p.y);
        if (dist < 0.06 && now - this.lastReviveSendTime > 0.5) {
          if (p.diedAt && Date.now() - p.diedAt >= 700) {
            this.net.send("revive_request", { targetId: p.id });
            this.lastReviveSendTime = now;
          }
        }
      }

      // 4. 기믹 장애물 피격 판정 (관리자 모드 및 대시 중에는 완전 무적)
      if (this.timeline && !this.isDashing && now > this.localInvulnerableUntil && me.nickname !== "관리자") {
        const elapsed = this.stageElapsed();
        let hit = false;
        let hitEvent = null;

        // 소급 충돌 판정 (Catch-up check): 탭 전환이나 프레임 지연 시 건너뛴 시간 분할 검사
        const lastCheck = this._lastCollisionCheckElapsed ?? (elapsed - dt);
        this._lastCollisionCheckElapsed = elapsed;
        const timeDiff = elapsed - lastCheck;
        const steps = (timeDiff > 0.07 && timeDiff < 3.0) ? Math.min(8, Math.ceil(timeDiff / 0.04)) : 1;

        for (let s = 1; s <= steps; s++) {
          const checkElapsed = lastCheck + (timeDiff * s) / steps;
          const orbs = this.getGrooveOrbs(checkElapsed);
          for (const ev of this.timeline.events) {
            if (ev.t > checkElapsed + 1.5) break;
            if (this.consumedHitEvents && this.consumedHitEvents.has(ev)) continue;
            const local = checkElapsed - ev.t;
            if (!isEventVisible(ev, local)) continue;
            if (checkCollision(me, ev, local, orbs)) {
              hit = true;
              hitEvent = ev;
              break;
            }
          }
          if (hit) break;

          // 4-B. 현재 테마 고유 엔티티 및 기믹 충돌 검사 (M/C 구체, 궤도 위험영역, 드랍 십자 레이저 등)
          if (this.currentTheme?.checkCollision && this.currentTheme.checkCollision(me, checkElapsed, this.canvas)) {
            hit = true;
            break;
          }

        }

        if (hit) {
          if (hitEvent && this.consumedHitEvents) {
            this.consumedHitEvents.add(hitEvent);
          }
          this.localLastHitAt = Date.now();
          if (me) me.lastHitAt = Date.now();
          this.net.send("hit", {});
          this.localInvulnerableUntil = Math.max(this.localInvulnerableUntil, now + 1.6); // 1.6초 무적 부여
          this.triggerHitFX();
        }
      }

      // 4-C. 인트로 및 브레이크 페이즈 전용: 멜로디 탄환이 시작될 때 랜덤 플레이어를 조준(Lock-on)
      if (this.timeline && this.timeline.events) {
        const elapsed = this.stageElapsed();
        const pInfo = this.currentTheme?.getPhaseInfo
          ? this.currentTheme.getPhaseInfo(elapsed, this.timeline)
          : null;
        const currentPhase = pInfo?.currentPhase || "groove";

        // 그루브 구간(groove)은 음의 높낮이에 따라 고정되므로, 인트로 및 브레이크에서만 플레이어 락온 조준
        if (currentPhase === "intro" || currentPhase === "break") {
          const living = Object.values(this.roomState.players).filter((p) => !p.dead);
          if (living.length > 0) {
            living.sort((a, b) => a.id.localeCompare(b.id));

            for (const ev of this.timeline.events) {
              if (ev.type !== "melody_bolt") continue;
              const local = elapsed - ev.t;
              const warnDur = ev.warnDuration || 0.75;

              // 경고 시작 시점에 대상 플레이어의 위치를 목적지로 락온 (캐릭터 이동 가능 전체 범위 0.06 ~ 0.94 커버)
              if (local >= -warnDur && local < 0.2) {
                if (!ev._playerAimLocked) {
                  ev._playerAimLocked = true;
                  const pIdx = Math.floor(Math.abs(ev.t * 137.5)) % living.length;
                  const target = living[pIdx];
                  if (target) {
                    // 캐릭터가 천장(0.02)이나 바닥(0.98) 끝에 붙어 있어도 정중앙으로 유도 조준 (0.01 ~ 0.99)
                    ev.params.y = Math.max(0.01, Math.min(0.99, target.y));
                    ev.params.targetX = Math.max(0.15, Math.min(0.85, target.x));
                    // 왼쪽(0.0)과 오른쪽(1.0)에서 50% 확률로 랜덤하게 발사
                    const fromLeft = ev.params.startX === 0.0 || (typeof ev.params.startX !== "number" && Math.sin(ev.t * 3141.59 + 71.3) > 0);
                    ev.params.startX = fromLeft ? 0.0 : 1.0;
                    const activeDur = ev.activeDuration || 0.45;
                    ev.params.speed = (Math.abs(ev.params.targetX - ev.params.startX) / activeDur) * 0.85;
                  }
                }
              } else if (local < -warnDur) {
                ev._playerAimLocked = false;
              }
            }
          }
        }
      }
    }

    // 5. 비트 펄스 강도 갱신 (음악 타임라인의 모든 세분화된 박자 beats와 연동)
    if (this.timeline) {
      const elapsed = this.stageElapsed();
      if (this.timeline.beats && this.timeline.beats.length > 0) {
        for (const b of this.timeline.beats) {
          const diff = elapsed - b.t;
          if (diff >= 0 && diff < 0.07) {
            // 모든 비트의 강약에 따라 펄스 유발 (최대 1.0)
            const pulse = Math.min(1.0, (b.energy || 0.6) * 1.35);
            this.beatIntensity = Math.max(this.beatIntensity, pulse);
          }
        }
      } else if (this.timeline.events) {
        for (const ev of this.timeline.events) {
          const local = elapsed - ev.t;
          if (local >= 0 && local < 0.08) {
            this.beatIntensity = Math.max(this.beatIntensity, ev.energy || 0.85);
          }
        }
      }
    }
    // 지오메트리 대쉬 감성의 비트 감쇠
    this.beatIntensity = Math.max(0, this.beatIntensity - dt * 2.5);

    // 6. 플레이어 연출 상태 갱신
    for (const p of Object.values(this.roomState.players)) {
      const anim = this._getAnim(p.id);
      if (anim.prevX !== null) {
        const dx = p.x - anim.prevX, dy = p.y - anim.prevY;
        if (Math.hypot(dx, dy) > 0.0008) {
          anim.facing = Math.atan2(dy * this.canvas.height, dx * this.canvas.width);
          // 내 캐릭터의 facing을 대시용으로도 추적
          if (p.id === this.net.playerId) this._facing = anim.facing;
        }
      }
      if (p.id === this.net.playerId && this.controlMode === "MOUSE" && this.mouseInCanvas) {
        anim.facing = this._facing;
      }
      anim.prevX = p.x; anim.prevY = p.y;

      if (!p.dead) {
        anim.trail.push({ x: p.x, y: p.y, age: 0 });
      }
      anim.trail = anim.trail.filter((t) => (t.age += dt) < TRAIL_LIFETIME);

      if (p.dead && !anim.wasDead) anim.deathT = 0;
      if (!p.dead) anim.deathT = null;
      if (anim.deathT !== null) anim.deathT += dt;
      anim.wasDead = p.dead;

      anim.dashParticles = anim.dashParticles.filter((pt) => {
        pt.age += dt;
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.vx *= 0.92; pt.vy *= 0.92;
        return pt.age < pt.life;
      });
    }

    // 네온 펄스 로고 폭발 파티클 물리 갱신
    if (this.logoShatterParticles.length > 0) {
      this.logoShatterParticles = this.logoShatterParticles.filter((pt) => {
        pt.age += dt;
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.rot += pt.vrot * dt;
        pt.vx *= pt.drag;
        pt.vy *= pt.drag;
        return pt.age < pt.life;
      });
    }

    if (this.logoShatterShockwave) {
      this.logoShatterShockwave.age += dt;
      if (this.logoShatterShockwave.age >= this.logoShatterShockwave.maxLife) {
        this.logoShatterShockwave = null;
      }
    }

    // 7. 오디오 싱크 밀림 보정 (백그라운드 탭 전환 또는 브라우저 지연 복구)
    if (this.audioEl && !this.audioEl.paused && !this.audioEl.seeking && this.timeline) {
      const elapsed = this.stageElapsed();
      if (elapsed >= 0 && elapsed < (this.timeline.durationSec || 9999)) {
        const diff = Math.abs(this.audioEl.currentTime - elapsed);
        if (diff > 0.3 && this.audioEl.readyState >= 1) {
          try {
            this.audioEl.currentTime = elapsed;
          } catch (_) { }
        }
      }
    }
  }

  _render() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.save();

    // 1. 스크린 셰이크 적용 (피격 시 흔들림)
    if (this.screenShakeTimer > 0) {
      const shakeRatio = this.screenShakeTimer / 0.3;
      const ox = (Math.random() - 0.5) * this.shakeIntensity * shakeRatio;
      const oy = (Math.random() - 0.5) * this.shakeIntensity * shakeRatio;
      ctx.translate(ox, oy);
    }

    const elapsed = this.stageElapsed();
    const pInfo = this.currentTheme && this.currentTheme.getPhaseInfo
      ? this.currentTheme.getPhaseInfo(elapsed, this.timeline)
      : null;
    const currentPhase = pInfo?.currentPhase || "groove";

    // 지오메트리 대쉬 스타일 비트 줌 펄스 (빌드 및 드랍 페이즈에서만 발동)
    const canZoom = currentPhase === "build_1" || currentPhase === "build_2" || currentPhase === "drop";
    if (canZoom && this.beatIntensity > 0.01) {
      const scale = 1.0 + Math.min(0.045, this.beatIntensity * 0.042);
      ctx.translate(W / 2, H / 2);
      ctx.scale(scale, scale);
      ctx.translate(-W / 2, -H / 2);
    }

    // 1. 테마별 배경 렌더링 (타임라인 페이즈 및 3초 전 보간 연계)
    this.currentTheme.renderBackground(ctx, W, H, this.beatIntensity, elapsed, this.timeline);

    // 1-B. 테마 고유 엔티티 및 기믹 렌더링 (구체, 궤도 위험영역, M-C 레이저, 보스 등)
    if (this.currentTheme?.renderEntities) {
      this.currentTheme.renderEntities(ctx, W, H, elapsed, this.beatIntensity);
    }

    // 2. JS&B 스타일 기믹 장애물 (경고선 & 비트 발동)
    if (this.timeline) {
      for (const ev of this.timeline.events) {
        if (ev.t > elapsed + 1.5) break;
        const local = elapsed - ev.t;
        if (!isEventVisible(ev, local)) continue;
        renderObstacle(ctx, ev, local, this.currentTheme, W, H);
      }
    }

    // 3. 플레이어 렌더링
    for (const p of Object.values(this.roomState.players)) {
      this._drawPlayer(p, W, H);
    }

    // 4. 지오메트리 대쉬 스타일 비트 네온 블룸(빛 번짐) 오버레이
    this.currentTheme.renderBloom(ctx, W, H, this.beatIntensity, elapsed, this.timeline);

    // 5-A. 피격 및 회복 플래시 FX
    if (this.damageFlashTimer > 0) {
      const flashAlpha = Math.min(0.7, (this.damageFlashTimer / 0.35) * 0.7);
      const vigGrad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
      vigGrad.addColorStop(0, "rgba(255, 0, 0, 0)");
      vigGrad.addColorStop(1, `rgba(239, 68, 68, ${flashAlpha})`);
      ctx.fillStyle = vigGrad;
      ctx.fillRect(0, 0, W, H);
    }

    if (this.healFlashTimer > 0) {
      const flashAlpha = Math.min(0.5, (this.healFlashTimer / 0.5) * 0.5);
      const vigGrad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
      vigGrad.addColorStop(0, "rgba(0, 255, 0, 0)");
      vigGrad.addColorStop(1, `rgba(34, 197, 94, ${flashAlpha})`); // Tailwind-style green
      ctx.fillStyle = vigGrad;
      ctx.fillRect(0, 0, W, H);
    }

    // 5-B. 캐릭터와 패턴을 모두 덮는 인트로 암전 페이드인 연출 (향후 연출 확장 지원)
    let introEndTime = 31;
    if (this.timeline && this.timeline.phases) {
      const introSeg = this.timeline.phases.find((p) => p.phase === "intro");
      if (introSeg) introEndTime = introSeg.endTime;
    }

    let blackAlpha = 0;
    if (elapsed < introEndTime) {
      const introProg = Math.max(0, Math.min(1, elapsed / introEndTime));
      blackAlpha = 1.0 - introProg;
    }

    if (currentPhase !== "build_2" && currentPhase !== "drop") {
      this._logoShattered = false;
    }

    // 첫 드랍 돌입 시 만약 프레임 스킵 등으로 로고 파티클이 아직 사출되지 않았다면 드랍 시작 순간 즉시 방출
    if (currentPhase === "drop" && !this._logoShattered) {
      const firstDropSeg = this.timeline?.phases?.find((p) => p.phase === "drop");
      if (firstDropSeg && Math.abs(elapsed - firstDropSeg.startTime) < 0.5) {
        this._spawnLogoShatterParticles(W, H);
        this._logoShattered = true;
      }
    }

    // build_2 페이즈: 드랍 직전 텐션 고조를 위해 화면이 점점 어두워지고 깜빡이는 연출 추가
    let isInFirstPreDrop = false;
    let preDropProgress = 0;

    if (currentPhase === "build_2" && pInfo?.currentSegment) {
      const seg = pInfo.currentSegment;
      const preDropGap = seg.preDropGapDuration || 0;
      const preDropStartTime = seg.endTime - preDropGap;
      const hasPreDrop = preDropGap >= 0.4;
      // 첫 번째 드랍 세그먼트 직전인지 판별
      const firstDropSeg = this.timeline?.phases?.find((p) => p.phase === "drop");
      const isLeadingToFirstDrop =
        firstDropSeg &&
        pInfo.nextSegment &&
        Math.abs(pInfo.nextSegment.startTime - firstDropSeg.startTime) < 0.1;

      // 심볼 연출은 프리드랍이 최소 1.2초 이상으로 넉넉할 때만 발동 (1.2초 미만은 깔끔한 화면 암전 침묵만 유지)
      const canShowFilamentSymbol = isLeadingToFirstDrop && preDropGap >= 1.2;

      if (hasPreDrop && elapsed >= preDropStartTime) {
        // 프리-드랍 쉬는 구간 돌입: 화면 완전 암전!
        blackAlpha = 1.0;
        if (canShowFilamentSymbol) {
          isInFirstPreDrop = true;
          preDropProgress = Math.max(0, Math.min(1, (elapsed - preDropStartTime) / preDropGap));
        }
      } else {
        // 프리 드랍 쉼 구간 시작 전까지의 빌드업 어두워짐 연출 (깜빡임 없이 매끄럽게 어두워짐)
        const effectiveEnd = hasPreDrop ? preDropStartTime : seg.endTime;
        const dur = effectiveEnd - seg.startTime;
        if (dur > 0) {
          const prog = Math.max(0, Math.min(1, (elapsed - seg.startTime) / dur));
          // 프레임 드랍처럼 보이는 스트로보(깜빡임)를 제거하고, 매끄러운 지수 곡선으로 점진적 암전 (0% -> 95%)
          const build2Alpha = Math.min(1.0, Math.pow(prog, 1.4) * 0.95);
          blackAlpha = Math.max(blackAlpha, build2Alpha);
        }
      }
    }
    if (typeof this.screenBlackoutAlpha === "number") {
      blackAlpha = Math.max(blackAlpha, this.screenBlackoutAlpha);
    }

    if (blackAlpha > 0.001) {
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(1.0, blackAlpha)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // 5-C. 첫 드랍 직전 쉬는 구간(Pre-drop Gap) 특수 연출 "Neon Pulse" (개선된 하드 엣지 듀얼톤 시퀀스)
    if (isInFirstPreDrop) {
      const t = preDropProgress; // 0.0 ~ 1.0 정규화된 트리거 시간
      
      ctx.save();
      
      // Phase 0: 화면 전체 렌더링을 차단하고 딥 블랙 배경(#000000 ~ #050508)만 활성화
      const bgGray = Math.floor(t * 8); // 0 ~ 8
      ctx.fillStyle = `rgb(${bgGray}, ${bgGray}, ${Math.floor(bgGray * 1.5)})`; 
      ctx.fillRect(0, 0, W, H);
      
      // 미세한 유기적 와이어 및 회로 패턴 매핑 (암도 대비 #0A0A12)
      ctx.strokeStyle = "#0a0a12";
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      for (let d = -H; d < W * 2; d += 60) {
        ctx.moveTo(d, 0);
        ctx.lineTo(d - H, H);
      }
      ctx.stroke();

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      
      // 트랜스폼 및 뷰포트 상태 초기화
      const cx = W / 2;
      const cy = H / 2;
      let scale = 1.0;
      let shakeX = 0;
      let shakeY = 0;
      let isShattered = false;
      let isInvert = false;

      // Phase 2: Resonance & Core Glow (0.55 ~ 0.85)
      // 단일 그룹 결합 후 리드미컬 팽창/수축, 카메라 쉐이크
      if (t >= 0.55 && t < 0.85) {
        const p2 = (t - 0.55) / 0.30; // 0.0 ~ 1.0
        // sin 파형 기반 1.00 -> 1.08 -> 1.00
        scale = 1.0 + Math.sin(p2 * Math.PI) * 0.08;
        // 저주파 럼블 카메라 쉐이크 (진폭 1.5px)
        shakeX = (Math.random() - 0.5) * 3.0;
        shakeY = (Math.random() - 0.5) * 3.0;
      }
      
      // Phase 3: Impact Flash & Shatter (0.85 ~ 1.00)
      if (t >= 0.85) {
        scale = 1.0; // 프리즈 프레임 스케일 고정
        
        // 0.90 순간 1~2 프레임 흑백 반전 플래시
        if (t >= 0.90 && t < 0.93) {
           isInvert = (Math.random() > 0.3); // 깜빡임 모방
        }
        
        // 0.98 이상 도달 시 파괴 사출
        if (t >= 0.98) {
           isShattered = true; 
           if (!this._logoShattered) {
             this._spawnLogoShatterParticles(W, H);
             this._logoShattered = true;
           }
        }
      }

      ctx.translate(cx + shakeX, cy + shakeY);
      ctx.scale(scale, scale);
      
      if (isInvert) {
         ctx.fillStyle = "#ffffff";
         ctx.fillRect(-W, -H, W * 2, H * 2);
      }
      
      // 사진과 같은 속도감과 엣지를 위해 기울기(Skew) 추가
      ctx.transform(1, 0, -0.22, 1.0, 0, 0);

      const baseFontSize = Math.floor(H * 0.24); // 베이스 폰트 크기 살짝 키움
      
      // 상하 블록 오프셋: NEON과 PULSE가 겹치지 않으면서도 안정적으로 배치되도록 간격 확보
      const neonYOffset = -baseFontSize * 0.41;
      const pulseYOffset = baseFontSize * 0.41;

      // 플리커 난수 발생 함수 (0.1s 구간 내 3~4회 점멸)
      const getFlicker = (time, startT, duration) => {
        if (time < startT) return 0;
        if (time > startT + duration) return 1;
        // 30Hz~60Hz 수준의 빠른 Random Binary
        return Math.random() > 0.4 ? 1 : 0;
      };

      // 코어 알파 및 색수차 계산
      let coreAlpha = 0;
      let chromaOffset = 0;
      if (t >= 0.55 && t < 0.85) {
         const p2 = (t - 0.55) / 0.30;
         coreAlpha = p2 * 0.8; // 0.0 -> 0.8
         // Chromatic Aberration 0.0 -> 0.4 -> 0.1
         const chromaLevel = p2 < 0.5 ? (p2 * 2 * 0.4) : (0.4 - (p2 - 0.5) * 2 * 0.3);
         chromaOffset = chromaLevel * 25; // 픽셀 오프셋
      } else if (t >= 0.85) {
         coreAlpha = 0.8;
         chromaOffset = 0.1 * 25;
      }

      const drawHardEdgeText = (text, y, baseColor, isNeonLayer, flickerState, tPhase0, textScale = 1.0) => {
         ctx.save();
         ctx.scale(textScale, textScale);
         const scaledY = y / textScale;
         
         const currentFontSize = Math.floor(baseFontSize);
         ctx.font = `900 ${currentFontSize}px "Orbitron", "Rajdhani", sans-serif`;

         // Phase 0: 극저조도 와이어프레임 노출 (0.00 ~ 0.20)
         if (t < 0.20) {
            ctx.globalAlpha = tPhase0 * 0.15; // 0.0 -> 0.15 Linear
            ctx.strokeStyle = "#333333";
            ctx.lineWidth = Math.max(1, currentFontSize * 0.005);
            ctx.strokeText(text, 0, scaledY);
            ctx.restore();
            return;
         }
         
         // 점등 전 암막 구간 (플리커 0)
         if (flickerState === 0) {
            ctx.globalAlpha = 0.15;
            ctx.strokeStyle = "#333333";
            ctx.lineWidth = Math.max(1, currentFontSize * 0.005);
            ctx.strokeText(text, 0, scaledY);
            ctx.restore();
            return;
         }

         // 점등 후 상태 렌더링
         ctx.lineJoin = "miter";
         ctx.miterLimit = 4.0;

         // RGB 색수차 (Chromatic Aberration - 좌우 글리치)
         if (chromaOffset > 0 && !isInvert) {
             ctx.globalAlpha = 0.6;
             ctx.strokeStyle = "#ff0055"; // Red/Magenta 채널
             ctx.lineWidth = currentFontSize * 0.015;
             ctx.strokeText(text, -chromaOffset, scaledY);
             ctx.strokeStyle = "#0055ff"; // Blue/Cyan 채널
             ctx.strokeText(text, chromaOffset, scaledY);
         }

         ctx.globalAlpha = 1.0;
         
         let bloomMult = t >= 0.55 ? 1.5 : 1.0;
         if (isInvert) bloomMult = 0; 
         
         if (bloomMult > 0) {
             ctx.shadowColor = baseColor;
             // 2차 블룸: 은은하게 퍼져나가는 대기 글로우 (Ambient Haze) 반경 30~80px
             ctx.shadowBlur = 40 * bloomMult;
             ctx.strokeStyle = baseColor;
             ctx.lineWidth = currentFontSize * 0.035;
             ctx.strokeText(text, 0, scaledY);
             
             // 1차 블룸: 텍스트 테두리 주변 반경 2~5px의 타이트하고 선명한 글로우
             ctx.shadowBlur = 10 * bloomMult;
             ctx.lineWidth = currentFontSize * 0.015;
             ctx.strokeText(text, 0, scaledY);
         } else {
             ctx.shadowBlur = 0;
         }
         
         // 선명한 하드 엣지 마감 (Blur에 묻히지 않는 날카로운 윤곽선)
         ctx.shadowBlur = 0;
         ctx.strokeStyle = isInvert ? "#000000" : baseColor;
         ctx.lineWidth = currentFontSize * 0.012;
         ctx.strokeText(text, 0, scaledY);

         // 코어 라인 (순백색 마감)
         if (coreAlpha > 0) {
             ctx.globalAlpha = isInvert ? 1.0 : coreAlpha;
             ctx.strokeStyle = isInvert ? "#000000" : "#ffffff";
             ctx.lineWidth = Math.max(1, currentFontSize * 0.005); // 가장 안쪽 얇은 중심축
             ctx.strokeText(text, 0, scaledY);
         }
         ctx.restore();
      };

      if (!isShattered) {
          const tPhase0 = Math.min(1.0, t / 0.20);
          
          // 상단 'NEON' (마젠타 강조): 스케일을 살짝 줄여서 PULSE 위에 안착하는 느낌
          const neonFlicker = getFlicker(t, 0.20, 0.12);
          drawHardEdgeText("NEON", neonYOffset, "#ff007f", true, neonFlicker, tPhase0, 0.88);

          // 하단 'PULSE' (일렉트릭 시안): 넓은 베이스
          const pulseFlicker = getFlicker(t, 0.38, 0.12);
          drawHardEdgeText("PULSE", pulseYOffset, "#00f0ff", false, pulseFlicker, tPhase0, 1.0);
      }

      ctx.restore();
    }

    // 5-D. 네온 펄스 로고 폭발 파편 파티클 (프리드랍 종료 후 드랍 페이즈 진입 시에도 맵 밖으로 쫙 퍼져나감)
    if (this.logoShatterParticles.length > 0 || (this.logoShatterShockwave && this.logoShatterShockwave.age < this.logoShatterShockwave.maxLife)) {
      this._drawLogoShatterParticles(ctx, W, H);
    }

    ctx.restore();

    // 마우스 커스텀 커서 (가장 위에 렌더링)
    this._drawCustomCursor(W, H);

    // 6. HUD 정보 갱신
    const hudStage = document.getElementById("hud-stage");
    if (hudStage) {
      let phaseBadge = "";
      if (pInfo && pInfo.currentPhase) {
        const transTag = pInfo.isTransitioning ? ` <span style="color: #ffe600; animation: blinkText 0.6s infinite alternate;" title="다음 페이즈 전환 중">⚡</span>` : "";
        const colorMap = {
          intro: "#94a3b8",
          groove: "#06b6d4",
          build_1: "#f59e0b",
          build_2: "#f59e0b",
          drop: "#ff007f",
          break: "#a855f7",
          finale: "#64748b",
        };
        const badgeColor = colorMap[pInfo.currentPhase] || "#06b6d4";
        phaseBadge = ` <span style="margin-left: 6px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 800; letter-spacing: 0.5px; border: 1px solid ${badgeColor}; color: ${badgeColor}; background: rgba(0, 0, 0, 0.45); text-shadow: 0 0 8px ${badgeColor};">${pInfo.currentPhase.toUpperCase()}${transTag}</span>`;
      }
      hudStage.innerHTML = `<span class="stage-badge">STAGE ${this.stage} / 3</span> <span class="theme-badge">${this.currentTheme.name}</span>${phaseBadge}`;
    }
    const me = this.roomState.players[this.net.playerId];
    const hudLives = document.getElementById("hud-lives");
    if (me && hudLives) {
      let statusHtml = "";
      let healTimerHtml = "";
      const srvNow = this.net ? this.net.now() : Date.now();

      if (me.nickname === "관리자") {
        statusHtml = `<div class="revive-wait-container"><span class="revive-wait-text" style="color: #38bdf8; font-weight: 700; background: rgba(56, 189, 248, 0.18); border: 1px solid rgba(56, 189, 248, 0.5); padding: 3px 10px; border-radius: 6px;">👑 관리자 무적 모드</span></div>`;
      } else if (me.dead) {
        const remainSec = Math.max(0, REVIVE_WINDOW_SEC - (srvNow - (me.diedAt || srvNow)) / 1000).toFixed(1);
        statusHtml = `<div class="revive-wait-container"><span class="revive-wait-text">사망 - ${remainSec}초 내 터치 시 부활</span></div>`;
      } else if (me.lives < 3) {
        const lastHit = me.lastHitAt || this.localLastHitAt || this.serverStartTime || srvNow;
        const elapsedMs = Math.max(0, srvNow - lastHit);
        const AUTO_HEAL_MS = 10000;
        const remainMs = Math.max(0, AUTO_HEAL_MS - elapsedMs);
        const remainSec = (remainMs / 1000).toFixed(1);
        healTimerHtml = `<div class="heal-timer-container"><span class="heal-timer-badge">💚 회복까지 ${remainSec}초</span></div>`;
      }

      const hearts = [0, 1, 2]
        .map((i) => {
          if (me.nickname === "관리자") {
            return `<span class="heart-icon alive" style="filter: drop-shadow(0 0 6px #38bdf8); color: #38bdf8;">❤</span>`;
          }
          if (i < me.lives) {
            return `<span class="heart-icon alive">❤</span>`;
          }
          if (i === me.lives && !me.dead) {
            const lastHit = me.lastHitAt || this.localLastHitAt || this.serverStartTime || srvNow;
            const elapsedMs = Math.max(0, srvNow - lastHit);
            const fillRatio = Math.max(0, Math.min(1.0, elapsedMs / 10000));
            const clipInset = (100 - fillRatio * 100).toFixed(1);
            return `<span class="heart-icon recovering" title="회복 진행도: ${(fillRatio * 100).toFixed(0)}%">
              <span class="heart-bg">❤</span>
              <span class="heart-fill" style="clip-path: inset(${clipInset}% 0 0 0);">❤</span>
            </span>`;
          }
          return `<span class="heart-icon lost">❤</span>`;
        })
        .join("");
      hudLives.innerHTML = `<div class="hud-hearts">${hearts}</div>${statusHtml}${healTimerHtml}`;
    }

    const progressFill = document.getElementById("song-progress-fill");
    const progressTime = document.getElementById("song-progress-time");
    const progressPercent = document.getElementById("song-progress-percent");
    if (this.timeline && progressFill && progressTime && progressPercent) this._updateProgress(elapsed);
  }

  _updateProgress(elapsed) {
    const progressFill = document.getElementById("song-progress-fill");
    const progressTime = document.getElementById("song-progress-time");
    const progressPercent = document.getElementById("song-progress-percent");
    if (!this.timeline || !progressFill || !progressTime || !progressPercent) return;
    const duration = Math.max(0.001, this.timeline.durationSec || 0);
    const current = Math.max(0, Math.min(duration, elapsed));
    const ratio = Math.max(0, Math.min(1, current / duration));
    progressFill.style.transform = `scaleX(${ratio})`;
    progressTime.textContent = `${this._formatTime(current)} / ${this._formatTime(duration)}`;
    progressPercent.textContent = `${Math.round(ratio * 100)}%`;
  }

  getGrooveOrbs(elapsed) {
    return this.currentTheme?.getOrbs ? this.currentTheme.getOrbs(elapsed, this.canvas) : null;
  }

  _drawPlayer(p, W, H) {
    const { ctx } = this;
    const anim = this._getAnim(p.id);

    // 트레일 잔상
    for (const t of anim.trail) {
      const a = 1 - t.age / TRAIL_LIFETIME;
      ctx.save();
      ctx.globalAlpha = a * 0.4;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(t.x * W, t.y * H, PLAYER_RADIUS * W * 0.7 * a, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 대쉬 파티클
    for (const pt of anim.dashParticles) {
      const a = 1 - pt.age / pt.life;
      ctx.save();
      ctx.globalAlpha = a * 0.85;
      ctx.translate(pt.x * W, pt.y * H);
      ctx.rotate(pt.rot);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 10;
      const s = pt.size * W * a;
      ctx.beginPath();
      ctx.moveTo(0, -s); ctx.lineTo(s * 0.86, s * 0.5); ctx.lineTo(-s * 0.86, s * 0.5);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    const now = performance.now();
    const isLocalMe = p.id === this.net.playerId;
    const srvNow = this.net ? this.net.now() : Date.now();
    const isRemoteInvuln = Boolean(p.invulnerableUntil && srvNow < p.invulnerableUntil && (p.invulnerableUntil - srvNow) <= 2200);
    const invuln = isLocalMe
      ? ((performance.now() / 1000) < this.localInvulnerableUntil)
      : isRemoteInvuln;

    ctx.save();
    ctx.translate(p.x * W, p.y * H);

    if (p.dead) {
      // 쓰러짐 다운 연출 (0.7초 동안 회전하며 작아짐)
      const t = Math.min(1, (anim.deathT || 0) / DEATH_FADE_SEC);
      const scale = 1 - t * 0.35;
      ctx.scale(scale, scale);
      ctx.rotate(anim.facing + Math.PI / 2 + t * Math.PI);

      // 사망 플레이어 깜빡임 (Flicker 연출: 0.2 ~ 1.0)
      const flickerAlpha = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(now / 70));
      ctx.globalAlpha = flickerAlpha;

      // 사망 후 부활 대기 링 표시 (4초 기준)
      const remainRatio = Math.max(0, 1 - (srvNow - (p.diedAt || srvNow)) / (REVIVE_WINDOW_SEC * 1000));
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_RADIUS * W * 2.2, -Math.PI / 2, -Math.PI / 2 + remainRatio * Math.PI * 2);
      ctx.stroke();

      // 쓰러진 심볼 (강렬한 네온 깜빡임)
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_RADIUS * W * 0.85, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_RADIUS * W * 0.45, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.rotate(anim.facing + Math.PI / 2);

      // 관리자 모드 네온 오라 링
      if (p.nickname === "관리자") {
        ctx.save();
        ctx.globalAlpha = 0.6 + 0.3 * Math.sin(now / 120);
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2.2;
        ctx.shadowColor = "#38bdf8";
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.arc(0, 0, PLAYER_RADIUS * W * 1.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 피격 무적 실드 펄스
      if (invuln) {
        ctx.save();
        ctx.globalAlpha = 0.5 + 0.4 * Math.sin(now / 50);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 16;
        ctx.beginPath();
        ctx.arc(0, 0, PLAYER_RADIUS * W * 1.8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      const r = PLAYER_RADIUS * W;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.3);
      ctx.lineTo(r, r);
      ctx.lineTo(0, r * 0.5);
      ctx.lineTo(-r, r);
      ctx.closePath();
      ctx.fill();

      // 테두리 글로우
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    ctx.restore();

    // 닉네임 표시
    ctx.save();
    ctx.fillStyle = p.nickname === "관리자" ? "#38bdf8" : "#ffffff";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000000";
    ctx.shadowBlur = 4;
    const nameLabel = p.nickname === "관리자" ? "👑 관리자" : p.nickname;
    ctx.fillText(nameLabel, p.x * W, p.y * H - PLAYER_RADIUS * W * 2.2);
    ctx.restore();
  }

  _drawCustomCursor(W, H) {
    if (this.controlMode !== "MOUSE" || !this.mouseInCanvas) return;
    const { ctx } = this;
    const cx = this.mouseX * W;
    const cy = this.mouseY * H;
    const now = performance.now() / 1000;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(now * 2);

    // 네온 크로스헤어 스타일
    ctx.strokeStyle = "#00f0ff";
    ctx.lineWidth = 2;
    ctx.shadowColor = "#00f0ff";
    ctx.shadowBlur = 8;

    const s = 10;
    const g = 4;
    ctx.beginPath();
    // 십자선 (중간 갭)
    ctx.moveTo(g, 0); ctx.lineTo(s, 0);
    ctx.moveTo(-g, 0); ctx.lineTo(-s, 0);
    ctx.moveTo(0, g); ctx.lineTo(0, s);
    ctx.moveTo(0, -g); ctx.lineTo(0, -s);
    ctx.stroke();

    // 중앙 작은 점
    ctx.fillStyle = "#fff";
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}
