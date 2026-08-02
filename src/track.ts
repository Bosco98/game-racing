/**
 * Track generation — everything about the road lives here.
 *
 * The track is a 1-D world measured in meters, generated from a circuit
 * definition. Every circuit has a fixed seed, so a circuit is a *place*:
 * same curves, same hills, same traffic plan every time you race it —
 * that's what makes best times and medals mean something.
 *
 * Segments are SEG_LEN meters long and carry a `curve` value (how hard the
 * road bends at that point) and an `elev` value (road height, for hills).
 * The renderer accumulates curve to bend the projected road; the physics
 * uses it as centrifugal pull on the cars.
 *
 * Circuits escalate: the `ramp` parameter scales curve strength and traffic
 * density up along the road, so the last stretch of a circuit is always
 * meaner than the first.
 */

export const SEG_LEN = 5; // meters per segment
export const RUNOFF = 700; // road generated past the finish (coast-down + draw distance)
export const ROAD_HALF_W = 6; // meters from road center to the edge line

/* ------------------------------------------------------------------ */
/* Circuits                                                            */
/* ------------------------------------------------------------------ */

export type CircuitSpecial = "race" | "endless" | "chase";

export interface SkyPalette {
  top: string;
  mid: string;
  low: string;
  horizon: string;
  fog: { r: number; g: number; b: number };
}

export interface Circuit {
  id: string;
  name: string;
  tagline: string;
  seed: number;
  /** Meters from start to finish. For endless this is the (huge) road cap. */
  length: number;
  /** Curve peak multiplier; 1 = the classic road. */
  curvy: number;
  /** Elevation multiplier; 1 = the classic hills. */
  hills: number;
  /** Traffic density multiplier; 1 = the classic spacing, 2 = twice as dense. */
  traffic: number;
  /** How much harder curves/traffic get by the end of the road (0 = flat). */
  ramp: number;
  special: CircuitSpecial;
  palette: SkyPalette;
  /**
   * Medal thresholds. Races/chase: finish time in ms (under = earned).
   * Endless: distance in meters (over = earned).
   */
  medals: { gold: number; silver: number; bronze: number };
}

const DUSK: SkyPalette = {
  top: "#0b1022",
  mid: "#1b2a4a",
  low: "#45496f",
  horizon: "#b06a45",
  fog: { r: 27, g: 42, b: 74 },
};

/** Medal times from average-speed fractions of the 58 m/s top speed. */
function medalTimes(length: number, gold: number, silver: number, bronze: number) {
  const ms = (frac: number) => Math.round((length / (58 * frac)) * 1000);
  return { gold: ms(gold), silver: ms(silver), bronze: ms(bronze) };
}

