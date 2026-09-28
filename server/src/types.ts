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
  isDefault?: boolean; // 테마 기본곡 여부
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
  | "sweep_laser"
  | "melody_bolt"
  | "orb_move"
  | "beat_pulse"
  | "trail_hazard";

export type InstrumentType = "kick" | "snare" | "melody" | "hihat" | "drop";
export type Instrument = InstrumentType;

export interface InstrumentOnset {
  t: number;
  instrument: Instrument;
  energy: number;
  band: "low" | "mid" | "high";
  pitch?: number;
  
  // Transient & Analysis metrics
  confidence?: number;
  strength?: number;
  subEnergy?: number;
  kickEnergy?: number;
  lowMidEnergy?: number;
  sectionTransitionScore?: number;

  // Rhythm Layer
  beatIndex?: number;
  beatPosition?: number; // 0 to 3 for a 4/4 measure, etc.
  subdivision?: number; // 1 (beat), 0.5 (8th note), 0.25 (16th note), etc.
  distanceToGrid?: number;
  accent?: "strong" | "normal" | "weak";
  syncConfidence?: "high" | "medium" | "low";
  density?: "low" | "medium" | "high";

  // Pattern Grouping
  patternId?: string;
  patternType?: "single" | "sequence" | "burst" | "alternating";
  patternIndex?: number;
  patternLength?: number;
  
  // Melody / Harmony specific
  pitchDelta?: number;
  pitchDirection?: "up" | "down" | "stable";
  duration?: number;
  holdDuration?: number;
}

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
  holdDuration?: number; // 지속형 노트/장애물 지속 시간 (초)
  duration?: number;
  pitch?: number;
  pitchDelta?: number;
  pitchDirection?: "up" | "down" | "stable";
  type: ObstacleType;
  instrument: InstrumentType; // 1:1 대조 악기 소리
  band: "low" | "mid" | "high"; // 주파수 대역
  energy: number; // 0~1
  params: {
    x: number; // 0~1 정규화 좌표
    y: number;
    startX?: number; // 가로 탄환 발사 시작점 (0: 좌, 1: 우)
    targetX?: number; // 가로 탄환 도달 지점 (0~1)
    side?: "left" | "right"; // 그루브 구체 오브젝트 위치 (좌/우)
    targetY?: number; // 구체 이동 목표 y 좌표 (0~1)
    fromX?: number; // 이동 시작 x
    fromY?: number; // 이동 시작 y
    x1?: number; // 잔상/트레일 시작점
    y1?: number;
    x2?: number; // 잔상/트레일 끝점
    y2?: number;
    moveDuration?: number; // 구체 이동 지속 시간
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
    isMCLaser?: boolean;   // BUILD 1: M과 C를 직접 잇는 회전 연결 레이저
    isBuildKick?: boolean; // BUILD 1: 킥 타격 회전 가속용
    noCollision?: boolean; // 시각/물리 효과 전용, 플레이어 피격 없음
  };
};

export interface Timeline {
  songId: string;
  stage: number;
  durationSec: number;
  themeId: string;
  events: ObstacleEvent[];
  beats: BeatPulse[]; // 모든 박자에 반응하는 배경 펄스용
  phases: PhaseTimelineSegment[];
  rawOnsets?: any[]; // 비주얼라이저/분석용 필터링 전 원본 데이터
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
  lastHitAt?: number; // ms epoch, 일정 시간 무피격 시 체력 회복 로직에 사용
  stats?: PlayerStats;
  totalStats?: PlayerStats;
}

export type RoomPhase = "lobby" | "playing" | "stage_clear" | "stage_failed" | "game_clear";

export interface RoomState {
  id: string;
  hostId: string;
  phase: RoomPhase;
  stage: number; // 1~3, playing 중 현재 스테이지
  songs: [SongSlot, SongSlot, SongSlot];
  players: Record<string, PlayerState>;
  lastStats?: Record<string, PlayerStats & { nickname: string; color: string; totalHitCount: number; totalDeathCount: number; totalReviveCount: number }>;
}

export type PhaseType = 'intro' | 'groove' | 'build_1' | 'build_2' | 'drop' | 'break' | 'finale';

export interface PhaseTimelineSegment {
  phase: PhaseType;
  startTime: number; // 초 단위
  endTime: number; // 초 단위
  intensity: number; // 0.0 ~ 1.0 (페이즈 내 난이도/밀도)
  dropIntensity?: number;
  dominantInstrument?: 'kick' | 'snare' | 'melody' | 'hihat'; // 해당 페이즈의 메인 주파수 대역
  dropImpactTime?: number; // 드랍 페이즈 전용: 실제 음악 임팩트(첫 폭발 타격)의 정밀 타임스탬프 (초 단위, 프레임 정밀도)
  preDropGapDuration?: number; // 빌드 페이즈 전용: 드랍 직전 쉼/침묵 구간의 길이 (초 단위, 예: 0.46초)
}

export interface PhasePatternRule {
  instrument: 'kick' | 'snare' | 'melody' | 'hihat' | 'drop';
  densityLimit: number; // 동시에 나올 수 있는 최대 장애물 수
  speedMultiplier: number; // 장애물 이동 속도 가중치
}

export interface TimelineData extends Timeline {}
