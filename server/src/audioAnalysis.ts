import { spawn } from "child_process";
// @ts-ignore - ffmpeg-static exports a string path with no types
import ffmpegPath from "ffmpeg-static";
import { ObstacleEvent, Timeline, InstrumentType, PhaseTimelineSegment, PhaseType, TimelineData, BeatPulse, Instrument, InstrumentOnset } from "./types";
import { AudioAnalysisResult, getPatternGenerator, registerPatternGenerator, PatternGenerator } from "./patterns";
import { buildTimeline } from "./timelineBuilder";

export { Instrument, InstrumentOnset } from "./types";

const SAMPLE_RATE = 22050;
const FRAME_SIZE = 1024; // FFT 윈도우 크기
const HOP = 512; // 50% 오버랩
const FRAME_SEC = HOP / SAMPLE_RATE;

/** 4대 핵심 주파수 대역 (드럼, 신스/화음, 멜로디, 하이햇) */
const INSTRUMENT_RANGES: Record<Exclude<Instrument, "drop">, [number, number]> = {
  kick: [30, 300],      // 킥 + 스네어 드럼 통합 메인 비트 (30~300Hz)
  snare: [400, 2000],   // 중음역대 신디사이저 / 화음 (400~2000Hz)
  melody: [2000, 4200], // 리드 신스, 보컬, 멜로디 음표 (2000~4200Hz)
  hihat: [4200, 10000], // 찰랑거리는 하이햇, 셰이커 (4200~10000Hz)
};

/** ffmpeg로 오디오 파일을 16bit mono PCM으로 디코딩한다. maxDurationSec을 주면 그 길이까지만 디코딩해 분석 속도를 높인다. */
export function decodeToPCM(filePath: string, maxDurationSec?: number): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ["-i", filePath];
    if (maxDurationSec) args.push("-t", String(Math.ceil(maxDurationSec) + 1));
    args.push("-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-");

    const proc = spawn(ffmpegPath as unknown as string, args);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", () => {
      /* ffmpeg 로그는 무시 */
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (chunks.length === 0) {
        reject(new Error(`ffmpeg decode failed (code ${code})`));
        return;
      }
      const buf = Buffer.concat(chunks);
      const samples = new Float32Array(buf.length / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buf.readInt16LE(i * 2) / 32768;
      }
      resolve(samples);
    });
  });
}

/** 반복(iterative) radix-2 Cooley-Tukey FFT. re/im 길이는 2의 거듭제곱이어야 한다. 결과는 in-place로 re/im에 저장. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
}

const HANN = (() => {
  const w = new Float64Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1));
  return w;
})();

/**
 * 오디오를 세부 대역(킥, 스네어, 멜로디, 하이햇, 드롭)으로 나눠 정밀 분석.
 * 1. Log-compressed Spectral Flux 및 Local Peak Picking 기반 온셋 감지 (지속음 오검출 억제)
 * 2. Crest Factor(피크 집중도) 분석을 통한 멜로디(피치) vs 하이햇(노이즈) 분리
 * 3. 스네어 특성(중저역 바디 + 고역 와이어 동시 폭발)과 킥(초저역 중심) 충돌 방지 및 중재
 */
