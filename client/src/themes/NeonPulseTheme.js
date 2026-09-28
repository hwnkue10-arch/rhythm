import { BaseTheme } from "./BaseTheme.js";

export class NeonPulseTheme extends BaseTheme {
  constructor() {
    super("neon_pulse", "Neon Pulse", {
      defaultSong: {
        title: "Through The Obsidian Grid",
        url: "/assets/Through_The_Obsidian_Grid.mp3",
        durationSec: 177,
        fullDurationSec: 177,
      },
    });
    this.gridOffset = 0;
    this.particles = this._initParticles(32);
    // 마젠타(#FF007F)와 시안(#00F0FF) 2가지 네온 색상
    this.pulsePalettes = [
      { r: 255, g: 0, b: 127, hex: "#ff007f" },  // 네온 마젠타
      { r: 0, g: 240, b: 255, hex: "#00f0ff" },  // 일렉트릭 시안
    ];
    this.currentPaletteIndex = 0;
    this.lastBeatIntensity = 0;
    this.timeline = null;
    this.phases = [];
    this.kickPaletteIndex = 0;
    this.kickIntensity = 0;
    this.snareIntensity = 0;
    this.hihatIntensity = 0;
    this.melodyIntensity = 0;
    this.lastMelodyIntensity = 0;
    this.melodyWhiteCore = 0;
    this.snareWhiteCore = 0;
    this.lastKickTime = -999;
    this.lastRenderTime = 0;
  }

  setTimeline(timeline) {
    this.timeline = timeline;
    this.phases = (timeline && timeline.phases) || [];
    this._cachedOrbs = null;
    this._cachedOrbsElapsed = -999999;

    // 타임라인 이벤트 사전 필터링 및 인덱싱 (프레임 드랍 랙 원천 차단)
    this._orbMoveEvents = (timeline?.events || []).filter((e) => e.type === "orb_move");
    this._mcLaserEvents = (timeline?.events || []).filter((e) => e.params?.isMCLaser);
    this._sideShockwaveEvents = (timeline?.events || []).filter((e) => e.type === "shockwave" && e.params?.side);

    // 각 build_1 및 build_2 세그먼트별 킥 사전 인덱싱
    this._kicksBySeg = new Map();
    const allKicks = [
      ...(timeline?.events || []).filter((e) => e.instrument === "kick"),
      ...(timeline?.beats || []).filter((b) => b.instrument === "kick"),
    ].sort((a, b) => a.t - b.t);

    const uniqueKicks = [];
    for (const k of allKicks) {
      if (!uniqueKicks.length || k.t - uniqueKicks[uniqueKicks.length - 1].t > 0.08) {
        uniqueKicks.push(k);
      }
    }

    for (const seg of this.phases) {
      if (seg.phase === "build_1") {
        // build_1과 이어지는 build_2 세그먼트까지 합친 전체 빌드 킥을 단일 타임라인으로 인덱싱
        const nextSeg = this.phases.find((p) => p.phase === "build_2" && Math.abs(p.startTime - seg.endTime) < 1.0);
        const endT = nextSeg ? nextSeg.endTime : seg.endTime;
        // 0.22초 이상 간격의 뚜렷한 킥만 필터링 (고속 연타 킥 떨림/뚝뚝 끊김 방지)
        const segKicks = uniqueKicks.filter((k) => k.t >= seg.startTime && k.t <= endT + 4.0);
        this._kicksBySeg.set(seg.startTime, segKicks);
      }
    }
  }

  /**
   * 현재 재생 시간(currentTime)을 기준으로 현재 페이즈와 다음 페이즈, 전환 진행도(0.0~1.0)를 산출
   */
  getPhaseInfo(time, timelineOverride) {
    const phases = (timelineOverride && timelineOverride.phases) || this.phases;
    if (!phases || phases.length === 0) {
      return {
        currentPhase: "intro",
        nextPhase: "intro",
        isTransitioning: false,
        transitionProgress: 0,
        currentSegment: null,
        nextSegment: null,
      };
    }

    let idx = phases.findIndex((s) => time >= s.startTime && time < s.endTime);
    if (idx === -1) {
      if (time < phases[0].startTime) idx = 0;
      else idx = phases.length - 1;
    }

    const currentSegment = phases[idx];
    const currentPhase = currentSegment.phase;
    const nextSegment = idx + 1 < phases.length ? phases[idx + 1] : null;
    const nextPhase = nextSegment ? nextSegment.phase : currentPhase;

    let isTransitioning = false;
    let transitionProgress = 0;

    // 다음 페이즈 시작 3초 전부터 전환 모드로 전환 (0.0 ~ 1.0)
    if (nextSegment) {
      const timeRemaining = nextSegment.startTime - time;
      const TRANSITION_WINDOW = 3.0;
      if (timeRemaining <= TRANSITION_WINDOW && timeRemaining >= 0) {
        isTransitioning = true;
        const raw = 1.0 - timeRemaining / TRANSITION_WINDOW;
        // Smoothstep (3x^2 - 2x^3) 보간
        transitionProgress = Math.max(0, Math.min(1, raw * raw * (3 - 2 * raw)));
      }
    }

    return {
      currentPhase,
      nextPhase,
      isTransitioning,
      transitionProgress,
      currentSegment,
      nextSegment,
    };
  }

  /** 페이즈별 연출 프로필 */
  _getPhaseProfile(phase) {
    const profiles = {
      // 1. intro: 가운데 원형 발광 없이 그리드와 대각선 비트 점멸 + 네온 부유 파티클 유지
      intro: {
        bgBase: { r: 20, g: 12, b: 32 },
        bgGlow: { r: 0, g: 210, b: 255 },
        glowMult: 0.0,
        gridAlphaBase: 0.05,
        gridAlphaBeat: 0.85,
        diagAlphaBase: 0.05,
        diagAlphaBeat: 0.85,
        gridLineWidth: 1.0,
        gridSpeedMult: 0.55,
        bloomScale: 0.0,
        particleSpeedMult: 0.65,
        particleAlphaMult: 0.75,
      },
      // 2. groove: 마젠타/시안 기본 비트 펄스 및 그리드 활성화
      groove: {
        bgBase: { r: 20, g: 12, b: 32 },
        bgGlow: { r: 0, g: 240, b: 255 },
        glowMult: 0.45,
        gridAlphaBase: 0.10,
        gridAlphaBeat: 0.45,
        diagAlphaBase: 0.09,
        diagAlphaBeat: 0.50,
        gridLineWidth: 1.0,
        gridSpeedMult: 1.0,
        bloomScale: 1.0,
        particleSpeedMult: 1.0,
        particleAlphaMult: 1.0,
      },
      // 3. build: 페이즈 종료 3초 전부터 그리드 속도 가속, 블룸 강도 상승 및 시각적 예고 펄스 적용
      build: {
        bgBase: { r: 20, g: 12, b: 32 },
        bgGlow: { r: 255, g: 42, b: 109 },
        glowMult: 0.70,
        gridAlphaBase: 0.14,
        gridAlphaBeat: 0.55,
        diagAlphaBase: 0.12,
        diagAlphaBeat: 0.60,
        gridLineWidth: 1.0,
        gridSpeedMult: 1.8,
        bloomScale: 1.5,
        particleSpeedMult: 1.8,
        particleAlphaMult: 1.3,
      },
      // 4. drop: 임팩트는 살리되 눈이 피로하지 않도록 정제된 네온 빛 번짐 연출
      drop: {
        bgBase: { r: 20, g: 12, b: 32 },
        bgGlow: { r: 255, g: 0, b: 127 },
        glowMult: 0.8,
        gridAlphaBase: 0.12,
        gridAlphaBeat: 0.58, // 최대 70% 수준으로 조절하여 눈부심(쨍함) 완화
        diagAlphaBase: 0.10,
        diagAlphaBeat: 0.60, // 최대 70% 수준으로 조절
        gridLineWidth: 1.0,
        gridSpeedMult: 2.2,
        bloomScale: 1.8,
        particleSpeedMult: 2.0,
        particleAlphaMult: 1.4,
      },
      // 5. break: 인트로와 거의 동일한 차분한 다크 배경 및 펄스 (재정비 연출)
      break: {
        bgBase: { r: 20, g: 12, b: 32 },
        bgGlow: { r: 0, g: 210, b: 255 },
        glowMult: 0.0,
        gridAlphaBase: 0.05,
        gridAlphaBeat: 0.85,
        diagAlphaBase: 0.05,
        diagAlphaBeat: 0.85,
        gridLineWidth: 1.0,
        gridSpeedMult: 0.55,
        bloomScale: 0.0,
        particleSpeedMult: 0.65,
        particleAlphaMult: 0.75,
      },
      // 6. finale: 점진적 페이드 효과
      finale: {
        bgBase: { r: 20, g: 12, b: 32 },
        bgGlow: { r: 0, g: 200, b: 240 },
        glowMult: 0.20,
        gridAlphaBase: 0.05,
        gridAlphaBeat: 0.15,
        diagAlphaBase: 0.05,
        diagAlphaBeat: 0.15,
        gridLineWidth: 1.0,
        gridSpeedMult: 0.3,
        bloomScale: 0.3,
        particleSpeedMult: 0.3,
        particleAlphaMult: 0.3,
      },
    };
    return profiles[phase] || (phase && phase.startsWith("build") ? profiles.build : profiles.groove);
  }

