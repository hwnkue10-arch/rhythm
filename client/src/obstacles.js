/**
 * Just Shapes & Beats 스타일의 기믹 장애물 시스템.
 * 모든 장애물은 [경고(Telegraph) -> 비트 발동(Active) -> 소멸(Fade)]의 2단계 라이프사이클을 갖습니다.
 * - 경고 단계에서는 붉은색 점멸선/반투명 영역으로 피할 위치를 미리 알려줍니다 (피격 판정 없음).
 * - 음악의 비트 시점(local >= 0)에 눈부신 네온 발광과 함께 실제 피격 판정이 활성화됩니다.
 */

const PLAYER_RADIUS = 0.003; // JSAB-style extremely precise core hitbox

/**
 * 특정 이벤트가 현재 활성 판정 시간 내에 있는지 여부를 반환합니다.
 */
export function isEventCollidable(ev, local) {
  const activeDur = ev.activeDuration || 0.35;
  return local >= 0 && local < activeDur;
}

/**
 * 특정 이벤트가 현재 화면에 그려져야 하는지 여부.
 */
export function isEventVisible(ev, local) {
  if (ev.type === "orb_move" || ev.params?.noCollision) return false;
  const warnDur = ev.warnDuration || 0.85;
  const activeDur = ev.activeDuration || 0.35;
  return local >= -warnDur && local < activeDur + 0.2;
}

/**
 * 플레이어와 장애물 이벤트의 피격 충돌 검사
 * @param {{x: number, y: number}} player
 * @param {import("../../server/src/types").ObstacleEvent} ev
 * @param {number} local - (elapsed - ev.t)
 * @returns {boolean}
 */