export function detectInstrumentOnsets(samples: Float32Array): InstrumentOnset[] {
  const frameCount = Math.max(0, Math.floor((samples.length - FRAME_SIZE) / HOP));
  const numBins = FRAME_SIZE / 2; // 512
  const binHz = SAMPLE_RATE / FRAME_SIZE; // ~21.533 Hz

  const binKick: [number, number] = [Math.max(1, Math.floor(30 / binHz)), Math.min(numBins - 1, Math.ceil(300 / binHz))]; // Legacy for reference
  const binSub: [number, number] = [Math.max(1, Math.floor(30 / binHz)), Math.min(numBins - 1, Math.ceil(80 / binHz))]; // 30~80Hz
  const binKickBand: [number, number] = [Math.max(1, Math.floor(80 / binHz)), Math.min(numBins - 1, Math.ceil(180 / binHz))]; // 80~180Hz
  const binLowMid: [number, number] = [Math.max(1, Math.floor(180 / binHz)), Math.min(numBins - 1, Math.ceil(300 / binHz))]; // 180~300Hz
  const binSnare: [number, number] = [Math.max(1, Math.floor(400 / binHz)), Math.min(numBins - 1, Math.ceil(2000 / binHz))]; // 400~2000Hz (중음역대 화음/신디사이저 - 기존 snare 슬롯 재사용)
  const binMelody: [number, number] = [Math.max(1, Math.floor(2000 / binHz)), Math.min(numBins - 1, Math.ceil(4200 / binHz))]; // 2000~4200Hz (보컬, 리드 멜로디)
  const binHigh: [number, number] = [Math.max(1, Math.floor(4500 / binHz)), Math.min(numBins - 1, Math.ceil(10000 / binHz))]; // 4.5~10kHz

  // 1. 프레임별 복소 FFT 및 로그 압축 스펙트럼(Log-compressed Magnitude) 계산
  const magFrames: Float32Array[] = [];
  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);

  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP;
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = (samples[start + i] ?? 0) * HANN[i];
      im[i] = 0;
    }
    fft(re, im);

    const mag = new Float32Array(numBins);
    for (let b = 0; b < numBins; b++) {
      const val = Math.hypot(re[b], im[b]);
      mag[b] = Math.log1p(10 * val); // Log compression: 약한 신호 보존 및 거대 피크 포화 방지
    }
    magFrames.push(mag);
  }

  // 2. Bin별 Half-wave Rectified Difference 및 Subband Spectral Flux 계산
  const rawKickFlux = new Float32Array(frameCount);
  const rawSnareFlux = new Float32Array(frameCount);
  const rawSnarePitch = new Float32Array(frameCount);
  const rawMelodyFlux = new Float32Array(frameCount);
  const rawMelodyPitch = new Float32Array(frameCount);
  const rawHihatFlux = new Float32Array(frameCount);
  const rawTotalFlux = new Float32Array(frameCount);
  const rawTotalEnergy = new Float32Array(frameCount);

  // KICK Feature Arrays
  const subEnergyArr = new Float32Array(frameCount);
  const kickCoreEnergyArr = new Float32Array(frameCount);
  const lowMidEnergyArr = new Float32Array(frameCount);
  const totalLowEnergyArr = new Float32Array(frameCount);
  const highEnergyArr = new Float32Array(frameCount);
  const subDiffArr = new Float32Array(frameCount);
  const kickCoreDiffArr = new Float32Array(frameCount);
  const lowMidDiffArr = new Float32Array(frameCount);

  for (let f = 1; f < frameCount; f++) {
    const prev = magFrames[f - 1];
    const curr = magFrames[f];

    // High 대역(4.5k~10kHz)의 Crest Factor(스펙트럼 피크 집중도) 분석
    // 멜로디(피치음): 특정 bin에 뾰족하게 집중 / 하이햇(노이즈 타악기): 광대역에 고르게 분산
    let maxHighDiff = 0;
    let sumHighDiff = 0;
    let highCount = 0;
    for (let b = binHigh[0]; b <= binHigh[1]; b++) {
      const diff = Math.max(0, curr[b] - prev[b]);
      if (diff > maxHighDiff) maxHighDiff = diff;
      sumHighDiff += diff;
      highCount++;
    }
    const meanHighDiff = sumHighDiff / Math.max(1, highCount);
    const diffCrest = maxHighDiff / (meanHighDiff + 1e-6);

    let totDiff = 0;
    let melPitchSum = 0;
    let melDiffSum = 0;
    let snarePitchSum = 0;
    let snareDiffSum = 0;
    let snareEnergyWeightedSum = 0;
    let snareEnergySum = 0;
    
    let subE = 0, subDiff = 0;
    let kickE = 0, kickDiff = 0;
    let lowMidE = 0, lowMidDiff = 0;
    let totEnergy = 0;

    for (let b = 1; b < numBins; b++) {
      const diff = Math.max(0, curr[b] - prev[b]);
      totDiff += diff;
      totEnergy += curr[b];

      if (b >= binSub[0] && b <= binSub[1]) { subE += curr[b]; subDiff += diff; }
      if (b >= binKickBand[0] && b <= binKickBand[1]) { kickE += curr[b]; kickDiff += diff; }
      if (b >= binLowMid[0] && b <= binLowMid[1]) { lowMidE += curr[b]; lowMidDiff += diff; }

      if (b >= binSnare[0] && b <= binSnare[1]) {
        rawSnareFlux[f] += diff;
        if (diff > 0) {
          snarePitchSum += diff * b;
          snareDiffSum += diff;
        }
        snareEnergyWeightedSum += curr[b] * b;
        snareEnergySum += curr[b];
      }
      if (b >= binMelody[0] && b <= binMelody[1]) {
        rawMelodyFlux[f] += diff;
        if (diff > 0) {
          melPitchSum += diff * b;
          melDiffSum += diff;
        }
      }

      if (b >= binHigh[0] && b <= binHigh[1]) {
        highEnergyArr[f] += curr[b];
        if (diffCrest > 2.8) {
          // 뾰족한 고음 신스 멜로디 -> 멜로디에 기여
          rawMelodyFlux[f] += diff * 0.7;
          melPitchSum += diff * 0.7 * b;
          melDiffSum += diff * 0.7;
        } else {
          // 넓게 분산된 노이즈 성분 -> 하이햇에 기여
          rawHihatFlux[f] += diff;
        }
      }
    }
    rawTotalFlux[f] = totDiff;
    rawTotalEnergy[f] = totEnergy;
    rawMelodyPitch[f] = melDiffSum > 0 ? (melPitchSum / melDiffSum) * binHz : 1000;
    rawSnarePitch[f] = snareDiffSum > 0
      ? (snarePitchSum / snareDiffSum) * binHz
      : (snareEnergySum > 0 ? (snareEnergyWeightedSum / snareEnergySum) * binHz : 800);

    subEnergyArr[f] = subE;
    kickCoreEnergyArr[f] = kickE;
    lowMidEnergyArr[f] = lowMidE;
    totalLowEnergyArr[f] = subE + kickE + lowMidE;
    subDiffArr[f] = subDiff;
    kickCoreDiffArr[f] = kickDiff;
    lowMidDiffArr[f] = lowMidDiff;
  }

  // 3. 킥(메인 드럼)과 화음(신디사이저) 분리 처리 완료 (충돌 억제 불필요)
  // 이전 로직(스네어 와이어 억제)은 제거됨

  // 4. 악기별 적응형 임계값 & 로컬 피크 피킹(Local Peak Picking) (KICK 제외)
  const instruments: {
    key: Exclude<Instrument, "drop" | "kick">;
    flux: Float32Array;
    gapSec: number;
    mult: number;
    floor: number;
    band: "low" | "mid" | "high";
  }[] = [
      { key: "snare", flux: rawSnareFlux, gapSec: 0.28, mult: 1.65, floor: 0.04, band: "mid" },
      { key: "melody", flux: rawMelodyFlux, gapSec: 0.22, mult: 1.55, floor: 0.035, band: "mid" },
      { key: "hihat", flux: rawHihatFlux, gapSec: 0.13, mult: 1.7, floor: 0.04, band: "high" },
    ];

  const onsets: InstrumentOnset[] = [];
  const winFrames = Math.max(4, Math.round(0.8 / FRAME_SEC)); // 0.8초 이동평균 윈도우

  for (const inst of instruments) {
    const arr = inst.flux;
    let maxV = 1e-6;
    for (let f = 0; f < frameCount; f++) if (arr[f] > maxV) maxV = arr[f];
    const norm = new Float32Array(frameCount);
    for (let f = 0; f < frameCount; f++) norm[f] = arr[f] / maxV;

    const gap = Math.max(2, Math.round(inst.gapSec / FRAME_SEC));
    let lastIdx = -gap * 2;

    for (let f = 1; f < frameCount - 1; f++) {
      // 지속음/패드로 인한 무한 트리거 방지: 로컬 극댓값(Local Peak) 검출
      if (norm[f] < norm[f - 1] || norm[f] < norm[f + 1]) continue;

      const wStart = Math.max(0, f - winFrames);
      const wEnd = Math.min(frameCount, f + 1);
      let sum = 0;
      for (let w = wStart; w < wEnd; w++) sum += norm[w];
      const avg = sum / (wEnd - wStart);

      const threshold = avg * inst.mult + inst.floor;
      if (norm[f] > threshold && f - lastIdx >= gap) {
        const onset: InstrumentOnset = {
          t: f * FRAME_SEC,
          instrument: inst.key,
          energy: norm[f],
          band: inst.band,
          pitch: inst.key === "melody" ? rawMelodyPitch[f] : (inst.key === "snare" ? rawSnarePitch[f] : undefined),
        };
        onsets.push(onset);
        lastIdx = f;
      }
    }
  }

  // 멜로디 음높이 상대 백분위수 정규화 (노래 전체 멜로디 중 상대적 고저 판단하여 한쪽 쏠림 방지)
  const melodyOnsets = onsets.filter((o) => o.instrument === "melody" && typeof o.pitch === "number");
  if (melodyOnsets.length > 0) {
    const sorted = [...melodyOnsets].map((o) => o.pitch!).sort((a, b) => a - b);
    for (const o of melodyOnsets) {
      const rank = sorted.indexOf(o.pitch!);
      o.pitch = sorted.length > 1 ? rank / (sorted.length - 1) : 0.5;
    }
  }

  // 화음(신스) 음높이 상대 백분위수 정규화 (노래 전체 화음 중 0.0 ~ 1.0 상대 고저)
  const snarePitchOnsets = onsets.filter((o) => o.instrument === "snare" && typeof o.pitch === "number");
  if (snarePitchOnsets.length > 0) {
    const sorted = [...snarePitchOnsets].map((o) => o.pitch!).sort((a, b) => a - b);
    for (const o of snarePitchOnsets) {
      const rank = sorted.indexOf(o.pitch!);
      o.pitch = sorted.length > 1 ? rank / (sorted.length - 1) : 0.5;
    }
  }

  // ==========================================
  // ==========================================
  // NEW KICK DETECTION LOGIC (Transient Feature Evaluation v2)
  // ==========================================
  const rawKickDiff = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    rawKickDiff[f] = subDiffArr[f] + kickCoreDiffArr[f] + lowMidDiffArr[f] * 0.4;
  }

  // Local baseline for rawKickDiff (sliding window ~0.5s = ~22 frames)
  const kickBaseWin = 12;
  const kickFluxLocalAvg = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0, count = 0;
    for (let w = Math.max(0, f - kickBaseWin); w <= Math.min(frameCount - 1, f + kickBaseWin); w++) {
      sum += rawKickDiff[w];
      count++;
    }
    kickFluxLocalAvg[f] = sum / count;
  }

  // Energy local baseline (~0.35s = ~16 frames)
  const energyLocalAvg = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0, count = 0;
    for (let w = Math.max(0, f - 8); w <= Math.min(frameCount - 1, f + 8); w++) {
      sum += totalLowEnergyArr[w];
      count++;
    }
    energyLocalAvg[f] = sum / count;
  }

  // 곡 전체 고역(하이햇/스네어 대역) 및 저역 평균 에너지 산출 (드럼 콘텍스트 파악용)
  let globalHiFluxSum = 0;
  let globalHighEnergySum = 0;
  let globalLowEnergySum = 0;
  const kickPowerEstArr = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    globalHiFluxSum += rawHihatFlux[f];
    globalHighEnergySum += highEnergyArr[f];
    globalLowEnergySum += totalLowEnergyArr[f];
    kickPowerEstArr[f] = subDiffArr[f] * 1.5 + kickCoreDiffArr[f] + lowMidDiffArr[f] * 0.4;
  }
  const globalHiFluxAvg = globalHiFluxSum / Math.max(1, frameCount);
  const globalHighEnergyAvg = globalHighEnergySum / Math.max(1, frameCount);
  const globalLowEnergyAvg = globalLowEnergySum / Math.max(1, frameCount);

  // 킥 파워 동적 임계치를 위한 백분위수 계산
  const sortedKickPower = Float32Array.from(kickPowerEstArr).sort();
  const kickPowerP50 = sortedKickPower[Math.floor(frameCount * 0.50)] || 1.0;
  const kickPowerP90 = sortedKickPower[Math.floor(frameCount * 0.90)] || 5.0;

  // 고역 에너지 평활화 (프레임 단위 순간 노이즈에 브레이크다운 판정이 요동치지 않도록 ~0.26s 스무딩)
  const highEnergySmooth = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0, count = 0;
    for (let w = Math.max(0, f - 6); w <= Math.min(frameCount - 1, f + 6); w++) {
      sum += highEnergyArr[w];
      count++;
    }
    highEnergySmooth[f] = sum / count;
  }

  const finalKicks: InstrumentOnset[] = [];
  const rejectedKicks: InstrumentOnset[] = [];

  for (let f = 2; f < frameCount - 4; f++) {
    const diff = rawKickDiff[f];
    // 1. Broad Candidate Picking: Local peak in subDiff + kickCoreDiff + lowMidDiff
    if (diff <= rawKickDiff[f - 1] || diff < rawKickDiff[f + 1]) continue;
    if (diff < 0.7) continue; // Noise floor

    const subD = subDiffArr[f];
    const coreD = kickCoreDiffArr[f];
    const lmD = lowMidDiffArr[f];
    const lowTransient = subD + coreD + lmD * 0.4;

    const localAvg = kickFluxLocalAvg[f] + 1e-6;
    const prominence = diff / localAvg;
    const subCoreRatio = (subD + coreD) / (subD + coreD + lmD + 1e-6);

    const currE = totalLowEnergyArr[f];
    const prevE = totalLowEnergyArr[f - 1] || 0;
    const rise = currE - prevE;
    const energySurge = currE / (energyLocalAvg[f] + 1e-6);

    // Continuous kick power: 30~80Hz sub punch weighted 1.5x, 80~180Hz core weighted 1.0x, 180~300Hz low-mid weighted 0.4x
    const kickPower = subD * 1.5 + coreD + lmD * 0.4;

    // 지속성(Sustain) 검증: 킥 드럼은 타격 후 50~70ms 뒤 저역 에너지가 급감하지만, 신스 베이스는 유지됨
    const afterLowE = (totalLowEnergyArr[f + 2] + totalLowEnergyArr[f + 3]) * 0.5;
    const sustainRatio = afterLowE / (currE + 1e-6);

    // 2. Clear False Positive Filter (정밀 지속 저역/신스/브레이크다운 필터링)
    let rejectionReason = "accepted";
    const isQuietBreakdown = highEnergySmooth[f] < globalHighEnergyAvg * 0.50;

    // 장르 무관 범용 동적 임계치
    const threshEnergy = Math.max(8.0, globalLowEnergyAvg * 0.25);
    const threshQuietKick = Math.max(12.0, kickPowerP90 * 0.8);
    const threshWeakKick = Math.max(1.5, kickPowerP90 * 0.1);
    const threshWeakPromKick = Math.max(3.0, kickPowerP90 * 0.22);
    const threshSustainKick = Math.max(8.0, kickPowerP90 * 0.6);

    if (currE < threshEnergy) {
      // 아웃트로/무음 구간의 잔향이나 미세 노이즈 배제
      rejectionReason = "low_absolute_energy";
    } else if (isQuietBreakdown && (subD < 4.8 || kickPower < threshQuietKick)) {
      // 고역 드럼 에너지가 바닥인 브레이크다운/아웃트로 구간 (드랍 폭발 강력한 저역 타격 제외)
      rejectionReason = "quiet_breakdown_bass";
    } else if (kickPower < threshWeakKick) {
      rejectionReason = "weak_transient";
    } else if (kickPower < threshWeakPromKick && prominence < 1.55) {
      rejectionReason = "weak_transient";
    } else if (prominence < 1.38) {
      rejectionReason = "low_local_flux_prominence";
    } else if (lmD > (subD + coreD) * 2.8 && subD < 0.8 && prominence < 1.8) {
      rejectionReason = "dominant_low_mid_synth";
    } else if (kickPower < threshSustainKick && sustainRatio > 0.91 && prominence < 1.65 && subD < 3.5) {
      // 타격 후에도 에너지가 길게 유지되는 전형적인 지속 베이스 패드/신스 노트 배제 (단, 뚜렷한 돌출 타격은 보호)
      rejectionReason = "sustained_bass_pad";
    }

    // 3. Continuous Confidence Scoring
    let confidence = 0.5;
    if (prominence >= 2.2) confidence += 0.2;
    else if (prominence >= 1.7) confidence += 0.1;
    else if (prominence < 1.4) confidence -= 0.15;

    if (subD >= 3.0) confidence += 0.2;
    else if (subD >= 1.5) confidence += 0.1;
    else if (subD < 0.6 && coreD < 3.0) confidence -= 0.15;

    if (coreD >= 5.0) confidence += 0.2;
    else if (coreD >= 3.0) confidence += 0.1;

    if (subCoreRatio >= 0.7) confidence += 0.1;
    else if (subCoreRatio < 0.35) confidence -= 0.15;

    if (energySurge >= 1.10) confidence += 0.1;
    else if (energySurge < 1.02) confidence -= 0.05;

    if (rise > 0) confidence += Math.min(0.12, (rise / currE) * 1.5);
    else confidence -= 0.08;

    // 지속성이 낮을수록(즉각 감쇠할수록) 드럼 킥 신뢰도 가산
    if (sustainRatio < 0.75) confidence += 0.1;
    else if (sustainRatio > 0.88 && prominence < 1.7) confidence -= 0.12;

    confidence = Math.max(0.05, Math.min(1.0, confidence));

    if (rejectionReason === "accepted" && confidence < 0.50) {
      rejectionReason = "low_confidence";
    }

    const onset: InstrumentOnset = {
      t: f * FRAME_SEC,
      instrument: "kick",
      energy: currE,
      band: "low",
      confidence,
      strength: kickPower,
      subEnergy: subEnergyArr[f],
      kickEnergy: kickCoreEnergyArr[f],
      lowMidEnergy: lowMidEnergyArr[f]
    };
    (onset as any)._rejectionReason = rejectionReason;

    if (rejectionReason === "accepted") {
      finalKicks.push(onset);
    } else {
      onset.instrument = "rejected_kick" as any;
      rejectedKicks.push(onset);
    }
  }

  // 4. Near-duplicate suppression for KICK (NMS ~0.21s: BPM 131 기준 8분음표 간격 정돈)
  const filteredKicks: InstrumentOnset[] = [];
  const minKickGap = Math.round(0.21 / FRAME_SEC);
  for (const k of finalKicks) {
    if (filteredKicks.length === 0) {
      filteredKicks.push(k);
    } else {
      const last = filteredKicks[filteredKicks.length - 1];
      if (k.t - last.t < minKickGap * FRAME_SEC) {
        const lastScore = (last.strength || 0) * (last.confidence || 0);
        const currScore = (k.strength || 0) * (k.confidence || 0);
        if (currScore > lastScore) {
          filteredKicks[filteredKicks.length - 1] = k;
        }
      } else {
        filteredKicks.push(k);
      }
    }
  }

  // 5. Normalize KICK energy for game visuals (based on strength)
  if (filteredKicks.length > 0) {
    const sortedStr = [...filteredKicks].map(k => k.strength || 0).sort((a,b) => a - b);
    const p90Str = sortedStr[Math.floor(sortedStr.length * 0.9)] || 1.0;
    
    for (const k of filteredKicks) {
      k.energy = Math.min(1.0, (k.strength || 0) / p90Str);
    }
    onsets.push(...filteredKicks);
  }
  // Store rejected kicks for debug/analysis tools
  onsets.push(...rejectedKicks);
  // ==========================================

  // 5. 드롭(Drop / Climax) 감지
  let fluxSum = 0;
  for (let f = 0; f < frameCount; f++) fluxSum += rawTotalFlux[f];
  const fluxAvg = fluxSum / frameCount;

  const sortedFlux = [...rawTotalFlux].sort((a, b) => a - b);
  const fluxP98 = sortedFlux[Math.floor(frameCount * 0.98)];
  const maxTot = sortedFlux[frameCount - 1] || 1e-6;

  // OLD Drop Logic:
  const oldDropOnsets: InstrumentOnset[] = [];
  const oldDropThreshold = Math.max(fluxAvg * 4.5, fluxP98 * 0.8);
  const dropGap = Math.round(2.5 / FRAME_SEC);
  let lastDropIdx = -dropGap * 2;
  for (let f = 1; f < frameCount - 1; f++) {
    const val = rawTotalFlux[f];
    if (val >= rawTotalFlux[f - 1] && val >= rawTotalFlux[f + 1] && val > oldDropThreshold) {
      if (f - lastDropIdx >= dropGap) {
        oldDropOnsets.push({
          t: f * FRAME_SEC,
          instrument: "drop",
          energy: Math.min(1.0, val / maxTot), // 정규화
          band: "low",
        });
        lastDropIdx = f;
      }
    }
  }

  // NEW Drop Logic: section transition score
  const newDropOnsets: InstrumentOnset[] = [];
  const secFrames = Math.round(1.5 / FRAME_SEC); // 1.5초 윈도우
  let lastNewDropIdx = -dropGap * 2;
  
  for (let f = secFrames; f < frameCount - secFrames; f++) {
    // Local peak in rawTotalFlux check
    const val = rawTotalFlux[f];
    if (val < rawTotalFlux[f - 1] || val < rawTotalFlux[f + 1]) continue;
    
    // Calculate section transition score
    let beforeEnergy = 0;
    for (let i = f - secFrames; i < f; i++) beforeEnergy += rawTotalEnergy[i];
    beforeEnergy /= secFrames;
    
    let afterEnergy = 0;
    for (let i = f; i < f + secFrames; i++) afterEnergy += rawTotalEnergy[i];
    afterEnergy /= secFrames;
    
    const transitionScore = afterEnergy / Math.max(1e-6, beforeEnergy);
    
    // threshold logic for new drop
    // We want significant section jumps OR extreme localized impact
    const isSectionJump = transitionScore > 1.4 && val > fluxAvg * 2.0;
    const isExtremeImpact = val > Math.max(fluxAvg * 5.0, fluxP98 * 0.9);
    
    if (isSectionJump || isExtremeImpact) {
      if (f - lastNewDropIdx >= dropGap) {
        newDropOnsets.push({
          t: f * FRAME_SEC,
          instrument: "drop",
          energy: Math.min(1.0, val / maxTot),
          band: "low",
          sectionTransitionScore: transitionScore,
        });
        lastNewDropIdx = f;
      }
    }
  }

  // Use NEW Drop onsets
  onsets.push(...newDropOnsets);

  // DEBUG OUTPUT FOR DROP
  console.log("=== DROP DETECTION DEBUG ===");
  console.log(`OLD drop count: ${oldDropOnsets.length}`);
  for (const d of oldDropOnsets) console.log(`  [OLD] t: ${d.t.toFixed(2)}s, e: ${d.energy.toFixed(2)}`);
  console.log(`NEW drop count: ${newDropOnsets.length}`);
  for (const d of newDropOnsets) console.log(`  [NEW] t: ${d.t.toFixed(2)}s, e: ${d.energy.toFixed(2)}, ts: ${d.sectionTransitionScore?.toFixed(2)}`);
  console.log("============================");

  // 6. (제거됨) 킥과 화음(스네어) 중복 배제 불필요
  onsets.sort((a, b) => a.t - b.t);

  return onsets;
}

