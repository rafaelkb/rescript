/**
 * Player preferences (lib/playerPrefs.ts): playback speed and cut placement.
 * The functions are window-guarded, so a fake localStorage stands in for the
 * browser here.
 */
import {
  CUT_FIT_MODES,
  DEFAULT_CUT_FIT_MODE,
  DEFAULT_PLAYBACK_RATE,
  PLAYBACK_RATES,
  clampPlaybackRate,
  formatPlaybackRate,
  isCutFitMode,
  loadCutFitMode,
  loadPlaybackRate,
  saveCutFitMode,
  savePlaybackRate,
} from "../lib/playerPrefs";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const memory = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
  },
};

// Defaults before anything is stored.
assert(loadPlaybackRate() === DEFAULT_PLAYBACK_RATE, "default speed is 1x");
assert(loadCutFitMode() === DEFAULT_CUT_FIT_MODE, "default cut mode is fit");
assert(DEFAULT_CUT_FIT_MODE === "fit", "fit is the out-of-the-box mode");

// Clamping snaps onto the offered rates.
assert(clampPlaybackRate(1.5) === 1.5, "offered rate kept");
assert(clampPlaybackRate(1.48) === 1.5, "nearby rate snapped");
assert(clampPlaybackRate(0) === DEFAULT_PLAYBACK_RATE, "0 falls back to 1x");
assert(clampPlaybackRate(-2) === DEFAULT_PLAYBACK_RATE, "negatives fall back");
assert(clampPlaybackRate(Number.NaN) === DEFAULT_PLAYBACK_RATE, "NaN falls back");
assert(clampPlaybackRate(99) === DEFAULT_PLAYBACK_RATE, "absurd rates fall back");
assert(
  PLAYBACK_RATES.includes(2.5 as (typeof PLAYBACK_RATES)[number]),
  "2.5x is offered"
);

// Labels.
assert(formatPlaybackRate(1) === "1×", "1x label");
assert(formatPlaybackRate(1.5) === "1.5×", "1.5x label");
assert(formatPlaybackRate(0.75) === "0.75×", "0.75x label");

// Round trip through storage.
assert(savePlaybackRate(2) === 2, "save returns the value");
assert(loadPlaybackRate() === 2, "speed survives a reload");
savePlaybackRate(2.5);
assert(loadPlaybackRate() === 2.5, "speed updates");
memory.set("rescript.playback-rate", "banana");
assert(loadPlaybackRate() === DEFAULT_PLAYBACK_RATE, "garbage falls back");

// Cut placement modes.
assert(CUT_FIT_MODES.length === 3, "three cut modes");
assert(isCutFitMode("fit") && isCutFitMode("gap") && isCutFitMode("bounds"), "known modes");
assert(!isCutFitMode("center"), "unknown mode rejected");
assert(!isCutFitMode(null), "null rejected");
assert(saveCutFitMode("gap") === "gap", "save returns the mode");
assert(loadCutFitMode() === "gap", "mode survives a reload");
memory.set("rescript.cut-fit", "nonsense");
assert(loadCutFitMode() === DEFAULT_CUT_FIT_MODE, "garbage mode falls back");

console.log("ALL PLAYER PREFS TESTS PASSED");
