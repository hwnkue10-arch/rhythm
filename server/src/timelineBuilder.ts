import { TimelineData } from "./types";
import { AudioAnalysisResult, getPatternGenerator } from "./patterns";
import { hashString } from "./utils/random";

/**
 * 순수 음악 분석 데이터와 선택된 테마 ID를 조합하여,
 * 최종 게임 타임라인(TimelineData)을 빌드합니다.
 */
export function buildTimeline(
  analysis: AudioAnalysisResult,
  stage: number,
  themeId: string = "neon_pulse"
): TimelineData {
  const generator = getPatternGenerator(themeId);
  const seed = hashString(analysis.songId) + stage * 7919;
  const events = generator.generateEvents(analysis, stage, seed);

  return {
    songId: analysis.songId,
    stage,
    durationSec: analysis.durationSec,
    phases: analysis.phases,
    events,
    beats: analysis.beats,
    rawOnsets: analysis.onsets.filter((o) => o.t <= analysis.durationSec),
    themeId: generator.themeId,
  };
}