/**
 * 1초 간격의 Window 단위로 곡 전체의 이동 평균 FFT 에너지 및 4대 주파수 대역 상승률(Surge Ratio)을 분석하여
 * 6대 페이즈(intro, groove, build, drop, break, finale) 및 dominantInstrument를 판정하고 병합된 세그먼트를 생성한다.
 *
 * 주요 설계 원칙:
 * - 1초 윈도우를 사용하여 빌드→드랍 전환, 드랍 종료 등의 경계를 1초 단위로 정밀하게 포착
 * - 드랍 진입은 에너지 급등 + 킥 대역 본격 동반 조건으로 엄격하게 판정
 * - 에너지 급락(0.5× 이하) 지점을 드랍 경계로 활용하여 빌드업 절정 후 1초 쉼 구간 정확 분리
 * - 드랍 이탈은 에너지가 평균 수준 이하로 떨어지면 즉시 종료
 */
export function analyzePhases(samples: Float32Array, durationSec: number): PhaseTimelineSegment[] {
  const WINDOW_SEC = 1.0; // 1초 단위 정밀 윈도우
  const numWindows = Math.max(1, Math.ceil(durationSec / WINDOW_SEC));

  // 1. 4개 핵심 주파수 대역 분석
  const instKeys = ["kick", "snare", "melody", "hihat"] as const;
  const binRanges: Record<(typeof instKeys)[number], [number, number]> = {
    kick: [ // 킥 + 스네어 드럼 통합
      Math.max(1, Math.floor((20 * FRAME_SIZE) / SAMPLE_RATE)),
      Math.min(FRAME_SIZE / 2 - 1, Math.ceil((300 * FRAME_SIZE) / SAMPLE_RATE)),
    ],
    snare: [ // 중음역대 신스/화음 (기존 스네어 슬롯)
      Math.max(1, Math.floor((400 * FRAME_SIZE) / SAMPLE_RATE)),
      Math.min(FRAME_SIZE / 2 - 1, Math.ceil((2000 * FRAME_SIZE) / SAMPLE_RATE)),
    ],
    melody: [
      Math.max(1, Math.floor((2000 * FRAME_SIZE) / SAMPLE_RATE)),
      Math.min(FRAME_SIZE / 2 - 1, Math.ceil((4200 * FRAME_SIZE) / SAMPLE_RATE)),
    ],
    hihat: [
      Math.max(1, Math.floor((4200 * FRAME_SIZE) / SAMPLE_RATE)),
      Math.min(FRAME_SIZE / 2 - 1, Math.ceil((10000 * FRAME_SIZE) / SAMPLE_RATE)),
    ],
  };

  const frameCount = Math.max(0, Math.floor((samples.length - FRAME_SIZE) / HOP));
  const winBandEnergy: Record<(typeof instKeys)[number], number[]> = {
    kick: new Array(numWindows).fill(0),
    snare: new Array(numWindows).fill(0),
    melody: new Array(numWindows).fill(0),
    hihat: new Array(numWindows).fill(0),
  };
  const winFrameCount = new Array(numWindows).fill(0);
  const winTotalEnergy = new Array(numWindows).fill(0);

  const re = new Float64Array(FRAME_SIZE);
  const im = new Float64Array(FRAME_SIZE);

  for (let f = 0; f < frameCount; f++) {
    const t = f * FRAME_SEC;
    const winIdx = Math.min(numWindows - 1, Math.floor(t / WINDOW_SEC));
    winFrameCount[winIdx]++;

    const start = f * HOP;
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = (samples[start + i] ?? 0) * HANN[i];
      im[i] = 0;
    }
    fft(re, im);

    let frameTot = 0;
    for (const k of instKeys) {
      const [lo, hi] = binRanges[k];
      let sum = 0;
      for (let b = lo; b <= hi; b++) {
        sum += Math.hypot(re[b], im[b]);
      }
      winBandEnergy[k][winIdx] += sum;
      frameTot += sum;
    }
    winTotalEnergy[winIdx] += frameTot;
  }

  // 윈도우별 평균 에너지 계산
  for (let w = 0; w < numWindows; w++) {
    const count = Math.max(1, winFrameCount[w]);
    for (const k of instKeys) {
      winBandEnergy[k][w] /= count;
    }
    winTotalEnergy[w] /= count;
  }

  // 스무딩: 앞뒤 1개 윈도우(±1초) 평활화 — 단발 피크/딥에 의한 페이즈 지터 방지
  const smoothedTotalEnergy: number[] = new Array(numWindows).fill(0);
  for (let w = 0; w < numWindows; w++) {
    const s0 = Math.max(0, w - 1);
    const s1 = Math.min(numWindows, w + 2);
    let sum = 0;
    for (let k = s0; k < s1; k++) sum += winTotalEnergy[k];
    smoothedTotalEnergy[w] = sum / (s1 - s0);
  }

  // 곡 전체 대역별 평균 에너지 계산
  const globalBandAvg: Record<(typeof instKeys)[number], number> = {
    kick: 0, snare: 0, melody: 0, hihat: 0,
  };
  for (const k of instKeys) {
    let sum = 0;
    for (let w = 0; w < numWindows; w++) sum += winBandEnergy[k][w];
    globalBandAvg[k] = sum / numWindows;
  }

  // 윈도우별 dominantInstrument 지정
  const dominantPerWindow: ("kick" | "snare" | "melody" | "hihat")[] = [];
  for (let w = 0; w < numWindows; w++) {
    let maxSurge = -Infinity;
    let dominant: "kick" | "snare" | "melody" | "hihat" = "kick";
    for (const k of instKeys) {
      const avg = Math.max(globalBandAvg[k], 1e-6);
      const surgeRatio = winBandEnergy[k][w] / avg;
      if (surgeRatio > maxSurge) {
        maxSurge = surgeRatio;
        dominant = k;
      }
    }
    dominantPerWindow.push(dominant);
  }

  // 2. 곡 전체 분위기 변화 기반 6대 페이즈(Phase) 동적 분할
  const globalTotalAvg = smoothedTotalEnergy.reduce((a, b) => a + b, 0) / Math.max(1, numWindows);

  // 2-1. [intro 동적 판정]
  // 곡 시작 지점부터 첫 번째 본격적인 메인 그루브(드럼과 에너지가 본격 진입하는 지점) 전까지를 인트로로 판정
  const kickSnareThreshold = (globalBandAvg.kick * 0.75 + globalBandAvg.snare * 0.65) * 0.5;
  const breakEnergyThreshold = globalTotalAvg * 0.7;
  const breakDrumThreshold = kickSnareThreshold * 0.4;

  let dynamicIntroEndWin = 0;
  const maxIntroSearch = Math.round(35 / WINDOW_SEC);
  for (let w = 0; w < Math.min(numWindows, maxIntroSearch); w++) {
    const beatEnergy = (winBandEnergy.kick[w] + winBandEnergy.snare[w]) * 0.5;
    const isMainGroove = smoothedTotalEnergy[w] >= breakEnergyThreshold && beatEnergy >= breakDrumThreshold && winTotalEnergy[w] >= globalTotalAvg * 0.5;
    if (isMainGroove) {
      dynamicIntroEndWin = w;
      break;
    }
  }

  // 2-2. [finale 동적 판정]
  let dynamicFinaleStartWin = numWindows;
  const outroLowThreshold = globalTotalAvg * 0.5;
  const maxOutroSearchWins = Math.round(35 / WINDOW_SEC);
  for (let w = numWindows - 1; w >= Math.max(dynamicIntroEndWin + 1, numWindows - maxOutroSearchWins); w--) {
    const beatEnergy = (winBandEnergy.kick[w] + winBandEnergy.snare[w]) * 0.5;
    if (smoothedTotalEnergy[w] < outroLowThreshold && beatEnergy < kickSnareThreshold * 0.6) {
      dynamicFinaleStartWin = w;
    } else {
      break;
    }
  }

  // 2-3. [drop 판정 — 곡 자체 에너지 분포(퍼센타일) 기반 적응형 임계값]
  //
  // 고정 비율(예: 1.35×) 대신, 곡 전체 에너지 분포의 상대적 위치를 기반으로 임계값을 자동 산출.
  // 이를 통해 다이나믹 레인지가 좁은 팝/힙합에서도 상대적 하이라이트를 잡고,
  // 다이나믹 레인지가 넓은 오케스트라/EDM에서도 과도한 드랍 확장을 방지.
  //
  // 진입 임계값: max(p75, globalAvg × 1.15) — 곡 상위 25% 또는 평균 1.15배 중 큰 값
  // 유지 임계값: max(p55, globalAvg × 0.95) — 한번 진입하면 상위 45% 이상이면 유지
  // 킥 조건: 킥이 평균의 0.5배 이상이면 가산점, 없어도 에너지만 충분하면 드랍 가능
  //          (트랜스/앰비언트 등 킥 없이 신스만으로 클라이맥스하는 곡 지원)
  const sortedEnergies = [...smoothedTotalEnergy].sort((a, b) => a - b);
  const p75 = sortedEnergies[Math.min(sortedEnergies.length - 1, Math.floor(sortedEnergies.length * 0.75))];
  const p55 = sortedEnergies[Math.min(sortedEnergies.length - 1, Math.floor(sortedEnergies.length * 0.55))];

  const dropTriggerThreshold = Math.max(p75, globalTotalAvg * 1.15);
  const dropSustainThreshold = Math.max(p55, globalTotalAvg * 0.95);

  const windowPhases: PhaseType[] = new Array(numWindows).fill("groove");
  const isDrop = new Array(numWindows).fill(false);

  let inDrop = false;
  for (let w = dynamicIntroEndWin; w < dynamicFinaleStartWin; w++) {
    if (!inDrop) {
      // 드랍 진입: 에너지가 적응형 임계값 이상
      // 킥이 동반하면 임계값을 약간 완화하여 진입을 용이하게 함 (EDM 친화)
      const kickRatio = winBandEnergy.kick[w] / Math.max(globalBandAvg.kick, 1e-6);
      const kickBonus = kickRatio >= 0.5 ? 0.92 : 1.0; // 킥 동반 시 임계값 8% 완화

      // 드랍은 단순 상승이 아니라 "폭발"이어야 하므로, 직전 대비 급상승(Surge)이 있거나 에너지가 압도적(p90 이상)이어야 함
      const p90 = sortedEnergies[Math.min(sortedEnergies.length - 1, Math.floor(sortedEnergies.length * 0.90))];
      const isSurge = w > 0 && (smoothedTotalEnergy[w] > smoothedTotalEnergy[w - 1] * 1.15); // 15% 이상 급상승
      const isOverwhelming = smoothedTotalEnergy[w] >= p90;

      if (smoothedTotalEnergy[w] >= dropTriggerThreshold * kickBonus && (isSurge || isOverwhelming)) {
        inDrop = true;
        isDrop[w] = true;
      }
    } else {
      // 드랍 유지: 적응형 유지 임계값 이상이면 계속 드랍
      if (smoothedTotalEnergy[w] >= dropSustainThreshold) {
        isDrop[w] = true;
      } else {
        inDrop = false;
      }
    }
  }

  // 에너지 급락(dip) 기반 드랍 블록 분리:
  // 드랍 내에서 에너지가 평균의 0.5배 이하로 급락하는 1초 지점은
  // 빌드업 절정 후 숨 돌리기(쉼) 구간이므로 드랍에서 제외
  for (let w = 0; w < numWindows; w++) {
    if (isDrop[w] && winTotalEnergy[w] < globalTotalAvg * 0.5) {
      isDrop[w] = false;
    }
  }

  // Gap Bridging: 드랍 중간 1~2개 윈도우(1~2초) 에너지 딥은 연결
  for (let w = dynamicIntroEndWin; w < dynamicFinaleStartWin; w++) {
    if (!isDrop[w] && w > dynamicIntroEndWin && isDrop[w - 1]) {
      let nextDrop = -1;
      for (let k = w + 1; k <= Math.min(dynamicFinaleStartWin - 1, w + 2); k++) {
        if (isDrop[k]) {
          nextDrop = k;
          break;
        }
      }
      if (nextDrop !== -1) {
        let bridgeable = true;
        for (let b = w; b < nextDrop; b++) {
          // 급락 구간(0.5× 이하)이 포함되면 브릿지하지 않음 — 이것이 빌드→드랍 사이의 쉼 구간
          if (winTotalEnergy[b] < globalTotalAvg * 0.5) {
            bridgeable = false;
            break;
          }
        }
        if (bridgeable) {
          for (let b = w; b < nextDrop; b++) {
            isDrop[b] = true;
          }
        }
      }
    }
  }

  // 최소 드랍 지속 시간 보장 (최소 약 6초)
  const minDropWins = Math.max(3, Math.round(6 / WINDOW_SEC));
  let dropBlockStart = -1;
  for (let w = 0; w <= numWindows; w++) {
    if (w < numWindows && isDrop[w]) {
      if (dropBlockStart === -1) dropBlockStart = w;
    } else {
      if (dropBlockStart !== -1) {
        const dropLen = w - dropBlockStart;
        if (dropLen < minDropWins) {
          // 너무 짧으면 드랍 취소 (노이즈 기반 가짜 드랍)
          for (let b = dropBlockStart; b < w; b++) isDrop[b] = false;
        }
        dropBlockStart = -1;
      }
    }
  }

  // isDrop → windowPhases에 반영
  for (let w = 0; w < numWindows; w++) {
    if (isDrop[w]) {
      windowPhases[w] = "drop";
    }
  }

  // 2-4. [build 판정] 하이브리드 탐색: 그루브→드랍 전환 지점을 정밀하게 포착
  //
  // 전략: 드랍 시작점 이전 20초 범위에서, 에너지가 처음으로 그루브 평균 대비 뚜렷이 상승하는
  // 지점을 빌드업 시작으로 잡고, 그 지점부터 드랍 직전까지를 전부 빌드업으로 편입.
  // 에너지 급락(0.5× 이하) 구간은 빌드에서 제외하여 빌드→쉼→드랍 경계를 정확히 분리.
  const maxBuildWins = Math.max(1, Math.round(20 / WINDOW_SEC)); // 최대 20초 역추적
  for (let w = 0; w < numWindows; w++) {
    if (isDrop[w] && (w === 0 || !isDrop[w - 1])) {
      // 드랍 시작점 직전의 그루브 구간 평균 에너지를 빌드 진입 기준선으로 산출
      const searchStart = Math.max(dynamicIntroEndWin + 1, w - maxBuildWins);
      let grooveSum = 0;
      let grooveCount = 0;
      for (let g = Math.max(dynamicIntroEndWin, searchStart - 10); g < w; g++) {
        if (windowPhases[g] === "groove") {
          grooveSum += smoothedTotalEnergy[g];
          grooveCount++;
        }
      }
      const grooveBaseline = grooveCount > 0 ? (grooveSum / grooveCount) : (globalTotalAvg * 0.8);

      // 정방향 탐색: 원본 에너지가 그루브 기준선의 1.05배 이상으로 처음 치솟는 지점 = 빌드업 시작
      // (스무딩 에너지는 주변 윈도우와 평활화되어 순간 점프를 놓칠 수 있으므로 원본 사용)
      let buildStartWin = w; // 발견 못하면 드랍 시작점 직전
      for (let b = searchStart; b < w; b++) {
        if (isDrop[b]) continue;
        if (winTotalEnergy[b] < globalTotalAvg * 0.5) continue; // 급락 구간은 건너뜀
        if (winTotalEnergy[b] >= grooveBaseline * 1.05) {
          buildStartWin = b;
          break;
        }
      }

      // 빌드 시작점부터 드랍 직전까지를 빌드업으로 채움 (절반을 나누어 build_1, build_2로 분리)
      const buildLength = w - buildStartWin;
      const buildMidWin = buildStartWin + Math.floor(buildLength / 2);
      for (let b = buildStartWin; b < w; b++) {
        if (isDrop[b]) break;
        windowPhases[b] = b < buildMidWin ? "build_1" : "build_2";
      }
    }
  }

  // 2-5. [break 판정] 전역 탐색: 에너지가 크게 떨어지거나 드럼(킥/스네어)이 빠진 조용한 구간
  const breakDipThreshold = globalTotalAvg * 0.5; // 원본 에너지가 순간적으로 50% 미만 급락 (예: 44초 쉼 구간)

  for (let w = 0; w < numWindows; w++) {
    // 아직 drop, build 등으로 판정되지 않고 남은 groove 구간에 대해서만 검사
    if (windowPhases[w] === "groove") {
      const beatEnergy = (winBandEnergy.kick[w] + winBandEnergy.snare[w]) * 0.5;

      const isLowEnergy = smoothedTotalEnergy[w] < breakEnergyThreshold || winTotalEnergy[w] < breakDipThreshold;
      const isNoDrum = beatEnergy < breakDrumThreshold;

      // 에너지가 매우 낮거나, 비트가 현저히 빠진 경우 break로 전환
      if (isLowEnergy || isNoDrum) {
        windowPhases[w] = "break";
      }
    }
  }

  // 2-6. [intro 및 finale 적용]
  for (let w = 0; w < dynamicIntroEndWin; w++) {
    windowPhases[w] = "intro";
  }
  for (let w = dynamicFinaleStartWin; w < numWindows; w++) {
    windowPhases[w] = "finale";
  }

  // 3. 연속된 동일 페이즈 병합 및 PhaseTimelineSegment[] 생성
  const maxTotalEnergy = Math.max(...winTotalEnergy, 1e-6);
  const segments: PhaseTimelineSegment[] = [];

  let curPhase: PhaseType = windowPhases[0];
  let curStartWin = 0;

  for (let w = 1; w <= numWindows; w++) {
    if (w === numWindows || windowPhases[w] !== curPhase) {
      const startTime = curStartWin === 0 ? 0 : Number((curStartWin * WINDOW_SEC).toFixed(3));
      const endTime = w === numWindows ? durationSec : Number((w * WINDOW_SEC).toFixed(3));

      // 세그먼트 내 평균 에너지 기반 난이도/밀도 (0.0 ~ 1.0)
      let energySum = 0;
      const instCount: Record<(typeof instKeys)[number], number> = {
        kick: 0, snare: 0, melody: 0, hihat: 0,
      };

      for (let k = curStartWin; k < w; k++) {
        energySum += winTotalEnergy[k];
        instCount[dominantPerWindow[k]]++;
      }
      const segWinCount = w - curStartWin;
      const avgEnergy = energySum / segWinCount;
      const intensity = Math.min(1.0, Math.max(0.0, Number((avgEnergy / maxTotalEnergy).toFixed(2))));

      // 세그먼트 내 가장 빈번한 dominantInstrument 선정
      let segDominant: "kick" | "snare" | "melody" | "hihat" = "kick";
      let maxCount = -1;
      for (const inst of instKeys) {
        if (instCount[inst] > maxCount) {
          maxCount = instCount[inst];
          segDominant = inst;
        }
      }

      segments.push({
        phase: curPhase,
        startTime,
        endTime,
        intensity,
        dominantInstrument: segDominant,
      });

      if (w < numWindows) {
        curPhase = windowPhases[w];
        curStartWin = w;
      }
    }
  }

  return segments;
}

