/**
 * Simulation — cars and traffic in track space.
 *
 * Everything here works in meters on the shared 1-D track from track.ts.
 * No rendering, no networking: race.ts owns the state and calls step()
 * every frame; render.ts draws whatever state is in here.
 */

import {
  type Track,
  type TrafficSpawn,
  curveAt,
  mulberry32,
  RACE_LENGTH,
  ROAD_HALF_W,
} from "./track";

export const CAR_W = 1.9; // meters
export const CAR_L = 4.4;
export const MAX_SPEED = 58; // m/s (~209 km/h)
export const NITRO_MULTIPLIER = 1.32;
export const NITRO_DURATION_MS = 1600;
export const NITRO_COOLDOWN_MS = 6000;

/** How much faster a trailing car may go, at most (rubber-banding). */
const RUBBER_BAND_MAX = 0.09;
/** Centrifugal pull at full curve and full speed, m/s of lateral drift. */
const CENTRIFUGAL = 11;

export interface CarState {
  /** Track position, meters. */
  d: number;
  /** Lateral offset from road center, meters. Negative = left. */
  x: number;
  /** Forward speed, m/s. */
  speed: number;
  steer: number; // -1..1 input
  gas: number; // 0..1 input
  brake: number; // 0..1 input
  nitroUntil: number;
  nitroReadyAt: number;
  invincibleUntil: number;
  /** Set when the car crosses RACE_LENGTH; inputs are ignored after. */
  finished: boolean;
  /** Steering input frozen while true (disconnected player). */
  ghost: boolean;
}

export interface TrafficCar {
  d: number;
  x: number;
  speed: number;
  width: number;
  length: number;
  color: string;
  truck: boolean;
  /** Lateral position this car is drifting toward. */
  targetX: number;
  /** While in the future, the blinker flashes and the car has not moved yet. */
  blinkUntil: number;
  /** Direction of the announced lane change, for rendering the blinker. */
  blinkDir: -1 | 0 | 1;
  nextThinkAt: number;
  rng: () => number;
}

export interface StepCallbacks {
  /** A player car hit traffic (or was rammed hard). */
  onCrash: (car: CarState) => void;
  /** Two player cars traded paint. */
  onBump: (a: CarState, b: CarState) => void;
}

export function createCar(startX: number): CarState {
  return {
    d: 0,
    x: startX,
    speed: 0,
    steer: 0,
    gas: 0,
    brake: 0,
    nitroUntil: 0,
    nitroReadyAt: 0,
    invincibleUntil: 0,
    finished: false,
    ghost: false,
  };
}

export function spawnTraffic(spawns: TrafficSpawn[]): TrafficCar[] {
  return spawns.map((s) => ({
    d: s.d,
    x: s.x,
    speed: s.speed,
    width: s.width,
    length: s.length,
    color: s.color,
    truck: s.truck,
    targetX: s.x,
    blinkUntil: 0,
    blinkDir: 0,
    nextThinkAt: 0,
    rng: mulberry32(s.seed),
  }));
}

export function tryNitro(car: CarState, now: number): boolean {
  if (now < car.nitroReadyAt || car.ghost || car.finished) return false;
  car.nitroUntil = now + NITRO_DURATION_MS;
  car.nitroReadyAt = now + NITRO_COOLDOWN_MS;
  return true;
}

export function maxSpeedFor(car: CarState, now: number, leaderD: number): number {
  const nitro = now < car.nitroUntil ? NITRO_MULTIPLIER : 1;
  // Rubber band: up to +9% top speed when far behind the leader.
  const behind = Math.max(0, leaderD - car.d);
  const band = 1 + Math.min(RUBBER_BAND_MAX, (behind / 1200) * RUBBER_BAND_MAX * 4);
  return MAX_SPEED * nitro * band;
}

/* ------------------------------------------------------------------ */
/* Traffic                                                             */
/* ------------------------------------------------------------------ */

