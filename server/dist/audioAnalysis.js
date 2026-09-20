"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeToPCM = decodeToPCM;
exports.detectInstrumentOnsets = detectInstrumentOnsets;
exports.buildTimeline = buildTimeline;
exports.analyzeSongToTimeline = analyzeSongToTimeline;
const child_process_1 = require("child_process");
// @ts-ignore - ffmpeg-static exports a string path with no types
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
const SAMPLE_RATE = 22050;
const FRAME_SIZE = 1024; // FFT 윈도우 크기
const HOP = 512; // 50% 오버랩
const FRAME_SEC = HOP / SAMPLE_RATE;
/** 4대 핵심 주파수 대역 (킥, 스네어, 멜로디, 하이햇) */
const INSTRUMENT_RANGES = {
    kick: [20, 130], // 서브베이스 & 무거운 킥 드럼 (20~130Hz)
    snare: [250, 1400], // 스네어 / 클랩 / 타악기 어택 (250~1400Hz)
    melody: [1400, 4200], // 리드 신스, 보컬, 멜로디 음표 (1400~4200Hz)
    hihat: [4200, 10000], // 찰랑거리는 하이햇, 셰이커 (4200~10000Hz)
};
/** ffmpeg로 오디오 파일을 16bit mono PCM으로 디코딩한다. maxDurationSec을 주면 그 길이까지만 디코딩해 분석 속도를 높인다. */
function decodeToPCM(filePath, maxDurationSec) {
    return new Promise((resolve, reject) => {
        const args = ["-i", filePath];
        if (maxDurationSec)
            args.push("-t", String(Math.ceil(maxDurationSec) + 1));
        args.push("-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-");
        const proc = (0, child_process_1.spawn)(ffmpeg_static_1.default, args);
        const chunks = [];
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
function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1)
            j ^= bit;
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
    for (let i = 0; i < FRAME_SIZE; i++)
        w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1));
    return w;
})();
/**
 * 오디오를 세부 대역(킥, 스네어, 멜로디, 하이햇, 드롭)으로 나눠 정밀 분석.
 * 각 악기/소리의 온셋을 추출하여 고유 패턴과 1:1 대조할 수 있도록 한다.
 */