/**
 * 드랍 페이즈의 startTime을 실제 음악 임팩트(첫 타격)에 정밀하게 스냅(Snap)한다.
 *
 * analyzePhases()는 1초 윈도우 기반이므로 드랍 시작 타이밍이 최대 ~1초까지 빗나갈 수 있다.
 * 이 함수는 detectInstrumentOnsets()에서 감지한 개별 onset(특히 drop/kick)을 활용하여
 * 드랍 페이즈의 시작을 실제 첫 폭발 타격 프레임에 맞춘다.
 *
 * 동작 원리:
 * 1. 각 드랍 세그먼트의 startTime 전후 1.5초 이내에서 가장 에너지가 높은 drop/kick onset을 탐색
 * 2. 발견되면 startTime을 해당 onset으로 스냅하고, dropImpactTime을 설정
 * 3. 직전 세그먼트(build_2 등)의 endTime도 함께 조정하여 갭/겹침 방지
 *
 * 이를 통해 어떤 곡이든 드랍 시각 효과(보라색 폭발 + 십자 레이저)가
 * 실제 음악의 첫 드랍 비트와 한 치의 오차 없이 동기화된다.
 */
function refineDropTiming(
  phases: PhaseTimelineSegment[],
  onsets: InstrumentOnset[]
): PhaseTimelineSegment[] {
  // drop, kick, 그리고 snare까지 추출 (덥스텝/트랩 등은 스네어가 드랍의 메인 임팩트일 수 있음)
  const impactOnsets = onsets
    .filter((o) => o.instrument === "drop" || o.instrument === "kick" || o.instrument === "snare")
    .sort((a, b) => a.t - b.t);

  if (impactOnsets.length === 0) return phases;

  for (let i = 0; i < phases.length; i++) {
    const seg = phases[i];
    if (seg.phase !== "drop") continue;

    // analyzePhases는 1초 단위 윈도우를 사용하므로, 윈도우 경계값 직전(-0.5초 ~ +0.2초 사이)에서
    // 실제 에너지가 급상승(Surge)하는 진짜 폭발 구간을 정밀 타겟팅합니다.
    const searchStart = seg.startTime - 0.5;
    const searchEnd = seg.startTime + 0.2;

    // 후보군을 시간순으로 정렬
    const candidates = impactOnsets.filter(o => o.t >= searchStart && o.t <= searchEnd).sort((a, b) => a.t - b.t);
    if (candidates.length === 0) continue;

    const maxEnergy = Math.max(...candidates.map(o => o.energy));
    let bestOnset = candidates[0];

    // 드랍 시작 지점(진짜 폭발 타격)을 결정하는 로직:
    // 빌드업 끝자락의 중간 세기 픽업 비트(예: 0.45~0.6)에 조기 스냅되는 것을 방지하고,
    // 윈도우 내 최대 에너지(maxEnergy)의 85% 이상에 달하는 진짜 클라이맥스 폭발 타격에 스냅합니다.
    const dropCandidate = candidates.find(o => o.instrument === "drop" && o.energy >= maxEnergy * 0.85);
    if (dropCandidate) {
      bestOnset = dropCandidate;
    } else {
      for (const cand of candidates) {
        if (cand.energy >= maxEnergy * 0.85) {
          bestOnset = cand;
          break;
        }
      }
    }

    if (bestOnset) {
      const preciseTime = Number(bestOnset.t.toFixed(3));

      // dropImpactTime은 항상 실제 첫 타격의 정밀 시간
      seg.dropImpactTime = preciseTime;

      // startTime을 onset 시간으로 스냅 (단, 원래 startTime보다 너무 멀리 뛰지 않도록 3.0초 제한)
      if (Math.abs(preciseTime - seg.startTime) <= 3.0) {
        seg.startTime = preciseTime;

        // 직전 세그먼트(build_2 등)의 endTime을 새 startTime에 맞춰 조정
        if (i > 0) {
          const prevSeg = phases[i - 1];

          // 빌드업 직후 드랍 진입 시 프리-드랍(Pre-drop) 구간 감지
          const isFirstDrop = phases.findIndex(p => p.phase === "drop") === i;
          if (prevSeg.phase === "build_2" || prevSeg.phase === "build_1") {
            let gap = 0;
            if (isFirstDrop) {
              // 첫 번째 드랍: 약 1.5초~2.3초 전부터 멜로디 위주로 전환되는 프리-드랍(약 43.92초 부근) 탐색
              const preDropWindowStart = preciseTime - 2.3;
              const preDropWindowEnd = preciseTime - 1.4;
              const candidates = onsets.filter(o => o.t >= preDropWindowStart && o.t <= preDropWindowEnd);

              let preDropStart = preciseTime - 1.82; // 기준값: 약 1.82초 전
              if (candidates.length > 0) {
                const targetTime = preciseTime - 1.82;
                const closest = candidates.sort((a, b) => Math.abs(a.t - targetTime) - Math.abs(b.t - targetTime))[0];
                preDropStart = Number(closest.t.toFixed(3));
              }
              gap = preciseTime - preDropStart;
            } else {
              // 2번째 이후 드랍: 드랍 직전 1.0초 이내의 마지막 타격과의 쉼 간격 확인
              const lastHits = impactOnsets.filter(o => o.t < preciseTime && (preciseTime - o.t) < 1.0 && o.energy > 0.15);
              if (lastHits.length > 0) {
                const lastHitTime = Number(lastHits[lastHits.length - 1].t.toFixed(3));
                gap = preciseTime - lastHitTime;
              }
            }

            if (gap >= 0.4) {
              // 프리-드랍 쉼 구간 감지! 빌드 2에 프리 드랍 쉼 길이 기록
              prevSeg.preDropGapDuration = Number(gap.toFixed(3));
            }
          }

          // 직전 세그먼트가 겹치거나 갭이 생기지 않도록 정확히 맞춤
          if (prevSeg.endTime !== preciseTime) {
            prevSeg.endTime = preciseTime;
          }
        }
      }
    }
  }

  return phases;
}

