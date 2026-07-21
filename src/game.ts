import type { TiltEvents, HostSession, Player } from "@opencontrol/sdk";

/**
 * Racing game engine — pure game logic + canvas rendering.
 * All networking lives in the OpenControl SDK.
 *
 * Top-down endless highway: tilt the phone to steer, GAS/BRAKE triggers,
 * A = nitro. Dodge traffic; the leaderboard tracks distance.
 */

// Virtual world, cover-scaled so the game always fills the window.
const W = 1600;
const H = 900;

const ROAD_W = 820;
const ROAD_X = (W - ROAD_W) / 2;
const LANES = 4;
const LANE_W = ROAD_W / LANES;

const CAR_W = 62;
const CAR_H = 104;
const MAX_SPEED_PX = 1500; // px/s at speed = 1
const NITRO_MULTIPLIER = 1.9;
const NITRO_DURATION_MS = 1500;
const NITRO_COOLDOWN_MS = 6000;

const COLORS = ["#7ee787", "#7aa2ff", "#ffd042", "#ff5a5f", "#c792ea", "#4dd0e1", "#ffa657", "#f0f6fc"];

interface Car {
  player: Player<TiltEvents>;
  name: string;
  color: string;
  x: number;
  y: number;
  speed: number; // 0..1 throttle-integrated
  steer: number; // -1..1
  gas: number;
  brake: number;
  distance: number; // meters
  nitroUntil: number;
  nitroReadyAt: number;
  invincibleUntil: number;
  ghost: boolean;
}

interface Obstacle {
  x: number;
  y: number;
  color: string;
}

export interface LeaderboardRow {
  id: string;
  name: string;
  color: string;
  distance: number;
  ghost: boolean;
}

export interface RacingGameCallbacks {
  onPlayersChange: (count: number) => void;
  onLeaderboard: (rows: LeaderboardRow[]) => void;
}

export class RacingGame {
  private cars = new Map<string, Car>();
  private obstacles: Obstacle[] = [];
  private spawnGap = 400; // px of world scroll until next obstacle
  private laneOffset = 0; // scroll accumulator for lane dashes
  private rafId = 0;
  private last = 0;
  private hudTimer = 0;
  private readonly unsubscribes: (() => void)[] = [];
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly session: HostSession<TiltEvents>,
    private readonly callbacks: RacingGameCallbacks,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.resize = this.resize.bind(this);
    addEventListener("resize", this.resize);
    this.resize();

    this.unsubscribes.push(
      session.on("join", (player) => this.addCar(player)),
      session.on("leave", (player) => {
        this.cars.delete(player.id);
        callbacks.onPlayersChange(session.playerCount);
      }),
      session.on("disconnect", (player) => {
        const car = this.cars.get(player.id);
        if (car) car.ghost = true;
      }),
      session.on("reconnect", (player) => {
        const car = this.cars.get(player.id);
        if (car) car.ghost = false;
      }),
    );

