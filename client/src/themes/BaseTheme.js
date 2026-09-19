/**
 * 모든 스테이지 테마의 기본이 되는 베이스 클래스.
 * 새로운 테마를 만들 때는 BaseTheme을 상속받아 원하는 비주얼과 이펙트를 오버라이드합니다.
 */
export class BaseTheme {
  constructor(id, name, options = {}) {
    this.id = id;
    this.name = name;
    this.options = options;
  }

  /**
   * 테마의 배경을 렌더링합니다.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W - 캔버스 가로 너비
   * @param {number} H - 캔버스 세로 높이
   * @param {number} beatIntensity - 현재 박자 강도 (0.0 ~ 1.0)
   * @param {number} time - 경과 시간(초)
   */
  renderBackground(ctx, W, H, beatIntensity, time) {
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, W, H);
  }

  /**
   * 지오메트리 대쉬 스타일의 화면 펄스/블룸(빛 번짐) 오버레이를 렌더링합니다.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W
   * @param {number} H
   * @param {number} beatIntensity
   */
  renderBloom(ctx, W, H, beatIntensity) {
    if (beatIntensity <= 0.01) return;
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const alpha = Math.min(0.4, beatIntensity * 0.4);
    ctx.fillStyle = `rgba(255, 46, 154, ${alpha})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  /**
   * 기믹 장애물의 테마별 컬러와 발광 스타일을 반환합니다.
   * @param {string} type - laser, wave, shockwave, wall_crush, zone_blast 등
   * @param {string} band - low, mid, high
   */
  getObstacleStyle(type, band) {
    const colors = {
      low: { main: "#ff2a6d", glow: "rgba(255, 42, 109, 0.8)", blur: 24 },
      mid: { main: "#05d9e8", glow: "rgba(5, 217, 232, 0.8)", blur: 18 },
      high: { main: "#ffe600", glow: "rgba(255, 230, 0, 0.8)", blur: 14 },
    };
    return colors[band] || colors.mid;
  }
}
