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
 */

import type { TiltEvents, HostSession, Player } from "@bosco98/opencontrol-sdk";
import {
  type CarState,
  type TrafficCar,
  createCar,
  spawnTraffic,
  stepCars,
  stepTraffic,
  tryNitro,
} from "./physics";
import { type Track, generateTrack, RACE_LENGTH } from "./track";
import { Renderer, type Phase, type RenderPlayer } from "./render";

const COLORS = ["#7ee787", "#7aa2ff", "#ffd042", "#ff5a5f", "#c792ea", "#4dd0e1", "#ffa657", "#f0f6fc"];
/** Side-by-side grid slots on the start line (lateral meters), by pane order. */
const START_SLOTS = [-4.05, 4.05, -1.35, 1.35];
/** Everyone still driving gets this long after the winner finishes. */
const STRAGGLER_MS = 30_000;

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
}

export interface GameSnapshot {
  phase: Phase;
  /** 3..1 during countdown, 0 = "GO!" flash, -1 = hidden. */
  countdown: number;
  players: RacerSnapshot[];
  raceLength: number;
}

interface Racer {
  player: Player<TiltEvents>;
  car: CarState;
  color: string;
  ready: boolean;
  spectator: boolean;
  place: number;
  finishMs: number | null;
}

export class RacingGame {
  private phase: Phase = "lobby";
  private track: Track;
  private traffic: TrafficCar[];
  private readonly racers = new Map<string, Racer>();

  private countdownEndAt = 0;
  private lastCountdownTick = -1;
  private raceStartAt = 0;
  private firstFinishAt = 0;
  private finishedCount = 0;
  private demoD = 0;

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
    this.track = generateTrack(Math.floor(Math.random() * 0x7fffffff));
    this.traffic = spawnTraffic(this.track.traffic);

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
        if (racer) racer.car.ghost = false;
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
    };
    this.racers.set(player.id, racer);

    player.on("tilt", ({ value }) => {
      racer.car.steer = value;
    });
    player.on("trigger", ({ side, value }) => {
      if (side === "right") racer.car.gas = value;
      else racer.car.brake = value;
    });
    player.on("buttonDown", ({ button }) => {
      if (button !== "a") return;
      if (this.phase === "lobby" || this.phase === "finished") {
        racer.ready = !racer.ready;
        player.vibrate(40);
        this.checkStart();
        this.emitSnapshot();
      } else if (this.phase === "racing" && !racer.spectator) {
        if (tryNitro(racer.car, performance.now())) player.vibrate(80);
      }
    });

    this.emitSnapshot();
  }

  /** All racers who take part in the current/next race, in stable pane order. */
  private activeRacers(): Racer[] {
    return [...this.racers.values()]
      .filter((r) => !r.spectator)
      .sort((a, b) => a.player.index - b.player.index);
  }

  /* ---------------------------------------------------------------- */
  /* Phase transitions                                                 */
  /* ---------------------------------------------------------------- */

  private checkStart(): void {
    if (this.phase !== "lobby" && this.phase !== "finished") return;
    const eligible = [...this.racers.values()].filter((r) => !r.car.ghost);
    if (eligible.length >= 1 && eligible.every((r) => r.ready)) this.beginCountdown();
  }

  private beginCountdown(): void {
    this.track = generateTrack(Math.floor(Math.random() * 0x7fffffff));
    this.traffic = spawnTraffic(this.track.traffic);
    this.finishedCount = 0;
    this.firstFinishAt = 0;

    const grid = [...this.racers.values()].sort((a, b) => a.player.index - b.player.index);
    grid.forEach((racer, i) => {
      const ghost = racer.car.ghost;
      racer.car = createCar(START_SLOTS[i % START_SLOTS.length]);
      racer.car.ghost = ghost;
      racer.spectator = false;
      racer.ready = false;
      racer.place = i + 1;
      racer.finishMs = null;
    });

    this.phase = "countdown";
    this.countdownEndAt = performance.now() + 3000;
    this.lastCountdownTick = -1;
    this.emitSnapshot();
  }

  private endRace(): void {
    // DNF placements: unfinished racers ranked by how far they got.
    const unfinished = this.activeRacers()
      .filter((r) => !r.car.finished)
      .sort((a, b) => b.car.d - a.car.d);
    unfinished.forEach((racer, i) => {
      racer.place = this.finishedCount + i + 1;
    });

    // Everyone (including mid-race joiners) races next round.
    for (const racer of this.racers.values()) {
      racer.spectator = false;
      racer.ready = false;
    }
    this.phase = "finished";
    this.emitSnapshot();
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

    const players = this.renderPlayers();
    try {
      this.renderer.draw({
        track: this.track,
        traffic: this.traffic,
        players,
        phase: this.phase,
        now,
        demoD: this.demoD,
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

    // Finish-line crossings.
    for (const racer of active) {
      if (racer.car.finished && racer.finishMs === null) {
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

  private racerFor(car: CarState): Racer | undefined {
    for (const racer of this.racers.values()) if (racer.car === car) return racer;
    return undefined;
  }

  /* ---------------------------------------------------------------- */
  /* Output                                                            */
  /* ---------------------------------------------------------------- */

  private renderPlayers(): RenderPlayer[] {
    return this.activeRacers().map((racer) => ({
      car: racer.car,
      name: racer.player.name,
      color: racer.color,
      place: racer.place,
      finished: racer.car.finished,
      ghost: racer.car.ghost,
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
      raceLength: RACE_LENGTH,
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
        })),
    });
  }
}
