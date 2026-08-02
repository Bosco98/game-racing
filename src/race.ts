/**
 * Race orchestration — the state machine that turns the sim + renderer
 * into an actual race:
 *
 *   lobby ──(everyone ready, press A)──▶ countdown ──▶ racing ──▶ finished
 *     ▲                                                              │
 *     └────────────────────(press A to rematch)──────────────────────┘
 *
 * Owns all mutable game state; HostApp only renders overlays from the
 * snapshots this emits.
 *
 * Lobby controls (phones):
 *   A — ready up · B — toggle your gearbox (Grand Prix)
 *   P1's GAS — next circuit · P1's BRAKE — switch Cruise/Grand Prix
 *
 * Modes:
 *   Cruise      — the original drive model: gas, brake, nitro on A.
 *   Grand Prix  — 4-speed gearbox. AUTO shifts itself (decently, never
 *                 perfectly); MANUAL gets the 1-2-3-4 strip on the phone
 *                 and earns boosts for redline shifts.
 */

import type { TiltEvents, HostSession, Player } from "@bosco98/opencontrol-sdk";
import {
  type CarState,
  type Pickup,
  type ShiftQuality,
  type TrafficCar,
  GEAR_COUNT,
  createCar,
  collectPickups,
  rpmFor,
  shiftGear,
  spawnPickups,
  spawnTraffic,
  stepCars,
  stepTraffic,
  tryNitro,
} from "./physics";
import {
  type Circuit,
  type Track,
  CIRCUITS,
  ENDLESS_CHECKPOINT_S,
  ENDLESS_START_S,
  generateTrack,
} from "./track";
import { submitResult, tierFor, type MedalTier } from "./records";
import { Renderer, type Phase, type RenderPlayer } from "./render";

const COLORS = ["#7ee787", "#7aa2ff", "#ffd042", "#ff5a5f", "#c792ea", "#4dd0e1", "#ffa657", "#f0f6fc"];
/** Side-by-side grid slots on the start line (lateral meters), by pane order. */
const START_SLOTS = [-4.05, 4.05, -1.35, 1.35];
/** Everyone still driving gets this long after the winner finishes. */
const STRAGGLER_MS = 30_000;

/* Chase tuning: the cop's cruise speed is beatable flat out, the gap only
 * bleeds fast when you're crawling (crashes), and a bust needs contact. */
const COP_START_GAP = 60;
const COP_MAX_GAP = 90;
const COP_SPEED = 45; // m/s — beat this and you pull away
const COP_CLOSE_CAP = 9; // m/s — fastest the cop may close
const COP_PULL_CAP = 6; // m/s — fastest you may pull away
const COP_BUST_GAP = 5;

export type GameMode = "cruise" | "gp";

export interface RacerSnapshot {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  /** Joined mid-race; races from the next countdown. */
  spectator: boolean;
  ghost: boolean;
  place: number;
  finished: boolean;
  /** Race time in ms, null until this racer finishes (DNF stays null). */
  finishMs: number | null;
  distance: number;
  /** Grand Prix gearbox choice. */
  manual: boolean;
  coins: number;
  busted: boolean;
}

export interface RaceResult {
  tier: MedalTier | null;
  newRecord: boolean;
  /** Winning time in ms, or best distance in meters for endless. */
  value: number;
}

export interface GameSnapshot {
  phase: Phase;
  /** 3..1 during countdown, 0 = "GO!" flash, -1 = hidden. */
  countdown: number;
  mode: GameMode;
  circuitIndex: number;
  players: RacerSnapshot[];
  raceLength: number;
  /** Medal outcome of the race that just finished (phase "finished" only). */
  result: RaceResult | null;
}

interface Racer {
  player: Player<TiltEvents>;
  car: CarState;
  color: string;
  ready: boolean;
  spectator: boolean;
  place: number;
  finishMs: number | null;
  /** Grand Prix: wants the 1-2-3-4 strip instead of the auto box. */
  manual: boolean;
  busted: boolean;
  /** Meters of buffer left before the cop (chase circuits). */
  copGap: number;
}

export class RacingGame {
  private phase: Phase = "lobby";
  private mode: GameMode = "cruise";
  private circuitIndex = 0;
  private track: Track;
  private traffic: TrafficCar[];
  private pickups: Pickup[];
  private readonly racers = new Map<string, Racer>();

