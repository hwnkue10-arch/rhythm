import { renderObstacle, checkCollision, isEventVisible } from "./obstacles.js";
import { themeRegistry } from "./themes/ThemeRegistry.js";

const BASE_SPEED = 0.36; // 초당 정규화 이동 속도 (반응성 향상)
const SHIFT_MULTIPLIER = 1.55;
const DASH_DISTANCE = 0.24; // 대시 거리 50% 상향 (순간 돌파감 극대화)
const DASH_DURATION = 0.14; // 날렵한 순간 대시
const DASH_COOLDOWN = 0.25; // 쿨타임 0.25초로 단축하여 더 민첩한 연타 대응
const DASH_INVULN = DASH_DURATION;
const PLAYER_RADIUS = 0.011; // 캐릭터 크기 40% 축소 (정밀 회피 및 날렵한 비주얼)
const DEATH_FADE_SEC = 0.7; // 0.7초 동안 다운 연출
const TRAIL_LIFETIME = 0.32;

export class Game {
  constructor(net, canvas, audioEl, roomState) {
    this.net = net;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.audioEl = audioEl;
    this.roomState = roomState;

    this.keys = new Set();
    this.dashCooldownUntil = 0;
    this.dashActiveUntil = 0;
    this.dashDir = { x: 0, y: 0 };
    this.localInvulnerableUntil = 0;

    this.timeline = null;
    this.stage = 1;
    this.serverStartTime = 0;
    this.currentTheme = themeRegistry.get("neon_pulse");
    this.beatIntensity = 0; // 0.0 ~ 1.0 (비트 강도)
    this.lastReviveSendTime = 0;

    this.running = false;
    this._lastFrameTime = 0;
    this.anim = new Map(); // playerId -> { facing, trail:[], dashParticles:[], deathT, wasDead, prevX, prevY }

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._loop = this._loop.bind(this);

    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
  }

  destroy() {
    this.running = false;
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
  }

