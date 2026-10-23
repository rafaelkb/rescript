/**
 * Player preferences (lib/playerPrefs.ts): playback speed and cut placement.
 * The functions are window-guarded, so a fake localStorage stands in for the
 * browser here.
 */
import {
  CUT_FIT_MODES,
  DEFAULT_CUT_END_THRESHOLD,
  DEFAULT_CUT_FIT_MODE,
  DEFAULT_CUT_SNAP_DISTANCE,
  DEFAULT_CUT_START_THRESHOLD,
  DEFAULT_PLAYBACK_RATE,
  PLAYBACK_RATES,
  clampCutEdgeThreshold,
  clampCutSnapDistance,
  clampPlaybackRate,
  formatCutEdgeThreshold,
  formatPlaybackRate,
  isCutFitMode,
  loadCutEndThreshold,
  loadCutFitMode,
  loadCutSnapDistance,
  loadCutStartThreshold,
  loadPlaybackRate,
  saveCutEndThreshold,
  saveCutFitMode,
  saveCutSnapDistance,
  saveCutStartThreshold,
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

// Cut snap distance.
assert(loadCutSnapDistance() === DEFAULT_CUT_SNAP_DISTANCE, "default cut distance");
assert(clampCutSnapDistance(0.49) === 0.5, "distance snaps to nearest offered");
assert(saveCutSnapDistance(0.75) === 0.75, "save distance returns value");
assert(loadCutSnapDistance() === 0.75, "distance survives reload");

// Start and end word-cut thresholds.
assert(
  loadCutStartThreshold() === DEFAULT_CUT_START_THRESHOLD,
  "default start threshold is 0.5"
);
assert(
  loadCutEndThreshold() === DEFAULT_CUT_END_THRESHOLD,
  "default end threshold is 0.5"
);
assert(DEFAULT_CUT_START_THRESHOLD === 0.5, "start default is 50%");
assert(DEFAULT_CUT_END_THRESHOLD === 0.5, "end default is 50%");
assert(clampCutEdgeThreshold(0) === 0, "0% kept");
assert(clampCutEdgeThreshold(1) === 1, "100% kept");
assert(clampCutEdgeThreshold(-0.5) === 0, "negative clamps to 0");
assert(clampCutEdgeThreshold(1.8) === 1, "above 1 clamps to 1");
assert(
  clampCutEdgeThreshold(Number.NaN) === DEFAULT_CUT_START_THRESHOLD,
  "NaN threshold falls back"
);
assert(formatCutEdgeThreshold(0) === "0%", "0% label");
assert(formatCutEdgeThreshold(0.5) === "50%", "50% label");
assert(formatCutEdgeThreshold(1) === "100%", "100% label");
assert(saveCutStartThreshold(0.8) === 0.8, "save start threshold");
assert(saveCutEndThreshold(0.25) === 0.25, "save end threshold");
assert(loadCutStartThreshold() === 0.8, "start threshold survives reload");
assert(loadCutEndThreshold() === 0.25, "end threshold survives reload");
memory.set("rescript.cut-start-threshold", "");
memory.set("rescript.cut-end-threshold", "not-a-number");
assert(
  loadCutStartThreshold() === DEFAULT_CUT_START_THRESHOLD,
  "empty start threshold falls back"
);
assert(
  loadCutEndThreshold() === DEFAULT_CUT_END_THRESHOLD,
  "garbage end threshold falls back"
);

console.log("ALL PLAYER PREFS TESTS PASSED");