export const CIRCUITS: Circuit[] = [
  {
    id: "coastal",
    name: "Coastal Sprint",
    tagline: "Fast, open and friendly — learn the road here",
    seed: 811_247,
    length: 1800,
    curvy: 0.75,
    hills: 0.8,
    traffic: 0.85,
    ramp: 0.25,
    special: "race",
    palette: {
      top: "#0c1a2e",
      mid: "#1d3a5f",
      low: "#4a6a8f",
      horizon: "#e8955f",
      fog: { r: 40, g: 62, b: 92 },
    },
    medals: medalTimes(1800, 0.58, 0.5, 0.42),
  },
  {
    id: "canyon",
    name: "Canyon Run",
    tagline: "Sweeping bends and long climbs",
    seed: 402_913,
    length: 2200,
    curvy: 1.1,
    hills: 1.5,
    traffic: 0.9,
    ramp: 0.35,
    special: "race",
    palette: {
      top: "#160f22",
      mid: "#3a2440",
      low: "#7a4550",
      horizon: "#d97a3d",
      fog: { r: 58, g: 40, b: 58 },
    },
    medals: medalTimes(2200, 0.56, 0.48, 0.4),
  },
  {
    id: "rushhour",
    name: "Rush Hour",
    tagline: "Wall-to-wall traffic — thread the needle",
    seed: 918_004,
    length: 2000,
    curvy: 0.85,
    hills: 0.7,
    traffic: 1.7,
    ramp: 0.45,
    special: "race",
    palette: DUSK,
    medals: medalTimes(2000, 0.52, 0.44, 0.37),
  },
  {
    id: "mountain",
    name: "Mountain Pass",
    tagline: "Hairpins, crests and no mercy",
    seed: 663_890,
    length: 2600,
    curvy: 1.45,
    hills: 2.1,
    traffic: 0.75,
    ramp: 0.4,
    special: "race",
    palette: {
      top: "#0a1420",
      mid: "#16324a",
      low: "#3d5a70",
      horizon: "#9fb4c4",
      fog: { r: 46, g: 66, b: 84 },
    },
    medals: medalTimes(2600, 0.54, 0.46, 0.38),
  },
  {
    id: "chase",
    name: "Midnight Chase",
    tagline: "Outrun the law — get caught and it's over",
    seed: 550_119,
    length: 2400,
    curvy: 1.0,
    hills: 1.0,
    traffic: 1.15,
    ramp: 0.35,
    special: "chase",
    palette: {
      top: "#05060e",
      mid: "#0d1226",
      low: "#1c2140",
      horizon: "#5a3d8f",
      fog: { r: 16, g: 18, b: 40 },
    },
    medals: medalTimes(2400, 0.55, 0.47, 0.39),
  },
  {
    id: "endless",
    name: "Endless Rush",
    tagline: "Checkpoints buy time — how far can you get?",
    seed: 137_766,
    length: 30_000,
    curvy: 0.9,
    hills: 1.0,
    traffic: 1.0,
    ramp: 1.6,
    special: "endless",
    palette: {
      top: "#101026",
      mid: "#2c1e4a",
      low: "#5f3a6a",
      horizon: "#e85f8f",
      fog: { r: 46, g: 30, b: 66 },
    },
    medals: { gold: 6000, silver: 4200, bronze: 2800 },
  },
];

/** Seconds on the clock at the start of an endless run / added per checkpoint. */
export const ENDLESS_START_S = 45;
export const ENDLESS_CHECKPOINT_S = 18;
export const ENDLESS_CHECKPOINT_EVERY = 750; // meters

/* ------------------------------------------------------------------ */
/* Track data                                                          */
/* ------------------------------------------------------------------ */

export interface TrackSegment {
  /** Signed bend strength, roughly -1..1. Positive bends right. */
  curve: number;
  /** Road elevation in meters at the segment start. */
  elev: number;
}

export interface TrafficSpawn {
  /** Track position the car starts at when the race begins. */
  d: number;
  /** Lateral offset from road center, meters. */
  x: number;
  /** Cruising speed, m/s. Always well below player top speed. */
  speed: number;
  width: number;
  length: number;
  color: string;
  truck: boolean;
  /** Per-car RNG seed for its lane-change behavior. */
  seed: number;
}

export interface PickupSpawn {
  d: number;
  x: number;
  kind: "boost" | "coin";
}

export interface Track {
  circuit: Circuit;
  segments: TrackSegment[];
  traffic: TrafficSpawn[];
  pickups: PickupSpawn[];
  /** Finish line, meters. */
  raceLength: number;
  /** Checkpoint positions (endless circuits only). */
  checkpoints: number[];
  /** Total generated road length in meters (race + runoff). */
  end: number;
}

/* ------------------------------------------------------------------ */
/* Seeded RNG (mulberry32) — deterministic per circuit                 */
/* ------------------------------------------------------------------ */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Road shape                                                          */
/* ------------------------------------------------------------------ */

