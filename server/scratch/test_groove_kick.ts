import { analyzeSongToTimeline } from "../src/audioAnalysis";
import path from "path";

async function run() {
  const songPath = path.resolve("../client/assets/Through_The_Obsidian_Grid.mp3");
  const t = await analyzeSongToTimeline(songPath, "default", 3, 160);

  const grooveEvents = t.events.filter(e => e.t >= 16 && e.t <= 31 && (e.type === "shockwave" || e.type === "orb_move"));
  console.log(`Found ${grooveEvents.length} groove events (shockwave & orb_move)`);

  for (const ev of grooveEvents) {
    if (ev.type === "orb_move") {
      console.log(`[t=${ev.t.toFixed(2)}] ORB_MOVE: side=${ev.params?.side}, fromY=${ev.params?.fromY?.toFixed(3)}, targetY=${ev.params?.targetY?.toFixed(3)} (dur=${ev.activeDuration})`);
    } else if (ev.type === "shockwave") {
      console.log(`[t=${ev.t.toFixed(2)}] SHOCKWAVE: side=${ev.params?.side}, x=${ev.params?.x}, y=${ev.params?.y?.toFixed(3)}`);
    }
  }
}

run().catch(console.error);
