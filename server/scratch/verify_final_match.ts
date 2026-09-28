import { analyzeSongToTimeline } from '../src/audioAnalysis';
import path from 'path';

async function testFinal() {
  const songPath = path.resolve('../client/assets/Through_The_Obsidian_Grid.mp3');
  const tl: any = await analyzeSongToTimeline(songPath, 'default', 3, 160);
  
  const rawOnsets = tl.rawOnsets;
  const rawSnares = rawOnsets.filter((o: any) => o.instrument === 'snare');
  const rawMelodies = rawOnsets.filter((o: any) => o.instrument === 'melody');
  
  console.log(`[RawOnsets] Snare(Synth): ${rawSnares.length}, Melody: ${rawMelodies.length}`);

  const events = tl.events;
  // Note: M-C lasers have isMCLaser: true, regular snares have direction: 'vertical'
  const evSnares = events.filter((e: any) => e.instrument === 'snare');
  const evMelodies = events.filter((e: any) => e.instrument === 'melody');

  console.log(`[Events] Snare(Synth): ${evSnares.length}, Melody: ${evMelodies.length}`);
  
  // Check that all raw snares have an exact matching event
  let matchedSnares = 0;
  for (const s of rawSnares) {
    if (events.some((e: any) => e.instrument === 'snare' && Math.abs(e.t - s.t) < 0.001)) {
      matchedSnares++;
    }
  }
  console.log(`Snare match rate: ${matchedSnares} / ${rawSnares.length}`);

  // Check that all raw melodies have an exact matching event
  let matchedMelodies = 0;
  for (const m of rawMelodies) {
    if (events.some((e: any) => e.instrument === 'melody' && Math.abs(e.t - m.t) < 0.001)) {
      matchedMelodies++;
    }
  }
  console.log(`Melody match rate: ${matchedMelodies} / ${rawMelodies.length}`);
}

testFinal().catch(console.error);
