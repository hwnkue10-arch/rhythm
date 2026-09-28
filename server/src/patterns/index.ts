import { PatternGenerator } from "./types";
import { NeonPulsePatternGenerator } from "./NeonPulsePatternGenerator";

export * from "./types";
export * from "./NeonPulsePatternGenerator";

const registry = new Map<string, PatternGenerator>();

// 기본 테마 등록
const defaultGenerator = new NeonPulsePatternGenerator();
registry.set("neon_pulse", defaultGenerator);
registry.set("default", defaultGenerator);

/**
 * 새로운 테마 패턴 생성기를 등록합니다.
 */
export function registerPatternGenerator(generator: PatternGenerator): void {
  registry.set(generator.themeId, generator);
}

/**
 * 테마 ID에 대응하는 패턴 생성기를 반환합니다.
 * 미등록 테마이거나 미지정 시 기본 "neon_pulse" 생성기가 반환됩니다.
 */
export function getPatternGenerator(themeId?: string): PatternGenerator {
  if (!themeId) return defaultGenerator;
  return registry.get(themeId) ?? defaultGenerator;
}
