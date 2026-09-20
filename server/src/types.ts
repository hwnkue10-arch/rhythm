export type SourceType = "upload" | "youtube";

export interface SongSlot {
  slot: 1 | 2 | 3;
  sourceType: SourceType | null;
  title: string | null;
  filePath: string | null; // 서버 로컬 경로 (재생/분석용)
  publicUrl: string | null; // 클라이언트가 스트리밍할 URL
  fullDurationSec: number | null; // 원곡 실제 길이
  durationSec: number | null; // 이번 스테이지에서 실제 사용할 길이(기본 2분 캡, 시작 전 조절 가능)
  verified: boolean; // 유튜브 링크 확인 절차 통과 여부
}

export type ObstacleType =
  | "laser"
  | "wave"
  | "shockwave"
  | "wall_crush"
  | "zone_blast"
  | "straight"
  | "blaster"
  | "gatling"
  | "sweep_laser";

export type InstrumentType = "kick" | "snare" | "melody" | "hihat" | "drop";

export interface BeatPulse {
  t: number; // 초 단위 타임스탬프
  energy: number; // 0~1
  band: "low" | "mid" | "high";
  instrument?: InstrumentType;
}

export interface ObstacleEvent {
  t: number; // 스테이지 시작 후 경과 초 (비트 타격 시점)
  warnDuration: number; // 비트 전 경고 표시 지속 시간 (초, 예: 0.85초)
  activeDuration: number; // 비트 후 피격 유효 시간 (초, 예: 0.35초)
  type: ObstacleType;
  instrument: InstrumentType; // 1:1 대조 악기 소리
  band: "low" | "mid" | "high"; // 주파수 대역
  energy: number; // 0~1
  params: {
    x: number; // 0~1 정규화 좌표
    y: number;
    angle?: number;
    speed?: number;
    width?: number;
    length?: number;
    radius?: number;
    direction?: "horizontal" | "vertical" | "left" | "right" | "up" | "down";
    amplitude?: number;
    frequency?: number;
    count?: number;
    burstCount?: number;
    burstInterval?: number;
    sweepAngle?: number;   // sweep_laser: 시작 각도 (라디안)
    sweepSpeed?: number;   // sweep_laser: 초당 회전 속도 (라디안/초)
    sweepLength?: number;  // sweep_laser: 빔 길이 (0~1 정규화)
  };
}

export interface Timeline {
  songId: string;
  stage: number;
  durationSec: number;
  themeId: string;
  events: ObstacleEvent[];
  beats: BeatPulse[]; // 모든 박자에 반응하는 배경 펄스용
}

export interface PlayerStats {
  hitCount: number;
  deathCount: number;
  reviveCount: number;
}

export interface PlayerState {
  id: string;
  nickname: string;
  color: string;
  connected: boolean;
  lives: number;
  dead: boolean;
  diedAt: number | null; // ms epoch, 부활 가능 시간 계산용
  x: number;
  y: number;
  invulnerableUntil: number; // ms epoch
  stats?: PlayerStats;
}

export type RoomPhase = "lobby" | "playing" | "stage_clear" | "stage_failed" | "game_clear";

export interface RoomState {
  id: string;
  hostId: string;
  phase: RoomPhase;
  stage: number; // 1~3, playing 중 현재 스테이지
  songs: [SongSlot, SongSlot, SongSlot];
  players: Record<string, PlayerState>;
}