  /** 두 프로필 간의 Smoothstep / Linear Lerp 보간 */
  _interpolateProfiles(pCurr, pNext, t) {
    const lerp = (a, b, factor) => a + (b - a) * factor;
    const lerpColor = (c1, c2, factor) => ({
      r: Math.round(lerp(c1.r, c2.r, factor)),
      g: Math.round(lerp(c1.g, c2.g, factor)),
      b: Math.round(lerp(c1.b, c2.b, factor)),
    });

    return {
      bgBase: lerpColor(pCurr.bgBase, pNext.bgBase, t),
      bgGlow: lerpColor(pCurr.bgGlow, pNext.bgGlow, t),
      glowMult: lerp(pCurr.glowMult, pNext.glowMult, t),
      gridAlphaBase: lerp(pCurr.gridAlphaBase, pNext.gridAlphaBase, t),
      gridAlphaBeat: lerp(pCurr.gridAlphaBeat, pNext.gridAlphaBeat, t),
      diagAlphaBase: lerp(pCurr.diagAlphaBase, pNext.diagAlphaBase, t),
      diagAlphaBeat: lerp(pCurr.diagAlphaBeat, pNext.diagAlphaBeat, t),
      gridLineWidth: lerp(pCurr.gridLineWidth, pNext.gridLineWidth, t),
      gridSpeedMult: lerp(pCurr.gridSpeedMult, pNext.gridSpeedMult, t),
      bloomScale: lerp(pCurr.bloomScale, pNext.bloomScale, t),
      particleSpeedMult: lerp(pCurr.particleSpeedMult, pNext.particleSpeedMult, t),
      particleAlphaMult: lerp(pCurr.particleAlphaMult, pNext.particleAlphaMult, t),
    };
  }

  /**
   * 음악 비트/음표의 자연스러운 ADSR(어택-홀드-감쇠) 엔벨로프 계산:
   * - holdTime 동안 최고 밝기 100% 유지 (너무 빨리 꺼지는 깜빡임 현상 방지)
   * - decayTime 동안 부드러운 지수/곡선 감쇠로 풍부한 음악적 잔향 형성
   */
  _calcEnvelope(diff, energy, holdTime, decayTime, curve = 1.8) {
    if (diff < 0) return 0;
    const peak = Math.min(1.0, (energy || 0.6) * 1.45);
    if (diff <= holdTime) return peak;
    const elapsedDecay = diff - holdTime;
    if (elapsedDecay >= decayTime) return 0;
    const progress = elapsedDecay / decayTime;
    return peak * Math.pow(1 - progress, curve);
  }

  /**
   * 비트가 쿵/착 터지는 첫 0.035초 동안 쨍하지 않고 부드러운 일렉트릭 코어 하이라이트 강도 계산
   */
  _calcWhiteCore(diff, energy, peakDuration = 0.032, fadeDuration = 0.045) {
    if (diff < 0) return 0;
    const peak = Math.min(0.85, (energy || 0.6) * 1.1);
    if (diff <= peakDuration) return peak;
    const elapsed = diff - peakDuration;
    if (elapsed >= fadeDuration) return 0;
    return peak * (1.0 - elapsed / fadeDuration);
  }

  /**
   * 음악 타임라인의 악기별(Kick, Snare, Hi-hat, Melody) 온셋을 1:1로 감지하여
   * 각 배경 요소 전용의 독립 강도를 실시간 갱신 및 자연스럽게 감쇠(Decay)합니다.
   */
  _updateInstrumentIntensities(time, timeline) {
    const dt = this.lastRenderTime > 0 ? Math.max(0.001, Math.min(0.1, time - this.lastRenderTime)) : 0.016;
    this.lastRenderTime = time;

    let maxKick = 0;
    let maxSnare = 0;
    let maxHihat = 0;
    let maxMelody = 0;
    let maxMelodyWhite = 0;
    let maxSnareWhite = 0;

    const beats = (timeline && timeline.beats) || [];
    if (beats.length > 0) {
      for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
        const diff = time - b.t;
        if (diff < 0) break; // beats는 시간순 정렬되어 있으므로 미래 비트는 순회 중단
        if (diff > 0.65) continue; // 최대 잔향 범위(0.65초) 이전 비트는 건너뜀

        const inst = b.instrument || "kick";
        if (inst === "kick") {
          const val = this._calcEnvelope(diff, b.energy || 0.6, 0.14, 0.46, 1.8);
          if (val > maxKick) maxKick = val;
        } else if (inst === "snare") {
          const val = this._calcEnvelope(diff, b.energy || 0.6, 0.11, 0.42, 1.6);
          if (val > maxSnare) maxSnare = val;
          const wVal = this._calcWhiteCore(diff, b.energy || 0.6, 0.040, 0.045);
          if (wVal > maxSnareWhite) maxSnareWhite = wVal;
        } else if (inst === "hihat") {
          const val = this._calcEnvelope(diff, b.energy || 0.5, 0.08, 0.28, 1.5);
          if (val > maxHihat) maxHihat = val;
        } else if (inst === "melody") {
          const val = this._calcEnvelope(diff, b.energy || 0.6, 0.15, 0.50, 1.7);
          if (val > maxMelody) maxMelody = val;
          const wVal = this._calcWhiteCore(diff, b.energy || 0.6, 0.042, 0.048);
          if (wVal > maxMelodyWhite) maxMelodyWhite = wVal;
        }
      }
    } else if (timeline && timeline.events) {
      for (let i = 0; i < timeline.events.length; i++) {
        const ev = timeline.events[i];
        const diff = time - ev.t;
        if (diff < 0) break;
        if (diff > 0.65) continue;

        const inst = ev.instrument || "kick";
        if (inst === "kick") {
          const val = this._calcEnvelope(diff, ev.energy || 0.7, 0.14, 0.46, 1.8);
          if (val > maxKick) maxKick = val;
        } else if (inst === "snare") {
          const val = this._calcEnvelope(diff, ev.energy || 0.7, 0.11, 0.42, 1.6);
          if (val > maxSnare) maxSnare = val;
          const wVal = this._calcWhiteCore(diff, ev.energy || 0.7, 0.040, 0.045);
          if (wVal > maxSnareWhite) maxSnareWhite = wVal;
        } else if (inst === "hihat") {
          const val = this._calcEnvelope(diff, ev.energy || 0.6, 0.08, 0.28, 1.5);
          if (val > maxHihat) maxHihat = val;
        } else if (inst === "melody") {
          const val = this._calcEnvelope(diff, ev.energy || 0.7, 0.15, 0.50, 1.7);
          if (val > maxMelody) maxMelody = val;
          const wVal = this._calcWhiteCore(diff, ev.energy || 0.7, 0.042, 0.048);
          if (wVal > maxMelodyWhite) maxMelodyWhite = wVal;
        }
      }
    }

    // 엔벨로프 계산값과 부드러운 감쇠 블렌딩 (순간적인 튐 없이 최고치 유지 및 잔향 표현)
    this.kickIntensity = Math.max(maxKick, this.kickIntensity - dt * 1.8);
    this.snareIntensity = Math.max(maxSnare, this.snareIntensity - dt * 2.0);
    this.hihatIntensity = Math.max(maxHihat, this.hihatIntensity - dt * 3.2);
    this.melodyIntensity = Math.max(maxMelody, this.melodyIntensity - dt * 1.8);
    this.melodyWhiteCore = maxMelodyWhite;
    this.snareWhiteCore = maxSnareWhite;
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

