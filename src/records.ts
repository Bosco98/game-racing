/**
 * Deck-local circuit records — best time (races) or best distance (endless)
 * plus the medal that value earns. Stored in localStorage so the deck
 * remembers across sessions; per-deck, not per-player, by design: the couch
 * competes against the house record.
 */

import type { Circuit } from "./track";

export type MedalTier = "gold" | "silver" | "bronze";

export interface CircuitRecord {
  bestMs?: number;
  bestDist?: number;
}

const KEY = "tilt-grand-prix:records";

export function loadRecords(): Record<string, CircuitRecord> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, CircuitRecord>;
  } catch {
    return {};
  }
}

function save(records: Record<string, CircuitRecord>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    /* private mode etc. — records just don't persist */
  }
}

/** Merge a race result in; returns true when it beat the stored record. */
export function submitResult(circuit: Circuit, value: number): boolean {
  const records = loadRecords();
  const record = records[circuit.id] ?? {};
  let improved = false;
  if (circuit.special === "endless") {
    if (record.bestDist === undefined || value > record.bestDist) {
      record.bestDist = Math.round(value);
      improved = true;
    }
  } else {
    if (record.bestMs === undefined || value < record.bestMs) {
      record.bestMs = Math.round(value);
      improved = true;
    }
  }
  records[circuit.id] = record;
  save(records);
  return improved;
}

/** Medal a value earns on this circuit (null = no medal). */
export function tierFor(circuit: Circuit, value: number | null | undefined): MedalTier | null {
  if (value === null || value === undefined) return null;
  const { gold, silver, bronze } = circuit.medals;
  if (circuit.special === "endless") {
    return value >= gold ? "gold" : value >= silver ? "silver" : value >= bronze ? "bronze" : null;
  }
  return value <= gold ? "gold" : value <= silver ? "silver" : value <= bronze ? "bronze" : null;
}

/** The medal the stored record earns (for the lobby carousel). */
export function recordTier(circuit: Circuit): MedalTier | null {
  const record = loadRecords()[circuit.id];
  return tierFor(circuit, circuit.special === "endless" ? record?.bestDist : record?.bestMs);
}