export function stepTraffic(traffic: TrafficCar[], dt: number, now: number): void {
  for (const t of traffic) {
    t.d += t.speed * dt;

    // Think: occasionally pick a new lateral position, blinker first.
    if (now >= t.nextThinkAt) {
      t.nextThinkAt = now + 3500 + t.rng() * 5500;
      if (!t.truck || t.rng() < 0.4) {
        const limit = ROAD_HALF_W - t.width / 2 - 0.4;
        const target = -limit + t.rng() * limit * 2;
        // Only commit if the destination corridor is clear of other traffic.
        const blocked = traffic.some(
          (o) =>
            o !== t &&
            Math.abs(o.d - t.d) < 20 &&
            Math.abs(o.x - target) < (o.width + t.width) / 2 + 0.8,
        );
        if (!blocked && Math.abs(target - t.x) > 0.8) {
          t.targetX = target;
          t.blinkDir = target > t.x ? 1 : -1;
          t.blinkUntil = now + 800; // announce before moving — dodges stay readable
        }
      }
    }

    // Drift toward target after the blinker phase.
    if (now >= t.blinkUntil && t.targetX !== t.x) {
      const dx = t.targetX - t.x;
      const step = Math.sign(dx) * Math.min(Math.abs(dx), 1.6 * dt);
      t.x += step;
      if (Math.abs(t.targetX - t.x) < 0.05) {
        t.x = t.targetX;
        t.blinkDir = 0;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Player cars                                                         */
/* ------------------------------------------------------------------ */

export function stepCars(
  cars: CarState[],
  traffic: TrafficCar[],
  track: Track,
  dt: number,
  now: number,
  callbacks: StepCallbacks,
): void {
  let leaderD = 0;
  for (const car of cars) leaderD = Math.max(leaderD, car.d);

  for (const car of cars) {
    const top = maxSpeedFor(car, now, leaderD);

    if (car.finished) {
      // Coast out past the line.
      car.speed = Math.max(0, car.speed - 18 * dt);
    } else {
      const gas = car.ghost ? 0 : car.gas;
      const brake = car.ghost ? 0 : car.brake;
      const accel = gas * 26 - brake * 48 - 4.5; // 4.5 = drag/rolling resistance
      car.speed = Math.max(0, Math.min(top, car.speed + accel * dt));
    }

    car.d += car.speed * dt;

    const speedRatio = car.speed / MAX_SPEED;

    // Steering authority grows with speed; centrifugal pull fights you in curves.
    const steer = car.ghost || car.finished ? 0 : car.steer;
    car.x += steer * (3.5 + 11.5 * speedRatio) * dt;
    car.x -= curveAt(track, car.d) * speedRatio * speedRatio * CENTRIFUGAL * dt;

    // Road edges: scrubbing the edge line costs speed.
    const limit = ROAD_HALF_W - CAR_W / 2 - 0.15;
    if (car.x < -limit || car.x > limit) {
      car.x = Math.max(-limit, Math.min(limit, car.x));
      car.speed *= 1 - 0.9 * dt;
    }

    if (!car.finished && car.d >= RACE_LENGTH) {
      car.finished = true;
    }

    // Traffic collisions.
    if (now > car.invincibleUntil && !car.finished) {
      for (const t of traffic) {
        if (
          Math.abs(t.d - car.d) < (t.length + CAR_L) / 2 * 0.85 &&
          Math.abs(t.x - car.x) < (t.width + CAR_W) / 2 * 0.85
        ) {
          car.speed *= 0.3;
          car.nitroUntil = 0;
          car.invincibleUntil = now + 1400;
          callbacks.onCrash(car);
          break;
        }
      }
    }
  }

  // Player-vs-player bumping: push apart laterally, rear car loses a little.
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      if (a.ghost || b.ghost) continue;
      if (Math.abs(a.d - b.d) < CAR_L * 0.9 && Math.abs(a.x - b.x) < CAR_W * 1.05) {
        const push = (CAR_W * 1.05 - Math.abs(a.x - b.x)) / 2 + 0.05;
        const dir = a.x <= b.x ? -1 : 1;
        a.x += dir * push;
        b.x -= dir * push;
        const rear = a.d < b.d ? a : b;
        rear.speed *= 0.96;
        callbacks.onBump(a, b);
      }
    }
  }
}