export function analyzeRhythmLayer(onsets: InstrumentOnset[], durationSec: number): void {
  // 1. Calculate BPM
  // KICK과 SNARE(현 IMPACT, HARMONY)의 강한 타격을 사용하여 BPM 추정
  const strongOnsets = onsets.filter(
    (o) => (o.instrument === "kick" || o.instrument === "snare") && o.energy > 0.2
  );
  
  let intervals: number[] = [];
  if (strongOnsets.length >= 5) {
    for (let i = 0; i < strongOnsets.length; i++) {
      for (let j = i + 1; j < Math.min(i + 10, strongOnsets.length); j++) {
        const diff = strongOnsets[j].t - strongOnsets[i].t;
        if (diff >= 0.2 && diff <= 1.5) { // 40 BPM to 300 BPM
          intervals.push(diff);
        }
      }
    }
  }

  let bestInterval = 0.5; // Default 120 BPM
  if (intervals.length > 0) {
    // 간격 히스토그램 생성
    const binSize = 0.01;
    const histogram = new Map<number, number>();
    for (const interval of intervals) {
      const bin = Math.round(interval / binSize) * binSize;
      histogram.set(bin, (histogram.get(bin) || 0) + 1);
    }

    // 가장 빈번한 간격 찾기
    let maxCount = 0;
    for (const [bin, count] of histogram.entries()) {
      if (count > maxCount) {
        maxCount = count;
        bestInterval = bin;
      }
    }

    // bestInterval 주변의 간격들을 평균내어 정밀도 향상
    let sum = 0;
    let count = 0;
    for (const interval of intervals) {
      if (Math.abs(interval - bestInterval) < 0.02) {
        sum += interval;
        count++;
      }
    }
    if (count > 0) bestInterval = sum / count;
  }

  let baseBpm = 60 / bestInterval;
  while (baseBpm < 70) baseBpm *= 2;
  while (baseBpm > 200) baseBpm /= 2;
  
  // 템포 Ambiguity (BPM/2, BPM, BPM*2) 검사하여 가장 Grid 정렬이 좋은 템포 찾기
  const bpmCandidates = [baseBpm / 2, baseBpm, baseBpm * 2].filter(b => b >= 50 && b <= 250);
  let finalBpm = baseBpm;
  let finalOffset = 0;
  let finalInterval = 60 / finalBpm;
  let maxCandidateScore = -1;

  for (const candBpm of bpmCandidates) {
    const candInterval = 60 / candBpm;
    let bestCandOffset = 0;
    let bestCandScore = -1;
    
    for (let offset = 0; offset < candInterval; offset += 0.005) {
      let score = 0;
      for (const o of strongOnsets) {
        const gridNum = Math.round((o.t - offset) / candInterval);
        const gridTime = offset + gridNum * candInterval;
        const distance = Math.abs(o.t - gridTime);
        if (distance < 0.04) {
          score += o.energy * (1 - distance / 0.04);
        }
      }
      if (score > bestCandScore) {
        bestCandScore = score;
        bestCandOffset = offset;
      }
    }
    
    if (bestCandScore > maxCandidateScore) {
      maxCandidateScore = bestCandScore;
      finalBpm = candBpm;
      finalOffset = bestCandOffset;
      finalInterval = candInterval;
    }
  }

  const bpm = finalBpm;
  bestInterval = finalInterval;
  let bestOffset = finalOffset;
  
  console.log(`[Rhythm Layer] Estimated BPM: ${bpm.toFixed(2)}, Beat Offset: ${bestOffset.toFixed(3)}s`);

  // 3. Apply Rhythm to Onsets
  for (const o of onsets) {
    const floatGridNum = (o.t - bestOffset) / bestInterval;
    
    // 16분음표 단위 격자(1/4 beat) 기준으로 검사
    const grid16Num = Math.round(floatGridNum * 4);
    const grid16Time = bestOffset + (grid16Num / 4) * bestInterval;
    const dist16 = Math.abs(o.t - grid16Time);
    
    const isSnap = dist16 < 0.05; // 50ms 이내면 박자에 맞는 것으로 간주
    
    o.distanceToGrid = Number(dist16.toFixed(4));
    
    if (isSnap) {
      o.syncConfidence = dist16 < 0.02 ? "high" : "medium";
      o.beatIndex = Math.floor(grid16Num / 4);
      
      const sub = grid16Num % 4;
      if (sub === 0) o.subdivision = 1;       // 정박
      else if (sub === 2) o.subdivision = 0.5; // 8분음표 (엇박)
      else o.subdivision = 0.25;              // 16분음표
      
      o.beatPosition = o.beatIndex % 4; // 4/4 박자 기준 마디 내 위치 (0, 1, 2, 3)
    } else {
      o.syncConfidence = "low";
      o.subdivision = undefined; // off-grid
    }
  }
    
  // 4. Calculate Density (Sliding Window ~2초)
  for (let i = 0; i < onsets.length; i++) {
    const o = onsets[i];
    let windowEventCount = 0;
    let activeLayers = new Set<string>();
    let subDivCount = 0;
    
    // O(N^2) 피하기 위해 근처 인덱스만 탐색 (최대 ±40개)
    for (let j = Math.max(0, i - 40); j < Math.min(onsets.length, i + 40); j++) {
      const neighbor = onsets[j];
      if (Math.abs(neighbor.t - o.t) <= 1.0 && neighbor.syncConfidence !== "low") {
        windowEventCount++;
        activeLayers.add(neighbor.instrument);
        if (neighbor.subdivision === 0.25 || neighbor.subdivision === 0.5) subDivCount++;
      }
    }
    
    // Density 결정 (이벤트 수, 활성 레이어 수, 엇박/16분음표 비율 고려)
    let score = windowEventCount + (activeLayers.size * 2) + (subDivCount * 0.5);
    if (score >= 18) {
      o.density = "high";
    } else if (score >= 8) {
      o.density = "medium";
    } else {
      o.density = "low";
    }
  }

  // 4.5 Calculate Accent
  for (let i = 0; i < onsets.length; i++) {
    const o = onsets[i];
    let localMaxEnergy = 0;
    let localAvgEnergy = 0;
    let count = 0;
    for (let j = Math.max(0, i - 10); j < Math.min(onsets.length, i + 10); j++) {
      const n = onsets[j];
      if (Math.abs(n.t - o.t) <= 1.0 && n.instrument === o.instrument) {
        if (n.energy > localMaxEnergy) localMaxEnergy = n.energy;
        localAvgEnergy += n.energy;
        count++;
      }
    }
    localAvgEnergy = count > 0 ? localAvgEnergy / count : o.energy;

    let isStrong = false;
    let isWeak = false;

    // 강박 조건: 절대 에너지가 높고, 로컬 내에서도 두드러지며, 정박(subdivision=1)인 경우
    if (o.energy > 0.35 && o.energy >= localAvgEnergy * 1.2 && o.subdivision === 1) {
      isStrong = true;
    }
    // 약박 조건: 밀도가 높은데 에너지가 평균 이하이거나, 16분음표이면서 에너지가 낮은 경우
    else if ((o.density === "high" && o.energy < localAvgEnergy * 0.8) || (o.subdivision === 0.25 && o.energy < 0.2)) {
      isWeak = true;
    }

    if (isStrong) o.accent = "strong";
    else if (isWeak) o.accent = "weak";
    else o.accent = "normal";
  }

  // 5. Pattern Grouping
  // 동일한 악기(레이어)의 연속된 온셋을 묶어 시퀀스나 버스트 패턴으로 정의
  const instruments: Instrument[] = ["kick", "snare", "melody", "hihat", "drop"];
  
  for (const inst of instruments) {
    const instOnsets = onsets.filter(o => o.instrument === inst).sort((a, b) => a.t - b.t);
    let currentGroup: InstrumentOnset[] = [];
    
    for (let i = 0; i <= instOnsets.length; i++) {
      const o = instOnsets[i];
      const prev = currentGroup.length > 0 ? currentGroup[currentGroup.length - 1] : null;
      
      let shouldBreak = false;
      if (!o) {
        shouldBreak = true; // 배열 끝
      } else if (prev) {
        const gap = o.t - prev.t;
        // 간격이 너무 멀거나 (예: 1.2초 이상), 두 타격 모두 정박(subdivision=1)이면서 거리가 먼 경우 그룹 분리
        if (gap > 1.2) {
          shouldBreak = true;
        } else if (gap > 0.6 && o.subdivision === 1 && prev.subdivision === 1) {
          shouldBreak = true;
        }
      }
      
      if (shouldBreak) {
        if (currentGroup.length === 1) {
          currentGroup[0].patternType = "single";
          currentGroup[0].patternIndex = 0;
          currentGroup[0].patternLength = 1;
        } else if (currentGroup.length > 1) {
          const patternId = `pat_${inst}_${currentGroup[0].t.toFixed(2)}`;
          // 멜로디나 하이햇의 빠른 연타는 burst, 일반적인 비트는 sequence로 명명
          let pType: "sequence" | "burst" = "sequence";
          if ((inst === "hihat" || inst === "melody") && currentGroup.length >= 4) {
             const avgGap = (currentGroup[currentGroup.length-1].t - currentGroup[0].t) / (currentGroup.length - 1);
             if (avgGap < 0.2) pType = "burst";
          }
          
          for (let k = 0; k < currentGroup.length; k++) {
            currentGroup[k].patternId = patternId;
            currentGroup[k].patternType = pType;
            currentGroup[k].patternIndex = k;
            currentGroup[k].patternLength = currentGroup.length;
            
            // 6. Pitch Trajectory (Melody & Harmony)
            if ((inst === "melody" || inst === "snare") && currentGroup[k].pitch !== undefined) {
              if (k > 0 && currentGroup[k-1].pitch !== undefined) {
                const delta = currentGroup[k].pitch! - currentGroup[k-1].pitch!;
                currentGroup[k].pitchDelta = delta;
                if (Math.abs(delta) < 0.05) currentGroup[k].pitchDirection = "stable";
                else if (delta > 0) currentGroup[k].pitchDirection = "up";
                else currentGroup[k].pitchDirection = "down";
              } else {
                currentGroup[k].pitchDelta = 0;
                currentGroup[k].pitchDirection = "stable";
              }
            }
            
            // 7. Harmony (Synth/Snare) Duration
            if (inst === "snare") {
              if (k < currentGroup.length - 1) {
                const nextT = currentGroup[k+1].t;
                // 다음 노트까지의 시간을 duration으로 하되 최대 1.0초 제한
                currentGroup[k].duration = Math.min(1.0, nextT - currentGroup[k].t);
              } else {
                currentGroup[k].duration = 0.35; // 마지막 노트는 기본 길이
              }
            }
          }
        }
        currentGroup = [];
      }
      
      if (o) {
        currentGroup.push(o);
      }
    }
  }

  // 8. Harmony (Synth/Snare) Sustain Duration Calculation
  // 모든 화음(신스) 노트가 다음 화음 직전까지(레가토), 혹은 풍부한 여운(0.4~1.2초) 동안 유지되도록 duration & holdDuration 부여
  const snareOnsets = onsets.filter(o => o.instrument === "snare").sort((a, b) => a.t - b.t);
  for (let i = 0; i < snareOnsets.length; i++) {
    const o = snareOnsets[i];
    const nextO = snareOnsets[i + 1];
    let dur = 0.45;
    if (nextO) {
      const gap = nextO.t - o.t;
      if (gap <= 2.2) {
        // 다음 화음 직전까지 매끄럽게 레가토(Legato)로 길게 유지 (타격 구분용 30ms 간격 확보)
        dur = Math.max(0.20, gap - 0.03);
      } else {
        // 화음 간격이 긴 경우 자연스러운 서스테인 여운(0.6~1.2초) 적용
        dur = Math.min(1.2, Math.max(0.5, gap * 0.4));
      }
    } else {
      dur = 0.8;
    }
    o.duration = dur;
    o.holdDuration = dur;
  }

  // 9. Melody Pitch Trajectory & Duration Calculation
  // 모든 멜로디 노트의 이전 음 대비 상승/하강(delta, direction) 및 자연스러운 음표 지속 시간 부여
  const melodyOnsetsList = onsets.filter(o => o.instrument === "melody").sort((a, b) => a.t - b.t);
  for (let i = 0; i < melodyOnsetsList.length; i++) {
    const m = melodyOnsetsList[i];
    const prevM = i > 0 ? melodyOnsetsList[i - 1] : undefined;
    if (prevM && m.pitch !== undefined && prevM.pitch !== undefined) {
      if (m.t - prevM.t <= 2.5) {
        const delta = m.pitch - prevM.pitch;
        m.pitchDelta = delta;
        if (Math.abs(delta) < 0.04) m.pitchDirection = "stable";
        else if (delta > 0) m.pitchDirection = "up";
        else m.pitchDirection = "down";
      } else {
        m.pitchDelta = 0;
        m.pitchDirection = "stable";
      }
    } else {
      m.pitchDelta = 0;
      m.pitchDirection = "stable";
    }

    const nextM = melodyOnsetsList[i + 1];
    let mDur = 0.22;
    if (nextM) {
      const mGap = nextM.t - m.t;
      if (mGap <= 1.0) {
        mDur = Math.max(0.12, Math.min(0.65, mGap - 0.02));
      } else {
        mDur = 0.28;
      }
    } else {
      mDur = 0.35;
    }
    m.duration = mDur;
    m.holdDuration = mDur;
  }
}

