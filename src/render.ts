/**
 * Pseudo-3D renderer — OutRun-style projected road with Mario Kart-style
 * split screen. Pure drawing: reads sim state, never mutates it.
 *
 * Layouts: 1 player fullscreen, 2 players top/bottom halves,
 * 3 players quadrants + standings panel, 4 players quadrants.
 */

import {
  type CarState,
  type Pickup,
  type TrafficCar,
  CAR_W,
  MAX_SPEED,
  NITRO_COOLDOWN_MS,
  PERFECT_RPM,
} from "./physics";
import {
  type Track,
  ENDLESS_CHECKPOINT_EVERY,
  ROAD_HALF_W,
  SEG_LEN,
  elevAt,
} from "./track";

export type Phase = "lobby" | "countdown" | "racing" | "finished";

export interface RenderPlayer {
  car: CarState;
  /** Pane index — also the identity bit used by pickup collection. */
  index: number;
  name: string;
  color: string;
  /** Current standing, 1-based. */
  place: number;
  finished: boolean;
  ghost: boolean;
  /** Engine rpm 0..1 of the current gear band (Grand Prix). */
  rpm: number;
  busted: boolean;
  /** Meters of buffer before the cop, or null off chase circuits. */
  copGap: number | null;
}

export interface RenderState {
  track: Track;
  traffic: TrafficCar[];
  pickups: Pickup[];
  players: RenderPlayer[];
  phase: Phase;
  mode: "cruise" | "gp";
  now: number;
  /** Camera distance for the attract-mode camera when no players are in. */
  demoD: number;
  /** Endless Rush clock, when that circuit is live. */
  endless: { leftS: number; flashUntil: number; bonusS: number } | null;
}

interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Row {
  /** Screen y of this segment boundary. */
  y: number;
  /** Screen x of the road center. */
  cx: number;
  /** Half road width in px. */
  halfW: number;
  /** Distance ahead of the camera, meters. */
  dz: number;
  /** World distance of this boundary. */
  d: number;
  /** Accumulated road-center lateral offset, meters. */
  offset: number;
}

