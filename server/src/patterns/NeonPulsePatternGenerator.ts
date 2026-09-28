import { InstrumentOnset, ObstacleEvent, PhaseTimelineSegment, PhaseType, Instrument } from "../types";
import { PatternGenerator, AudioAnalysisResult } from "./types";
import { mulberry32 } from "../utils/random";

interface GrooveOrbMover {
  fromY: number;
  targetY: number;
  startTime: number;
  duration: number;
}

interface GrooveOrbState {
  left: GrooveOrbMover;
  right: GrooveOrbMover;
  kickSide: "left" | "right";
  hihatSide: "left" | "right";
}

function getGrooveOrbY(orb: GrooveOrbMover, t: number): number {
  if (t <= orb.startTime) return orb.fromY;
  if (t >= orb.startTime + orb.duration) return orb.targetY;
  const p = (t - orb.startTime) / orb.duration;
  const easeP = p * p * (3 - 2 * p); // smoothstep interpolation
  return orb.fromY + (orb.targetY - orb.fromY) * easeP;
}

/**
 * NeonPulse 테마 전용 악기 이벤트 변환기:
 * - kick  -> 구체 몸체 shockwave 또는 바닥 비트 충격파
 * - snare -> 세로 네온 레이저
 * - melody-> 타깃 조준 단발 레이저 (blaster)
 * - hihat -> 구체 상하 이동 (orb_move) 또는 외곽 스윕 레이저 (sweep_laser)
 * - drop  -> 거대 압살 벽 (wall_crush)
 */
