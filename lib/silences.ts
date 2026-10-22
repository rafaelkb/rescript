import { getCutRanges, isWordCutOut } from "./edits";
import type { ManualCut, TimeRange, Word } from "./types";

/**
 * Minimum gap length (seconds) that counts as a removable silence.
 * Shorter gaps are normal inter-word spacing from ASR and should stay.
 */
export const MIN_SILENCE_DURATION = 0.3;

/**
 * Leave this much audio (seconds) beside kept speech so word onsets/offsets
 * aren't clipped when Whisper timestamps are slightly tight.
 */
export const SILENCE_PAD = 0.05;

/**
 * Manual cuts that hold no words at all — what "Remove silences" leaves behind
 * (and any trim that happened to land on a pause). Restoring these brings the
 * quiet audio back without un-deleting speech, so a cut that merged with a
 * word-bearing cut is deliberately left out.
 */
export function findSilenceCuts(
  words: Word[],
  manualCuts: ManualCut[]
): TimeRange[] {
  return manualCuts
    .filter(
      (c) =>
        c.end - c.start > 1e-4 &&
        !words.some((w) => w.end > c.start + 1e-4 && w.start < c.end - 1e-4)
    )
    .map((c) => ({ start: c.start, end: c.end }));
}

/** Split `range` into the pieces not covered by any of `cuts`. */
function subtractCuts(range: TimeRange, cuts: TimeRange[]): TimeRange[] {
  let parts: TimeRange[] = [range];
  for (const cut of cuts) {
    parts = parts.flatMap((p) => {
      if (cut.end <= p.start + 1e-4 || cut.start >= p.end - 1e-4) return [p];
      const out: TimeRange[] = [];
      if (cut.start > p.start + 1e-4) out.push({ start: p.start, end: cut.start });
      if (cut.end < p.end - 1e-4) out.push({ start: cut.end, end: p.end });
      return out;
    });
  }
  return parts;
}

/**
 * Find silence ranges in the media that are not already cut: gaps before the
 * first kept word, between kept words, and after the last kept word, each at
 * least `minDuration` long. A small pad is left beside speech so it isn't
 * clipped; media edges are cut flush.
 */
export function findSilenceRanges(
  words: Word[],
  duration: number,
  manualCuts: ManualCut[] = [],
  minDuration = MIN_SILENCE_DURATION,
  pad = SILENCE_PAD
): TimeRange[] {
  if (duration <= 0) return [];

  const cuts = getCutRanges(words, duration, manualCuts);
  const kept = words
    .filter((w) => !isWordCutOut(w, cuts))
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);

  // Raw gaps (no pad yet), tagged with whether each edge abuts speech.
  type Gap = { start: number; end: number; padStart: boolean; padEnd: boolean };
  const gaps: Gap[] = [];
  let cursor = 0;
  let prevWasSpeech = false;
  for (const w of kept) {
    if (w.start > cursor + 1e-4) {
      gaps.push({
        start: cursor,
        end: w.start,
        padStart: prevWasSpeech,
        padEnd: true,
      });
    }
    cursor = Math.max(cursor, w.end);
    prevWasSpeech = true;
  }
  if (duration > cursor + 1e-4) {
    gaps.push({
      start: cursor,
      end: duration,
      padStart: prevWasSpeech,
      padEnd: false,
    });
  }

  const out: TimeRange[] = [];
  for (const gap of gaps) {
    if (gap.end - gap.start < minDuration - 1e-4) continue;
    for (const part of subtractCuts(
      { start: gap.start, end: gap.end },
      cuts
    )) {
      if (part.end - part.start < minDuration - 1e-4) continue;
      // Only pad edges that still sit against speech (not against a prior cut).
      const padStart = gap.padStart && Math.abs(part.start - gap.start) < 1e-4;
      const padEnd = gap.padEnd && Math.abs(part.end - gap.end) < 1e-4;
      const start = part.start + (padStart ? pad : 0);
      const end = part.end - (padEnd ? pad : 0);
      if (end - start > 1e-4) out.push({ start, end });
    }
  }
  return out;
}

/** Bounds for the user-adjustable silence threshold (seconds). */
export const SILENCE_THRESHOLD_MIN = 0.1;
export const SILENCE_THRESHOLD_MAX = 2;

/** The threshold "Remove silences" uses until the user changes it. */
export const DEFAULT_SILENCE_THRESHOLD = MIN_SILENCE_DURATION;

const SILENCE_THRESHOLD_STORAGE_KEY = "rescript.silence-threshold";

/** Clamp to the slider's range; anything unparseable falls back to the default. */
export function clampSilenceThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SILENCE_THRESHOLD;
  return Math.min(
    SILENCE_THRESHOLD_MAX,
    Math.max(SILENCE_THRESHOLD_MIN, value)
  );
}

/** Read the saved silence threshold from localStorage (defaults to 0.3 s). */
export function loadSilenceThreshold(): number {
  if (typeof window === "undefined") return DEFAULT_SILENCE_THRESHOLD;
  try {
    const raw = window.localStorage.getItem(SILENCE_THRESHOLD_STORAGE_KEY);
    if (raw != null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return clampSilenceThreshold(parsed);
    }
  } catch {
    // private mode / disabled storage
  }
  return DEFAULT_SILENCE_THRESHOLD;
}

/** Persist the silence threshold for the next visit; returns the clamped value. */
export function saveSilenceThreshold(value: number): number {
  const clamped = clampSilenceThreshold(value);
  if (typeof window === "undefined") return clamped;
  try {
    window.localStorage.setItem(
      SILENCE_THRESHOLD_STORAGE_KEY,
      String(clamped)
    );
  } catch {
    // private mode / disabled storage
  }
  return clamped;
}