export function generateTrack(circuit: Circuit): Track {
  const rng = mulberry32(circuit.seed);
  const raceLength = circuit.length;
  const segmentCount = Math.ceil((raceLength + RUNOFF) / SEG_LEN);
  const curves = new Float64Array(segmentCount);

  /** Difficulty multiplier at distance d: 1 at the start, 1+ramp at the finish. */
  const zone = (d: number) => 1 + circuit.ramp * Math.min(1, d / raceLength);

  // Lay out features: an opening straight, then alternating straights and
  // eased curves until we run out of road. Later zones bend harder and give
  // less breathing room between curves.
  let at = Math.floor(150 / SEG_LEN); // fair, straight start
  let lastDir = 0;
  while (at < segmentCount) {
    const z = zone(at * SEG_LEN);
    const straight = Math.floor(((60 + rng() * 140) / z) / SEG_LEN);
    at += Math.max(4, straight);
    if (at >= segmentCount) break;

    const lengthSegs = Math.floor((110 + rng() * 190) / SEG_LEN);
    // Avoid three same-direction curves in a row feeling like one long arc.
    let dir = rng() < 0.5 ? -1 : 1;
    if (dir === lastDir && rng() < 0.6) dir = -dir;
    lastDir = dir;
    const peak = (0.4 + rng() * 0.6) * dir * circuit.curvy * z;
    for (let i = 0; i < lengthSegs && at + i < segmentCount; i++) {
      const t = i / lengthSegs; // 0..1 across the curve, eased in and out
      curves[at + i] = peak * Math.sin(t * Math.PI) ** 2 * 2;
    }
    at += lengthSegs;
  }

  // Hills: two layered sine waves, flattened near the start line.
  const p1 = rng() * Math.PI * 2;
  const p2 = rng() * Math.PI * 2;
  const segments: TrackSegment[] = new Array(segmentCount);
  for (let i = 0; i < segmentCount; i++) {
    const d = i * SEG_LEN;
    const ramp = Math.min(1, d / 320);
    const elev =
      ramp *
      circuit.hills *
      (11 * Math.sin((d / 730) * Math.PI * 2 + p1) + 4.5 * Math.sin((d / 240) * Math.PI * 2 + p2));
    segments[i] = { curve: curves[i], elev };
  }

  const checkpoints: number[] = [];
  if (circuit.special === "endless") {
    for (let d = ENDLESS_CHECKPOINT_EVERY; d < raceLength; d += ENDLESS_CHECKPOINT_EVERY) {
      checkpoints.push(d);
    }
  }

  return {
    circuit,
    segments,
    traffic: planTraffic(rng, raceLength, circuit.traffic, zone),
    pickups: planPickups(rng, raceLength),
    raceLength,
    checkpoints,
    end: segmentCount * SEG_LEN,
  };
}

export function segmentAt(track: Track, d: number): TrackSegment {
  const i = Math.floor(d / SEG_LEN);
  return track.segments[Math.max(0, Math.min(track.segments.length - 1, i))];
}

export function curveAt(track: Track, d: number): number {
  return segmentAt(track, d).curve;
}

/** Road elevation at any distance, interpolated between segments. */
export function elevAt(track: Track, d: number): number {
  const i = Math.floor(d / SEG_LEN);
  const a = track.segments[Math.max(0, Math.min(track.segments.length - 1, i))];
  const b = track.segments[Math.max(0, Math.min(track.segments.length - 1, i + 1))];
  const t = (d - i * SEG_LEN) / SEG_LEN;
  return a.elev + (b.elev - a.elev) * t;
}

/* ------------------------------------------------------------------ */
/* Traffic plan                                                        */
/* ------------------------------------------------------------------ */

const TRAFFIC_COLORS = ["#8b95a5", "#6d7889", "#a58b6d", "#7d8b6d", "#6d7ba5", "#9a6d8b"];
/** Minimum drivable gap that must survive around any cluster of traffic. */
const MIN_GAP = 2.7;

/**
 * Seed traffic along the track. Cars sit at continuous lateral positions —
 * no lanes — and the spawner guarantees that within any tight cluster
 * (cars near the same track position) a gap of at least MIN_GAP meters
 * remains, so the road is always drivable but never free.
 */