  _onKeyDown(e) {
    this.keys.add(e.code);
    if (e.code === "Space") this._tryDash();
  }
  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  _tryDash() {
    const now = performance.now() / 1000;
    if (now < this.dashCooldownUntil) return;
    const dir = this._inputDirection();
    if (dir.x === 0 && dir.y === 0) return;
    this.dashDir = dir;
    this.dashActiveUntil = now + DASH_DURATION;
    this.dashCooldownUntil = now + DASH_COOLDOWN;
    this.localInvulnerableUntil = now + DASH_INVULN;

    const me = this.roomState.players[this.net.playerId];
    if (me) {
      const anim = this._getAnim(me.id);
      for (let i = 0; i < 12; i++) {
        const a = Math.atan2(-dir.y, -dir.x) + (Math.random() - 0.5) * 1.2;
        const spd = 0.25 + Math.random() * 0.4;
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
    const tid = themeId || (timeline && timeline.themeId) || "neon_pulse";
    this.currentTheme = themeRegistry.get(tid);

    this.dashCooldownUntil = 0;
    this.dashActiveUntil = 0;
    this.localInvulnerableUntil = 0;
    this.beatIntensity = 0;
    this.lastReviveSendTime = 0;
    this.anim.clear();

    this.audioEl.src = songUrl;
    this.audioEl.volume = (document.getElementById("volume-slider").value || 70) / 100;

    const delay = serverStartTime - Date.now();
    this.audioEl.pause();
    this.audioEl.currentTime = 0;
    clearTimeout(this._audioStopTimer);
    clearTimeout(this._audioStartTimer);
    this._audioStartTimer = setTimeout(() => {
      this.audioEl.play().catch(() => {});
    }, Math.max(0, delay));

    this._audioStopTimer = setTimeout(() => {
      this.audioEl.pause();
    }, Math.max(0, delay) + timeline.durationSec * 1000 + 50);

    const me = this.roomState.players[this.net.playerId];
    if (me) { me.x = 0.5; me.y = 0.85; }

    if (!this.running) {
      this.running = true;
      this._lastFrameTime = performance.now();
      requestAnimationFrame(this._loop);
    }
  }

  stopStage() {
    this.running = false;
    clearTimeout(this._audioStopTimer);
    clearTimeout(this._audioStartTimer);
    this.audioEl.pause();
  }

  stageElapsed() {
    return (Date.now() - this.serverStartTime) / 1000;
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

    if (me && !me.dead) {
      // 1. 이동 및 대시
      if (now < this.dashActiveUntil) {
        me.x += this.dashDir.x * (DASH_DISTANCE / DASH_DURATION) * dt;
        me.y += this.dashDir.y * (DASH_DISTANCE / DASH_DURATION) * dt;
      } else {
        const dir = this._inputDirection();
        const speed = BASE_SPEED * (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? SHIFT_MULTIPLIER : 1);
        me.x += dir.x * speed * dt;
        me.y += dir.y * speed * dt;
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

      // 4. 기믹 장애물 피격 판정
      if (this.timeline && now > this.localInvulnerableUntil) {
        const elapsed = this.stageElapsed();
        for (const ev of this.timeline.events) {
          const local = elapsed - ev.t;
          if (!isEventVisible(ev, local)) continue;
          if (checkCollision(me, ev, local)) {
            this.net.send("hit", {});
            this.localInvulnerableUntil = now + 0.8;
            break;
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
        if (Math.hypot(dx, dy) > 0.0008) anim.facing = Math.atan2(dy, dx);
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
  }

  _render() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    // 지오메트리 대쉬 스타일 비트 줌 펄스 (모든 박자에 반응하여 쿵쿵 뜀, 최대 1.045배)
    if (this.beatIntensity > 0.01) {
      const scale = 1.0 + Math.min(0.045, this.beatIntensity * 0.042);
      ctx.translate(W / 2, H / 2);
      ctx.scale(scale, scale);
      ctx.translate(-W / 2, -H / 2);
    }

    const elapsed = this.stageElapsed();

    // 1. 테마별 배경 렌더링
    this.currentTheme.renderBackground(ctx, W, H, this.beatIntensity, elapsed);

    // 2. JS&B 스타일 기믹 장애물 (경고선 & 비트 발동)
    if (this.timeline) {
      for (const ev of this.timeline.events) {
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
    this.currentTheme.renderBloom(ctx, W, H, this.beatIntensity);

    ctx.restore();

    // 5. HUD 정보 갱신
    document.getElementById("hud-stage").textContent = `스테이지 ${this.stage} / 3 (${this.currentTheme.name})`;
    const me = this.roomState.players[this.net.playerId];
    let statusText = "";
    if (me) {
      if (me.dead) {
        const remainSec = Math.max(0, 3 - (Date.now() - (me.diedAt || 0)) / 1000).toFixed(1);
        statusText = ` (사망 - ${remainSec}초 내 터치 시 부활)`;
      }
      document.getElementById("hud-lives").textContent = `${"❤".repeat(me.lives)}${statusText}`;
    }
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
    const invuln = Date.now() < (p.invulnerableUntil || 0);

    ctx.save();
    ctx.translate(p.x * W, p.y * H);

    if (p.dead) {
      // 쓰러짐 다운 연출 (0.7초 동안 회전하며 작아짐)
      const t = Math.min(1, (anim.deathT || 0) / DEATH_FADE_SEC);
      const scale = 1 - t * 0.35;
      ctx.scale(scale, scale);
      ctx.rotate(anim.facing + Math.PI / 2 + t * Math.PI);

      // 사망 후 부활 대기 링 표시
      const remainRatio = Math.max(0, 1 - (Date.now() - (p.diedAt || Date.now())) / 3000);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_RADIUS * W * 2.2, -Math.PI / 2, -Math.PI / 2 + remainRatio * Math.PI * 2);
      ctx.stroke();

      // 쓰러진 심볼
      ctx.fillStyle = "rgba(200, 200, 200, 0.6)";
      ctx.beginPath();
      ctx.arc(0, 0, PLAYER_RADIUS * W * 0.7, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.rotate(anim.facing + Math.PI / 2);

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
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.shadowColor = "#000000";
    ctx.shadowBlur = 4;
    ctx.fillText(p.nickname, p.x * W, p.y * H - PLAYER_RADIUS * W * 2.2);
    ctx.restore();
  }
}