  private countdownEndAt = 0;
  private lastCountdownTick = -1;
  private raceStartAt = 0;
  private firstFinishAt = 0;
  private finishedCount = 0;
  private demoD = 0;
  private result: RaceResult | null = null;

  /* Endless Rush: one shared clock the leader keeps alive. */
  private clockEndAt = 0;
  private nextCheckpoint = 0;
  private checkpointFlashAt = 0;

  private rafId = 0;
  private last = 0;
  private snapshotTimer = 0;
  private readonly renderer: Renderer;
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    canvas: HTMLCanvasElement,
    private readonly session: HostSession<TiltEvents>,
    private readonly onSnapshot: (snapshot: GameSnapshot) => void,
  ) {
    this.renderer = new Renderer(canvas);
    this.track = generateTrack(this.circuit);
    this.traffic = spawnTraffic(this.track.traffic);
    this.pickups = spawnPickups(this.track.pickups);

    this.unsubscribes.push(
      session.on("join", (player) => this.addRacer(player)),
      session.on("leave", (player) => {
        this.racers.delete(player.id);
        if (this.racers.size === 0) this.phase = "lobby";
        else this.checkStart();
        this.emitSnapshot();
      }),
      session.on("disconnect", (player) => {
        const racer = this.racers.get(player.id);
        if (racer) racer.car.ghost = true;
        this.emitSnapshot();
      }),
      session.on("reconnect", (player) => {
        const racer = this.racers.get(player.id);
        if (racer) {
          racer.car.ghost = false;
          // Re-arm the phone's layout — a reload came back with plain A/B.
          this.sendLayout(racer);
        }
        this.emitSnapshot();
      }),
    );

    this.last = performance.now();
    this.rafId = requestAnimationFrame((now) => this.loop(now));
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.renderer.destroy();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
  }

  private get circuit(): Circuit {
    return CIRCUITS[this.circuitIndex];
  }

  private get inMenu(): boolean {
    return this.phase === "lobby" || this.phase === "finished";
  }

  /* ---------------------------------------------------------------- */
  /* Players                                                           */
  /* ---------------------------------------------------------------- */

  private addRacer(player: Player<TiltEvents>): void {
    const racer: Racer = {
      player,
      car: createCar(START_SLOTS[this.racers.size % START_SLOTS.length]),
      color: COLORS[player.index % COLORS.length],
      ready: false,
      spectator: this.phase === "racing" || this.phase === "countdown",
      place: this.racers.size + 1,
      finishMs: null,
      manual: false,
      busted: false,
      copGap: COP_START_GAP,
    };
    this.racers.set(player.id, racer);

    player.on("tilt", ({ value }) => {
      racer.car.steer = value;
    });
    player.on("trigger", ({ side, value }) => {
      if (side === "right") racer.car.gas = value;
      else racer.car.brake = value;
      // In the menu, P1's triggers double as the circuit/mode selector.
      if (value === 1 && this.inMenu && this.isMenuDriver(racer)) {
        if (side === "right") this.cycleCircuit();
        else this.toggleMode();
      }
    });
    player.on("buttonDown", ({ button }) => {
      if (button === "b") {
        if (this.inMenu && this.mode === "gp") {
          racer.manual = !racer.manual;
          player.vibrate(racer.manual ? [30, 40, 30] : 30);
          this.emitSnapshot();
        }
        return;
      }
      // Button A from here down.
      if (this.inMenu) {
        racer.ready = !racer.ready;
        player.vibrate(40);
        this.checkStart();
        this.emitSnapshot();
      } else if (this.phase === "racing" && !racer.spectator && this.mode === "cruise") {
        if (tryNitro(racer.car, performance.now())) player.vibrate(80);
      }
    });
    player.on("gear", ({ gear }) => {
      if (this.phase !== "racing" || racer.spectator || !racer.manual) return;
      const now = performance.now();
      const quality = shiftGear(racer.car, gear, now, this.leaderD());
      this.shiftFeedback(racer, quality);
    });

    this.emitSnapshot();
  }

  /** The phone that drives the lobby menu: first connected non-ghost racer. */
  private isMenuDriver(racer: Racer): boolean {
    let driver: Racer | null = null;
    for (const candidate of this.racers.values()) {
      if (candidate.car.ghost) continue;
      if (!driver || candidate.player.index < driver.player.index) driver = candidate;
    }
    return driver === racer;
  }

  private shiftFeedback(racer: Racer, quality: ShiftQuality | null): void {
    if (quality === "perfect") racer.player.vibrate([25, 25, 80]);
    else if (quality === "ok") racer.player.vibrate(20);
    else if (quality === "bog" || quality === "overrev") racer.player.vibrate(120);
  }

  /** All racers who take part in the current/next race, in stable pane order. */
  private activeRacers(): Racer[] {
    return [...this.racers.values()]
      .filter((r) => !r.spectator)
      .sort((a, b) => a.player.index - b.player.index);
  }

  private leaderD(): number {
    let d = 0;
    for (const racer of this.racers.values()) d = Math.max(d, racer.car.d);
    return d;
  }

  /* ---------------------------------------------------------------- */
  /* Lobby menu                                                        */
  /* ---------------------------------------------------------------- */

  private cycleCircuit(): void {
    this.circuitIndex = (this.circuitIndex + 1) % CIRCUITS.length;
    this.track = generateTrack(this.circuit);
    this.traffic = spawnTraffic(this.track.traffic);
    this.pickups = spawnPickups(this.track.pickups);
    this.demoD = 0;
    // The old race's medal line would sit under the new circuit's name.
    this.result = null;
    this.emitSnapshot();
  }

  private toggleMode(): void {
    this.mode = this.mode === "cruise" ? "gp" : "cruise";
    this.emitSnapshot();
  }

  /** Tell one phone which layout it should be showing right now. */
  private sendLayout(racer: Racer): void {
    const racing = this.phase === "racing" || this.phase === "countdown";
    const wantsGears = racing && this.mode === "gp" && racer.manual && !racer.spectator;
    racer.player.send("tilt:layout", { gears: wantsGears ? GEAR_COUNT : 0 });
    if (wantsGears) racer.player.send("tilt:gear", { gear: racer.car.gearing?.gear ?? 1 });
  }

  /* ---------------------------------------------------------------- */
  /* Phase transitions                                                 */
  /* ---------------------------------------------------------------- */

  private checkStart(): void {
    if (!this.inMenu) return;
    const eligible = [...this.racers.values()].filter((r) => !r.car.ghost);
    if (eligible.length >= 1 && eligible.every((r) => r.ready)) this.beginCountdown();
  }

  private beginCountdown(): void {
    this.track = generateTrack(this.circuit);
    this.traffic = spawnTraffic(this.track.traffic);
    this.pickups = spawnPickups(this.track.pickups);
    this.finishedCount = 0;
    this.firstFinishAt = 0;
    this.result = null;
    this.nextCheckpoint = 0;
    this.checkpointFlashAt = 0;

    const grid = [...this.racers.values()].sort((a, b) => a.player.index - b.player.index);
    grid.forEach((racer, i) => {
      const ghost = racer.car.ghost;
      racer.car = createCar(START_SLOTS[i % START_SLOTS.length]);
      racer.car.ghost = ghost;
      if (this.mode === "gp") {
        racer.car.gearing = { gear: 1, auto: !racer.manual, perfectUntil: 0, shiftedAt: 0, lastShift: null };
      }
      racer.spectator = false;
      racer.ready = false;
      racer.place = i + 1;
      racer.finishMs = null;
      racer.busted = false;
      racer.copGap = COP_START_GAP;
    });

    this.phase = "countdown";
    this.countdownEndAt = performance.now() + 3000;
    this.lastCountdownTick = -1;
    for (const racer of this.racers.values()) this.sendLayout(racer);
    this.emitSnapshot();
  }

  private endRace(): void {
    // Everyone without a time (DNF, busted, out of clock) ranks by distance.
    const notClassified = this.activeRacers()
      .filter((r) => r.finishMs === null)
      .sort((a, b) => b.car.d - a.car.d);
    notClassified.forEach((racer, i) => {
      racer.place = this.finishedCount + i + 1;
    });

    this.result = this.computeResult();

    // Everyone (including mid-race joiners) races next round.
    for (const racer of this.racers.values()) {
      racer.spectator = false;
      racer.ready = false;
    }
    this.phase = "finished";
    for (const racer of this.racers.values()) this.sendLayout(racer);
    this.emitSnapshot();
  }

  /** Best result of the race vs this circuit's medals and the house record. */
  private computeResult(): RaceResult | null {
    const active = this.activeRacers();
    if (active.length === 0) return null;
    const circuit = this.circuit;
    if (circuit.special === "endless") {
      const best = Math.max(...active.map((r) => r.car.d));
      return { tier: tierFor(circuit, best), newRecord: submitResult(circuit, best), value: Math.round(best) };
    }
    const times = active.map((r) => r.finishMs).filter((t): t is number => t !== null);
    if (times.length === 0) return null; // nobody made it — no medal, no record
    const best = Math.min(...times);
    return { tier: tierFor(circuit, best), newRecord: submitResult(circuit, best), value: best };
  }

  /* ---------------------------------------------------------------- */
  /* Main loop                                                         */
  /* ---------------------------------------------------------------- */

  private loop(now: number): void {
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;

    if (this.phase === "countdown") this.tickCountdown(now);
    if (this.phase === "racing") this.tickRace(dt, now);
    if (this.racers.size === 0) {
      // Attract mode: cruise the camera and keep traffic alive (wrapped so the
      // road never empties). beginCountdown() respawns traffic from the plan.
      this.demoD = (this.demoD + 24 * dt) % (this.track.end - 450);
      stepTraffic(this.traffic, dt, now);
      for (const t of this.traffic) t.d %= this.track.end;
    }

    const players = this.renderPlayers(now);
    try {
      this.renderer.draw({
        track: this.track,
        traffic: this.traffic,
        pickups: this.pickups,
        players,
        phase: this.phase,
        mode: this.mode,
        now,
        demoD: this.demoD,
        endless:
          this.circuit.special === "endless" && (this.phase === "racing" || this.phase === "finished")
            ? {
                leftS: Math.max(0, (this.clockEndAt - now) / 1000),
                flashUntil: this.checkpointFlashAt + 1400,
                bonusS: ENDLESS_CHECKPOINT_S,
              }
            : null,
      });
    } catch (err) {
      // A bad frame must not kill the game loop; the sim is still healthy.
      console.error("render frame failed", err);
    }

    this.snapshotTimer += dt;
    if (this.snapshotTimer > 0.25) {
      this.snapshotTimer = 0;
      this.emitSnapshot();
    }

    this.rafId = requestAnimationFrame((next) => this.loop(next));
  }

  private tickCountdown(now: number): void {
    const tick = Math.ceil((this.countdownEndAt - now) / 1000);
    if (tick !== this.lastCountdownTick) {
      this.lastCountdownTick = tick;
      for (const racer of this.racers.values()) racer.player.vibrate(45);
      this.emitSnapshot();
    }
    if (now >= this.countdownEndAt) {
      this.phase = "racing";
      this.raceStartAt = now;
      this.clockEndAt = now + ENDLESS_START_S * 1000;
      for (const racer of this.racers.values()) racer.player.vibrate(130);
      this.emitSnapshot();
    }
  }

  private tickRace(dt: number, now: number): void {
    const active = this.activeRacers();
    if (active.length === 0) {
      // Every actual racer left mid-race; only spectators remain.
      this.endRace();
      return;
    }
    stepTraffic(this.traffic, dt, now);
    stepCars(
      active.map((r) => r.car),
      this.traffic,
      this.track,
      dt,
      now,
      {
        onCrash: (car) => this.racerFor(car)?.player.vibrate(250),
        onBump: (a, b) => {
          this.racerFor(a)?.player.vibrate(60);
          this.racerFor(b)?.player.vibrate(60);
        },
      },
    );

    // Pickups (pane index = collection identity).
    active.forEach((racer, i) => {
      if (racer.car.finished || racer.car.ghost) return;
      const got = collectPickups(racer.car, i, this.pickups, now);
      if (got.boosts > 0) racer.player.vibrate(70);
      else if (got.coins > 0) racer.player.vibrate(12);
    });

    if (this.circuit.special === "endless") this.tickEndless(active, now);
    if (this.circuit.special === "chase") this.tickChase(active, dt, now);

    // Finish-line crossings (busted cars are "finished" but never classify).
    for (const racer of active) {
      if (racer.car.finished && racer.finishMs === null && !racer.busted) {
        this.finishedCount += 1;
        racer.finishMs = now - this.raceStartAt;
        racer.place = this.finishedCount;
        racer.player.vibrate(200);
        if (!this.firstFinishAt) this.firstFinishAt = now;
      }
    }

    // Live standings for everyone still on the road.
    const running = active
      .filter((r) => r.finishMs === null)
      .sort((a, b) => b.car.d - a.car.d);
    running.forEach((racer, i) => {
      racer.place = this.finishedCount + i + 1;
    });

    const driving = active.filter((r) => !r.car.finished && !r.car.ghost);
    const timedOut = this.firstFinishAt !== 0 && now > this.firstFinishAt + STRAGGLER_MS;
    if (driving.length === 0 || timedOut) this.endRace();
  }

  /** Shared clock: the leader hitting a checkpoint buys everyone time. */
  private tickEndless(active: Racer[], now: number): void {
    const checkpoints = this.track.checkpoints;
    const leader = Math.max(...active.map((r) => r.car.d));
    while (this.nextCheckpoint < checkpoints.length && leader >= checkpoints[this.nextCheckpoint]) {
      this.nextCheckpoint += 1;
      this.clockEndAt += ENDLESS_CHECKPOINT_S * 1000;
      this.checkpointFlashAt = now;
      for (const racer of active) racer.player.vibrate([40, 40, 40]);
    }
    if (now >= this.clockEndAt) {
      for (const racer of active) racer.car.finished = true; // freeze the field
      this.endRace();
    }
  }

  /** Per-racer cop pressure — pure gap bookkeeping, the renderer sells it. */
  private tickChase(active: Racer[], dt: number, now: number): void {
    for (const racer of active) {
      if (racer.car.finished || racer.car.ghost) continue;
      const rate = Math.max(-COP_CLOSE_CAP, Math.min(COP_PULL_CAP, racer.car.speed - COP_SPEED));
      racer.copGap = Math.min(COP_MAX_GAP, racer.copGap + rate * dt);
      if (racer.copGap <= COP_BUST_GAP) {
        racer.busted = true;
        racer.car.finished = true; // freezes inputs, coasts out
        racer.player.vibrate([300, 100, 300]);
      }
    }
  }

  private racerFor(car: CarState): Racer | undefined {
    for (const racer of this.racers.values()) if (racer.car === car) return racer;
    return undefined;
  }

  /* ---------------------------------------------------------------- */
  /* Output                                                            */
  /* ---------------------------------------------------------------- */

  private renderPlayers(now: number): RenderPlayer[] {
    const leaderD = this.leaderD();
    return this.activeRacers().map((racer, i) => ({
      car: racer.car,
      index: i,
      name: racer.player.name,
      color: racer.color,
      place: racer.place,
      finished: racer.car.finished,
      ghost: racer.car.ghost,
      rpm: rpmFor(racer.car, now, leaderD),
      busted: racer.busted,
      copGap: this.circuit.special === "chase" ? racer.copGap : null,
    }));
  }

  private emitSnapshot(): void {
    const now = performance.now();
    let countdown = -1;
    if (this.phase === "countdown") {
      countdown = Math.max(1, Math.min(3, Math.ceil((this.countdownEndAt - now) / 1000)));
    } else if (this.phase === "racing" && now - this.raceStartAt < 900) {
      countdown = 0;
    }

    this.onSnapshot({
      phase: this.phase,
      countdown,
      mode: this.mode,
      circuitIndex: this.circuitIndex,
      raceLength: this.track.raceLength,
      result: this.phase === "finished" ? this.result : null,
      players: [...this.racers.values()]
        .sort((a, b) => a.place - b.place || a.player.index - b.player.index)
        .map((racer) => ({
          id: racer.player.id,
          name: racer.player.name,
          color: racer.color,
          ready: racer.ready,
          spectator: racer.spectator,
          ghost: racer.car.ghost,
          place: racer.place,
          finished: racer.car.finished,
          finishMs: racer.finishMs,
          distance: Math.floor(racer.car.d),
          manual: racer.manual,
          coins: racer.car.coins,
          busted: racer.busted,
        })),
    });
  }
}
