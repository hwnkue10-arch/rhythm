import { analyzeSongToTimeline } from "../src/audioAnalysis";
import path from "path";

async function run() {
  const songPath = path.resolve("../client/assets/Through_The_Obsidian_Grid.mp3");
  const t = await analyzeSongToTimeline(songPath, "default", 3, 160);

  const build1Seg = t.phases.find(p => p.phase === "build_1");
  console.log("BUILD 1 Segment:", build1Seg);

  if (!build1Seg) {
    console.log("No build_1 segment found!");
    return;
  }

  const b1Events = t.events.filter(e => e.t >= build1Seg.startTime - 0.5 && e.t <= build1Seg.endTime + 0.5);
  console.log(`\nFound ${b1Events.length} events in BUILD 1 window:`);

  for (const ev of b1Events) {
    if (ev.params?.isMCLaser) {
      console.log(`★ [t=${ev.t.toFixed(2)}] MC_LASER: warn=${ev.warnDuration}s, active=${ev.activeDuration}s, width=${ev.params.width}`);
    } else {
      console.log(`  [t=${ev.t.toFixed(2)}] ${ev.type} (${ev.instrument}/${ev.band}): warn=${ev.warnDuration}s, active=${ev.activeDuration}s, params=${JSON.stringify(ev.params)}`);
    }
  }
}

run().catch(console.error);