const DRAW_SEGMENTS = 78; // ~390m draw distance
const CAM_BEHIND = 13; // camera meters behind the car
const CAM_HEIGHT = 3.4;
const CURVE_SCALE = 0.055; // road bend accumulation, meters/segment²
const NEAR_PLANE = 0.2;

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.resize = this.resize.bind(this);
    addEventListener("resize", this.resize);
    this.resize();
  }

  destroy(): void {
    removeEventListener("resize", this.resize);
  }

  private resize(): void {
    this.cssW = innerWidth;
    this.cssH = innerHeight;
    this.canvas.width = Math.floor(innerWidth * devicePixelRatio);
    this.canvas.height = Math.floor(innerHeight * devicePixelRatio);
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  draw(state: RenderState): void {
    const { ctx } = this;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    const racers = state.players;
    const panes = this.layout(Math.max(1, racers.length));

    if (racers.length === 0) {
      this.drawViewport(panes[0], null, { d: state.demoD, x: 0 }, state);
    } else {
      racers.forEach((p, i) => {
        this.drawViewport(panes[i], p, { d: p.car.d - CAM_BEHIND, x: p.car.x * 0.85 }, state);
      });
      if (racers.length === 3) this.drawStandingsPanel(panes[3], state);
    }

    this.drawPaneBorders(panes);
    if (state.phase === "racing" || state.phase === "finished" || state.phase === "countdown") {
      if (state.endless) this.drawEndlessClock(state);
      else this.drawProgressStrip(state);
    }
  }

  private layout(count: number): Viewport[] {
    const { cssW: w, cssH: h } = this;
    if (count <= 1) return [{ x: 0, y: 0, w, h }];
    if (count === 2) {
      return [
        { x: 0, y: 0, w, h: h / 2 },
        { x: 0, y: h / 2, w, h: h / 2 },
      ];
    }
    return [
      { x: 0, y: 0, w: w / 2, h: h / 2 },
      { x: w / 2, y: 0, w: w / 2, h: h / 2 },
      { x: 0, y: h / 2, w: w / 2, h: h / 2 },
      { x: w / 2, y: h / 2, w: w / 2, h: h / 2 },
    ];
  }

  /* ---------------------------------------------------------------- */
  /* One viewport                                                      */
  /* ---------------------------------------------------------------- */

  private drawViewport(
    vp: Viewport,
    owner: RenderPlayer | null,
    cam: { d: number; x: number },
    state: RenderState,
  ): void {
    const { ctx } = this;
    const { track, now } = state;
    const palette = track.circuit.palette;

    ctx.save();
    ctx.beginPath();
    ctx.rect(vp.x, vp.y, vp.w, vp.h);
    ctx.clip();

    // Wide panes (2-player split) get a wider frustum so the road fills them.
    const focal = Math.max(vp.h * 1.5, vp.w * 0.55);
    const horizonY = vp.y + vp.h * 0.42;
    const camY = elevAt(track, cam.d) + CAM_HEIGHT;

    // Sky
    const sky = ctx.createLinearGradient(0, vp.y, 0, horizonY + vp.h * 0.1);
    sky.addColorStop(0, palette.top);
    sky.addColorStop(0.62, palette.mid);
    sky.addColorStop(0.9, palette.low);
    sky.addColorStop(1, palette.horizon);
    ctx.fillStyle = sky;
    ctx.fillRect(vp.x, vp.y, vp.w, vp.h);

    // Project segment boundaries.
    const baseSeg = Math.floor(cam.d / SEG_LEN);
    const basePercent = (cam.d - baseSeg * SEG_LEN) / SEG_LEN;
    const rows: (Row | null)[] = [];
    let offset = 0;
    let delta = -this.segCurve(track, baseSeg) * CURVE_SCALE * basePercent;

    for (let n = 0; n <= DRAW_SEGMENTS; n++) {
      const segIdx = baseSeg + n;
      const d = segIdx * SEG_LEN;
      const dz = d - cam.d;
      if (dz < NEAR_PLANE) {
        rows.push(null);
      } else {
        const scale = focal / dz;
        rows.push({
          y: horizonY + (camY - this.segElev(track, segIdx)) * scale,
          cx: vp.x + vp.w / 2 + (offset - cam.x) * scale,
          halfW: ROAD_HALF_W * scale,
          dz,
          d,
          offset,
        });
      }
      delta += this.segCurve(track, segIdx) * CURVE_SCALE;
      offset += delta;
    }

    // Bucket sprites (traffic, pickups, other players) by segment for painter order.
    const buckets = new Map<number, Array<() => void>>();
    const addSprite = (d: number, fn: () => void) => {
      const n = Math.floor(d / SEG_LEN) - baseSeg;
      if (n < 0 || n > DRAW_SEGMENTS) return;
      let list = buckets.get(n);
      if (!list) buckets.set(n, (list = []));
      list.push(fn);
    };

    for (const t of state.traffic) {
      addSprite(t.d, () => this.drawWorldCar(vp, cam, rows, focal, horizonY, camY, state, t.d, t.x, t.width, t.truck ? 0.95 : 0.62, t.color, { blinkDir: t.blinkDir, blinkOn: t.blinkUntil > now || t.targetX !== t.x, now }));
    }
    if (owner) {
      const bit = 1 << owner.index;
      for (const p of state.pickups) {
        if (p.takenBy & bit) continue;
        addSprite(p.d, () => this.drawPickup(vp, cam, rows, focal, horizonY, camY, state, p));
      }
    }
    for (const p of state.players) {
      if (p === owner) continue;
      addSprite(p.car.d, () =>
        this.drawWorldCar(vp, cam, rows, focal, horizonY, camY, state, p.car.d, p.car.x, CAR_W, 0.62, p.color, {
          label: p.name,
          nitro: now < p.car.nitroUntil,
          ghost: p.ghost,
          now,
        }),
      );
    }

    // Road, far → near. Sprites paint right after their own ground slice and
    // before nearer slices, so crests occlude them naturally.
    for (let n = DRAW_SEGMENTS - 1; n >= 0; n--) {
      const sprites = buckets.get(n + 1);
      if (sprites) for (const fn of sprites) fn();
      const near = rows[n];
      const far = rows[n + 1];
      if (near && far) this.drawRoadSlice(vp, near, far, baseSeg + n, n, state);
    }
    const nearSprites = buckets.get(0);
    if (nearSprites) for (const fn of nearSprites) fn();

    if (owner) {
      this.drawOwnCar(vp, owner, focal, horizonY, camY, state.track, now);
      if (owner.copGap !== null) this.drawCopPressure(vp, owner, now);
      this.drawPaneHud(vp, owner, state);
    }

    ctx.restore();
  }

  private segCurve(track: Track, i: number): number {
    return track.segments[Math.max(0, Math.min(track.segments.length - 1, i))].curve;
  }

  private segElev(track: Track, i: number): number {
    return track.segments[Math.max(0, Math.min(track.segments.length - 1, i))].elev;
  }

  private drawRoadSlice(
    vp: Viewport,
    near: Row,
    far: Row,
    segIdx: number,
    n: number,
    state: RenderState,
  ): void {
    const { ctx } = this;
    const { track } = state;
    const fogColor = track.circuit.palette.fog;
    const yTop = Math.min(far.y, near.y);
    const light = segIdx % 2 === 0;

    // Grass band across the pane.
    ctx.fillStyle = light ? "#0f1d13" : "#122417";
    ctx.fillRect(vp.x, yTop, vp.w, Math.max(0.5, near.y - yTop + 0.5));

    // Road body.
    ctx.fillStyle = light ? "#23262e" : "#26292f";
    this.trapezoid(near.cx, near.y, near.halfW, far.cx, far.y, far.halfW);

    // Rumble strips.
    ctx.fillStyle = light ? "#c94f4f" : "#e8eaf0";
    const rumbleN = near.halfW * 0.08;
    const rumbleF = far.halfW * 0.08;
    this.trapezoid(near.cx - near.halfW - rumbleN / 2, near.y, rumbleN / 2, far.cx - far.halfW - rumbleF / 2, far.y, rumbleF / 2);
    this.trapezoid(near.cx + near.halfW + rumbleN / 2, near.y, rumbleN / 2, far.cx + far.halfW + rumbleF / 2, far.y, rumbleF / 2);

    const segStart = segIdx * SEG_LEN;
    const isCheckpoint =
      track.circuit.special === "endless" &&
      segStart > 0 &&
      segStart < track.raceLength &&
      segStart % ENDLESS_CHECKPOINT_EVERY < SEG_LEN * 2;

    // Finish line: checkered band across two segments at the line.
    if (segStart >= track.raceLength - SEG_LEN && segStart < track.raceLength + SEG_LEN) {
      this.checkerSlice(near, far, "#f0f6fc", "#14161c");
    } else if (isCheckpoint) {
      this.checkerSlice(near, far, "#4dd0e1", "#0d3a44");
    } else if (light) {
      // Dashed lane guides at thirds — cosmetic; traffic ignores lanes.
      ctx.fillStyle = "rgba(255,255,255,0.42)";
      for (const frac of [-1 / 3, 1 / 3]) {
        const nx = near.cx + near.halfW * frac;
        const fx = far.cx + far.halfW * frac;
        this.trapezoid(nx, near.y, Math.max(1, near.halfW * 0.012), fx, far.y, Math.max(0.6, far.halfW * 0.012));
      }
    }

    // Fog toward the horizon.
    const fog = (n / DRAW_SEGMENTS) ** 2 * 0.72;
    if (fog > 0.02) {
      ctx.fillStyle = `rgba(${fogColor.r},${fogColor.g},${fogColor.b},${fog})`;
      ctx.fillRect(vp.x, yTop, vp.w, Math.max(0.5, near.y - yTop + 0.5));
    }
  }

  private trapezoid(nx: number, ny: number, nHalf: number, fx: number, fy: number, fHalf: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(nx - nHalf, ny);
    ctx.lineTo(nx + nHalf, ny);
    ctx.lineTo(fx + fHalf, fy);
    ctx.lineTo(fx - fHalf, fy);
    ctx.closePath();
    ctx.fill();
  }

  private checkerSlice(near: Row, far: Row, a: string, b: string): void {
    const { ctx } = this;
    const cells = 8;
    for (let c = 0; c < cells; c++) {
      const f0 = -1 + (2 * c) / cells;
      const f1 = -1 + (2 * (c + 1)) / cells;
      ctx.fillStyle = c % 2 === 0 ? a : b;
      ctx.beginPath();
      ctx.moveTo(near.cx + near.halfW * f0, near.y);
      ctx.lineTo(near.cx + near.halfW * f1, near.y);
      ctx.lineTo(far.cx + far.halfW * f1, far.y);
      ctx.lineTo(far.cx + far.halfW * f0, far.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Sprites                                                           */
  /* ---------------------------------------------------------------- */

  /** Project a world (d, x) onto this pane. Returns null when off-range. */
  private project(
    vp: Viewport,
    cam: { d: number; x: number },
    rows: (Row | null)[],
    focal: number,
    horizonY: number,
    camY: number,
    track: Track,
    d: number,
    x: number,
  ): { cx: number; baseY: number; scale: number } | null {
    const dz = d - cam.d;
    if (dz < NEAR_PLANE + 1 || dz > DRAW_SEGMENTS * SEG_LEN) return null;
    const n = Math.floor(d / SEG_LEN) - Math.floor(cam.d / SEG_LEN);
    const rowA = rows[Math.max(0, Math.min(rows.length - 1, n))];
    const rowB = rows[Math.max(0, Math.min(rows.length - 1, n + 1))];
    const roadOffset = rowA && rowB ? rowA.offset + (rowB.offset - rowA.offset) * ((d % SEG_LEN) / SEG_LEN) : rowA?.offset ?? rowB?.offset ?? 0;
    const scale = focal / dz;
    return {
      cx: vp.x + vp.w / 2 + (roadOffset + x - cam.x) * scale,
      baseY: horizonY + (camY - elevAt(track, d)) * scale,
      scale,
    };
  }

  /** Draw a car somewhere out on the track (traffic or another player). */
  private drawWorldCar(
    vp: Viewport,
    cam: { d: number; x: number },
    rows: (Row | null)[],
    focal: number,
    horizonY: number,
    camY: number,
    state: RenderState,
    d: number,
    x: number,
    widthM: number,
    aspect: number,
    color: string,
    opts: {
      label?: string;
      nitro?: boolean;
      ghost?: boolean;
      blinkDir?: -1 | 0 | 1;
      blinkOn?: boolean;
      now: number;
    },
  ): void {
    const pos = this.project(vp, cam, rows, focal, horizonY, camY, state.track, d, x);
    if (!pos) return;
    const w = widthM * pos.scale;
    if (w < 2) return;

    this.carSprite(pos.cx, pos.baseY, w, aspect, color, {
      alpha: opts.ghost ? 0.35 : 1,
      nitro: opts.nitro ?? false,
      blink: opts.blinkOn && opts.blinkDir ? (Math.floor(opts.now / 180) % 2 === 0 ? opts.blinkDir : 0) : 0,
    });

    if (opts.label && w > 16) {
      const { ctx } = this;
      ctx.globalAlpha = opts.ghost ? 0.5 : 0.92;
      ctx.font = `600 ${Math.max(11, Math.min(15, w * 0.16))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = "#fff";
      ctx.fillText(opts.label, pos.cx, pos.baseY - w * aspect - w * 0.34 - 4);
      ctx.globalAlpha = 1;
    }
  }

  /** Coins bob and glint; boost canisters pulse. Same procedural style as cars. */
  private drawPickup(
    vp: Viewport,
    cam: { d: number; x: number },
    rows: (Row | null)[],
    focal: number,
    horizonY: number,
    camY: number,
    state: RenderState,
    pickup: Pickup,
  ): void {
    const pos = this.project(vp, cam, rows, focal, horizonY, camY, state.track, pickup.d, pickup.x);
    if (!pos) return;
    const { ctx } = this;
    const size = 1.1 * pos.scale;
    if (size < 2.5) return;

    if (pickup.kind === "coin") {
      const bob = Math.sin(state.now / 260 + pickup.d * 0.7) * size * 0.14;
      const cy = pos.baseY - size * 0.75 + bob;
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.beginPath();
      ctx.ellipse(pos.cx, pos.baseY, size * 0.32, Math.max(1, size * 0.08), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffd042";
      ctx.beginPath();
      ctx.arc(pos.cx, cy, size * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#a3720a";
      ctx.lineWidth = Math.max(1, size * 0.09);
      ctx.beginPath();
      ctx.arc(pos.cx, cy, size * 0.26, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const pulse = 0.85 + Math.sin(state.now / 180) * 0.15;
      const w = size * 0.62;
      const h = size * 1.05;
      const cy = pos.baseY - h;
      ctx.globalAlpha = 0.35 * pulse;
      ctx.fillStyle = "#ffa657";
      ctx.beginPath();
      ctx.arc(pos.cx, cy + h * 0.5, size * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#ff7a1a";
      this.roundRect(pos.cx - w / 2, cy, w, h, w * 0.3);
      ctx.fill();
      ctx.fillStyle = "#ffd042";
      this.roundRect(pos.cx - w * 0.18, cy + h * 0.18, w * 0.36, h * 0.4, w * 0.12);
      ctx.fill();
    }
  }

  /** Rear-view car sprite. (cx, baseY) is the bottom-center on the road. */
  private carSprite(
    cx: number,
    baseY: number,
    w: number,
    aspect: number,
    color: string,
    fx: { alpha: number; nitro: boolean; blink: -1 | 0 | 1 },
  ): void {
    const { ctx } = this;
    const bodyH = w * aspect;
    const roofH = w * 0.26;

    ctx.globalAlpha = fx.alpha * 0.35;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(cx, baseY, w * 0.56, Math.max(1.5, w * 0.09), 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = fx.alpha;
    if (fx.nitro) {
      ctx.fillStyle = "#ffa657";
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.2, baseY);
      ctx.lineTo(cx, baseY + w * 0.36 + Math.random() * w * 0.12);
      ctx.lineTo(cx + w * 0.2, baseY);
      ctx.fill();
    }

    // Body
    ctx.fillStyle = color;
    this.roundRect(cx - w / 2, baseY - bodyH, w, bodyH, w * 0.12);
    ctx.fill();
    // Roof
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    this.roundRect(cx - w * 0.36, baseY - bodyH - roofH, w * 0.72, roofH + w * 0.06, w * 0.08);
    ctx.fill();
    // Tail lights
    ctx.fillStyle = "#ff5a5f";
    ctx.fillRect(cx - w * 0.42, baseY - bodyH * 0.62, w * 0.16, Math.max(1.5, bodyH * 0.12));
    ctx.fillRect(cx + w * 0.26, baseY - bodyH * 0.62, w * 0.16, Math.max(1.5, bodyH * 0.12));
    // Blinker
    if (fx.blink !== 0) {
      ctx.fillStyle = "#ffd042";
      const bx = fx.blink < 0 ? cx - w * 0.5 : cx + w * 0.34;
      ctx.fillRect(bx, baseY - bodyH * 0.4, w * 0.16, Math.max(2, bodyH * 0.16));
    }
    ctx.globalAlpha = 1;
  }

  private drawOwnCar(
    vp: Viewport,
    owner: RenderPlayer,
    focal: number,
    horizonY: number,
    camY: number,
    track: Track,
    now: number,
  ): void {
    const { ctx } = this;
    const car = owner.car;
    const w = CAR_W * (focal / CAM_BEHIND);
    const cx = vp.x + vp.w / 2 + car.x * 0.15 * (focal / CAM_BEHIND);
    const baseY = horizonY + (camY - elevAt(track, car.d)) * (focal / CAM_BEHIND);
    const flashing = now < car.invincibleUntil && Math.floor(now / 100) % 2 === 0;
    const bounce = Math.sin(now / 60) * Math.min(2, (car.speed / MAX_SPEED) * 2.2);

    ctx.save();
    ctx.translate(cx, baseY + bounce);
    ctx.rotate(car.steer * 0.055);
    this.carSprite(0, 0, w, 0.6, owner.color, {
      alpha: owner.ghost ? 0.35 : flashing ? 0.45 : 1,
      nitro: now < car.nitroUntil,
      blink: 0,
    });
    ctx.restore();
  }

  /** Red/blue urgency the closer the cop gets; the bar is the whole "cop". */
  private drawCopPressure(vp: Viewport, owner: RenderPlayer, now: number): void {
    const { ctx } = this;
    const gap = owner.copGap!;
    const danger = Math.max(0, Math.min(1, 1 - gap / 45)); // 0 safe → 1 busted

    if (danger > 0.15 && !owner.finished) {
      // Strobing edge vignette.
      const phase = Math.floor(now / 220) % 2 === 0;
      const strength = 0.12 + danger * 0.3;
      const glow = ctx.createLinearGradient(0, vp.y, 0, vp.y + vp.h);
      const color = phase ? `rgba(255,60,70,${strength})` : `rgba(70,110,255,${strength})`;
      glow.addColorStop(0, color);
      glow.addColorStop(0.35, "rgba(0,0,0,0)");
      glow.addColorStop(0.65, "rgba(0,0,0,0)");
      glow.addColorStop(1, color);
      ctx.fillStyle = glow;
      ctx.fillRect(vp.x, vp.y, vp.w, vp.h);
    }

    // Gap bar bottom-center.
    const w = Math.min(180, vp.w * 0.3);
    const x = vp.x + (vp.w - w) / 2;
    const y = vp.y + vp.h - 22;
    ctx.fillStyle = "rgba(10,12,16,0.72)";
    this.roundRect(x - 8, y - 16, w + 16, 30, 8);
    ctx.fill();
    ctx.font = "800 10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = Math.floor(now / 220) % 2 === 0 ? "#ff5a5f" : "#7aa2ff";
    ctx.fillText("POLICE", x, y - 5);
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    this.roundRect(x, y, w, 7, 3.5);
    ctx.fill();
    ctx.fillStyle = danger > 0.6 ? "#ff5a5f" : danger > 0.3 ? "#ffd042" : "#7ee787";
    this.roundRect(x, y, w * Math.max(0.02, Math.min(1, gap / 90)), 7, 3.5);
    ctx.fill();

    if (owner.busted) {
      ctx.textAlign = "center";
      ctx.font = "800 34px system-ui, sans-serif";
      ctx.fillStyle = Math.floor(now / 220) % 2 === 0 ? "#ff5a5f" : "#7aa2ff";
      ctx.fillText("BUSTED", vp.x + vp.w / 2, vp.y + vp.h * 0.3);
    }
  }

  /* ---------------------------------------------------------------- */
  /* HUD                                                               */
  /* ---------------------------------------------------------------- */

  private drawPaneHud(vp: Viewport, owner: RenderPlayer, state: RenderState): void {
    const { ctx } = this;
    const pad = 12;

    // Name + position
    ctx.textAlign = "left";
    ctx.font = "800 20px system-ui, sans-serif";
    ctx.fillStyle = owner.color;
    const ord = ordinal(owner.place);
    ctx.fillText(ord, vp.x + pad, vp.y + pad + 18);
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(owner.ghost ? `${owner.name} — reconnecting…` : owner.name, vp.x + pad + ctx.measureText(ord).width + 34, vp.y + pad + 16);

    // Speed
    ctx.textAlign = "right";
    ctx.font = "700 16px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillText(`${Math.round(owner.car.speed * 3.6)} km/h`, vp.x + vp.w - pad, vp.y + vp.h - pad);

    // Coins
    if (owner.car.coins > 0) {
      const cy = vp.y + vp.h - pad - 24;
      ctx.fillStyle = "#ffd042";
      ctx.beginPath();
      ctx.arc(vp.x + vp.w - pad - 38, cy - 4, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "700 14px system-ui, sans-serif";
      ctx.fillText(`${owner.car.coins}`, vp.x + vp.w - pad, cy);
    }

    if (owner.car.gearing) this.drawTach(vp, owner, state);
    else this.drawNitroBar(vp, owner, state);

    // Gap chips for players not visible from this pane.
    let topChip = 0;
    let bottomChip = 0;
    for (const p of state.players) {
      if (p === owner) continue;
      const delta = p.car.d - owner.car.d;
      if (delta > DRAW_SEGMENTS * SEG_LEN) {
        // + 38 keeps the chips clear of the global progress strip in top panes.
        this.gapChip(vp.x + vp.w / 2, vp.y + 38 + topChip * 24, `▲ ${p.name} +${Math.round(delta)}m`, p.color);
        topChip++;
      } else if (delta < -2) {
        this.gapChip(vp.x + vp.w / 2, vp.y + vp.h - 26 - bottomChip * 24, `▼ ${p.name} −${Math.round(-delta)}m`, p.color);
        bottomChip++;
      }
    }

    if (owner.finished && !owner.busted) {
      ctx.textAlign = "center";
      ctx.font = "800 34px system-ui, sans-serif";
      ctx.fillStyle = owner.color;
      ctx.fillText(state.endless ? "TIME UP" : `FINISHED ${ord}`, vp.x + vp.w / 2, vp.y + vp.h * 0.3);
    }
  }

  private drawNitroBar(vp: Viewport, owner: RenderPlayer, state: RenderState): void {
    const { ctx } = this;
    const pad = 12;
    const nw = Math.min(140, vp.w * 0.2);
    const nx = vp.x + pad;
    const ny = vp.y + vp.h - pad - 8;
    const ready = state.now >= owner.car.nitroReadyAt;
    const frac = ready ? 1 : Math.max(0, Math.min(1, 1 - (owner.car.nitroReadyAt - state.now) / NITRO_COOLDOWN_MS));
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    this.roundRect(nx, ny, nw, 8, 4);
    ctx.fill();
    ctx.fillStyle = ready ? "#7ee787" : "#8b95a5";
    this.roundRect(nx, ny, nw * frac, 8, 4);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fillText(ready ? "NITRO READY — press A" : "NITRO", nx, ny - 5);
  }

  /** Grand Prix: rpm bar with the perfect-shift window marked + gear digit. */
  private drawTach(vp: Viewport, owner: RenderPlayer, state: RenderState): void {
    const { ctx } = this;
    const g = owner.car.gearing!;
    const pad = 12;
    const tw = Math.min(170, vp.w * 0.26);
    const tx = vp.x + pad + 34;
    const ty = vp.y + vp.h - pad - 12;
    const rpm = owner.rpm;

    // Gear digit
    ctx.textAlign = "left";
    ctx.font = "800 30px system-ui, sans-serif";
    ctx.fillStyle = state.now < g.perfectUntil ? "#7ee787" : "rgba(255,255,255,0.92)";
    ctx.fillText(`${g.gear}`, vp.x + pad, ty + 12);
    ctx.font = "600 9px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(g.auto ? "AUTO" : "GEAR", vp.x + pad, ty - 20);

    // rpm bar
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    this.roundRect(tx, ty, tw, 12, 5);
    ctx.fill();
    // Perfect window
    ctx.fillStyle = "rgba(126,231,135,0.28)";
    this.roundRect(tx + tw * PERFECT_RPM, ty, tw * (1 - PERFECT_RPM), 12, 5);
    ctx.fill();
    // Needle fill
    const hot = rpm >= PERFECT_RPM;
    ctx.fillStyle = rpm > 0.985 ? "#ff5a5f" : hot ? "#7ee787" : "#7aa2ff";
    this.roundRect(tx, ty, tw * rpm, 12, 5);
    ctx.fill();

    // Shift verdict flash
    const sinceShift = state.now - g.shiftedAt;
    if (g.lastShift && sinceShift < 900 && !g.auto) {
      const label =
        g.lastShift === "perfect" ? "PERFECT SHIFT!" :
        g.lastShift === "bog" ? "TOO EARLY" :
        g.lastShift === "overrev" ? "OVER-REV!" : null;
      if (label) {
        ctx.textAlign = "left";
        ctx.font = "800 13px system-ui, sans-serif";
        ctx.globalAlpha = Math.max(0, 1 - sinceShift / 900);
        ctx.fillStyle = g.lastShift === "perfect" ? "#7ee787" : "#ff5a5f";
        ctx.fillText(label, tx, ty - 6 - sinceShift * 0.012);
        ctx.globalAlpha = 1;
      }
    }
  }

  private gapChip(cx: number, y: number, text: string, color: string): void {
    const { ctx } = this;
    ctx.font = "700 12px system-ui, sans-serif";
    const w = ctx.measureText(text).width + 22;
    ctx.fillStyle = "rgba(10,12,16,0.72)";
    this.roundRect(cx - w / 2, y, w, 20, 10);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(text, cx, y + 14);
  }

  private drawStandingsPanel(vp: Viewport, state: RenderState): void {
    const { ctx } = this;
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(vp.x, vp.y, vp.w, vp.h);

    ctx.textAlign = "left";
    ctx.font = "800 16px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillText("STANDINGS", vp.x + 28, vp.y + 42);

    const sorted = [...state.players].sort((a, b) => a.place - b.place);
    sorted.forEach((p, i) => {
      const y = vp.y + 80 + i * 34;
      ctx.font = "700 15px system-ui, sans-serif";
      ctx.fillStyle = p.color;
      ctx.fillText(ordinal(p.place), vp.x + 28, y);
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.fillText(p.name, vp.x + 84, y);
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = "600 13px system-ui, sans-serif";
      const detail = p.busted
        ? "busted"
        : p.finished
          ? "finished"
          : state.endless
            ? `${Math.round(p.car.d)}m`
            : `${Math.max(0, Math.round(state.track.raceLength - p.car.d))}m to go`;
      ctx.fillText(detail, vp.x + vp.w - 28 - ctx.measureText(detail).width, y);
    });
  }

  private drawProgressStrip(state: RenderState): void {
    const { ctx, cssW } = this;
    const w = Math.min(cssW * 0.44, 620);
    const x = (cssW - w) / 2;
    const y = 10;

    ctx.fillStyle = "rgba(10,12,16,0.72)";
    this.roundRect(x - 10, y - 6, w + 20, 18, 9);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    this.roundRect(x, y, w, 5, 2.5);
    ctx.fill();
    // Finish flag tick
    ctx.fillStyle = "#f0f6fc";
    ctx.fillRect(x + w - 1, y - 4, 2, 13);

    for (const p of state.players) {
      const frac = Math.max(0, Math.min(1, p.car.d / state.track.raceLength));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x + w * frac, y + 2.5, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Endless Rush: the shared countdown clock owns the top of the screen. */
  private drawEndlessClock(state: RenderState): void {
    const { ctx, cssW } = this;
    const endless = state.endless!;
    const x = cssW / 2;
    const urgent = endless.leftS < 10;

    ctx.fillStyle = "rgba(10,12,16,0.78)";
    this.roundRect(x - 64, 6, 128, 34, 10);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.font = "800 22px system-ui, sans-serif";
    ctx.fillStyle = urgent && Math.floor(state.now / 300) % 2 === 0 ? "#ff5a5f" : "#f0f6fc";
    const s = Math.ceil(endless.leftS);
    ctx.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, x, 31);

    if (state.now < endless.flashUntil) {
      const alpha = Math.max(0, (endless.flashUntil - state.now) / 1400);
      ctx.globalAlpha = alpha;
      ctx.font = "800 18px system-ui, sans-serif";
      ctx.fillStyle = "#4dd0e1";
      ctx.fillText(`CHECKPOINT +${endless.bonusS}s`, x, 62);
      ctx.globalAlpha = 1;
    }
  }

  private drawPaneBorders(panes: Viewport[]): void {
    const { ctx } = this;
    if (panes.length <= 1) return;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3;
    for (const vp of panes) ctx.strokeRect(vp.x, vp.y, vp.w, vp.h);
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    // Degenerate sizes must never throw (a thrown frame kills the rAF loop).
    w = Math.max(0, w);
    h = Math.max(0, h);
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}

function ordinal(place: number): string {
  const suffix = place === 1 ? "st" : place === 2 ? "nd" : place === 3 ? "rd" : "th";
  return `${place}${suffix}`;
}