function makeNeonPulseInstrumentEvent(
  onset: InstrumentOnset,
  stage: number,
  rand: () => number,
  melodyIndex: { v: number; lastPitch?: number; lastY?: number },
  phase?: PhaseType,
  grooveOrbState?: GrooveOrbState,
  dropIntensity: number = 0.5
): ObstacleEvent | null {
  const { t, energy, band } = onset;
  let { instrument } = onset;

  // 스테이지별 경고 시간 (인트로는 +0.25초 추가 여유 부여)
  let warnDuration = stage === 1 ? 0.75 : stage === 2 ? 0.62 : 0.5;
  if (phase === "intro") {
    warnDuration += 0.25;
  }

  let type: ObstacleEvent["type"];
  let activeDuration = 0.35;
  const params: ObstacleEvent["params"] = {
    x: 0.5,
    y: 0.5,
  };

  const speedMult = stage === 1 ? 0.9 : stage === 2 ? 1.05 : 1.2;

  if (instrument === "kick") {
    // 1. 킥: 그루브 페이즈에서 M/C 구체에서만 충격파 링 발동 (무작위 위치 생성 제거)
    if (phase === "groove" && grooveOrbState) {
      type = "shockwave";
      activeDuration = 0.65;
      
      let baseRadius = 0.45 + energy * 0.15;
      if (onset.accent === "strong") baseRadius *= 1.2;
      else if (onset.accent === "weak") baseRadius *= 0.7;
      if (onset.density === "high") baseRadius *= 0.8;

      if (onset.patternIndex === 0 || !grooveOrbState.kickSide) {
        grooveOrbState.kickSide = rand() < 0.5 ? "left" : "right";
      } else {
        grooveOrbState.kickSide = grooveOrbState.kickSide === "left" ? "right" : "left";
      }
      
      const side = grooveOrbState.kickSide;
      const orbMover = side === "left" ? grooveOrbState.left : grooveOrbState.right;
      const orbY = getGrooveOrbY(orbMover, onset.t);
      params.x = side === "left" ? 0.0 : 1.0;
      params.y = orbY;
      params.side = side;
      params.radius = baseRadius * 0.8;
      activeDuration = 1.35;
      warnDuration = Math.max(warnDuration, 0.85);
      params.speed = (params.radius / activeDuration) * speedMult;
    } else {
      // 그루브 외의 페이즈에서는 허공에 뜨는 무작위 충격파링 생성 금지
      return null;
    }
  } else if (instrument === "snare") {
    // 2. 화음/신스: 빌드에서는 M-C 연결 레이저, 그루브에서는 기본 세로 네온 레이저 생성
    if (phase === "build_1" || phase === "build_2") {
      // 빌드 패턴: 수렴하는 M/C 구체들을 잇는 연결 레이저 (synth 박자에 맞춰 발동 후 즉시 서서히 페이드아웃)
      type = "laser";
      warnDuration = 0.50;
      activeDuration = 0.26;
      params.x = 0.5;
      params.y = 0.5;
      params.isMCLaser = true;
      params.width = 0.032;
    } else if (phase === "groove") {
      // 기본 맵을 가로지르는 레이저는 그루브 패턴에만 생성
      type = "laser";
      activeDuration = onset.duration ? Math.max(0.25, onset.duration) : 0.35;
      let baseWidth = 0.026 + energy * 0.016;
      if (onset.accent === "strong") baseWidth *= 1.3;
      if (onset.density === "high") baseWidth *= 0.8;
      
      params.direction = "vertical";
      params.width = baseWidth;
      const edgePad = 0.12;
      params.x = edgePad + rand() * (1 - 2 * edgePad);
      params.y = 0.5;
    } else {
      // 기본 맵을 가로지르는 레이저는 그루브 패턴에만 나오므로 그 외 페이즈(intro, break, drop, finale 등)에서는 미생성
      return null;
    }
  } else if (instrument === "melody") {
    // 3. 멜로디: 빌드 패턴에서는 탄막 미생성 (하얀색 파티클 가속 요소로만 동작)
    if (phase === "build_1" || phase === "build_2") {
      return null;
    }
    type = "melody_bolt";
    activeDuration = 0.45;
    
    const currentPitch = onset.pitch ?? (0.3 + rand() * 0.4);
    let targetY: number;
    if (typeof onset.pitch === "number") {
      targetY = 0.90 - currentPitch * 0.80;
      targetY = Math.max(0.08, Math.min(0.92, targetY));
    } else {
      const step = (melodyIndex.v % 5) / 4;
      targetY = 0.18 + step * 0.64;
    }
    
    const fromLeft = melodyIndex.v % 2 === 0;
    params.startX = fromLeft ? 0.0 : 1.0;
    params.x = params.startX;
    params.y = targetY;
    params.targetY = targetY;
    params.targetX = fromLeft ? (0.35 + rand() * 0.30) : (0.65 - rand() * 0.30);
    params.width = 0.048 + energy * 0.016;
    melodyIndex.v++;
  } else if (instrument === "hihat") {
    // 4. 하이햇: 그루브 구체 이동 트리거 (모서리 스윕 레이저 삭제)
    if (phase === "groove" && grooveOrbState) {
      type = "orb_move";
      activeDuration = 0.40;
      warnDuration = 0.05;
      const side = grooveOrbState.hihatSide;
      grooveOrbState.hihatSide = side === "left" ? "right" : "left";
      const orbMover = side === "left" ? grooveOrbState.left : grooveOrbState.right;
      const currentY = getGrooveOrbY(orbMover, onset.t);
      let targetY = 0.18 + rand() * 0.64;
      if (Math.abs(targetY - currentY) < 0.22) {
        targetY = currentY > 0.5 ? currentY - 0.28 : currentY + 0.28;
      }
      targetY = Math.max(0.18, Math.min(0.82, targetY));

      orbMover.fromY = currentY;
      orbMover.targetY = targetY;
      orbMover.startTime = onset.t;
      orbMover.duration = 0.40;

      params.side = side;
      params.x = side === "left" ? 0.0 : 1.0;
      params.y = targetY;
      params.targetY = targetY;
      params.fromY = currentY;
      params.moveDuration = 0.40;
    } else {
      // 모서리 스윕 레이저(sweep_laser) 삭제
      return null;
    }
  } else if (instrument === "drop") {
    // 5. 드롭: 월 크러시(wall_crush) 패턴 자체 완전 삭제
    return null;
  } else {
    return null;
  }

  return {
    t,
    warnDuration,
    activeDuration,
    holdDuration: onset.holdDuration ?? activeDuration,
    duration: onset.duration ?? activeDuration,
    pitch: onset.pitch,
    pitchDelta: onset.pitchDelta,
    pitchDirection: onset.pitchDirection,
    type,
    instrument,
    band,
    energy,
    params,
  };
}