/**
 * 오디오 파일의 순수 음악적 특징(온셋, 비트, 페이즈 세그먼트 등)을 분석하여 반환합니다.
 * 특정 테마나 장애물 생성 로직과 완전히 분리되어 있습니다.
 */
export async function analyzeAudio(
  filePath: string,
  songId: string,
  durationSec: number
): Promise<AudioAnalysisResult> {
  const samples = await decodeToPCM(filePath, durationSec);
  const onsets = detectInstrumentOnsets(samples);
  
  // Rhythm Layer 연산 수행 (BPM, Beat Offset 추정 및 각 onset에 리듬 정보 부착)
  analyzeRhythmLayer(onsets, durationSec);
  
  const rawPhases = analyzePhases(samples, durationSec);

  // 드랍 타이밍을 실제 onset에 정밀 스냅하여 시각 효과와 음악을 완벽히 동기화
  const phases = refineDropTiming(rawPhases, onsets);
  
  // 드랍 페이즈의 dropIntensity 계산
  for (const p of phases) {
    if (p.phase === "drop") {
      let dropOnsetCount = 0;
      let kickCount = 0;
      let activeLayers = new Set<string>();
      
      for (const o of onsets) {
        if (o.t >= p.startTime && o.t < p.endTime) {
          dropOnsetCount++;
          activeLayers.add(o.instrument);
          if (o.instrument === "kick") kickCount++;
        }
      }
      const duration = Math.max(1, p.endTime - p.startTime);
      const densityPerSec = dropOnsetCount / duration;
      const kickFreq = kickCount / duration;
      
      // 요소: 1) phase intensity, 2) onset 밀도, 3) kick 활성도, 4) 활성 레이어 수
      const iPhase = p.intensity * 0.4;
      const iDensity = Math.min(1.0, densityPerSec / 15.0) * 0.3;
      const iKick = Math.min(1.0, kickFreq / 4.0) * 0.2;
      const iLayers = (activeLayers.size / 5.0) * 0.1;
      
      p.dropIntensity = Math.min(1.0, iPhase + iDensity + iKick + iLayers);
    }
  }

  const VALID_INSTRUMENTS = new Set<string>(["kick", "snare", "melody", "hihat", "drop"]);
  const trimmed = onsets.filter((o) => o.t <= durationSec && VALID_INSTRUMENTS.has(o.instrument));

  // 모든 세분화된 박자 펄스 데이터 (배경 비주얼라이저가 모든 박자에 쿵쿵 뜀)
  const beats: BeatPulse[] = trimmed.map((o) => ({
    t: o.t,
    energy: o.energy,
    band: o.band,
    instrument: o.instrument,
  }));

  return {
    songId,
    durationSec,
    onsets,
    phases,
    beats,
  };
}

/**
 * 음악 분석 후 지정된 테마 생성기를 통해 타임라인을 생성합니다. (기본 테마: neon_pulse)
 */
export async function analyzeSongToTimeline(
  filePath: string,
  songId: string,
  stage: number,
  durationSec: number,
  themeId: string = "neon_pulse"
): Promise<TimelineData> {
  const analysis = await analyzeAudio(filePath, songId, durationSec);
  return buildTimeline(analysis, stage, themeId);
}

// 하위 호환성 및 모듈 통합 re-export
export { buildTimeline } from "./timelineBuilder";
export { AudioAnalysisResult, PatternGenerator, getPatternGenerator, registerPatternGenerator } from "./patterns";