    this.last = performance.now();
    this.rafId = requestAnimationFrame((now) => this.loop(now));
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    removeEventListener("resize", this.resize);
    for (const unsubscribe of this.unsubscribes) unsubscribe();
  }

  private resize(): void {
    this.canvas.width = Math.floor(innerWidth * devicePixelRatio);
    this.canvas.height = Math.floor(innerHeight * devicePixelRatio);
  }

  private addCar(player: Player<TiltEvents>): void {
    const lane = this.cars.size % LANES;
    const car: Car = {
      player,
      name: player.name,
      color: COLORS[player.index % COLORS.length],
      x: ROAD_X + LANE_W * (lane + 0.5) - CAR_W / 2,
      y: 660,
      speed: 0,
      steer: 0,
      gas: 0,
      brake: 0,
      distance: 0,
      nitroUntil: 0,
      nitroReadyAt: 0,
      invincibleUntil: 0,
      ghost: false,
    };
    this.cars.set(player.id, car);
    this.callbacks.onPlayersChange(this.session.playerCount);

    player.on("tilt", ({ value }) => {
      car.steer = value;
    });
    player.on("trigger", ({ side, value }) => {
      if (side === "right") car.gas = value;
      else car.brake = value;
    });
    player.on("buttonDown", ({ button }) => {
      if (button === "a") this.tryNitro(car);
    });
  }

  private tryNitro(car: Car): void {
    const now = performance.now();
    if (now < car.nitroReadyAt || car.ghost) return;
    car.nitroUntil = now + NITRO_DURATION_MS;
    car.nitroReadyAt = now + NITRO_COOLDOWN_MS;
    car.player.vibrate(80);
  }

  /* -------------------------------------------------------------- */
  /* Simulation                                                      */
  /* -------------------------------------------------------------- */

  private effectiveSpeedPx(car: Car, now: number): number {
    const nitro = now < car.nitroUntil ? NITRO_MULTIPLIER : 1;
    return car.speed * MAX_SPEED_PX * nitro;
  }

  private step(dt: number): void {
    const now = performance.now();

    // World scrolls at the leader's pace; everyone else drifts back on screen.
    let worldSpeed = 0;
    for (const car of this.cars.values()) {
      if (!car.ghost) worldSpeed = Math.max(worldSpeed, this.effectiveSpeedPx(car, now));
    }

    for (const car of this.cars.values()) {
      if (car.ghost) continue;

      const accel = car.gas * 0.9 - car.brake * 1.8 - 0.12; // drag
      car.speed = Math.min(1, Math.max(0, car.speed + accel * dt));

      const mySpeed = this.effectiveSpeedPx(car, now);
      car.distance += (mySpeed * dt) / 12;

      // Steering authority grows with speed (no curb-crawling donuts).
      car.x += car.steer * 640 * (0.35 + car.speed * 0.65) * dt;
      car.x = Math.max(ROAD_X + 6, Math.min(ROAD_X + ROAD_W - CAR_W - 6, car.x));

      // Slower than the world → slide down the screen.
      car.y += (worldSpeed - mySpeed) * 0.35 * dt;
      car.y = Math.max(180, Math.min(H - CAR_H - 30, car.y));

      // Collisions with traffic
      if (now > car.invincibleUntil) {
        for (const obstacle of this.obstacles) {
          if (
            car.x < obstacle.x + CAR_W &&
            car.x + CAR_W > obstacle.x &&
            car.y < obstacle.y + CAR_H &&
            car.y + CAR_H > obstacle.y
          ) {
            car.speed *= 0.25;
            car.nitroUntil = 0;
            car.invincibleUntil = now + 1500;
            car.player.vibrate(250); // host → controller feedback
            break;
          }
        }
      }
    }

    // Traffic
    this.laneOffset = (this.laneOffset + worldSpeed * dt) % 80;
    this.spawnGap -= worldSpeed * dt;
    if (this.spawnGap <= 0 && this.cars.size > 0) {
      const lane = Math.floor(Math.random() * LANES);
      this.obstacles.push({
        x: ROAD_X + LANE_W * (lane + 0.5) - CAR_W / 2,
        y: -CAR_H - 20,
        color: `hsl(${Math.floor(Math.random() * 360)}, 30%, 40%)`,
      });
      this.spawnGap = 260 + Math.random() * 420;
    }
    for (const obstacle of this.obstacles) obstacle.y += worldSpeed * dt * 0.55;
    this.obstacles = this.obstacles.filter((o) => o.y < H + 200);
  }

  /* -------------------------------------------------------------- */
  /* Rendering                                                       */
  /* -------------------------------------------------------------- */

  private draw(): void {
    const { ctx, canvas } = this;
    const scale = Math.max(canvas.width / W, canvas.height / H);
    const offsetX = (canvas.width - W * scale) / 2;
    const offsetY = (canvas.height - H * scale) / 2;
    const now = performance.now();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0d1a10";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);

    // Grass edges
    ctx.fillStyle = "#12241a";
    ctx.fillRect(-W, 0, W + ROAD_X, H);
    ctx.fillRect(ROAD_X + ROAD_W, 0, W, H);

    // Road
    ctx.fillStyle = "#1c1f26";
    ctx.fillRect(ROAD_X, 0, ROAD_W, H);
    ctx.fillStyle = "#f0f6fc";
    ctx.fillRect(ROAD_X, 0, 8, H);
    ctx.fillRect(ROAD_X + ROAD_W - 8, 0, 8, H);

    // Lane dashes (scroll with the world)
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    for (let lane = 1; lane < LANES; lane++) {
      const x = ROAD_X + LANE_W * lane - 3;
      for (let y = -80 + this.laneOffset; y < H; y += 80) {
        ctx.fillRect(x, y, 6, 42);
      }
    }

    // Traffic
    for (const obstacle of this.obstacles) {
      this.drawCarBody(obstacle.x, obstacle.y, obstacle.color, 1);
    }

    // Players
    ctx.textAlign = "center";
    for (const car of this.cars.values()) {
      const flashing = now < car.invincibleUntil && Math.floor(now / 100) % 2 === 0;
      const alpha = car.ghost ? 0.3 : flashing ? 0.45 : 1;

      // Nitro flame
      if (now < car.nitroUntil && !car.ghost) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#ffa657";
        ctx.beginPath();
        ctx.moveTo(car.x + CAR_W * 0.3, car.y + CAR_H);
        ctx.lineTo(car.x + CAR_W * 0.5, car.y + CAR_H + 34 + Math.random() * 14);
        ctx.lineTo(car.x + CAR_W * 0.7, car.y + CAR_H);
        ctx.fill();
      }

      this.drawCarBody(car.x, car.y, car.color, alpha);

      ctx.globalAlpha = 1;
      ctx.font = "600 16px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(car.ghost ? `${car.name} (reconnecting…)` : car.name, car.x + CAR_W / 2, car.y - 10);
    }
  }

  private drawCarBody(x: number, y: number, color: string, alpha: number): void {
    const { ctx } = this;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    this.roundRect(x, y, CAR_W, CAR_H, 14);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    this.roundRect(x + 8, y + 18, CAR_W - 16, 26, 6); // windshield
    ctx.fill();
    this.roundRect(x + 8, y + CAR_H - 34, CAR_W - 16, 20, 6); // rear window
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* -------------------------------------------------------------- */
  /* Main loop                                                       */
  /* -------------------------------------------------------------- */

  private loop(now: number): void {
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;
    this.step(dt);
    this.draw();

    this.hudTimer += dt;
    if (this.hudTimer > 0.3) {
      this.hudTimer = 0;
      const rows = [...this.cars.values()]
        .map((car) => ({
          id: car.player.id,
          name: car.name,
          color: car.color,
          distance: Math.floor(car.distance),
          ghost: car.ghost,
        }))
        .sort((a, b) => b.distance - a.distance);
      this.callbacks.onLeaderboard(rows);
    }

    this.rafId = requestAnimationFrame((next) => this.loop(next));
  }
}