export function checkCollision(player, ev, local, orbs) {
  if (ev.type === "orb_move" || ev.params?.noCollision) return false;
  if (!isEventCollidable(ev, local)) return false;

  const { type, params, activeDuration } = ev;
  const progress = local / (activeDuration || 0.35); // 0 -> 1

  if (type === "laser") {
    // BUILD 1 & BUILD 2: M-C 연결 회전 레이저 선분 피격 판정
    if (params.isMCLaser && orbs && orbs.left && orbs.right) {
      const aspect = 16 / 9;
      const mx = orbs.left.x;
      const my = orbs.left.y;
      const cx = orbs.right.x;
      const cy = orbs.right.y;
      const midX = (mx + cx) * 0.5;
      const midY = (my + cy) * 0.5;
      const halfW = ((params.width || 0.032) / 2) + PLAYER_RADIUS;

      // 0.04초 동안 양 오브젝트에서 중앙으로 뻗어나와 맞닿음
      const meetDur = 0.04;
      if (local < meetDur) {
        const p = Math.max(0, Math.min(1.0, local / meetDur));
        const p1X = mx + (midX - mx) * p;
        const p1Y = my + (midY - my) * p;
        const p2X = cx + (midX - cx) * p;
        const p2Y = cy + (midY - cy) * p;

        const distToSeg = (ax, ay, bx, by) => {
          const sdx = (bx - ax) * aspect;
          const sdy = by - ay;
          const slenSq = sdx * sdx + sdy * sdy;
          if (slenSq === 0) return Math.hypot((player.x - ax) * aspect, player.y - ay);
          let st = (((player.x - ax) * aspect) * sdx + (player.y - ay) * sdy) / slenSq;
          st = Math.max(0, Math.min(1, st));
          return Math.hypot((player.x - (ax + st * (bx - ax))) * aspect, player.y - (ay + st * (by - ay)));
        };

        return distToSeg(mx, my, p1X, p1Y) < halfW || distToSeg(cx, cy, p2X, p2Y) < halfW;
      }

      const dx = (cx - mx) * aspect;
      const dy = cy - my;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq === 0 ? 0 : (((player.x - mx) * aspect) * dx + (player.y - my) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const closeX = mx + (t * (cx - mx));
      const closeY = my + (t * (cy - my));
      const dist = Math.hypot((player.x - closeX) * aspect, player.y - closeY);
      return dist < halfW;
    }

    const halfW = (params.width || 0.028) / 2 + PLAYER_RADIUS;
    if (params.direction === "horizontal") {
      return Math.abs(player.y - params.y) < halfW;
    }
    if (params.direction === "vertical") {
      return Math.abs(player.x - params.x) < halfW;
    }
    // 각도 레이저
    const ang = params.angle || 0;
    const dist = Math.abs(Math.cos(ang) * (player.y - params.y) - Math.sin(ang) * (player.x - params.x));
    return dist < halfW;
  }

  if (type === "shockwave") {
    // 0에서 maxRadius로 뻗어나가는 링
    const maxR = params.radius || 0.6;
    const currentR = progress * maxR;
    const thickness = 0.035 + PLAYER_RADIUS;
    const dist = Math.hypot(player.x - params.x, player.y - params.y);
    return Math.abs(dist - currentR) < thickness;
  }

  if (type === "wall_crush") {
    const w = params.width || 0.35;
    const slamFrac = Math.sin(Math.min(Math.PI, progress * Math.PI));
    const curW = w * (0.8 + 0.2 * slamFrac);
    if (params.direction === "left") return player.x < curW;
    if (params.direction === "right") return player.x > 1 - curW;
    if (params.direction === "up") return player.y < curW;
    if (params.direction === "down") return player.y > 1 - curW;
    return false;
  }

  if (type === "wave") {
    const spd = (params.speed || 0.4) * local;
    const amp = params.amplitude || 0.08;
    const freq = params.frequency || 4;
    const thick = 0.03 + PLAYER_RADIUS;

    if (params.direction === "left" || params.direction === "right") {
      const baseX = params.direction === "right" ? spd : 1 - spd;
      const waveX = baseX + Math.sin(player.y * Math.PI * freq) * amp;
      return Math.abs(player.x - waveX) < thick;
    } else {
      const baseY = params.direction === "down" ? spd : 1 - spd;
      const waveY = baseY + Math.sin(player.x * Math.PI * freq) * amp;
      return Math.abs(player.y - waveY) < thick;
    }
  }

  if (type === "zone_blast") {
    const r = (params.radius || 0.16) + PLAYER_RADIUS;
    const dist = Math.hypot(player.x - params.x, player.y - params.y);
    return dist < r;
  }

  if (type === "straight") {
    const ang = params.angle || 0;
    const spd = (params.speed || 0.6) * local;
    const curX = params.x + Math.cos(ang) * spd;
    const curY = params.y + Math.sin(ang) * spd;
    const r = (params.width || 0.025) + PLAYER_RADIUS;
    return Math.hypot(player.x - curX, player.y - curY) < r;
  }

  if (type === "blaster") {
    // 콤팩트한 1발 레이저 총: 맵을 덮지 않고 조준선 후 탕!
    const ang = params.angle || 0;
    const spd = (params.speed || 0.95) * local;
    const curX = params.x + Math.cos(ang) * spd;
    const curY = params.y + Math.sin(ang) * spd;
    const r = (params.width || 0.018) + PLAYER_RADIUS;
    return Math.hypot(player.x - curX, player.y - curY) < r;
  }

  if (type === "gatling") {
    // 연속 박자 두두두 연발 (burstCount 개수만큼 순차 발사)
    const ang = params.angle || 0;
    const spd = params.speed || 0.68;
    const count = params.burstCount || 4;
    const interval = params.burstInterval || 0.12;
    const r = (params.width || 0.016) + PLAYER_RADIUS;

    for (let i = 0; i < count; i++) {
      const bLocal = local - i * interval;
      if (bLocal >= 0 && bLocal < 0.7) {
        const curX = params.x + Math.cos(ang) * spd * bLocal;
        const curY = params.y + Math.sin(ang) * spd * bLocal;
        if (Math.hypot(player.x - curX, player.y - curY) < r) {
          return true;
        }
      }
    }
    return false;
  }

  if (type === "sweep_laser") {
    // 코너에서 회전하는 레이저 빔 — 빔 위에 플레이어가 있으면 피격
    const startAng = params.sweepAngle ?? 0;
    const sweepSpd = params.sweepSpeed ?? Math.PI * 1.4;
    const beamLen = params.sweepLength ?? 0.6;
    const halfW = (params.width || 0.022) / 2 + PLAYER_RADIUS;

    const currentAng = startAng + sweepSpd * local;

    // 빔: (params.x, params.y) → 방향 currentAng으로 beamLen 길이
    // 플레이어와 반직선 사이의 수직 거리 계산
    const dx = player.x - params.x;
    const dy = player.y - params.y;
    const cosA = Math.cos(currentAng);
    const sinA = Math.sin(currentAng);

    // 빔 방향 투영: t >= 0이면 빔 방향 안에 있음
    const proj = dx * cosA + dy * sinA;
    if (proj < 0 || proj > beamLen) return false;

    // 수직 거리
    const perp = Math.abs(-dx * sinA + dy * cosA);
    return perp < halfW;
  }

  if (type === "melody_bolt") {
    const startX = params.startX ?? 0;
    const targetX = params.targetX ?? (startX === 0 ? 0.7 : 0.3);
    const y = params.y ?? 0.5;
    const curX = startX + (targetX - startX) * progress;
    const halfH = ((params.width || 0.055) / 2) + PLAYER_RADIUS;
    const halfW = 0.045 + PLAYER_RADIUS;
    return Math.abs(player.x - curX) < halfW && Math.abs(player.y - y) < halfH;
  }

  if (type === "trail_hazard") {
    const x1 = params.x1 ?? params.x;
    const y1 = params.y1 ?? params.y;
    const x2 = params.x2 ?? params.x;
    const y2 = params.y2 ?? params.y;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((player.x - x1) * dx + (player.y - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const closestX = x1 + t * dx;
    const closestY = y1 + t * dy;
    const dist = Math.hypot(player.x - closestX, player.y - closestY);
    const halfW = (params.width || 0.024) / 2 + PLAYER_RADIUS;
    return dist < halfW;
  }

  return false;
}

/**
 * 기믹 장애물 렌더링 (경고 및 발동 단계 분기)
 * @param {CanvasRenderingContext2D} ctx
 * @param {import("../../server/src/types").ObstacleEvent} ev
 * @param {number} local - (elapsed - ev.t)
 * @param {import("./themes/BaseTheme.js").BaseTheme} theme
 * @param {number} W - 캔버스 너비
 * @param {number} H - 캔버스 높이
 */
export function renderObstacle(ctx, ev, local, theme, W, H) {
  if (ev.params?.isMCLaser) return; // M-C 연결 레이저는 구체 렌더러(_drawGrooveOrbs)에서 일체형으로 렌더링
  const warnDur = ev.warnDuration || 0.85;
  const activeDur = ev.activeDuration || 0.35;
  if (local < -warnDur || local > activeDur + 0.2) return;

  const style = theme.getObstacleStyle(ev.type, ev.band);
  const isWarning = local < 0;
  const warnProgress = Math.max(0, Math.min(1, (local + warnDur) / warnDur)); // 0 -> 1
  const activeProgress = Math.max(0, Math.min(1, local / activeDur)); // 0 -> 1

  ctx.save();

  if (isWarning) {
    // 경고 단계: 비트 직전에 깜빡임이 점점 빨라짐
    const blinkFreq = 4 + warnProgress * 14;
    const blinkAlpha = 0.3 + 0.5 * Math.sin(local * blinkFreq);
    ctx.fillStyle = style.warn;
    ctx.strokeStyle = style.warnBorder;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = Math.max(0.15, blinkAlpha);

    renderWarningShape(ctx, ev, warnProgress, W, H);
  } else {
    // 발동 단계: 네온 발광과 코어 하이라이트
    const fade = 1 - Math.max(0, (local - activeDur) / 0.2);
    ctx.globalAlpha = Math.max(0, Math.min(1, fade));
    ctx.shadowColor = style.glow;
    ctx.shadowBlur = style.blur;
    ctx.fillStyle = style.active;
    ctx.strokeStyle = style.activeCore;

    renderActiveShape(ctx, ev, activeProgress, style, W, H);
  }

  ctx.restore();
}

/** 경고 영역 가이드라인 그리기 */
function renderWarningShape(ctx, ev, progress, W, H) {
  const { type, params } = ev;

  if (type === "laser") {
    const w = (params.width || 0.028) * progress; // 경고선이 중심으로 모여들거나 굵어짐
    if (params.direction === "horizontal") {
      ctx.fillRect(0, (params.y - w / 2) * H, W, w * H);
      ctx.strokeRect(0, (params.y - w / 2) * H, W, w * H);
    } else if (params.direction === "vertical") {
      ctx.fillRect((params.x - w / 2) * W, 0, w * W, H);
      ctx.strokeRect((params.x - w / 2) * W, 0, w * W, H);
    } else {
      const ang = params.angle || 0;
      ctx.save();
      ctx.translate(params.x * W, params.y * H);
      ctx.rotate(ang);
      ctx.fillRect(-W * 1.5, (-w / 2) * H, W * 3, w * H);
      ctx.strokeRect(-W * 1.5, (-w / 2) * H, W * 3, w * H);
      ctx.restore();
    }
  } else if (type === "shockwave") {
    // 그루브 페이즈 등 오브젝트(구체)에서 발사되는 충격파(params.side)는
    // 외부에서 원이 모여드는 예고 연출을 삭제하고 오브젝트 내부 충전 연출로 일원화
    if (params.side) return;

    // 중심으로 좁혀오는 예고 링 (단독 shockwave의 경우만)
    const maxR = params.radius || 0.6;
    const previewR = maxR * (1 - progress * 0.4);
    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, previewR * W, 0, Math.PI * 2);
    ctx.stroke();
    // 중심 펄스 점
    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, 8 * progress, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "wall_crush") {
    const w = (params.width || 0.35) * progress;
    if (params.direction === "left") ctx.fillRect(0, 0, w * W, H);
    if (params.direction === "right") ctx.fillRect((1 - w) * W, 0, w * W, H);
    if (params.direction === "up") ctx.fillRect(0, 0, W, w * H);
    if (params.direction === "down") ctx.fillRect(0, (1 - w) * H, W, w * H);
  } else if (type === "wave") {
    const thick = 0.03 * W;
    ctx.beginPath();
    if (params.direction === "left" || params.direction === "right") {
      const startX = params.direction === "right" ? 0 : W;
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, H);
    } else {
      const startY = params.direction === "down" ? 0 : H;
      ctx.moveTo(0, startY);
      ctx.lineTo(W, startY);
    }
    ctx.lineWidth = thick;
    ctx.stroke();
  } else if (type === "zone_blast") {
    const r = (params.radius || 0.16) * progress;
    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, r * W, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (type === "straight") {
    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, 12 * progress, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "blaster") {
    // 콤팩트 레이저 총 조준선: 얇은 점선 조준선과 발사점 점멸 링
    const ang = params.angle || 0;
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(params.x * W, params.y * H);
    ctx.lineTo((params.x + Math.cos(ang) * 1.5) * W, (params.y + Math.sin(ang) * 1.5) * H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, 8 * progress, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (type === "gatling") {
    // 연속 기관총 발사구 조준점
    const ang = params.angle || 0;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(params.x * W, params.y * H);
    ctx.lineTo((params.x + Math.cos(ang) * 0.15) * W, (params.y + Math.sin(ang) * 0.15) * H);
    ctx.stroke();
    ctx.restore();
  } else if (type === "sweep_laser") {
    // 회전 레이저 경고: 코너에서 빙글 도는 얇은 점선 예고선
    const startAng = params.sweepAngle ?? 0;
    const sweepSpd = params.sweepSpeed ?? Math.PI * 1.4;
    const beamLen = params.sweepLength ?? 0.6;
    // 경고 단계에서는 최종 위치를 부분적으로 미리 보여줌 (progress로 각도 예측)
    const previewAng = startAng + sweepSpd * progress * 0.3;
    const ex = (params.x + Math.cos(previewAng) * beamLen) * W;
    const ey = (params.y + Math.sin(previewAng) * beamLen) * H;

    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(params.x * W, params.y * H);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    // 코너 원점 점멸 링
    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, 10 * progress, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (type === "melody_bolt") {
    // 멜로디 가로 탄환: 시작점(0 or 1)부터 도착 지점(targetX)까지만 경고 인디케이터 표시
    const startX = (params.startX ?? 0) * W;
    const targetX = (params.targetX ?? (params.startX === 0 ? 0.7 : 0.3)) * W;
    const y = params.y * H;
    const w = (params.width || 0.055) * H;
    const minX = Math.min(startX, targetX);
    const maxX = Math.max(startX, targetX);

    ctx.save();

    // 1. 발사 경로 점선 가이드 (startX부터 targetX 구간까지만!)
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(targetX, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. 경고 빔 영역 (startX부터 targetX 범위만 채움)
    const warnThickness = w * (0.35 + 0.65 * progress);
    ctx.fillRect(minX, y - warnThickness / 2, maxX - minX, warnThickness);

    // 3. 목표 지점(도착점) 인디케이터 마커
    const markerR = (w * 0.45) * (0.85 + 0.25 * Math.sin(progress * Math.PI * 4));
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.arc(targetX, y, markerR, 0, Math.PI * 2);
    ctx.stroke();

    // 목표점 십자 크로스헤어
    ctx.beginPath();
    ctx.moveTo(targetX - markerR * 1.4, y);
    ctx.lineTo(targetX + markerR * 1.4, y);
    ctx.moveTo(targetX, y - markerR * 1.4);
    ctx.lineTo(targetX, y + markerR * 1.4);
    ctx.stroke();

    // 4. 발사 시작 지점 화살표
    const dir = targetX > startX ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(startX, y - w * 0.4);
    ctx.lineTo(startX + dir * 18 * progress, y);
    ctx.lineTo(startX, y + w * 0.4);
    ctx.fill();

    ctx.restore();
  } else if (type === "trail_hazard") {
    const x1 = (params.x1 ?? params.x) * W;
    const y1 = (params.y1 ?? params.y) * H;
    const x2 = (params.x2 ?? params.x) * W;
    const y2 = (params.y2 ?? params.y) * H;
    const isCyan = params.side === "right";
    const color = isCyan ? "rgba(77, 248, 255, 0.4)" : "rgba(255, 77, 166, 0.4)";
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }
}

/** 비트 발동 실제 장애물 렌더링 */
function renderActiveShape(ctx, ev, progress, style, W, H) {
  const { type, params } = ev;

  if (type === "laser") {
    const w = params.width || 0.028;
    if (params.direction === "horizontal") {
      ctx.fillRect(0, (params.y - w / 2) * H, W, w * H);
      // 코어 백색 라인
      ctx.fillStyle = style.activeCore;
      ctx.fillRect(0, (params.y - w * 0.18) * H, W, w * 0.36 * H);
    } else if (params.direction === "vertical") {
      ctx.fillRect((params.x - w / 2) * W, 0, w * W, H);
      ctx.fillStyle = style.activeCore;
      ctx.fillRect((params.x - w * 0.18) * W, 0, w * 0.36 * W, H);
    } else {
      const ang = params.angle || 0;
      ctx.save();
      ctx.translate(params.x * W, params.y * H);
      ctx.rotate(ang);
      ctx.fillRect(-W * 1.5, (-w / 2) * H, W * 3, w * H);
      ctx.fillStyle = style.activeCore;
      ctx.fillRect(-W * 1.5, -w * 0.18 * H, W * 3, w * 0.36 * H);
      ctx.restore();
    }
  } else if (type === "shockwave") {
    const maxR = params.radius || 0.6;
    const curR = progress * maxR * W;
    const thick = 14 * (1 - progress * 0.5);

    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, curR, 0, Math.PI * 2);
    ctx.lineWidth = thick;
    ctx.stroke();

    // 밝은 중심 링
    ctx.strokeStyle = style.activeCore;
    ctx.lineWidth = thick * 0.35;
    ctx.stroke();
  } else if (type === "wall_crush") {
    const w = params.width || 0.35;
    const slam = Math.sin(Math.min(Math.PI, progress * Math.PI));
    const curW = w * (0.85 + 0.15 * slam);

    if (params.direction === "left") {
      ctx.fillRect(0, 0, curW * W, H);
      ctx.fillStyle = style.activeCore;
      ctx.fillRect((curW - 0.02) * W, 0, 0.02 * W, H);
    } else if (params.direction === "right") {
      ctx.fillRect((1 - curW) * W, 0, curW * W, H);
      ctx.fillStyle = style.activeCore;
      ctx.fillRect((1 - curW) * W, 0, 0.02 * W, H);
    } else if (params.direction === "up") {
      ctx.fillRect(0, 0, W, curW * H);
      ctx.fillStyle = style.activeCore;
      ctx.fillRect(0, (curW - 0.02) * H, W, 0.02 * H);
    } else if (params.direction === "down") {
      ctx.fillRect(0, (1 - curW) * H, W, curW * H);
      ctx.fillStyle = style.activeCore;
      ctx.fillRect(0, (1 - curW) * H, W, 0.02 * H);
    }
  } else if (type === "wave") {
    const spd = (params.speed || 0.4) * (progress * (ev.activeDuration || 0.35));
    const amp = (params.amplitude || 0.08) * W;
    const freq = params.frequency || 4;
    const thick = 16;

    ctx.beginPath();
    ctx.lineWidth = thick;
    if (params.direction === "left" || params.direction === "right") {
      const baseX = (params.direction === "right" ? spd : 1 - spd) * W;
      for (let y = 0; y <= H; y += 10) {
        const x = baseX + Math.sin((y / H) * Math.PI * freq) * amp;
        if (y === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    } else {
      const baseY = (params.direction === "down" ? spd : 1 - spd) * H;
      for (let x = 0; x <= W; x += 10) {
        const y = baseY + Math.sin((x / W) * Math.PI * freq) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  } else if (type === "zone_blast") {
    const r = (params.radius || 0.16) * W;
    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = style.activeCore;
    ctx.beginPath();
    ctx.arc(params.x * W, params.y * H, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "straight") {
    const ang = params.angle || 0;
    const dist = (params.speed || 0.6) * (progress * (ev.activeDuration || 0.35));
    const curX = (params.x + Math.cos(ang) * dist) * W;
    const curY = (params.y + Math.sin(ang) * dist) * H;
    const r = (params.width || 0.025) * W;

    ctx.beginPath();
    ctx.arc(curX, curY, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = style.activeCore;
    ctx.beginPath();
    ctx.arc(curX, curY, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "blaster") {
    // 콤팩트 단발 레이저 볼트: 날렵하고 시원한 1발 발사
    const ang = params.angle || 0;
    const dist = (params.speed || 0.95) * (progress * (ev.activeDuration || 0.28));
    const curX = (params.x + Math.cos(ang) * dist) * W;
    const curY = (params.y + Math.sin(ang) * dist) * H;
    const len = 35;
    const r = 6;

    ctx.save();
    ctx.translate(curX, curY);
    ctx.rotate(ang);
    ctx.fillStyle = style.active;
    ctx.beginPath();
    ctx.moveTo(len / 2, 0);
    ctx.lineTo(-len / 2, -r);
    ctx.lineTo(-len / 2 + 8, 0);
    ctx.lineTo(-len / 2, r);
    ctx.closePath();
    ctx.fill();
    // 코어 흰색
    ctx.fillStyle = style.activeCore;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (type === "gatling") {
    // 연속 박자 두두두 연발 탄환 스트림
    const ang = params.angle || 0;
    const spd = params.speed || 0.68;
    const count = params.burstCount || 4;
    const interval = params.burstInterval || 0.12;
    const elapsedLocal = progress * (ev.activeDuration || 0.85);

    for (let i = 0; i < count; i++) {
      const bLocal = elapsedLocal - i * interval;
      if (bLocal >= 0 && bLocal < 0.7) {
        const curX = (params.x + Math.cos(ang) * spd * bLocal) * W;
        const curY = (params.y + Math.sin(ang) * spd * bLocal) * H;
        ctx.fillStyle = style.active;
        ctx.beginPath();
        ctx.arc(curX, curY, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = style.activeCore;
        ctx.beginPath();
        ctx.arc(curX, curY, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (type === "sweep_laser") {
    // 코너에서 회전하는 빛나는 레이저 빔
    const startAng = params.sweepAngle ?? 0;
    const sweepSpd = params.sweepSpeed ?? Math.PI * 1.4;
    const beamLen = params.sweepLength ?? 0.6;
    const beamW = (params.width || 0.022) * W;
    const activeDur = ev.activeDuration || 0.55;

    const currentAng = startAng + sweepSpd * (progress * activeDur);
    const ox = params.x * W;
    const oy = params.y * H;
    const ex = (params.x + Math.cos(currentAng) * beamLen) * W;
    const ey = (params.y + Math.sin(currentAng) * beamLen) * H;

    // 페이드 아웃 (끝부분에서 서서히 사라짐)
    const fade = 1 - Math.max(0, (progress - 0.75) / 0.25);

    ctx.save();
    ctx.globalAlpha *= Math.max(0, fade);

    // 외곽 글로우 빔 (두꺼운 반투명)
    ctx.strokeStyle = style.active;
    ctx.lineWidth = beamW * 1.8;
    ctx.lineCap = "round";
    ctx.globalAlpha *= 0.45;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // 메인 빔
    ctx.globalAlpha = fade * 0.95;
    ctx.strokeStyle = style.active;
    ctx.lineWidth = beamW;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // 코어 (흰색 얇은 빔)
    ctx.strokeStyle = style.activeCore;
    ctx.lineWidth = beamW * 0.28;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // 원점 코너 밝은 점
    ctx.fillStyle = style.activeCore;
    ctx.globalAlpha = fade;
    ctx.beginPath();
    ctx.arc(ox, oy, beamW * 0.7, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  } else if (type === "melody_bolt") {
    // 멜로디 굵은 가로 네온 탄환 (시작점에서 목표점까지 이동)
    const startX = (params.startX ?? 0) * W;
    const targetX = (params.targetX ?? (params.startX === 0 ? 0.7 : 0.3)) * W;
    const curX = startX + (targetX - startX) * progress;
    const y = params.y * H;
    const w = (params.width || 0.055) * H;
    const len = Math.max(50, W * 0.085);
    const dir = targetX > startX ? 1 : -1;

    ctx.save();
    ctx.translate(curX, y);

    // 1. 발광 트레일 (꼬리 잔상)
    const trailLen = len * 1.5;
    const trailGrad = ctx.createLinearGradient(-dir * trailLen, 0, 0, 0);
    trailGrad.addColorStop(0, "rgba(0, 0, 0, 0)");
    trailGrad.addColorStop(1, style.active);
    ctx.fillStyle = trailGrad;
    ctx.beginPath();
    ctx.fillRect(-dir * trailLen, -w * 0.35, trailLen, w * 0.7);

    // 2. 굵직한 탄환 본체 (글로우 외곽 캡슐)
    ctx.fillStyle = style.active;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(-len / 2, -w / 2, len, w, w / 2);
    } else {
      ctx.rect(-len / 2, -w / 2, len, w);
    }
    ctx.fill();

    // 3. 고에너지 코어 (백색 중심부)
    ctx.fillStyle = style.activeCore;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(-len * 0.38, -w * 0.22, len * 0.76, w * 0.44, w * 0.22);
    } else {
      ctx.rect(-len * 0.38, -w * 0.22, len * 0.76, w * 0.44);
    }
    ctx.fill();

    // 4. 탄환 앞머리 플라즈마 헤드
    ctx.beginPath();
    ctx.arc(dir * (len / 2 - 3), 0, w * 0.38, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  } else if (type === "trail_hazard") {
    // 이동 잔상/위험 영역: 이동 경로를 잇는 번개/네온 에너지 띠
    const x1 = (params.x1 ?? params.x) * W;
    const y1 = (params.y1 ?? params.y) * H;
    const x2 = (params.x2 ?? params.x) * W;
    const y2 = (params.y2 ?? params.y) * H;
    const isCyan = params.side === "right";
    const glowColor = isCyan ? "#4df8ff" : "#ff4da6";
    const fade = Math.max(0, 1 - progress);
    const trailW = Math.max(3, (params.width || 0.024) * W * (1 - progress * 0.35));

    ctx.save();
    ctx.globalAlpha *= fade;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 16 * fade;
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = trailW;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // 뜨거운 백색 코어 라인
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = trailW * 0.38;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // 양 끝 잔상 에너지 스파크
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x1, y1, trailW * 0.45, 0, Math.PI * 2);
    ctx.arc(x2, y2, trailW * 0.45, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}