function planTraffic(
  rng: () => number,
  raceLength: number,
  density: number,
  zone: (d: number) => number,
): TrafficSpawn[] {
  const spawns: TrafficSpawn[] = [];
  let d = 170;
  while (d < raceLength + 250) {
    d += (16 + rng() * 34) / (density * zone(d));
    // Occasionally a pinch: two vehicles nearly abreast forcing one gap.
    const pinch = rng() < 0.14;
    const group = pinch ? 2 : 1;
    for (let g = 0; g < group; g++) {
      const truck = rng() < 0.18;
      const width = truck ? 2.5 : 1.85;
      const length = truck ? 7.5 : 4.4;
      const spawnD = d + g * (4 + rng() * 6);
      const x = placeWithGap(spawns, spawnD, width, rng);
      if (x === null) continue;
      spawns.push({
        d: spawnD,
        x,
        speed: truck ? 8 + rng() * 4 : 10 + rng() * 7,
        width,
        length,
        color: TRAFFIC_COLORS[Math.floor(rng() * TRAFFIC_COLORS.length)],
        truck,
        seed: Math.floor(rng() * 0xffffffff),
      });
    }
  }
  return spawns;
}

/**
 * Pick a lateral position for a new car at `d` such that, together with all
 * existing cars within CLUSTER meters, at least one MIN_GAP-wide corridor
 * stays open. Returns null if no fair placement was found.
 */
function placeWithGap(
  existing: TrafficSpawn[],
  d: number,
  width: number,
  rng: () => number,
): number | null {
  const CLUSTER = 26;
  const limit = ROAD_HALF_W - width / 2 - 0.35;
  const neighbors = existing.filter((s) => Math.abs(s.d - d) < CLUSTER);

  for (let attempt = 0; attempt < 10; attempt++) {
    const x = -limit + rng() * limit * 2;
    // Occupied intervals across the road for this cluster if we place here.
    const blocked: Array<[number, number]> = neighbors.map((s) => [
      s.x - s.width / 2 - 0.5,
      s.x + s.width / 2 + 0.5,
    ]);
    blocked.push([x - width / 2 - 0.5, x + width / 2 + 0.5]);
    blocked.sort((a, b) => a[0] - b[0]);

    // Walk the road edge-to-edge and find the widest surviving gap.
    let cursor = -ROAD_HALF_W;
    let widest = 0;
    for (const [from, to] of blocked) {
      widest = Math.max(widest, from - cursor);
      cursor = Math.max(cursor, to);
    }
    widest = Math.max(widest, ROAD_HALF_W - cursor);

    // Also require the newcomer not to overlap a neighbor outright.
    const overlaps = neighbors.some(
      (s) => Math.abs(s.d - d) < (s.length + 7) / 2 && Math.abs(s.x - x) < (s.width + width) / 2 + 0.3,
    );
    if (widest >= MIN_GAP && !overlaps) return x;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Pickups plan                                                        */
/* ------------------------------------------------------------------ */

/**
 * Coins come in short trains you can commit a line to; boost canisters sit
 * alone. Pickups are intangible, so they can overlap the traffic plan —
 * grabbing a coin train that threads a pinch is the whole point.
 */
function planPickups(rng: () => number, raceLength: number): PickupSpawn[] {
  const pickups: PickupSpawn[] = [];
  const limit = ROAD_HALF_W - 1.2;
  let d = 200;
  while (d < raceLength - 60) {
    d += 120 + rng() * 160;
    if (rng() < 0.3) {
      // Lone boost canister.
      pickups.push({ d, x: -limit + rng() * limit * 2, kind: "boost" });
    } else {
      // Train of 4-6 coins, drifting gently across the road.
      const count = 4 + Math.floor(rng() * 3);
      const x0 = -limit + rng() * limit * 2;
      const drift = (rng() - 0.5) * 2.4;
      for (let i = 0; i < count; i++) {
        const x = Math.max(-limit, Math.min(limit, x0 + drift * i));
        pickups.push({ d: d + i * 9, x, kind: "coin" });
      }
      d += count * 9;
    }
  }
  return pickups;
}
