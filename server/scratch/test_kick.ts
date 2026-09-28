import { decodeToPCM, detectInstrumentOnsets, analyzeSongToTimeline } from "../src/audioAnalysis";
import path from "path";

async function run() {
  const songPath = path.resolve("../client/assets/Through_The_Obsidian_Grid.mp3");
  const t = await analyzeSongToTimeline(songPath, "default", 3, 160);
  
  const allKicks = (t.rawOnsets || []).filter(o => o.instrument === "kick");
  console.log("Total valid kicks:", allKicks.length);

  const sections = [
    { name: "Intro (0~16s)", s: 0, e: 16 },
    { name: "Groove (16~31s)", s: 16, e: 31 },
    { name: "Build 1 (31~38s)", s: 31, e: 38 },
    { name: "Build 2 (38~44s)", s: 38, e: 44 },
    { name: "Drop (44~72s)", s: 44, e: 72 },
    { name: "Outro (149~160s)", s: 149, e: 160 },
  ];

  console.log("\n=== SECTION KICK COUNTS ===");
  for (const sec of sections) {
    const kCount = allKicks.filter(k => k.t >= sec.s && k.t < sec.e).length;
    console.log(`${sec.name}: ${kCount} kicks`);
  }

  const strengths = allKicks.map(k => k.strength || 0).sort((a,b) => a-b);
  if (strengths.length > 0) {
    console.log(`Kick strength P50: ${strengths[Math.floor(strengths.length * 0.5)]?.toFixed(2)}`);
    console.log(`Kick strength P90: ${strengths[Math.floor(strengths.length * 0.9)]?.toFixed(2)}`);
    console.log(`Kick strength P95: ${strengths[Math.floor(strengths.length * 0.95)]?.toFixed(2)}`);
    console.log(`Kick strength Max: ${strengths[strengths.length - 1]?.toFixed(2)}`);
  }
}

run().catch(console.error);