function detectInstrumentOnsets(samples) {
    const frameCount = Math.max(0, Math.floor((samples.length - FRAME_SIZE) / HOP));
    const instKeys = Object.keys(INSTRUMENT_RANGES);
    const binRanges = {};
    for (const k of instKeys) {
        const [loHz, hiHz] = INSTRUMENT_RANGES[k];
        binRanges[k] = [
            Math.max(1, Math.floor((loHz * FRAME_SIZE) / SAMPLE_RATE)),
            Math.min(FRAME_SIZE / 2 - 1, Math.ceil((hiHz * FRAME_SIZE) / SAMPLE_RATE)),
        ];
    }
    const energyMap = { kick: [], snare: [], melody: [], hihat: [] };
    const totalEnergy = [];
    const re = new Float64Array(FRAME_SIZE);
    const im = new Float64Array(FRAME_SIZE);
    for (let f = 0; f < frameCount; f++) {
        const start = f * HOP;
        for (let i = 0; i < FRAME_SIZE; i++) {
            re[i] = (samples[start + i] ?? 0) * HANN[i];
            im[i] = 0;
        }
        fft(re, im);
        let tot = 0;
        for (const k of instKeys) {
            const [lo, hi] = binRanges[k];
            let sum = 0;
            for (let b = lo; b <= hi; b++) {
                const mag = Math.hypot(re[b], im[b]);
                sum += mag;
                tot += mag;
            }
            energyMap[k].push(sum);
        }
        totalEnergy.push(tot);
    }
    const onsets = [];
    const windowFrames = Math.max(4, Math.round(1 / FRAME_SEC)); // 1초 이동평균 윈도우
    // 악기별 최소 발생 간격 (너무 겹치지 않는 음악적 템포)
    const gapFrames = {
        kick: Math.max(3, Math.round(0.25 / FRAME_SEC)), // 킥 드럼 최소 0.25s
        snare: Math.max(3, Math.round(0.28 / FRAME_SEC)), // 스네어 최소 0.28s
        melody: Math.max(2, Math.round(0.20 / FRAME_SEC)), // 멜로디 음표 최소 0.20s
        hihat: Math.max(2, Math.round(0.14 / FRAME_SEC)), // 하이햇 최소 0.14s
    };
    const mult = {
        kick: 1.55,
        snare: 1.6,
        melody: 1.7,
        hihat: 1.85,
    };
    // 1. 각 악기별 온셋 감지
    for (const k of instKeys) {
        const energies = energyMap[k];
        const maxE = Math.max(...energies, 1e-6);
        const norm = energies.map((e) => e / maxE);
        // Spectral flux (에너지 상승분)
        const flux = [0];
        for (let i = 1; i < norm.length; i++)
            flux.push(Math.max(0, norm[i] - norm[i - 1]));
        const maxFlux = Math.max(...flux, 1e-6);
        const normFlux = flux.map((v) => v / maxFlux);
        let lastIdx = -gapFrames[k] * 2;
        const bandName = k === "kick" ? "low" : k === "snare" || k === "melody" ? "mid" : "high";
        for (let i = 0; i < normFlux.length; i++) {
            const winStart = Math.max(0, i - windowFrames);
            const winEnd = Math.min(normFlux.length, i + 1);
            let avg = 0;
            for (let w = winStart; w < winEnd; w++)
                avg += normFlux[w];
            avg /= winEnd - winStart;
            const threshold = avg * mult[k] + 0.12;
            if (normFlux[i] > threshold && i - lastIdx >= gapFrames[k]) {
                onsets.push({
                    t: i * FRAME_SEC,
                    instrument: k,
                    energy: normFlux[i],
                    band: bandName,
                });
                lastIdx = i;
            }
        }
    }
    // 2. 전체 대역이 한 번에 폭발하는 '드롭(Drop / Climax)' 감지
    const maxTot = Math.max(...totalEnergy, 1e-6);
    const normTot = totalEnergy.map((e) => e / maxTot);
    const totFlux = [0];
    for (let i = 1; i < normTot.length; i++)
        totFlux.push(Math.max(0, normTot[i] - normTot[i - 1]));
    const maxTotFlux = Math.max(...totFlux, 1e-6);
    const dropFlux = totFlux.map((v) => v / maxTotFlux);
    let lastDropIdx = -Math.round(2.5 / FRAME_SEC);
    for (let i = 0; i < dropFlux.length; i++) {
        if (dropFlux[i] > 0.65 && i - lastDropIdx >= Math.round(2.2 / FRAME_SEC)) {
            onsets.push({
                t: i * FRAME_SEC,
                instrument: "drop",
                energy: dropFlux[i],
                band: "low",
            });
            lastDropIdx = i;
        }
    }
    return onsets.sort((a, b) => a.t - b.t);
}
function hashString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}
function mulberry32(seed) {
    let a = seed | 0;
    return function () {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * 감지된 악기 소리와 1:1로 정확히 대조되는 장애물 이벤트 생성:
 * - kick (쿵!) -> shockwave (바닥 비트 충격파)
 * - snare (착!) -> laser (가로/세로 네온 레이저 빔)
 * - melody (음표) -> blaster (타깃 조준 단발 레이저)
 * - hihat (치-치) -> gatling (리듬 틱 연속 탄환)
 * - drop (콰광!) -> wall_crush (거대 압살 벽)
 */
function makeInstrumentEvent(onset, stage, rand, melodyIndex) {
    const { t, instrument, energy, band } = onset;
    // 스테이지별 경고 시간 (1스테이지 0.75s, 2스테이지 0.62s, 3스테이지 0.50s)
    const warnDuration = stage === 1 ? 0.75 : stage === 2 ? 0.62 : 0.5;
    let type;
    let activeDuration = 0.35;
    const params = {
        x: 0.15 + rand() * 0.7,
        y: 0.15 + rand() * 0.7,
    };
    if (instrument === "kick") {
        // 1. 킥 드럼: 바닥을 쿵! 울리는 충격파 링 — 느리게 뻗어나가 대응 가능
        type = "shockwave";
        activeDuration = 0.85; // 더 길게 → 천천히 팽창
        params.radius = 0.50 + energy * 0.12; // 반경 소폭 감소
        params.speed = 0.22 + energy * 0.06; // 속도 ~40% 감소
    }
    else if (instrument === "snare") {
        // 2. 스네어 / 클랩: 착! 소리에 맞춰 화면을 가로지르는 번쩍이는 레이저
        type = "laser";
        activeDuration = 0.35;
        const isHoriz = rand() < 0.5;
        if (isHoriz) {
            params.direction = "horizontal";
            params.width = 0.045 + energy * 0.03;
            params.y = 0.15 + rand() * 0.7;
        }
        else {
            params.direction = "vertical";
            params.width = 0.045 + energy * 0.03;
            params.x = 0.15 + rand() * 0.7;
        }
    }
    else if (instrument === "melody") {
        // 3. 멜로디: 8방향 고정 각도에서 화면 가장자리 → 내부로 날아오는 레이저 볼트
        type = "blaster";
        activeDuration = 0.30;
        // 8방향 고정 각도 (0°=우, 45°=우하, 90°=하, 135°=좌하, 180°=좌, 225°=좌상, 270°=상, 315°=우상)
        const FIXED_ANGLES = [
            0,
            Math.PI * 0.25,
            Math.PI * 0.5,
            Math.PI * 0.75,
            Math.PI,
            Math.PI * 1.25,
            Math.PI * 1.5,
            Math.PI * 1.75,
        ];
        const dirIdx = melodyIndex.v % FIXED_ANGLES.length;
        melodyIndex.v++;
        const fireAngle = FIXED_ANGLES[dirIdx];
        // 발사 방향의 반대쪽 화면 가장자리에서 발사 (플레이어 쪽으로 날아오는 느낌)
        // 각도에 따라 발사 원점을 화면 가장자리에 고정
        const edgePad = 0.04;
        let ox = 0.5, oy = 0.5;
        const ax = Math.cos(fireAngle), ay = Math.sin(fireAngle);
        // 가장자리 중 가장 빨리 벗어나는 쪽
        if (Math.abs(ax) >= Math.abs(ay)) {
            ox = ax > 0 ? edgePad : 1 - edgePad;
            oy = 0.15 + rand() * 0.7;
        }
        else {
            ox = 0.15 + rand() * 0.7;
            oy = ay > 0 ? edgePad : 1 - edgePad;
        }
        params.x = ox;
        params.y = oy;
        params.angle = fireAngle;
        params.speed = 0.90 + energy * 0.15;
        params.width = 0.018;
    }
    else if (instrument === "hihat") {
        // 4. 하이햇: 화면 한쪽 가장자리에서 뻗어나오는 회전 레이저 빔 (치-치-치 리듬)
        type = "sweep_laser";
        activeDuration = 0.55;
        // 화면 코너 중 랜덤 1개에서 발사
        const corners = [
            { x: 0.0, y: 0.0 },
            { x: 1.0, y: 0.0 },
            { x: 0.0, y: 1.0 },
            { x: 1.0, y: 1.0 },
        ];
        const corner = corners[Math.floor(rand() * corners.length)];
        params.x = corner.x;
        params.y = corner.y;
        // 코너별 스윕 시작/끝 각도 (화면 안쪽을 훑는 방향)
        // 우상단 코너라면 180°~270°(좌↔하) 방향을 쓸어야 화면 안으로 들어옴
        const sweepRanges = {
            "0,0": { start: 0, speed: Math.PI * 1.4 }, // 좌상: 우~하 방향으로 쓸기
            "1,0": { start: Math.PI * 0.5, speed: Math.PI * 1.4 }, // 우상: 하~좌 방향으로 쓸기
            "0,1": { start: -Math.PI * 0.5, speed: Math.PI * 1.4 }, // 좌하: 우~상 방향으로 쓸기
            "1,1": { start: Math.PI, speed: -Math.PI * 1.4 }, // 우하: 좌~상 방향으로 쓸기
        };
        const key = `${corner.x},${corner.y}`;
        const sweep = sweepRanges[key] ?? { start: 0, speed: Math.PI * 1.2 };
        params.sweepAngle = sweep.start;
        params.sweepSpeed = sweep.speed * (0.9 + energy * 0.3); // 에너지 높을수록 빠르게
        params.sweepLength = 0.55 + energy * 0.15; // 빔 길이
        params.width = 0.022; // 빔 두께
    }
    else {
        // 5. 드롭 / 클라이맥스: 콰광! 전 대역 폭발 순간 화면 한 면을 쿵 내려찍는 압살 벽
        type = "wall_crush";
        activeDuration = 0.52;
        const dirs = ["left", "right", "up", "down"];
        params.direction = dirs[Math.floor(rand() * dirs.length)];
        params.width = 0.35 + energy * 0.1;
    }
    return {
        t,
        warnDuration,
        activeDuration,
        type,
        instrument,
        band,
        energy,
        params,
    };
}
/**
 * 음악의 모든 세부 온셋으로부터 타임라인을 구성.
 * 모든 박자에 맞춰 악기별 패턴이 1:1로 대조되어 나온다.
 */
function buildTimeline(onsets, songId, stage, durationSec) {
    const rand = mulberry32(hashString(songId) + stage * 7919);
    const trimmed = onsets.filter((o) => o.t <= durationSec);
    // 모든 세분화된 박자 펄스 데이터 (배경 비주얼라이저가 모든 박자에 쿵쿵 뜀)
    const beats = trimmed.map((o) => ({
        t: o.t,
        energy: o.energy,
        band: o.band,
        instrument: o.instrument,
    }));
    // 같은 시점(0.08초 이내)에 5개 악기가 동시에 전부 터져 시야를 가리는 것을 방지하기 위해
    // 우선순위(drop > kick > snare > melody > hihat) 기반으로 프레임당 조화로운 패턴 생성
    const priorityOrder = {
        drop: 5,
        kick: 4,
        snare: 3,
        melody: 2,
        hihat: 1,
    };
    const events = [];
    let lastTime = -1;
    let concurrentCount = 0;
    const melodyIndex = { v: 0 }; // melody blaster 방향 순환 카운터
    for (const onset of trimmed) {
        if (Math.abs(onset.t - lastTime) < 0.08) {
            // 0.08초 이내 동시 발생 패턴 개수 제한: 1스테이지 1개, 2스테이지 2개, 3스테이지 2~3개
            const maxConcurrent = stage === 1 ? 1 : 2;
            if (concurrentCount >= maxConcurrent)
                continue;
            concurrentCount++;
        }
        else {
            lastTime = onset.t;
            concurrentCount = 1;
        }
        events.push(makeInstrumentEvent(onset, stage, rand, melodyIndex));
    }
    events.sort((a, b) => a.t - b.t);
    return {
        songId,
        stage,
        durationSec,
        themeId: "neon_pulse",
        events,
        beats,
    };
}
async function analyzeSongToTimeline(filePath, songId, stage, durationSec) {
    const samples = await decodeToPCM(filePath, durationSec);
    const onsets = detectInstrumentOnsets(samples);
    return buildTimeline(onsets, songId, stage, durationSec);
}
