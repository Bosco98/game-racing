/**
 * Track generation — everything about the road lives here.
 *
 * The track is a 1-D world measured in meters. It is generated from a seed,
 * so every race the host runs is reproducible and every player races the
 * exact same road: same curves, same hills, same traffic plan.
 *
 * Segments are SEG_LEN meters long and carry a `curve` value (how hard the
 * road bends at that point) and an `elev` value (road height, for hills).
 * The renderer accumulates curve to bend the projected road; the physics
 * uses it as centrifugal pull on the cars.
 */

export const SEG_LEN = 5; // meters per segment
export const RACE_LENGTH = 2000; // meters from start line to finish line
export const RUNOFF = 700; // road generated past the finish (coast-down + draw distance)
export const ROAD_HALF_W = 6; // meters from road center to the edge line

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

export interface Track {
  seed: number;
  segments: TrackSegment[];
  traffic: TrafficSpawn[];
  /** Total generated road length in meters (race + runoff). */
  end: number;
}

/* ------------------------------------------------------------------ */
/* Seeded RNG (mulberry32) — deterministic per race                    */
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

export function generateTrack(seed: number): Track {
  const rng = mulberry32(seed);
  const segmentCount = Math.ceil((RACE_LENGTH + RUNOFF) / SEG_LEN);
  const curves = new Float64Array(segmentCount);

  // Lay out features: an opening straight, then alternating straights and
  // eased curves until we run out of road.
  let at = Math.floor(150 / SEG_LEN); // fair, straight start
  let lastDir = 0;
  while (at < segmentCount) {
    const straight = Math.floor((60 + rng() * 140) / SEG_LEN);
    at += straight;
    if (at >= segmentCount) break;

    const lengthSegs = Math.floor((110 + rng() * 190) / SEG_LEN);
    // Avoid three same-direction curves in a row feeling like one long arc.
    let dir = rng() < 0.5 ? -1 : 1;
    if (dir === lastDir && rng() < 0.6) dir = -dir;
    lastDir = dir;
    const peak = (0.4 + rng() * 0.6) * dir;
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
      ramp * (11 * Math.sin((d / 730) * Math.PI * 2 + p1) + 4.5 * Math.sin((d / 240) * Math.PI * 2 + p2));
    segments[i] = { curve: curves[i], elev };
  }

  return {
    seed,
    segments,
    traffic: planTraffic(rng),
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
function planTraffic(rng: () => number): TrafficSpawn[] {
  const spawns: TrafficSpawn[] = [];
  let d = 170;
  while (d < RACE_LENGTH + 250) {
    d += 16 + rng() * 34;
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