/**
 * NeonPulse 테마 패턴 생성기
 */
export class NeonPulsePatternGenerator implements PatternGenerator {
  themeId = "neon_pulse";

  generateEvents(
    analysis: AudioAnalysisResult,
    stage: number,
    seed: number
  ): ObstacleEvent[] {
    const { onsets, durationSec, phases } = analysis;
    const rand = mulberry32(seed);

    const VALID_INSTRUMENTS = new Set<string>(["kick", "snare", "melody", "hihat", "drop"]);
    const trimmed = onsets.filter((o) => o.t <= durationSec && VALID_INSTRUMENTS.has(o.instrument));

    function getPhaseSegmentAtTime(t: number): PhaseTimelineSegment | undefined {
      if (!phases || phases.length === 0) return undefined;
      return phases.find((p) => t >= p.startTime && t < p.endTime);
    }

    function getPhaseAtTime(t: number): PhaseType {
      const seg = getPhaseSegmentAtTime(t);
      return seg ? seg.phase : "groove";
    }

    const priorityOrder: Record<Instrument, number> = {
      drop: 5,
      kick: 4,
      snare: 3,
      melody: 2,
      hihat: 1,
    };

    let events: ObstacleEvent[] = [];
    const melodyIndex = { v: 0 };
    let lastIntroEventTime = -999;
    let lastHihatMoveTime = -999;

    const grooveOrbState: GrooveOrbState = {
      left: { fromY: 0.5, targetY: 0.5, startTime: 0, duration: 0.40 },
      right: { fromY: 0.5, targetY: 0.5, startTime: 0, duration: 0.40 },
      kickSide: "left",
      hihatSide: "left",
    };

    // 브레이크 페이즈 세그먼트별로 스네어와 멜로디 중 빈도가 더 많은 악기 사전 결정
    const breakDominantInstrument = new Map<PhaseTimelineSegment, "snare" | "melody">();
    if (phases) {
      const breakSegments = phases.filter((p) => p.phase === "break");
      for (const seg of breakSegments) {
        let snareCount = 0;
        let melodyCount = 0;
        for (const o of trimmed) {
          if (o.t >= seg.startTime && o.t < seg.endTime) {
            if (o.instrument === "snare") snareCount++;
            else if (o.instrument === "melody") melodyCount++;
          }
        }
        breakDominantInstrument.set(seg, melodyCount >= snareCount ? "melody" : "snare");
      }
    }

    // 1. SYNTH(snare)와 MELODY(melody) 패턴: 원시 감지(rawOnsets) 그대로 100% 1:1 최종 게임 이벤트에 생성
    for (const onset of trimmed) {
      if (onset.instrument === "snare" || onset.instrument === "melody") {
        const dropInt = getPhaseSegmentAtTime(onset.t)?.dropIntensity ?? 0.5;
        const phase = getPhaseAtTime(onset.t);
        const ev = makeNeonPulseInstrumentEvent(onset, stage, rand, melodyIndex, phase, grooveOrbState, dropInt);
        if (ev) {
          events.push(ev);
        }
      }
    }

    let i = 0;
    while (i < trimmed.length) {
      const clusterStart = trimmed[i].t;
      const cluster: InstrumentOnset[] = [];
      while (i < trimmed.length && trimmed[i].t - clusterStart <= 0.08) {
        cluster.push(trimmed[i]);
        i++;
      }

      const currentPhase = getPhaseAtTime(clusterStart);

      // 2. KICK / HIHAT 및 테마 고유 기믹 패턴 생성 (SYNTH/MELODY는 1:1 생성 완료, DROP(월크러시)은 완전 삭제)
      let candidates: InstrumentOnset[] = cluster.filter(
        (o) => o.instrument !== "snare" && o.instrument !== "melody" && o.instrument !== "drop"
      );

      // 난이도별(stage) 허용 악기 필터링
      if (stage === 1) {
        candidates = candidates.filter((o) => o.instrument === "kick");
      } else if (stage === 2) {
        candidates = candidates.filter((o) => o.instrument !== "hihat");
      }

      if (currentPhase === "intro") {
        // 인트로는 단일 악기 제한
        if (candidates.length === 0) continue;
      } else if (currentPhase === "break") {
        if (candidates.length === 0) continue;
      } else if (currentPhase === "groove") {
        // 하이햇은 구체 상하 이동(orb_move) 이벤트로 별도 처리
        const hihatOnset = cluster.find((o) => o.instrument === "hihat");
        if (hihatOnset && clusterStart - lastHihatMoveTime >= 0.45) {
          const dropInt = getPhaseSegmentAtTime(clusterStart)?.dropIntensity ?? 0.5;
          const ev = makeNeonPulseInstrumentEvent(hihatOnset, stage, rand, melodyIndex, currentPhase, grooveOrbState, dropInt);
          if (ev) events.push(ev);
          lastHihatMoveTime = clusterStart;
        }

        candidates = candidates.filter((o) => o.instrument !== "hihat");
        if (candidates.length === 0) continue;
      } else if (currentPhase === "build_1" || currentPhase === "build_2") {
        // BUILD 1 & BUILD 2: 킥 펄스(화면 줌 펄스) 생성
        // (SYNTH는 상단 루프에서 M-C 연결 레이저로 이미 100% 생성 완료됨)
        const kick = cluster.find((o) => o.instrument === "kick");
        if (kick) {
          events.push({
            t: kick.t,
            warnDuration: 0,
            activeDuration: 0.1,
            type: "beat_pulse",
            instrument: "kick",
            band: "low",
            energy: kick.energy,
            params: {
              x: 0.5,
              y: 0.5,
              isBuildKick: true,
              noCollision: true,
            },
          });
        }
        continue;
      }

      let maxConcurrent = currentPhase === "intro" ? 1 : (stage === 1 ? 1 : stage === 2 ? 2 : 3);
      if (currentPhase === "drop") maxConcurrent = Math.min(4, maxConcurrent + 1);

      const selected = candidates
        .sort((a, b) => priorityOrder[b.instrument] - priorityOrder[a.instrument] || b.energy - a.energy)
        .slice(0, maxConcurrent)
        .sort((a, b) => a.t - b.t);

      for (const onset of selected) {
        const dropInt = getPhaseSegmentAtTime(clusterStart)?.dropIntensity ?? 0.5;
        const ev = makeNeonPulseInstrumentEvent(onset, stage, rand, melodyIndex, currentPhase, grooveOrbState, dropInt);
        if (ev) {
          events.push(ev);
        }
        if (currentPhase === "intro") {
          lastIntroEventTime = clusterStart;
        }
      }

    }

    // 프리드랍(Pre-drop) 쉼 구간 장애물 완전 제거 (단, 원시 감지와 1:1 일치해야 하는 SYNTH와 MELODY는 유지)
    if (phases) {
      for (const p of phases) {
        if (p.preDropGapDuration && p.preDropGapDuration >= 0.4) {
          const preDropStart = p.endTime - p.preDropGapDuration;
          const preDropEnd = p.endTime;
          events = events.filter((ev) => {
            if (ev.instrument === "snare" || ev.instrument === "melody") return true;
            return ev.t < preDropStart || ev.t >= preDropEnd;
          });
        }
      }
    }

    events.sort((a, b) => a.t - b.t);
    return events;
  }
}
