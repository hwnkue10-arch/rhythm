import { BaseTheme } from "./BaseTheme.js";

export class NeonPulseTheme extends BaseTheme {
  constructor() {
    super("neon_pulse", "Neon Pulse");
    this.gridOffset = 0;
    this.particles = this._initParticles(32);
    // 마젠타(#FF007F)와 시안(#00F0FF) 2가지 네온 색상만 사용
    this.pulsePalettes = [
      { r: 255, g: 0, b: 127, hex: "#ff007f" },  // 네온 마젠타
      { r: 0, g: 240, b: 255, hex: "#00f0ff" },  // 일렉트릭 시안
    ];
    this.currentPaletteIndex = 0;
    this.lastBeatIntensity = 0;
  }

  _initParticles(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.04,
        vy: (Math.random() - 0.5) * 0.04,
        size: 3 + Math.random() * 8,
        color: Math.random() < 0.5 ? "#05d9e8" : "#ff2a6d",
        alpha: 0.2 + Math.random() * 0.4,
        rot: Math.random() * Math.PI * 2,
        vrot: (Math.random() - 0.5) * 2,
      });
    }
    return arr;
  }

  renderBackground(ctx, W, H, beatIntensity, time) {
    // 비트 온셋 감지 시 다음 멀티컬러로 순환 변경
    if (beatIntensity > 0.35 && this.lastBeatIntensity <= 0.35) {
      this.currentPaletteIndex = (this.currentPaletteIndex + 1) % this.pulsePalettes.length;
    }
    this.lastBeatIntensity = beatIntensity;
    const curColor = this.pulsePalettes[this.currentPaletteIndex];

    // 1. 딥 다크 네온 배경 그라디언트 (비트에 맞춰 멀티컬러 네온으로 번쩍임)
    const cx = W / 2;
    const cy = H / 2;
    const basePulse = beatIntensity * 0.45;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.85);
    grad.addColorStop(
      0,
      `rgba(${Math.min(255, 15 + curColor.r * basePulse * 0.8)}, ${Math.min(255, 10 + curColor.g * basePulse * 0.8)}, ${Math.min(255, 20 + curColor.b * basePulse * 0.8)}, 1)`
    );
    grad.addColorStop(0.55, `rgba(12, 14, 28, 1)`);
    grad.addColorStop(1, "#020205");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 2. 비트 펄스 반응형 네온 바닥 그리드
    ctx.save();
    const gridAlpha = 0.1 + beatIntensity * 0.35;
    ctx.strokeStyle = `rgba(${curColor.r}, ${curColor.g}, ${curColor.b}, ${gridAlpha})`;
    ctx.lineWidth = 1 + beatIntensity * 2.0;

    // 수직선
    const vSteps = 16;
    for (let i = 0; i <= vSteps; i++) {
      const x = (i / vSteps) * W;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // 수평선 (비트에 따라 아래로 스크롤)
    this.gridOffset = (this.gridOffset + 0.4 + beatIntensity * 1.6) % 48;
    for (let y = this.gridOffset; y <= H; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // 대각선 펄스 액센트
    ctx.strokeStyle = `rgba(255, 42, 109, ${gridAlpha * 0.85})`;
    for (let d = -H; d < W; d += 96) {
      ctx.beginPath();
      ctx.moveTo(d, 0);
      ctx.lineTo(d + H, H);
      ctx.stroke();
    }
    ctx.restore();

    // 3. 네온 부유 파티클 (비트에 맞춰 반짝임 및 가속)
    ctx.save();
    for (const p of this.particles) {
      p.x += p.vx * (1 + beatIntensity * 2.5) * 0.016;
      p.y += p.vy * (1 + beatIntensity * 2.5) * 0.016;
      p.rot += p.vrot * 0.016;
      if (p.x < 0) p.x += 1;
      if (p.x > 1) p.x -= 1;
      if (p.y < 0) p.y += 1;
      if (p.y > 1) p.y -= 1;

      const pa = Math.min(1, p.alpha * (0.8 + beatIntensity * 1.2));
      ctx.save();
      ctx.translate(p.x * W, p.y * H);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = pa;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8 + beatIntensity * 16;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }
    ctx.restore();
  }

  renderBloom(ctx, W, H, beatIntensity) {
    if (beatIntensity <= 0.02) return;

    const curColor = this.pulsePalettes[this.currentPaletteIndex];
    ctx.save();
    // 화면 테두리 강렬한 멀티컬러 네온 비네팅 플래시
    const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.75);
    grad.addColorStop(0, `rgba(${curColor.r}, ${curColor.g}, ${curColor.b}, 0)`);
    grad.addColorStop(1, `rgba(${curColor.r}, ${curColor.g}, ${curColor.b}, ${Math.min(0.65, beatIntensity * 0.6)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 상단/하단/좌우 네온 라인 비트 플래시
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = `rgba(${curColor.r}, ${curColor.g}, ${curColor.b}, ${Math.min(0.55, beatIntensity * 0.5)})`;
    const lineThick = 4 + beatIntensity * 12;
    ctx.fillRect(0, 0, W, lineThick);
    ctx.fillRect(0, H - lineThick, W, lineThick);
    ctx.fillRect(0, 0, lineThick, H);
    ctx.fillRect(W - lineThick, 0, lineThick, H);
    ctx.restore();
  }

  getObstacleStyle(type, band) {
    const palette = {
      laser: {
        warn: "rgba(255, 42, 109, 0.35)",
        warnBorder: "#ff2a6d",
        active: "#05d9e8",
        activeCore: "#ffffff",
        glow: "rgba(5, 217, 232, 0.9)",
        blur: 28,
      },
      wave: {
        warn: "rgba(138, 92, 255, 0.35)",
        warnBorder: "#8a5cff",
        active: "#ff2a6d",
        activeCore: "#ffb3d9",
        glow: "rgba(255, 42, 109, 0.9)",
        blur: 24,
      },
      shockwave: {
        warn: "rgba(5, 217, 232, 0.35)",
        warnBorder: "#05d9e8",
        active: "#ffe600",
        activeCore: "#ffffff",
        glow: "rgba(255, 230, 0, 0.9)",
        blur: 32,
      },
      wall_crush: {
        warn: "rgba(255, 42, 109, 0.4)",
        warnBorder: "#ff2a6d",
        active: "#ff0055",
        activeCore: "#ffffff",
        glow: "rgba(255, 0, 85, 0.95)",
        blur: 35,
      },
      zone_blast: {
        warn: "rgba(255, 170, 0, 0.35)",
        warnBorder: "#ffaa00",
        active: "#ff2a6d",
        activeCore: "#ffffff",
        glow: "rgba(255, 42, 109, 0.9)",
        blur: 26,
      },
      straight: {
        warn: "rgba(5, 217, 232, 0.3)",
        warnBorder: "#05d9e8",
        active: "#05d9e8",
        activeCore: "#ffffff",
        glow: "rgba(5, 217, 232, 0.8)",
        blur: 16,
      },
      blaster: {
        warn: "rgba(255, 42, 109, 0.4)",
        warnBorder: "#ff2a6d",
        active: "#ff2a6d",
        activeCore: "#ffffff",
        glow: "rgba(255, 42, 109, 0.95)",
        blur: 24,
      },
      gatling: {
        warn: "rgba(181, 76, 255, 0.4)",
        warnBorder: "#b54cff",
        active: "#b54cff",
        activeCore: "#ffffff",
        glow: "rgba(181, 76, 255, 0.95)",
        blur: 22,
      },
      sweep_laser: {
        warn: "rgba(0, 255, 180, 0.4)",
        warnBorder: "#00ffb4",
        active: "#00ffb4",
        activeCore: "#ffffff",
        glow: "rgba(0, 255, 180, 1.0)",
        blur: 36,
      },
    };
    return palette[type] || palette.laser;
  }
}
