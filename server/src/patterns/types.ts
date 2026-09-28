import { InstrumentOnset, ObstacleEvent, PhaseTimelineSegment, BeatPulse, TimelineData } from "../types";

/**
 * 순수 음악 분석 결과 데이터
 * 오디오 신호로부터 추출된 음악적 사실(BPM, 비트, 온셋, 페이즈 구간 등)만을 담고 있으며,
 * 특정 테마나 게임플레이 기믹에 대한 의존성이 전혀 없습니다.
 */
export interface AudioAnalysisResult {
  songId: string;
  durationSec: number;
  onsets: InstrumentOnset[];
  phases: PhaseTimelineSegment[];
  beats: BeatPulse[];
}

/**
 * 테마별 패턴 생성기 인터페이스
 * 입력된 순수 음악 분석 데이터(AudioAnalysisResult)를 바탕으로,
 * 해당 테마의 비주얼 기믹, 오브젝트 룰, 탄막 스타일에 맞는 장애물 이벤트(ObstacleEvent[])를 생성합니다.
 */
export interface PatternGenerator {
  themeId: string;
  generateEvents(
    analysis: AudioAnalysisResult,
    stage: number,
    seed: number
  ): ObstacleEvent[];
}
