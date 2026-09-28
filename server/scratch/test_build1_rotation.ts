import { analyzeSongToTimeline } from "../src/audioAnalysis";
import path from "path";

async function run() {
  const songPath = path.resolve("../client/assets/Through_The_Obsidian_Grid.mp3");
  const t = await analyzeSongToTimeline(songPath, "default", 3, 160);

  const build1Seg = t.phases.find(p => p.phase === "build_1")!;
  const t0 = build1Seg.startTime; // 31
  const t1 = build1Seg.endTime;   // 38
  const dur = t1 - t0;

  const kicks = t.events.filter(e => e.instrument === "kick" && e.t >= t0 && e.t < t1).sort((a,b)=>a.t-b.t);

  // Client _initBuild1Rotation replica
  const dt = 0.016;
  const steps = Math.ceil(dur / dt) + 2;
  const table = new Float32Array(steps);
  let curAngle = Math.PI;
  let curDir = 1;
  let curSpeed = 2.2;
  let kickIdx = 0;

  for (let i = 0; i < steps; i++) {
    const curT = t0 + i * dt;
    const prog = Math.min(1.0, i / steps);
    let baseSpeed = 2.2 + prog * 2.8;

    while (kickIdx < kicks.length && kicks[kickIdx].t <= curT) {
      const k = kicks[kickIdx++];
      const kProg = (k.t - t0) / dur;
      if (kProg < 0.28) {
        curSpeed += 1.0;
      } else if (kProg < 0.70) {
        curDir = -curDir;
        curSpeed = Math.max(curSpeed * 0.35, 1.8);
      } else {
        curDir = -curDir;
        curSpeed = Math.max(curSpeed * 0.45, 2.5) + 1.8;
      }
    }
    const targetSpeed = baseSpeed;
    curSpeed += (targetSpeed - curSpeed) * Math.min(1.0, 5.0 * dt);
    curAngle += curDir * curSpeed * dt;
    table[i] = curAngle;
  }

  function getAngle(elapsed: number) {
    const fIdx = (elapsed - t0) / dt;
    if (fIdx <= 0) return table[0];
    if (fIdx >= table.length - 1) return table[table.length - 1];
    const idx0 = Math.floor(fIdx);
    const frac = fIdx - idx0;
    return table[idx0] + (table[idx0 + 1] - table[idx0]) * frac;
  }

  console.log("=== BUILD 1 FRAME ROTATION SAMPLES (every 0.5s) ===");
  for (let s = t0; s <= t1; s += 0.5) {
    const angle = getAngle(s);
    const enterProg = Math.max(0, Math.min(1.0, (s - t0) / 0.6));
    const enterEase = enterProg * enterProg * (3 - 2 * enterProg);
    const curR = 0.46 - enterEase * 0.13;

    const mx = 0.5 + Math.cos(angle) * curR;
    const my = 0.5 + Math.sin(angle) * curR;
    const cx = 0.5 - Math.cos(angle) * curR;
    const cy = 0.5 - Math.sin(angle) * curR;

    const midX = (mx + cx) * 0.5;
    const midY = (my + cy) * 0.5;
    const dist = Math.hypot(mx - cx, my - cy);

    console.log(`[t=${s.toFixed(1)}s] Angle=${(angle * 180 / Math.PI % 360).toFixed(1)}°, R=${curR.toFixed(3)} | M=(${mx.toFixed(3)}, ${my.toFixed(3)}) C=(${cx.toFixed(3)}, ${cy.toFixed(3)}) | Center=(${midX.toFixed(2)}, ${midY.toFixed(2)}) Dist=${dist.toFixed(3)}`);
  }
}

run().catch(console.error);
