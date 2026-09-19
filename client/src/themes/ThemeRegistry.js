import { NeonPulseTheme } from "./NeonPulseTheme.js";

/**
 * 게임 스테이지 테마 관리 레지스트리.
 * 새로운 테마를 만들면 register()를 통해 등록하여 스테이지별로 무작위 또는 지정된 테마를 불러올 수 있습니다.
 */
class ThemeRegistry {
  constructor() {
    this.themes = new Map();
    // 기본 테마 등록
    this.register(new NeonPulseTheme());
  }

  /**
   * 새로운 테마 인스턴스를 등록합니다.
   * @param {import("./BaseTheme.js").BaseTheme} theme
   */
  register(theme) {
    this.themes.set(theme.id, theme);
  }

  /**
   * 지정된 ID의 테마를 반환합니다. 없을 경우 기본 테마를 반환합니다.
   * @param {string} id
   * @returns {import("./BaseTheme.js").BaseTheme}
   */
  get(id) {
    if (this.themes.has(id)) {
      return this.themes.get(id);
    }
    return this.themes.get("neon_pulse");
  }

  /**
   * 등록된 테마 중 무작위로 하나를 반환합니다.
   * @returns {import("./BaseTheme.js").BaseTheme}
   */
  getRandom() {
    const list = Array.from(this.themes.values());
    return list[Math.floor(Math.random() * list.length)];
  }
}

export const themeRegistry = new ThemeRegistry();