  renderBackground(ctx, W, H, beatIntensity, time, timeline) {
    if (timeline && !this.timeline) this.setTimeline(timeline);

    // 0. 악기별(Kick, Snare, Hihat, Melody) 독립 펄스 강도 갱신 (1:1 매칭)
    this._updateInstrumentIntensities(time, timeline);

    // 1. 현재 페이즈 및 3초 전 전환 진행도 계산
    const phaseInfo = this.getPhaseInfo(time, timeline);
    const { currentPhase, nextPhase, isTransitioning, transitionProgress, currentSegment } = phaseInfo;

    const pCurr = this._getPhaseProfile(currentPhase);
    const pNext = this._getPhaseProfile(nextPhase);

    // 3초 전부터 현재 페이즈에서 다음 페이즈로 부드럽게 Color & Intensity Lerp
    const prof = isTransitioning ? this._interpolateProfiles(pCurr, pNext, transitionProgress) : pCurr;

    // 그리드와 대각선의 색상을 안정적이고 시각적으로 편안하게 유지 (빈번한 색상 교체 완전 제거)
    // 페이즈별 고유 테마 컬러(prof.bgGlow)를 따르며, 페이즈 전환 시에만 3초에 걸쳐 부드럽게 전환
    this.lastMelodyIntensity = this.melodyIntensity;
    const curColor = prof.bgGlow;

    // 대각선 전용 대비 색상 산출 (그리드와 대각선이 서로 다른 고유 컬러를 안정적으로 유지)
    // 그리드가 마젠타 계열일 때 대각선은 일렉트릭 시안(#00F0FF), 시안 계열일 때 대각선은 비비드 핫핑크(#FF2A6D)
    const isMagentaBase = curColor.r > curColor.b;
    const diagColor = isMagentaBase
      ? { r: 0, g: 240, b: 255, hex: "#00f0ff" }
      : { r: 255, g: 42, b: 109, hex: "#ff2a6d" };

    const isCalmPhase = currentPhase === "intro" || currentPhase === "break";

    // build 페이즈 특화: 종료 3초 전부터 시각적 예고 펄스 및 가속
    let buildWarningPulse = 0;
    let extraSpeedFactor = 1.0;
    if ((currentPhase === "build" || currentPhase === "build_2") && isTransitioning) {
      // 3초 전부터 진동 주파수가 빨라지는 예고 펄스
      const pulseFreq = 10 + transitionProgress * 18;
      buildWarningPulse = (Math.sin(time * pulseFreq) * 0.5 + 0.5) * transitionProgress * 0.45;
      extraSpeedFactor = 1.0 + transitionProgress * 1.5; // 그리드 추가 가속
    }

    // intro 페이즈 특화: 0~2.5초 동안 서서히 깨어나는 부팅 연출 (완전 암흑 방지)
    let introBootFade = 1.0;
    if (currentPhase === "intro") {
      const bootProgress = Math.min(1.0, Math.max(0.0, time / 2.5));
      introBootFade = 0.25 + 0.75 * Math.sin((bootProgress * Math.PI) / 2);
    }

    // finale 페이즈 특화: 곡 끝으로 갈수록 점진적 페이드아웃
    let finaleFade = 1.0;
    if (currentPhase === "finale" && currentSegment) {
      const segDur = Math.max(1, currentSegment.endTime - currentSegment.startTime);
      const segProg = Math.max(0, Math.min(1, (time - currentSegment.startTime) / segDur));
      finaleFade = 1.0 - segProg * 0.65; // 최대 65% 어두워지는 페이드
    }

    const overallFade = finaleFade * introBootFade;

    // 1. 배경 베이스 렌더링
    // 모든 페이즈에서 깊은 다크 슬레이트 바이올렛 단색 렌더링 (도넛형 중심 그라데이션 제거)
    const bgR = Math.round(prof.bgBase.r * overallFade);
    const bgG = Math.round(prof.bgBase.g * overallFade);
    const bgB = Math.round(prof.bgBase.b * overallFade);
    ctx.fillStyle = `rgb(${bgR}, ${bgG}, ${bgB})`;
    ctx.fillRect(0, 0, W, H);

    // =========================================================================
    // 2. [요소 1: 멜로디(Melody) 1:1 매칭] 격자 바닥 그리드 조명 (수직선 & 수평선)
    //    - 오직 멜로디 선율에 번쩍이며, 선 굵기 1.0px 고정 유지
    //    - 대각선과 100% 독립적으로 렌더링되며, 멜로디와 스네어가 동시 타격 시 둘 다 함께 점멸
    // =========================================================================
    ctx.save();
    const melodyPulse = this.melodyIntensity;
    const gridAlpha = isCalmPhase
      ? Math.max(0.04, prof.gridAlphaBase + melodyPulse * prof.gridAlphaBeat)
      : Math.max(0.03, (prof.gridAlphaBase + melodyPulse * prof.gridAlphaBeat + buildWarningPulse * 0.35) * overallFade);

    // 화이트-핫 일렉트릭 코어: 드랍 페이즈에서 너무 쨍하지 않도록 45% 소프트 코어 블렌딩
    const isBuildPhase = currentPhase === "build" || currentPhase === "build_2";
    const melodyCoreAlpha = (currentPhase === "drop" ? 0.45 : (isBuildPhase && isTransitioning ? transitionProgress * 0.25 : 0.0)) * this.melodyWhiteCore;
    const gridR = Math.round(curColor.r + (255 - curColor.r) * melodyCoreAlpha);
    const gridG = Math.round(curColor.g + (255 - curColor.g) * melodyCoreAlpha);
    const gridB = Math.round(curColor.b + (255 - curColor.b) * melodyCoreAlpha);

    ctx.strokeStyle = `rgba(${gridR}, ${gridG}, ${gridB}, ${gridAlpha})`;
    ctx.lineWidth = 1.0; // 어느 페이즈든 선이 굵어지지 않도록 고정

    // 드랍 페이즈 특화: 오직 그리드 선 자체를 따라 퍼지는 부드러운 네온 빛 번짐(Bloom)
    if (currentPhase === "drop") {
      const shadowR = Math.round(curColor.r + (255 - curColor.r) * (melodyCoreAlpha * 0.4));
      const shadowG = Math.round(curColor.g + (255 - curColor.g) * (melodyCoreAlpha * 0.4));
      const shadowB = Math.round(curColor.b + (255 - curColor.b) * (melodyCoreAlpha * 0.4));
      ctx.shadowColor = `rgba(${shadowR}, ${shadowG}, ${shadowB}, 0.65)`;
      ctx.shadowBlur = 6 + melodyPulse * 16 + melodyCoreAlpha * 8; // 눈부심 없는 부드러운 네온 블룸
    } else if (melodyPulse > 0.35) {
      ctx.shadowColor = `rgba(${curColor.r}, ${curColor.g}, ${curColor.b}, 0.65)`;
      ctx.shadowBlur = 4 + melodyPulse * 10;
    } else {
      ctx.shadowBlur = 0;
    }

    // 수직선
    const vSteps = 16;
    for (let i = 0; i <= vSteps; i++) {
      const x = (i / vSteps) * W;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // [요소 2: 킥(Kick) 1:1 매칭] 수평선 스크롤 전진 무브먼트 (오직 묵직한 킥 베이스에만 앞으로 질주/가속)
    const scrollStep = (0.35 + this.kickIntensity * 2.8) * prof.gridSpeedMult * extraSpeedFactor;
    this.gridOffset = (this.gridOffset + scrollStep) % 48;
    for (let y = this.gridOffset; y <= H; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();

    // =========================================================================
    // 3. [요소 2: 스네어(Snare) 1:1 매칭] 대각선 사이버 액센트 라인
    //    - 그리드와 완전히 독립된 별개의 요소로 연출 (기본선 상시 표시)
    //    - 오직 스네어 비트에만 착! 하고 날카롭게 번쩍이며, 킥과 스네어 동시 타격 시 둘 다 함께 점멸
    //    - 그리드와 대비되는 전용 액센트 컬러(diagColor) 및 1.0px 고정
    // =========================================================================
    ctx.save();
    const snarePulse = this.snareIntensity;
    const diagAlpha = isCalmPhase
      ? Math.max(0.04, prof.diagAlphaBase + snarePulse * prof.diagAlphaBeat)
      : Math.max(0.03, (prof.diagAlphaBase + snarePulse * prof.diagAlphaBeat + buildWarningPulse * 0.35) * overallFade);

    // 화이트-핫 일렉트릭 코어: 드랍 페이즈에서 너무 쨍하지 않도록 45% 소프트 코어 블렌딩
    const snareCoreAlpha = (currentPhase === "drop" ? 0.45 : (isBuildPhase && isTransitioning ? transitionProgress * 0.25 : 0.0)) * this.snareWhiteCore;
    const diagR = Math.round(diagColor.r + (255 - diagColor.r) * snareCoreAlpha);
    const diagG = Math.round(diagColor.g + (255 - diagColor.g) * snareCoreAlpha);
    const diagB = Math.round(diagColor.b + (255 - diagColor.b) * snareCoreAlpha);

    ctx.strokeStyle = `rgba(${diagR}, ${diagG}, ${diagB}, ${diagAlpha})`;
    ctx.lineWidth = 1.0;

    // 드랍 페이즈 특화: 오직 대각선 선 자체를 따라 퍼지는 부드러운 네온 빛 번짐(Bloom)
    if (currentPhase === "drop") {
      const shadowR = Math.round(diagColor.r + (255 - diagColor.r) * (snareCoreAlpha * 0.4));
      const shadowG = Math.round(diagColor.g + (255 - diagColor.g) * (snareCoreAlpha * 0.4));
      const shadowB = Math.round(diagColor.b + (255 - diagColor.b) * (snareCoreAlpha * 0.4));
      ctx.shadowColor = `rgba(${shadowR}, ${shadowG}, ${shadowB}, 0.65)`;
      ctx.shadowBlur = 6 + snarePulse * 16 + snareCoreAlpha * 8; // 대각선 슬래시 라인을 따라 흐르는 부드러운 블룸
    } else if (snarePulse > 0.3) {
      ctx.shadowColor = `rgba(${diagColor.r}, ${diagColor.g}, ${diagColor.b}, 0.65)`;
      ctx.shadowBlur = 4 + snarePulse * 10;
    } else {
      ctx.shadowBlur = 0;
    }

    // 45도 대각선 슬래시 (그리드의 48px 수평 간격과 구분되도록 96px 간격으로 시각적 차별화)
    for (let d = -H; d < W; d += 96) {
      ctx.beginPath();
      ctx.moveTo(d, 0);
      ctx.lineTo(d + H, H);
      ctx.stroke();
    }
    ctx.restore();

    // =========================================================================
    // 4. [요소 3: 하이햇(Hi-hat) 1:1 매칭] 네온 부유 파티클
    //    - 오직 하이햇 비트에만 반짝이는 펄스 및 미세 가속/회전 트위치
    // =========================================================================
    if (prof.particleAlphaMult > 0.001) {
      ctx.save();
      const hihatPulse = this.hihatIntensity;
      const particleSpeed = prof.particleSpeedMult * extraSpeedFactor;
      const particleAlphaScale = prof.particleAlphaMult * finaleFade;

      for (const p of this.particles) {
        // 하이햇 비트 순간 가속 (치-치 거리는 하이햇 템포와 1:1 연동)
        const hihatSpeedBoost = 1.0 + hihatPulse * 3.5;
        p.x += p.vx * hihatSpeedBoost * 0.016 * particleSpeed;
        p.y += p.vy * hihatSpeedBoost * 0.016 * particleSpeed;
        p.rot += p.vrot * hihatSpeedBoost * 0.016 * particleSpeed;
        if (p.x < 0) p.x += 1;
        if (p.x > 1) p.x -= 1;
        if (p.y < 0) p.y += 1;
        if (p.y > 1) p.y -= 1;

        // 하이햇 비트에 맞춰 반짝이는 파티클 투명도 팝
        const pa = Math.min(1, Math.max(0, p.alpha * (0.65 + hihatPulse * 1.8) * particleAlphaScale));
        ctx.save();
        ctx.translate(p.x * W, p.y * H);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = pa;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = (4 + hihatPulse * 20) * prof.bloomScale;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  renderBloom(ctx, W, H, beatIntensity, time, timeline) {
    // 배경 테두리 빛 및 외곽 비네팅 완전 제거 요청 반영 (모든 페이즈에서 테두리 빛 없음)
    return;
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
      melody_bolt: {
        warn: "rgba(0, 240, 255, 0.38)",
        warnBorder: "#00f0ff",
        active: "#00f0ff",
        activeCore: "#ffffff",
        glow: "rgba(0, 240, 255, 0.95)",
        blur: 28,
      },
    };
    return palette[type] || palette.laser;
  }

  // ==========================================
  // Neon Pulse 전용 엔티티 & 물리 & 렌더링 시스템
  // ==========================================

  _getBuildDeltaAngle(elapsed, t0, kicks) {
    if (elapsed <= t0) return 0;

    // 1. 기본 시계방향 회전 각속도: 안정적이고 우아한 궤도 비행을 위해 1.05 rad/s로 조절 (약 60 deg/s)
    const baseSpeed = 1.05;
    let totalAngle = (elapsed - t0) * baseSpeed;

    // 2. 화면 확대 펄스(Zoom Pulse) 스타일 킥 서지:
    // 킥이 딱 느껴지는 순간 즉각 최고 속도로 확 빨라지고(Instant Peak),
    // 이후 부드럽게 지수 감쇠(Exponential Decay)하며 천천히 원래 속도로 줄어드는 탄력적 비트 모션
    if (kicks && kicks.length > 0) {
      const deltaOmegaMax = 1.85; // 킥 타격 순간 즉시 치솟는 강력한 추가 각속도 (기본 1.05 -> 순간 2.90 rad/s)
      const tau = 0.22; // 감쇠 시정수: 약 0.4~0.6초 동안 천천히 지수적으로 감속하며 다음 비트로 연결
      const kickTotalRad = deltaOmegaMax * tau; // 1회 킥의 총 가속 변위 (수렴치)
      const cutoffTime = tau * 5.0; // 1.10초 이후는 99.3% 이상 수렴하여 상수로 처리

      for (const k of kicks) {
        if (elapsed < k.t) break;
        const dt = elapsed - k.t;
        if (dt >= cutoffTime) {
          totalAngle += kickTotalRad;
        } else {
          // 적분: Integral(deltaOmegaMax * exp(-t/tau) dt) = deltaOmegaMax * tau * (1 - exp(-dt/tau))
          // dt=0 시점에 각속도는 최대(Instant Peak), 누적 각도는 0에서 시작하여 천천히 감속
          totalAngle += deltaOmegaMax * tau * (1.0 - Math.exp(-dt / tau));
        }
      }
    }

    return totalAngle;
  }

  // 타임라인 내의 멜로디 온셋 목록 가져오기 (결정론적 캐싱)
  _getMelodyOnsets() {
    if (this._cachedMelodyOnsets && this._cachedMelodyTimeline === this.timeline) {
      return this._cachedMelodyOnsets;
    }
    let list = [];
    if (this.timeline?.rawOnsets && Array.isArray(this.timeline.rawOnsets)) {
      list = this.timeline.rawOnsets.filter((o) => o.instrument === "melody");
    }
    if (!list.length && this.timeline?.events) {
      list = this.timeline.events.filter((e) => e.instrument === "melody" || e.type === "melody_bolt");
    }
    if (!list.length && this.timeline?.beats) {
      list = this.timeline.beats;
    }
    this._cachedMelodyTimeline = this.timeline;
    this._cachedMelodyOnsets = list.sort((a, b) => a.t - b.t);
    return this._cachedMelodyOnsets;
  }

  // BUILD 1 & BUILD 2: M-C 레이저 중앙 맞닿음 폭발로 방출되는 하얀색 파티클(탄막) 위치 및 상태 계산
  // (드랍 페이즈 심볼 파편 폭발처럼 360도 전방향 불규칙 각도, 속도, 크기 산란 적용)
  _getMCLaserParticles(elapsed, W, H) {
    const mcLasers = this._mcLaserEvents || (this.timeline?.events || []).filter((e) => e.params?.isMCLaser);
    if (!mcLasers.length) return [];

    const particles = [];
    const MEET_DUR = 0.04; // 레이저가 중앙에서 맞닿는 시간 (초)
    const PARTICLE_LIFETIME = 2.4; // 파티클 생존 시간
    const COUNT = 8; // 적절하고 쾌적한 8개 파편으로 수량 최적화
    const melodyOnsets = this._getMelodyOnsets();

    const baseSpeedPx = 0.28 * W; // 기준 비행 속도 (화면 밖으로 시원하게 빠져나가도록 대폭 상향)
    const boostDistPx = 0.075 * W; // 기준 멜로디 가속 전진 변위
    const boostTau = 0.12;

    // 프레임 흔들림(jitter) 방지를 위한 고속 결정론적 의사 난수 함수
    const pseudoRand = (seed) => {
      const s = Math.sin(seed) * 43758.5453123;
      return s - Math.floor(s);
    };

    for (const ev of mcLasers) {
      const impactT = ev.t + MEET_DUR;
      if (elapsed < impactT || elapsed > impactT + PARTICLE_LIFETIME) continue;

      const age = elapsed - impactT;
      const lifeRatio = 1.0 - (age / PARTICLE_LIFETIME);
      const alpha = Math.min(1.0, lifeRatio * 2.2);

      // 멜로디 박자에 맞춘 가속 펄스 계산
      let isMelodyPulsing = false;
      let totalMelodyBoost = 0;
      for (const m of melodyOnsets) {
        if (m.t < impactT) continue;
        if (m.t > elapsed) break;
        const dt = elapsed - m.t;
        if (dt < 0.14) {
          isMelodyPulsing = true;
        }
        if (dt >= boostTau * 5.0) {
          totalMelodyBoost += boostDistPx;
        } else {
          totalMelodyBoost += boostDistPx * (1.0 - Math.exp(-dt / boostTau));
        }
      }

      const baseAngle = ((ev.t * 137.508) % 360) * (Math.PI / 180);
      const cx = 0.5 * W;
      const cy = 0.5 * H;

      // 360도 전 방향으로 불규칙하고 역동적인 속도와 각도로 산란 (심볼 파편 폭발 효과)
      for (let i = 0; i < COUNT; i++) {
        const seed = ev.t * 1000 + i * 53.17;
        const rAngle = pseudoRand(seed + 1.1);
        const rSpeed = pseudoRand(seed + 2.3);
        const rBoost = pseudoRand(seed + 3.7);
        const rSize = pseudoRand(seed + 4.9);

        // 1. 불규칙 각도: 360도를 골고루 퍼지되, 인위적인 등간격을 깨는 자연스러운 파편 각도 산란
        const ang = (i * Math.PI * 2 / COUNT) + (rAngle - 0.5) * 0.95 + baseAngle;

        // 2. 불규칙 속도: 0.55배 ~ 1.45배까지 제각각 다른 사출 속도 부여
        const speedMult = 0.55 + rSpeed * 0.90;

        // 3. 불규칙 멜로디 가속 배율: 0.60배 ~ 1.40배
        const boostMult = 0.60 + rBoost * 0.80;

        // 4. 개별 파티클 이동 거리 계산
        const dist = (age * baseSpeedPx * speedMult) + (totalMelodyBoost * boostMult);

        const px = cx + Math.cos(ang) * dist;
        const py = cy + Math.sin(ang) * dist;

        // 5. 제각각 다른 파편 크기 (3.8px ~ 7.2px)
        const baseRadius = 3.8 + rSize * 3.4;
        const radius = isMelodyPulsing ? baseRadius * 1.35 : baseRadius;

        if (px >= -80 && px <= W + 80 && py >= -80 && py <= H + 80) {
          particles.push({
            px,
            py,
            ang,
            alpha,
            radius,
            speedMult,
            isMelodyPulsing,
            age,
          });
        }
      }
    }

    return particles;
  }

  // 주어진 시간 t 시점의 그루브 구체 좌/우 Y 좌표를 결정론적으로 계산 (세그먼트 전환 시 100% 연속성 보장)
  _getGrooveOrbPositions(t) {
    let leftY = 0.5;
    let rightY = 0.5;
    const moveEvents = this._orbMoveEvents || (this.timeline?.events || []).filter((e) => e.type === "orb_move");
    if (moveEvents.length > 0) {
      let prevLY = 0.5;
      let prevRY = 0.5;
      for (const ev of moveEvents) {
        if (ev.t > t + 0.5) break;

        const dur = ev.params?.moveDuration || 0.40;
        const targetY = typeof ev.params?.targetY === "number" ? ev.params.targetY : 0.5;

        if (ev.params?.side === "left") {
          if (t >= ev.t) {
            const p = Math.min(1.0, (t - ev.t) / dur);
            const easeP = p * p * (3 - 2 * p);
            leftY = prevLY + (targetY - prevLY) * easeP;
            if (p >= 1.0) { prevLY = targetY; }
          }
        } else if (ev.params?.side === "right") {
          if (t >= ev.t) {
            const p = Math.min(1.0, (t - ev.t) / dur);
            const easeP = p * p * (3 - 2 * p);
            rightY = prevRY + (targetY - prevRY) * easeP;
            if (p >= 1.0) { prevRY = targetY; }
          }
        }
      }
    }
    return { leftY, rightY };
  }

  getOrbs(elapsed, canvas) {
    // 동일 프레임 다중 호출 시 캐시 즉시 반환 (연산 랙 100% 제거)
    if (this._cachedOrbs && Math.abs(this._cachedOrbsElapsed - elapsed) < 0.0002) {
      return this._cachedOrbs;
    }

    let introEndTime = 16;
    if (this.timeline && this.timeline.phases) {
      const introSeg = this.timeline.phases.find((p) => p.phase === "intro");
      if (introSeg) introEndTime = introSeg.endTime;
    }

    const W = (canvas && canvas.width) ? canvas.width : 1280;
    const H = (canvas && canvas.height) ? canvas.height : 720;

    // 원래 구체 크기 (W 기준 0.048, 1280x720 기준 약 61.4px)
    const orbR = 0.048;
    const orbPixelR = orbR * W;

    // 현재 페이즈 및 전환 정보 확인
    const pInfo = this.getPhaseInfo(elapsed, this.timeline);
    const currentPhase = pInfo?.currentPhase || "groove";
    const nextPhase = pInfo?.nextPhase || currentPhase;
    const isTransitioning = pInfo?.isTransitioning || false;
    const transitionProgress = pInfo?.transitionProgress || 0;

    // 브레이크 전후 부드러운 전원 점등/소등 비율 계산 (0.0: 완전 소등, 1.0: 완전 점등)
    let powerRatio = 1.0;
    if (currentPhase === "break") {
      if (isTransitioning && nextPhase !== "break") {
        powerRatio = transitionProgress;
      } else {
        powerRatio = 0.0;
      }
    } else {
      if (isTransitioning && nextPhase === "break") {
        powerRatio = 1.0 - transitionProgress;
      } else {
        powerRatio = 1.0;
      }
    }

    // 1. 등장 연출 (인트로 종료 3초 전부터 화면 외곽에서 슬라이드인)
    let leftX = 0.0;
    let rightX = 1.0;
    let active = false;
    let alpha = 0.0;

    if (elapsed < introEndTime - 3.0) {
      return null;
    } else if (elapsed < introEndTime) {
      const progress = Math.max(0, Math.min(1, (elapsed - (introEndTime - 3.0)) / 3.0));
      const ease = 1 - Math.pow(1 - progress, 3);
      leftX = -orbR * (1 - ease);
      rightX = 1.0 + orbR * (1 - ease);
      alpha = ease;
      active = false;
    } else {
      leftX = 0.0;
      rightX = 1.0;
      alpha = 1.0;
      active = currentPhase !== "break" && powerRatio >= 0.3;
    }

    // 2. 그루브 상하 글라이딩 (결정론적 계산)
    const grooveCurrent = this._getGrooveOrbPositions(elapsed);
    let leftY = grooveCurrent.leftY;
    let rightY = grooveCurrent.rightY;

    // 3. BUILD 1 & BUILD 2: 정 원(Perfect Circle) 연속 회전 물리 모델
    // 맵 밖으로 조금이라도 나가지 않도록 세로 반지름에서 orbPixelR와 여유마진(4px) 제외
    const maxOrbitRadiusPx = Math.max(10, 0.5 * H - orbPixelR - 4);

    let hazardZone = {
      active: false,
      safeRadiusPx: maxOrbitRadiusPx,
      alpha: 0,
      cx: 0.5 * W,
      cy: 0.5 * H,
    };

    // 현재 시간에 정확히 일치하는 build_1 및 build_2 세그먼트 탐색
    const phases = this.phases || this.timeline?.phases || [];
    const currentSegment = pInfo?.currentSegment || phases.find((p) => elapsed >= p.startTime && elapsed < p.endTime);

    // build_1 세그먼트: currentPhase가 build_1이면 currentSegment, build_2이면 직전의 build_1 세그먼트
    let build1Seg = null;
    if (currentPhase === "build_1") {
      build1Seg = currentSegment?.phase === "build_1"
        ? currentSegment
        : phases.find((p) => p.phase === "build_1" && elapsed >= p.startTime - 4.0 && elapsed <= p.endTime + 0.5);
    } else if (currentPhase === "build_2") {
      const curStart = currentSegment ? currentSegment.startTime : elapsed;
      build1Seg = phases.find((p) => p.phase === "build_1" && Math.abs(p.endTime - curStart) < 1.0)
        || phases.find((p) => p.phase === "build_1" && p.endTime <= curStart);
    }

    if (build1Seg && (currentPhase === "build_1" || currentPhase === "build_2")) {
      const t0_b1 = build1Seg.startTime;
      const t1_b1 = build1Seg.endTime;

      // 그루브 종료 시점(t0_b1)의 M(좌)과 C(우)의 실제 위치 계산 (완벽한 유기적 연결)
      const groovePos = this._getGrooveOrbPositions(t0_b1);
      const grooveLY = groovePos.leftY;
      const grooveRY = groovePos.rightY;

      // 화면 중심 (0.5, 0.5) 기준 극좌표 (불변 원점)
      const dxM0 = (0.0 - 0.5) * W; // -0.5 * W (그루브 페이즈 좌측 벽 위치)
      const dyM0 = (grooveLY - 0.5) * H;
      const rM0 = Math.hypot(dxM0, dyM0);
      const thetaM0 = Math.atan2(dyM0, dxM0);

      const dxC0 = (1.0 - 0.5) * W; // +0.5 * W (그루브 페이즈 우측 벽 위치)
      const dyC0 = (grooveRY - 0.5) * H;
      const rC0 = Math.hypot(dxC0, dyC0);
      const thetaC0 = Math.atan2(dyC0, dxC0);

      // 시작 시점의 C와 M 상대 각도 차이 (-PI ~ PI 정규화)
      let diff0 = thetaC0 - thetaM0;
      while (diff0 <= -Math.PI) diff0 += Math.PI * 2;
      while (diff0 > Math.PI) diff0 -= Math.PI * 2;
      const targetDiff = (diff0 >= 0) ? Math.PI : -Math.PI;

      // 킥 목록 가져오기 (build_1 및 build_2 전체를 포함하는 연속 타임라인)
      let kicks = this._kicksBySeg?.get(t0_b1);
      if (!kicks && this.timeline) {
        const allKicks = [
          ...(this.timeline?.events || []).filter((e) => e.instrument === "kick" && e.t >= t0_b1),
          ...(this.timeline?.beats || []).filter((b) => b.instrument === "kick" && b.t >= t0_b1),
        ].sort((a, b) => a.t - b.t);
        kicks = [];
        for (const k of allKicks) {
          if (!kicks.length || k.t - kicks[kicks.length - 1].t > 0.22) kicks.push(k);
        }
        if (!this._kicksBySeg) this._kicksBySeg = new Map();
        this._kicksBySeg.set(t0_b1, kicks);
      }

      // build_1 및 build_2 전체에 걸쳐 단절 없이 부드럽게 이어지는 연속 시계방향 회전 각도
      const deltaAngle = this._getBuildDeltaAngle(elapsed, t0_b1, kicks);

      let isInOrbit = (currentPhase === "build_2");

      if (currentPhase === "build_1") {
        const evalT = Math.min(t1_b1, elapsed);
        const b1Dur = Math.max(1.0, t1_b1 - t0_b1);

        // 궤도 진입 시간: 약 1.0 ~ 1.2초 동안 자연스럽게 궤도 반경으로 수렴
        // (1회전 미만의 약 90도 회전 시점에 이미 궤도 반경에 안착하여 상하단 화면 이탈 방지)
        const enterDur = Math.min(1.2, Math.max(0.95, b1Dur * 0.28));
        const enterProg = Math.max(0, Math.min(1.0, (evalT - t0_b1) / enterDur));
        // easeOutCubic: 초반에 자연스럽게 거리를 좁혀 궤도로 진입
        const enterEase = 1 - Math.pow(1 - enterProg, 3);
        isInOrbit = enterProg >= 1.0;

        // 1. 회전 속도 100% 동일 유지:
        // 궤도 진입 중과 진입 후의 회전 각속도가 deltaAngle(baseSpeed 1.05 rad/s + 부드러운 킥 임펄스)로 완전히 동일!
        const angleM = thetaM0 + deltaAngle;
        const curDiff = diff0 * (1 - enterEase) + targetDiff * enterEase;
        const angleC = angleM + curDiff;

        // 2. 그루브 끝 위치와 100% 유기적 연결 및 단조 감소 거리 (멀어짐 0%):
        // t = t0_b1일 때 leftX = 0.0, leftY = grooveLY, rightX = 1.0, rightY = grooveRY로 완벽 일치!
        // 어떤 인위적 마진 스냅이나 클램프 없이 그루브의 반쯤 걸친 위치에서 자연스럽게 궤도로 진입
        const curDistM = rM0 * (1 - enterEase) + maxOrbitRadiusPx * enterEase;
        const curDistC = rC0 * (1 - enterEase) + maxOrbitRadiusPx * enterEase;

        leftX = 0.5 + (Math.cos(angleM) * curDistM) / W;
        leftY = 0.5 + (Math.sin(angleM) * curDistM) / H;
        rightX = 0.5 + (Math.cos(angleC) * curDistC) / W;
        rightY = 0.5 + (Math.sin(angleC) * curDistC) / H;

        // 3. [위험구역] 오브젝트 거리(curDistM/C)에 100% 맞춰 시작부터 궤도까지 부드럽게 좁혀짐 (단조 감소)
        const currentSafeRadiusPx = Math.max(curDistM, curDistC);
        hazardZone = {
          active: true,
          safeRadiusPx: currentSafeRadiusPx,
          alpha: Math.min(1.0, 0.45 + enterProg * 0.55),
          cx: 0.5 * W,
          cy: 0.5 * H,
        };

      } else if (currentPhase === "build_2" && currentSegment) {
        // [중요] 빌드 1에서 빌드 2로 넘어갈 때 순간이동 방지:
        // 빌드 1과 정확히 100% 동일한 연속 각도 유지 (서로 180도 일직선)
        const t0_b2 = currentSegment.startTime;
        const preDropGap = currentSegment.preDropGapDuration || 0;
        const t1_b2 = currentSegment.endTime - preDropGap;
        const dur_b2 = Math.max(0.5, t1_b2 - t0_b2);

        const shrinkProg = Math.max(0, Math.min(1.0, (elapsed - t0_b2) / dur_b2));
        const shrinkEase = shrinkProg * shrinkProg * (3 - 2 * shrinkProg);

        const curRadiusPx = maxOrbitRadiusPx * (1 - shrinkEase);

        const angleM = thetaM0 + deltaAngle;
        const angleC = angleM + Math.PI;

        leftX = 0.5 + (Math.cos(angleM) * curRadiusPx) / W;
        leftY = 0.5 + (Math.sin(angleM) * curRadiusPx) / H;
        rightX = 0.5 + (Math.cos(angleC) * curRadiusPx) / W;
        rightY = 0.5 + (Math.sin(angleC) * curRadiusPx) / H;

        if (shrinkProg < 0.40) {
          hazardZone = {
            active: true,
            safeRadiusPx: curRadiusPx,
            alpha: 1.0,
            cx: 0.5 * W,
            cy: 0.5 * H,
          };
        } else if (shrinkProg < 0.55) {
          const fade = (0.55 - shrinkProg) / 0.15;
          hazardZone = {
            active: true,
            safeRadiusPx: curRadiusPx,
            alpha: fade,
            cx: 0.5 * W,
            cy: 0.5 * H,
          };
        } else {
          hazardZone = {
            active: false,
            safeRadiusPx: curRadiusPx,
            alpha: 0,
            cx: 0.5 * W,
            cy: 0.5 * H,
          };
        }
      }

    } else if (currentPhase === "drop" || currentPhase === "finale") {
      leftX = 0.5;
      leftY = 0.5;
      rightX = 0.5;
      rightY = 0.5;
      hazardZone = {
        active: false,
        safeRadiusPx: maxOrbitRadiusPx,
        alpha: 0,
        cx: 0.5 * W,
        cy: 0.5 * H,
      };
    }

    const res = {
      left: { x: leftX, y: leftY, r: orbR, rPixels: orbPixelR, active, alpha },
      right: { x: rightX, y: rightY, r: orbR, rPixels: orbPixelR, active, alpha },
      hazardZone,
      powerRatio,
      currentPhase,
      isInOrbit: typeof isInOrbit === "boolean" ? isInOrbit : true,
    };

    this._cachedOrbsElapsed = elapsed;
    this._cachedOrbs = res;
    return res;
  }

  renderEntities(ctx, W, H, elapsed, beatIntensity) {
    const orbs = this.getOrbs(elapsed, ctx.canvas);
    if (!orbs) return;

    // 0. 드랍 페이즈 십자 레이저 및 중앙 백색광 폭발 플래시
    if (orbs.currentPhase === "drop" || orbs.currentPhase === "finale") {
      const pInfo = this.getPhaseInfo(elapsed, this.timeline);
      if (pInfo && pInfo.currentSegment) {
        const dropAnchor = pInfo.currentSegment.dropImpactTime ?? pInfo.currentSegment.startTime;
        const dropElapsed = elapsed - dropAnchor;

        const extendProg = Math.min(1.0, dropElapsed * 6.66);
        const lengthMod = extendProg * extendProg * (3 - 2 * extendProg);
        const maxLen = Math.max(W, H);
        const curLen = maxLen * lengthMod;

        const laserBaseThick = 0.015 * Math.max(W, H);
        const laserThick = laserBaseThick + (beatIntensity * laserBaseThick * 1.5);
        const laserAlpha = 0.6 + (beatIntensity * 0.4);

        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = laserAlpha;
        ctx.fillStyle = "#ffffff";

        const cx = W / 2;
        const cy = H / 2;
        ctx.fillRect(cx - curLen, cy - laserThick, curLen * 2, laserThick * 2);
        ctx.fillRect(cx - laserThick, cy - curLen, laserThick * 2, curLen * 2);
        ctx.restore();

        // 중앙 백색광 -> 보라색 물듦 폭발 플래시 연출 (팡!)
        if (dropElapsed >= 0 && dropElapsed < 1.0) {
          const fade = Math.pow(1.0 - dropElapsed, 2);
          const coreR = orbs.left.rPixels * (1.8 + fade * 2.5);

          ctx.save();
          ctx.globalAlpha = fade;
          ctx.globalCompositeOperation = "lighter";

          const flashGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
          flashGrad.addColorStop(0, "#ffffff");
          flashGrad.addColorStop(0.25, "#ffffff");
          flashGrad.addColorStop(0.55, "#d8b4fe");
          flashGrad.addColorStop(0.85, "#a855f7");
          flashGrad.addColorStop(1, "rgba(168, 85, 247, 0)");

          ctx.fillStyle = flashGrad;
          ctx.beginPath();
          ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
          ctx.fill();

          // 폭발 충격파 링
          const ringR = coreR * (1.2 + (1.0 - fade) * 1.8);
          ctx.strokeStyle = "rgba(255, 255, 255, " + (fade * 0.8) + ")";
          ctx.lineWidth = 6 * fade;
          ctx.beginPath();
          ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
          ctx.stroke();

          ctx.restore();
        }
      }
    }

    // 1. BUILD 1 & BUILD 2 원형 궤도 외곽 위험 영역(Hazard Zone) 렌더링
    if (orbs.hazardZone && orbs.hazardZone.active && orbs.hazardZone.alpha > 0.01) {
      const hz = orbs.hazardZone;
      const safeR = hz.safeRadiusPx;
      const alpha = hz.alpha;
      const cx = hz.cx;
      const cy = hz.cy;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.arc(cx, cy, Math.max(1, safeR), 0, Math.PI * 2, true);
      ctx.fillStyle = "rgba(220, 38, 38, " + (0.22 * alpha) + ")";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, safeR), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(239, 68, 68, " + (0.85 * alpha) + ")";
      ctx.lineWidth = 3.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.setLineDash([14, 10]);
      ctx.lineDashOffset = -elapsed * 35;
      ctx.arc(cx, cy, Math.max(1, safeR + 6), 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 77, 166, " + (0.5 * alpha) + ")";
      ctx.lineWidth = 2.0;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    const list = [orbs.left, orbs.right];
    const powerRatio = typeof orbs.powerRatio === "number" ? orbs.powerRatio : 1.0;

    let chargingSide = null;
    let chargeProgress = 0;
    let firingSide = null;

    const sideEvents = this._sideShockwaveEvents || (this.timeline?.events || []).filter((e) => e.type === "shockwave" && e.params?.side);
    if (sideEvents.length > 0 && powerRatio >= 0.35) {
      for (const ev of sideEvents) {
        const local = elapsed - ev.t;
        const warnDur = ev.warnDuration || 0.75;
        if (local >= -warnDur && local < 0) {
          chargingSide = ev.params.side;
          chargeProgress = (local + warnDur) / warnDur;
        } else if (local >= 0 && local < 0.25) {
          firingSide = ev.params.side;
        }
      }
    }

    // 2. BUILD 1 & BUILD 2: M-C 연결 레이저 시스템 (실제 레이저/경고 발동 시에만 렌더링, 불필요한 점선 연결 삭제)
    let activeMCLaser = null;
    let warningMCLaser = null;
    let mcWarnProgress = 0;

    if ((orbs.currentPhase === "build_1" || orbs.currentPhase === "build_2") && orbs.left.active && orbs.right.active) {
      const mx = orbs.left.x * W;
      const my = orbs.left.y * H;
      const cx = orbs.right.x * W;
      const cy = orbs.right.y * H;
      const midX = (mx + cx) * 0.5;
      const midY = (my + cy) * 0.5;

      const mcLasers = this._mcLaserEvents || (this.timeline?.events || []).filter((e) => e.params?.isMCLaser);
      for (const ev of mcLasers) {
        const local = elapsed - ev.t;
        const warnDur = ev.warnDuration || 0.5;
        const activeDur = ev.activeDuration || 0.26;
        if (!activeMCLaser && local >= 0 && local < activeDur) {
          activeMCLaser = ev;
        }
        if (!warningMCLaser && local >= -warnDur && local < 0) {
          warningMCLaser = ev;
          mcWarnProgress = (local + warnDur) / warnDur;
        }
        if (activeMCLaser && warningMCLaser) break;
      }

      if (activeMCLaser) {
        ctx.save();
        const local = elapsed - activeMCLaser.t;
        const meetDur = 0.04; // 40ms 만에 양쪽에서 맞닿음
        const meetProg = Math.min(1.0, local / meetDur);
        const ease = meetProg * meetProg * (3 - 2 * meetProg);
        const activeDur = activeMCLaser.activeDuration || 0.26;

        // "레이저는 synth 박자에 나오고 바로 서서히 사라지게"
        // 맞닿은 순간부터 activeDur 끝까지 즉시 부드럽게 감쇠(fade-out)
        let fadeAlpha = 1.0;
        if (local > meetDur) {
          const fadeProg = Math.max(0, Math.min(1.0, (local - meetDur) / (activeDur - meetDur)));
          fadeAlpha = Math.pow(1.0 - fadeProg, 1.25);
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, fadeAlpha));

        const baseBeamWidth = (activeMCLaser.params.width || 0.032) * W;
        const beamWidth = baseBeamWidth * (0.35 + 0.65 * fadeAlpha);

        const grad = ctx.createLinearGradient(mx, my, cx, cy);
        grad.addColorStop(0, "#ff4da6");
        grad.addColorStop(0.3, "#ff99cc");
        grad.addColorStop(0.5, "#ffffff");
        grad.addColorStop(0.7, "#99f7ff");
        grad.addColorStop(1, "#4df8ff");

        if (ease < 1.0) {
          // 1-A. 양쪽 구체에서 중앙(midX, midY)을 향해 뿜어져 나오는 두 줄기 레이저
          const p1X = mx + (midX - mx) * ease;
          const p1Y = my + (midY - my) * ease;
          const p2X = cx + (midX - cx) * ease;
          const p2Y = cy + (midY - cy) * ease;

          ctx.strokeStyle = grad;
          ctx.lineWidth = beamWidth;
          ctx.beginPath();
          ctx.moveTo(mx, my); ctx.lineTo(p1X, p1Y);
          ctx.moveTo(cx, cy); ctx.lineTo(p2X, p2Y);
          ctx.stroke();

          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = beamWidth * 0.42;
          ctx.beginPath();
          ctx.moveTo(mx, my); ctx.lineTo(p1X, p1Y);
          ctx.moveTo(cx, cy); ctx.lineTo(p2X, p2Y);
          ctx.stroke();

          // 돌진 중인 빔 헤드 에너지 코어
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(p1X, p1Y, beamWidth * 0.45, 0, Math.PI * 2);
          ctx.arc(p2X, p2Y, beamWidth * 0.45, 0, Math.PI * 2);
          ctx.fill();

        } else {
          // 1-B. 중앙에서 완벽히 맞닿아 관통하는 완전한 초고에너지 레이저 빔 (점진적 페이드아웃)
          ctx.strokeStyle = grad;
          ctx.lineWidth = beamWidth;
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(cx, cy);
          ctx.stroke();

          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = beamWidth * 0.42;
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(cx, cy);
          ctx.stroke();

          const pivotR = (6 + beatIntensity * 5) * fadeAlpha;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(midX, midY, pivotR, 0, Math.PI * 2);
          ctx.fill();

          // 1-C. 중앙에서 딱 맞닿는 순간 터져나오는 눈부신 순백의 충돌 폭발 플래시 (Impact Burst Flash)
          const burstTime = local - meetDur;
          if (burstTime >= 0 && burstTime < 0.20) {
            const burstFade = Math.pow(1.0 - (burstTime / 0.20), 2) * fadeAlpha;
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = Math.max(0, Math.min(1, burstFade));

            // 순백 충돌 코어 구체
            const burstCoreR = 14 + burstFade * 32;
            const bGrad = ctx.createRadialGradient(midX, midY, 0, midX, midY, burstCoreR);
            bGrad.addColorStop(0, "#ffffff");
            bGrad.addColorStop(0.4, "rgba(255, 255, 255, 0.9)");
            bGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
            ctx.fillStyle = bGrad;
            ctx.beginPath();
            ctx.arc(midX, midY, burstCoreR, 0, Math.PI * 2);
            ctx.fill();

            // 충격파 확장 링
            const ringR = 12 + (1.0 - burstFade) * 48;
            ctx.strokeStyle = `rgba(255, 255, 255, ${burstFade * 0.8})`;
            ctx.lineWidth = 3.5 * burstFade;
            ctx.beginPath();
            ctx.arc(midX, midY, ringR, 0, Math.PI * 2);
          }
        }

        ctx.restore();

      } else if (warningMCLaser) {
        ctx.save();
        const blinkFreq = 6 + mcWarnProgress * 18;
        const blinkAlpha = 0.35 + 0.55 * Math.sin(mcWarnProgress * blinkFreq);
        const guideWidth = 2.5 + mcWarnProgress * 4.0;

        ctx.strokeStyle = "rgba(239, 68, 68, " + Math.max(0.2, blinkAlpha) + ")";
        ctx.lineWidth = guideWidth;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(cx, cy);
        ctx.stroke();

        ctx.fillStyle = "rgba(239, 68, 68, " + Math.max(0.4, blinkAlpha) + ")";
        ctx.beginPath();
        ctx.arc(midX, midY, 4 + mcWarnProgress * 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // 2-B. M-C 레이저 맞닿음 폭발로 맵 바깥으로 퍼져나가는 하얀색 파티클(탄막) 렌더링
    if (orbs.currentPhase === "build_1" || orbs.currentPhase === "build_2") {
      const mcParticles = this._getMCLaserParticles(elapsed, W, H);
      if (mcParticles.length > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";

        for (const pt of mcParticles) {
          ctx.globalAlpha = pt.alpha;

          // 멜로디 박자에 맞춰 순간 가속 중일 때: 뒤쪽으로 뿜어지는 하얀색 스파크 트레일 (속도에 비례)
          if (pt.isMelodyPulsing) {
            const tailLen = (12 + pt.radius * 2.2) * (pt.speedMult || 1.0);
            const tailX = pt.px - Math.cos(pt.ang) * tailLen;
            const tailY = pt.py - Math.sin(pt.ang) * tailLen;

            ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
            ctx.lineWidth = Math.max(1.8, pt.radius * 0.45);
            ctx.beginPath();
            ctx.moveTo(tailX, tailY);
            ctx.lineTo(pt.px, pt.py);
            ctx.stroke();
          }

          // 외곽 순백 네온 블룸 글로우
          const glowR = pt.radius * 2.6;
          const pGrad = ctx.createRadialGradient(pt.px, pt.py, pt.radius * 0.3, pt.px, pt.py, glowR);
          pGrad.addColorStop(0, "#ffffff");
          pGrad.addColorStop(0.35, "rgba(255, 255, 255, 0.7)");
          pGrad.addColorStop(0.7, "rgba(215, 245, 255, 0.35)");
          pGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
          ctx.fillStyle = pGrad;
          ctx.beginPath();
          ctx.arc(pt.px, pt.py, glowR, 0, Math.PI * 2);
          ctx.fill();

          // 중심 순백 코어 구체
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(pt.px, pt.py, pt.radius, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      }
    }

    // 3. M / C 구체 렌더링
    const p = Math.max(0, Math.min(1, powerRatio)); // 0.0 (완전 소등) ~ 1.0 (완전 점등)

    for (let i = 0; i < list.length; i++) {
      const orb = list[i];
      const side = i === 0 ? "left" : "right";
      const cx = orb.x * W;
      const cy = orb.y * H;
      const r = orb.rPixels;
      const alpha = orb.alpha;
      if (alpha <= 0.001) continue;

      const dx = (orbs.left.x - orbs.right.x) * W;
      const dy = (orbs.left.y - orbs.right.y) * H;
      const dist = Math.hypot(dx, dy);
      const hitRadius = (orbs.left.rPixels) * 2.8;
      let whiteout = 0;
      if (dist < hitRadius && (orbs.currentPhase === "build_1" || orbs.currentPhase === "build_2")) {
        whiteout = 1.0 - (dist / hitRadius);
      }

      const isCharging = chargingSide === side || (warningMCLaser !== null);
      const isFiring = firingSide === side || (activeMCLaser !== null);

      const isMerged = (orbs.currentPhase === "drop" || orbs.currentPhase === "finale");
      // 드랍/피날레에서 두 구체가 중심(0.5, 0.5)으로 융합된 경우 중복 렌더링을 방지하고 신비로운 보라색(#a855f7)으로 단일 렌더링
      if (isMerged && i === 1) continue;

      const isCyan = !isMerged && (side === "right");

      // [부드러운 브레이크 소등/점등 보간]
      // 딱딱 끊기는 if문 대신, 배경색(20, 12, 32)과 네온 원색 사이를 powerRatio로 100% 매끄럽게 선형 보간!
      const primRGB = isMerged
        ? { r: 168, g: 85, b: 247 }
        : (isCyan ? { r: 77, g: 248, b: 255 } : { r: 255, g: 77, b: 166 });
      const chargeRGB = isMerged
        ? { r: 216, g: 180, b: 254 }
        : (isCyan ? { r: 179, g: 252, b: 255 } : { r: 255, g: 179, b: 217 });
      const stop1RGB = isMerged
        ? { r: 147, g: 51, b: 234 }
        : (isCyan ? { r: 0, g: 204, b: 204 } : { r: 230, g: 25, b: 133 });
      const stop2RGB = isMerged
        ? { r: 107, g: 33, b: 168 }
        : (isCyan ? { r: 0, g: 128, b: 128 } : { r: 179, g: 0, b: 89 });
      const borderRGB = isMerged
        ? { r: 168, g: 85, b: 247 }
        : (isCyan ? { r: 0, g: 230, b: 230 } : { r: 255, g: 0, b: 127 });

      // 중심 백색 코어 (소등 시 다크 메탈릭으로 부드럽게 암전)
      const cCore = `rgb(${Math.round(28 + 227 * p)}, ${Math.round(18 + 237 * p)}, ${Math.round(42 + 213 * p)})`;
      const curPrimary = `rgb(${Math.round(22 + (primRGB.r - 22) * p)}, ${Math.round(14 + (primRGB.g - 14) * p)}, ${Math.round(34 + (primRGB.b - 34) * p)})`;
      const curCharge = `rgb(${Math.round(30 + (chargeRGB.r - 30) * p)}, ${Math.round(20 + (chargeRGB.g - 20) * p)}, ${Math.round(45 + (chargeRGB.b - 45) * p)})`;
      const curStop1 = `rgb(${Math.round(16 + (stop1RGB.r - 16) * p)}, ${Math.round(10 + (stop1RGB.g - 10) * p)}, ${Math.round(26 + (stop1RGB.b - 26) * p)})`;
      const curStop2 = `rgb(${Math.round(12 + (stop2RGB.r - 12) * p)}, ${Math.round(8 + (stop2RGB.g - 8) * p)}, ${Math.round(20 + (stop2RGB.b - 20) * p)})`;

      const pulse = isFiring ? 1.25 : (1.0 + beatIntensity * 0.07 * p);
      const curR = r * (0.88 + 0.12 * p) * pulse;

      ctx.save();
      ctx.globalAlpha = alpha;

      // 1. 외곽 부드러운 네온 글로우 오라 (powerRatio 제곱 감쇠로 자연스럽게 소등)
      if (p > 0.01) {
        const glowAlpha = alpha * Math.pow(p, 1.8);
        const glowGrad = ctx.createRadialGradient(cx, cy, curR * 0.5, cx, cy, curR * 2.6);
        glowGrad.addColorStop(0, isCharging ? curCharge : curPrimary);
        const auraColor = isMerged
          ? `rgba(168, 85, 247, ${0.40 * p})`
          : (isCyan ? `rgba(77, 248, 255, ${0.35 * p})` : `rgba(255, 77, 166, ${0.35 * p})`);
        glowGrad.addColorStop(0.4, auraColor);
        glowGrad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.save();
        ctx.globalAlpha = glowAlpha;
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, curR * 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 2. 구체 본체 그라데이션
      const bodyGrad = ctx.createRadialGradient(cx, cy, curR * 0.1, cx, cy, curR);
      bodyGrad.addColorStop(0, cCore);
      bodyGrad.addColorStop(0.3, isCharging ? curCharge : curPrimary);
      bodyGrad.addColorStop(0.75, curStop1);
      bodyGrad.addColorStop(1, curStop2);
      ctx.fillStyle = bodyGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, curR, 0, Math.PI * 2);
      ctx.fill();

      // 화이트아웃 오버레이 (Whiteout Explosion): 본연의 색을 잃고 순백으로 끓어오름
      if (whiteout > 0.01) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = Math.min(1.0, whiteout * 1.5) * alpha;

        const whiteGrad = ctx.createRadialGradient(cx, cy, curR * 0.1, cx, cy, curR * 1.3);
        whiteGrad.addColorStop(0, "#ffffff");
        const whiteMidColor = isMerged ? "#e9d5ff" : (isCyan ? "#e0ffff" : "#ffe0f0");
        whiteGrad.addColorStop(0.4, whiteMidColor);
        whiteGrad.addColorStop(1, "rgba(255, 255, 255, 0)");

        ctx.fillStyle = whiteGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, curR * 1.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 외곽 테두리 (소등 시 배경 톤의 은은한 림 라이트로 부드럽게 블렌딩)
      const borderAlpha = 0.2 + 0.8 * p;
      ctx.strokeStyle = `rgba(${Math.round(65 + (borderRGB.r - 65) * p)}, ${Math.round(45 + (borderRGB.g - 45) * p)}, ${Math.round(85 + (borderRGB.b - 85) * p)}, ${borderAlpha})`;
      ctx.lineWidth = Math.max(2, curR * 0.08);
      ctx.beginPath();
      ctx.arc(cx, cy, curR, 0, Math.PI * 2);
      ctx.stroke();

      // 소등 상태에서는 오직 중앙의 미세한 스탠바이 대기 LED 인디케이터만 부드럽게 숨쉼
      if (p < 0.98) {
        const standbyProg = Math.sin(elapsed * 2.8) * 0.5 + 0.5;
        const ledAlpha = (1.0 - p) * (0.35 + 0.50 * standbyProg);
        const ledColor = isMerged
          ? `rgba(192, 132, 252, ${ledAlpha})`
          : (isCyan ? `rgba(85, 247, 247, ${ledAlpha})` : `rgba(255, 77, 166, ${ledAlpha})`);
        ctx.fillStyle = ledColor;
        ctx.beginPath();
        ctx.arc(cx, cy, curR * 0.25, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    // 4. 백색광 응축 (Whiteout Explosion) 중심점 이펙트 (빌드 페이즈 전용 롤백)
    if (orbs.currentPhase === "build_1" || orbs.currentPhase === "build_2") {
      const dx = (orbs.left.x - orbs.right.x) * W;
      const dy = (orbs.left.y - orbs.right.y) * H;
      const dist = Math.hypot(dx, dy);

      const baseR = orbs.left.rPixels;
      const hitRadius = baseR * 3.2;

      if (dist < hitRadius) {
        const overlap = 1.0 - (dist / hitRadius);
        const midX = (orbs.left.x + orbs.right.x) / 2 * W;
        const midY = (orbs.left.y + orbs.right.y) / 2 * H;

        // 겹치는 영역에서 터져나오는 눈부신 순백의 에너지 코어
        const coreR = baseR * (0.8 + overlap * 2.2) * (1.0 + beatIntensity * 0.2);

        ctx.save();
        ctx.globalAlpha = Math.min(1.0, overlap * 2.0) * orbs.left.alpha;
        ctx.globalCompositeOperation = "lighter";

        const wGrad = ctx.createRadialGradient(midX, midY, 0, midX, midY, coreR);
        wGrad.addColorStop(0, "#ffffff");
        wGrad.addColorStop(0.4, "#ffffff");
        wGrad.addColorStop(0.75, "rgba(255, 255, 255, 0.6)");
        wGrad.addColorStop(1, "rgba(255, 255, 255, 0)");

        ctx.fillStyle = wGrad;
        ctx.beginPath();
        ctx.arc(midX, midY, coreR, 0, Math.PI * 2);
        ctx.fill();

        // 중심 고에너지 백색 링
        const ringR = coreR * 0.7;
        ctx.strokeStyle = "rgba(255, 255, 255, " + Math.min(1.0, overlap * 1.5) + ")";
        ctx.lineWidth = Math.max(2, 4 * overlap);
        ctx.beginPath();
        ctx.arc(midX, midY, ringR, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
      }
    }
  }

      checkCollision(player, elapsed, canvas) {
    const orbs = this.getOrbs(elapsed, canvas);
    if (!orbs) return false;

    const W = (canvas && canvas.width) ? canvas.width : 1280;
    const H = (canvas && canvas.height) ? canvas.height : 720;
    const PLAYER_RADIUS_PX = 0.003 * W;

    // 1. M / C 구체 직접 피격 판정 (픽셀 공간 정확한 정원 거리 계산)
    if (orbs.left.active || orbs.right.active) {
      const hitR = orbs.left.rPixels + PLAYER_RADIUS_PX;
      const lDist = Math.hypot((player.x - orbs.left.x) * W, (player.y - orbs.left.y) * H);
      const rDist = Math.hypot((player.x - orbs.right.x) * W, (player.y - orbs.right.y) * H);
      if (lDist < hitR || rDist < hitR) return true;
    }

    // 2. BUILD 1 & BUILD 2 원형 궤도 외곽 위험 영역(Hazard Zone) 피격 판정
    if (orbs.hazardZone && orbs.hazardZone.active && orbs.hazardZone.alpha > 0.4) {
      const pDist = Math.hypot((player.x - 0.5) * W, (player.y - 0.5) * H);
      if (pDist > orbs.hazardZone.safeRadiusPx + PLAYER_RADIUS_PX) return true;
    }

    // 3. 드랍 페이즈 십자 레이저 충돌 검사
    if (orbs.currentPhase === "drop" || orbs.currentPhase === "finale") {
      const laserBaseThick = 0.015;
      const beatInt = this.lastBeatIntensity || 0;
      const laserThickPx = (laserBaseThick + (beatInt * laserBaseThick * 1.5)) * Math.max(W, H);
      if (Math.abs((player.y - 0.5) * H) < laserThickPx + PLAYER_RADIUS_PX) return true;
      if (Math.abs((player.x - 0.5) * W) < laserThickPx + PLAYER_RADIUS_PX) return true;
    }

    // 4. BUILD 1 & BUILD 2: M-C 레이저 맞닿음 폭발 하얀색 파티클(탄막) 피격 판정
    if (orbs.currentPhase === "build_1" || orbs.currentPhase === "build_2") {
      const mcParticles = this._getMCLaserParticles(elapsed, W, H);
      for (const pt of mcParticles) {
        if (pt.alpha < 0.25) continue;
        const pDist = Math.hypot(player.x * W - pt.px, player.y * H - pt.py);
        if (pDist < pt.radius + PLAYER_RADIUS_PX) {
          return true;
        }
      }
    }

    return false;
  }
}

