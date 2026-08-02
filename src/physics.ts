/**
 * Simulation — cars and traffic in track space.
 *
 * Everything here works in meters on the shared 1-D track from track.ts.
 * No rendering, no networking: race.ts owns the state and calls step()
 * every frame; render.ts draws whatever state is in here.
 *
 * Two drive models share the same car:
 *   - Cruise: the original arcade model — gas, brake, nitro on A.
 *   - Grand Prix: a 4-speed gearbox (`car.gearing` set). Each gear caps
 *     speed and pulls differently; shifting near the redline is rewarded,
 *     lugging a tall gear and money-shifting down are punished.
 */

import {
  type PickupSpawn,
  type Track,
  type TrafficSpawn,
  curveAt,
  mulberry32,
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

/* ------------------------------------------------------------------ */
/* Gearbox                                                             */
/* ------------------------------------------------------------------ */

export const GEAR_COUNT = 4;
/** Top speed of each gear as a fraction of the car's effective top speed. */
export const GEAR_TOP = [0.3, 0.52, 0.75, 1.0];
/** Acceleration authority per gear — low gears pull much harder. */
const GEAR_PULL = [2.0, 1.5, 1.15, 0.85];
/** rpm at which an upshift counts as perfect (up to the limiter). */
export const PERFECT_RPM = 0.82;
/** rpm below which an upshift bogs the engine. */
const BOG_RPM = 0.55;
const PERFECT_BOOST_MS = 1000;
const PERFECT_IMPULSE = 2.0; // m/s, instant
/** Lugging a tall gear at low rpm barely pulls. */
const LUG_RPM = 0.3;
const LUG_FACTOR = 0.35;
/** Money shift: braking force applied while over the new gear's cap. */
const OVERREV_DECEL = 30;

export interface Gearing {
  gear: number; // 1-based
  auto: boolean;
  /** Perfect-shift boost active until this timestamp. */
  perfectUntil: number;
  /** Timestamp of the last shift, for renderer flashes. */
  shiftedAt: number;
  /** Result of the last shift, for renderer/haptics. */
  lastShift: ShiftQuality | null;
}

export type ShiftQuality = "perfect" | "ok" | "bog" | "overrev";

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
  /** Set when the car crosses the finish line; inputs are ignored after. */
  finished: boolean;
  /** Steering input frozen while true (disconnected player). */
  ghost: boolean;
  /** Grand Prix gearbox; null = cruise drive model. */
  gearing: Gearing | null;
  coins: number;
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

export interface Pickup {
  d: number;
  x: number;
  kind: "boost" | "coin";
  /** Bitmask of pane indices that already collected this pickup. */
  takenBy: number;
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
    gearing: null,
    coins: 0,
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

export function spawnPickups(spawns: PickupSpawn[]): Pickup[] {
  return spawns.map((s) => ({ d: s.d, x: s.x, kind: s.kind, takenBy: 0 }));
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

/** Engine rpm as 0..1 of the current gear's band. */
export function rpmFor(car: CarState, now: number, leaderD: number): number {
  if (!car.gearing) return car.speed / maxSpeedFor(car, now, leaderD);
  const cap = GEAR_TOP[car.gearing.gear - 1] * maxSpeedFor(car, now, leaderD);
  return Math.max(0, Math.min(1, car.speed / cap));
}

/**
 * Manual gear select (also used by the auto-shifter). Grades the shift:
 * upshifting from the redline is perfect and briefly boosts; upshifting
 * from low revs bogs; downshifting far over the new cap is a money shift
 * (the over-rev decel in stepCars does the punishing).
 */
export function shiftGear(car: CarState, gear: number, now: number, leaderD: number): ShiftQuality | null {
  const g = car.gearing;
  if (!g || car.finished || car.ghost) return null;
  gear = Math.max(1, Math.min(GEAR_COUNT, Math.round(gear)));
  if (gear === g.gear) return null;

  const rpm = rpmFor(car, now, leaderD);
  let quality: ShiftQuality;
  if (gear > g.gear) {
    quality = gear === g.gear + 1 && rpm >= PERFECT_RPM ? "perfect" : rpm < BOG_RPM ? "bog" : "ok";
  } else {
    const newCap = GEAR_TOP[gear - 1] * maxSpeedFor(car, now, leaderD);
    quality = car.speed > newCap * 1.15 ? "overrev" : "ok";
  }

  g.gear = gear;
  g.shiftedAt = now;
  g.lastShift = quality;
  if (quality === "perfect") {
    g.perfectUntil = now + PERFECT_BOOST_MS;
    car.speed += PERFECT_IMPULSE;
  }
  return quality;
}

/** Decent-but-never-perfect gearbox for AUTO players. */
function autoShift(car: CarState, now: number, leaderD: number): void {
  const g = car.gearing!;
  const rpm = rpmFor(car, now, leaderD);
  if (rpm > 0.9 && g.gear < GEAR_COUNT && car.gas > 0) {
    g.gear += 1;
    g.shiftedAt = now;
    g.lastShift = "ok";
  } else if (g.gear > 1) {
    const lowerCap = GEAR_TOP[g.gear - 2] * maxSpeedFor(car, now, leaderD);
    if (car.speed < lowerCap * 0.82) {
      g.gear -= 1;
      g.shiftedAt = now;
      g.lastShift = "ok";
    }
  }
}

/** Grab an instant boost from a canister (no cooldown involved). */
export function applyBoostPickup(car: CarState, now: number): void {
  car.nitroUntil = Math.max(car.nitroUntil, now + 1100);
}

/**
 * Collect pickups under `car` for the racer at pane `index`.
 * Returns what was collected this frame (boost already applied).
 */
export function collectPickups(
  car: CarState,
  index: number,
  pickups: Pickup[],
  now: number,
): { coins: number; boosts: number } {
  const bit = 1 << index;
  let coins = 0;
  let boosts = 0;
  for (const p of pickups) {
    if (p.takenBy & bit) continue;
    if (Math.abs(p.d - car.d) < 3.4 && Math.abs(p.x - car.x) < 1.7) {
      p.takenBy |= bit;
      if (p.kind === "coin") {
        coins += 1;
        car.coins += 1;
      } else {
        boosts += 1;
        applyBoostPickup(car, now);
      }
    }
  }
  return { coins, boosts };
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
    } else if (car.gearing) {
      stepGeared(car, top, dt, now, leaderD);
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

    if (!car.finished && car.d >= track.raceLength) {
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
          // A crash also drops the box down to where the speed now is.
          if (car.gearing) {
            car.gearing.gear = Math.max(1, car.gearing.gear - 2);
            car.gearing.perfectUntil = 0;
          }
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

/** One integration step of the Grand Prix drive model. */
function stepGeared(car: CarState, top: number, dt: number, now: number, leaderD: number): void {
  const g = car.gearing!;
  if (g.auto && !car.ghost) autoShift(car, now, leaderD);

  const cap = GEAR_TOP[g.gear - 1] * top;
  const rpm = Math.max(0, Math.min(1, car.speed / cap));
  const gas = car.ghost ? 0 : car.gas;
  const brake = car.ghost ? 0 : car.brake;

  let pull = GEAR_PULL[g.gear - 1];
  if (g.gear > 1 && rpm < LUG_RPM) pull *= LUG_FACTOR; // lugging a tall gear
  if (now < g.perfectUntil) pull *= 1.6; // perfect-shift surge

  let accel = gas * 26 * pull - brake * 48 - 4.5;
  if (car.speed > cap) {
    // Money shift / crash-dropped gear: engine braking hauls you to the cap.
    accel = Math.min(accel, -OVERREV_DECEL);
    car.speed = Math.max(cap, car.speed + accel * dt);
    return;
  }
  car.speed = Math.max(0, Math.min(cap, car.speed + accel * dt));
}
