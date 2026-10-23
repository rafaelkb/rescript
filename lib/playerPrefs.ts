/**
 * Player preferences that outlive a session (localStorage, web + desktop):
 * preview playback speed and where a text deletion puts its cut edges.
 *
 * Kept free of imports from the React layer so anything can read it, and
 * window-guarded so a server render (or a test runner) gets the defaults.
 */
import type { CutFitMode } from "./cutSnap";

/**
 * Speeds offered in the player settings. 1 is the natural speed; below it for
 * skimming a rough cut, above it for proof-listening a long take.
 */
export const PLAYBACK_RATES = [
  0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3,
] as const;

export const DEFAULT_PLAYBACK_RATE = 1;

const PLAYBACK_RATE_STORAGE_KEY = "rescript.playback-rate";

/**
 * Snap an arbitrary number onto the offered rates. Anything unparseable (or
 * outside a sane range) falls back to natural speed, so a stale or hand-edited
 * localStorage value cannot leave playback at 0x — which would stall the
 * element — or at some absurd 16x.
 */
export function clampPlaybackRate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PLAYBACK_RATE;
  let best: number = PLAYBACK_RATES[0];
  let bestDistance = Infinity;
  for (const rate of PLAYBACK_RATES) {
    const distance = Math.abs(rate - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = rate;
    }
  }
  // More than a quarter-step away from any offered rate: not a real choice.
  return bestDistance <= 0.26 ? best : DEFAULT_PLAYBACK_RATE;
}

/** Human label for a rate: `1×`, `1.5×`, `0.75×`. */
export function formatPlaybackRate(rate: number): string {
  const clamped = clampPlaybackRate(rate);
  return `${clamped}×`;
}

/** Read the saved playback speed (defaults to 1x). */
export function loadPlaybackRate(): number {
  if (typeof window === "undefined") return DEFAULT_PLAYBACK_RATE;
  try {
    const raw = window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY);
    if (raw != null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return clampPlaybackRate(parsed);
    }
  } catch {
    // private mode / disabled storage
  }
  return DEFAULT_PLAYBACK_RATE;
}

/** Persist the playback speed; returns the clamped value. */
export function savePlaybackRate(value: number): number {
  const clamped = clampPlaybackRate(value);
  if (typeof window === "undefined") return clamped;
  try {
    window.localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(clamped));
  } catch {
    // private mode / disabled storage
  }
  return clamped;
}

const CUT_FIT_STORAGE_KEY = "rescript.cut-fit";

/** Order the modes are offered in the player settings. */
export const CUT_FIT_MODES: readonly CutFitMode[] = [
  "fit",
  "gap",
  "bounds",
] as const;

/**
 * Default: fit the cut inside the silence. Deleting text should never take the
 * first or last few milliseconds of the words beside it with it — ASR bounds
 * run tight, so the honest cut point is the audio, not the timestamp.
 */
export const DEFAULT_CUT_FIT_MODE: CutFitMode = "fit";

export function isCutFitMode(value: unknown): value is CutFitMode {
  return value === "fit" || value === "gap" || value === "bounds";
}

/** Read the saved cut-placement mode (defaults to {@link DEFAULT_CUT_FIT_MODE}). */
export function loadCutFitMode(): CutFitMode {
  if (typeof window === "undefined") return DEFAULT_CUT_FIT_MODE;
  try {
    const raw = window.localStorage.getItem(CUT_FIT_STORAGE_KEY);
    if (isCutFitMode(raw)) return raw;
  } catch {
    // private mode / disabled storage
  }
  return DEFAULT_CUT_FIT_MODE;
}

/** Persist the cut-placement mode; returns the value that was stored. */
export function saveCutFitMode(mode: CutFitMode): CutFitMode {
  const next = isCutFitMode(mode) ? mode : DEFAULT_CUT_FIT_MODE;
  if (typeof window === "undefined") return next;
  try {
    window.localStorage.setItem(CUT_FIT_STORAGE_KEY, next);
  } catch {
    // private mode / disabled storage
  }
  return next;
}
