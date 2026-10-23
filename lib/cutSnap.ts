/**
 * Cut-point refinement against the audio, applied when text is deleted.
 *
 * Word timestamps are only estimates: ASR routinely clips a word's bounds
 * tight, so cutting exactly at `[word.start, word.end]` leaves fragments of the
 * deleted speech audible at the cut edges (or, when the bounds run loose,
 * swallows silence that did not need to go). The decoded PCM is long gone by
 * edit time (the store keeps only the min/max envelope, see lib/waveform.ts),
 * but that envelope is enough: real pauses read as deep, wide troughs next to
 * speech. Each cut edge is therefore snapped into the nearby gap — the "exact"
 * cut point — which removes the leftover fragments and trims the cut back when
 * the bounds were loose.
 *
 * Three placement modes, chosen in the cut options menu ({@link CutFitMode}):
 *
 * - `"fit"` (default) — the edge is fitted *inside the silence*: it locates the
 *   pause (or syllable valley) between the deleted word and the neighboring
 *   kept word, strips soft consonant shoulders when a true silence core is
 *   present, and places the cut between the deleted-word side (`0%`) and the
 *   kept-word side (`100%`) according to `startThreshold` / `endThreshold`.
 * - `"gap"` — snaps into the pause bounded by the neighboring words'
 *   timestamps, placed at `startThreshold` / `endThreshold` (`50%` = centered).
 * - `"bounds"` — no analysis at all; cut exactly at the transcript bounds.
 */
import type { Word } from "./types";
import { peakBetween, type WaveformPeaks } from "./waveform";

/** PCM sample rate the waveform envelope is built at (mono 16 kHz). */
export const CUT_SNAP_SAMPLE_RATE = 16_000;

/** Widest an edge may move (seconds), in either direction. */
export const DEFAULT_MAX_SNAP_S = 0.35;

/** Envelope analysis hop (seconds). */
const HOP_S = 0.01;

/** A trough must last at least this long to count as a gap (seconds). */
const MIN_GAP_S = 0.03;

/** Minimum length for an inner silence core inside a quiet run (seconds). */
const MIN_CORE_GAP_S = 0.02;

/** A run must dip below this fraction of the window's peak to count as a gap. */
const GAP_DEPTH_RATIO = 0.4;

/** A run is "quiet" up to this fraction of the window's min→max span. */
const QUIET_TOLERANCE = 0.35;

/**
 * Stricter quiet fraction used to sharpen a pause past soft consonants
 * (/s/, /f/, /h/, plosive releases) when a true-silence core is present.
 */
const CORE_QUIET_TOLERANCE = 0.15;

/** Deleted words (and cuts) never collapse below this (seconds). */
const MIN_WORD_S = 0.02;

/**
 * Default distance kept from neighboring speech when fitting a cut inside a
 * pause (seconds). Twenty milliseconds is well inside the precision of the
 * envelope, so conservative cuts stop in silence without clipping an onset.
 */
const FIT_GUARD_S = 0.02;

/**
 * Tightest guard kept beside neighboring speech when a cut-edge threshold is
 * pushed all the way to 100% (seconds) — matches the 5 ms export micro-fade.
 */
const MIN_FIT_GUARD_S = 0.005;

/** Max radius around a word edge searched for a short coarticulation dip (s). */
const VALLEY_SEARCH_S = 0.14;

/** Where a text deletion puts its cut edges. See the module comment. */
export type CutFitMode = "fit" | "gap" | "bounds";

export interface CutSnapOptions {
  /** Widest an edge may move (seconds). Default {@link DEFAULT_MAX_SNAP_S}. */
  maxSnapS?: number;
  /** Envelope analysis hop (seconds). Default 0.01. */
  hopS?: number;
  /** Sample rate the envelope was built at. Default 16 kHz. */
  sampleRate?: number;
  /**
   * How edges are placed. Default `"gap"`: the primitives stay predictable for
   * callers that predate the setting, while the store passes the user's mode.
   */
  mode?: CutFitMode;
  /**
   * Length of the media (seconds). Only used by `"fit"`, which lets the search
   * run past the neighboring word's timestamp and trusts the envelope instead.
   */
  duration?: number;
  /**
   * Where the leading cut edge lands between the deleted word (`0`) and the
   * previous kept word (`1`). When omitted on low-level `snapCutBoundsToAudio`
   * calls, `"fit"` keeps its closest-edge placement and `"gap"` centers (`0.5`).
   */
  startThreshold?: number;
  /**
   * Where the trailing cut edge lands between the deleted word (`0`) and the
   * next kept word (`1`). When omitted on low-level `snapCutBoundsToAudio`
   * calls, `"fit"` keeps its closest-edge placement and `"gap"` centers (`0.5`).
   */
  endThreshold?: number;
  /**
   * Hard envelope search window `[lo, hi]` for `"fit"` mode so an edge cannot
   * jump across an adjacent short kept word (or across an internal pause of a
   * multi-word deleted run).
   */
  searchBounds?: { lo: number; hi: number };
  /**
   * Neighboring kept words' timestamps (`lo = prev.end`, `hi = next.start`)
   * when adjacent kept words exist. Used as the unclaimed-gap fallback when
   * speech has no detectable pause.
   */
  neighborBounds?: { lo?: number; hi?: number };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** Peak amplitude over [from, to) seconds of the envelope, 0..1. */
function peakBetweenSeconds(
  peaks: WaveformPeaks,
  from: number,
  to: number,
  sampleRate: number
): number {
  return peakBetween(
    peaks,
    Math.max(0, Math.round(from * sampleRate)),
    Math.max(1, Math.round(to * sampleRate))
  );
}

/**
 * Refine a broad quiet run `[runI, runJ)` to its inner true-silence core when
 * one exists.
 *
 * Fricatives (/s/, /f/, /h/) and soft consonant releases often sit at 15–35% of
 * vowel peak — quiet enough to pass `QUIET_TOLERANCE`, yet clearly audible if
 * left beside a cut. When the pause also drops to true room floor (`<= 15%` of
 * the window's span) for at least {@link MIN_CORE_GAP_S}, trimming to that core
 * excludes soft consonants on both the deleted word and the kept neighbor word.
 * Uniform pauses (e.g. digital silence) span the whole run and stay unchanged.
 */
function sharpenQuietRun(
  levels: Float32Array,
  from: number,
  hopS: number,
  runI: number,
  runJ: number,
  eMin: number,
  eMax: number,
  edge: number,
  outward: "earlier" | "later",
  requireOutwardOrStraddle: boolean
): { start: number; end: number } {
  const rawStart = from + runI * hopS;
  const rawEnd = from + runJ * hopS;
  const coreThresh = eMin + CORE_QUIET_TOLERANCE * (eMax - eMin);

  let best: { start: number; end: number } | null = null;
  let bestDistance = Infinity;
  let bestOutward = false;

  for (let i = runI; i < runJ; ) {
    if (levels[i] > coreThresh) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < runJ && levels[j] <= coreThresh) j++;
    const subStart = from + i * hopS;
    const subEnd = from + j * hopS;
    if (subEnd - subStart >= MIN_CORE_GAP_S - 1e-4) {
      const center = (subStart + subEnd) / 2;
      const straddles = subStart < edge && subEnd > edge;
      const outwardSide = outward === "earlier" ? center < edge : center > edge;
      if (!requireOutwardOrStraddle || straddles || outwardSide) {
        const distance =
          edge < subStart ? subStart - edge : edge > subEnd ? edge - subEnd : 0;
        const isOutward =
          outward === "earlier" ? subStart < edge : subEnd > edge;
        if (
          distance < bestDistance - 1e-9 ||
          (Math.abs(distance - bestDistance) <= 1e-9 &&
            isOutward &&
            !bestOutward)
        ) {
          bestDistance = distance;
          best = { start: subStart, end: subEnd };
          bestOutward = isOutward;
        }
      }
    }
    i = j;
  }

  return best ?? { start: rawStart, end: rawEnd };
}

/**
 * Locate the gap a cut edge should sit in, within
 * `[edge - maxSnapS, edge + maxSnapS] ∩ [lo, hi]`, and place the cut at
 * `threshold` (`0` = deleted-word side, `0.5` = center, `1` = kept-word side).
 *
 * Candidate troughs are the ones that could delimit the deleted speech: runs
 * whose center is on the outward side of the edge (so the cut grows and
 * leftover fragments are swallowed), plus any run the edge already sits inside
 * (so loose bounds are trimmed back into the gap). A trough on the far side of
 * the edge, inside the speech being deleted, is deliberately not a candidate.
 *
 * Returns null when no qualifying gap exists (contiguous speech, all-quiet
 * windows, flat energy): the edge then keeps its ASR value.
 */
function findGapPoint(
  peaks: WaveformPeaks,
  edge: number,
  lo: number,
  hi: number,
  maxSnapS: number,
  hopS: number,
  sampleRate: number,
  outward: "earlier" | "later",
  threshold = 0.5
): number | null {
  const from = Math.max(lo, edge - maxSnapS);
  const to = Math.min(hi, edge + maxSnapS);
  if (to - from < MIN_GAP_S) return null;

  const n = Math.max(2, Math.floor((to - from) / hopS));
  const levels = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    levels[i] = peakBetweenSeconds(
      peaks,
      from + i * hopS,
      from + (i + 1) * hopS,
      sampleRate
    );
  }
  let eMin = Infinity;
  let eMax = 0;
  for (const v of levels) {
    if (v < eMin) eMin = v;
    if (v > eMax) eMax = v;
  }
  // All-quiet: no fragment can be hiding here. Flat-loud: nothing to snap to.
  if (eMax < 0.02 || eMax - eMin < 1e-4) return null;

  const quietThresh = eMin + QUIET_TOLERANCE * (eMax - eMin);

  // Contiguous runs of "quiet" hops, as [startIndex, endIndexExclusive).
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < n; ) {
    if (levels[i] > quietThresh) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && levels[j] <= quietThresh) j++;
    runs.push([i, j]);
    i = j;
  }

  let bestIndices: [number, number] | null = null;
  let bestDistance = Infinity;
  for (const [i, j] of runs) {
    const runStart = from + i * hopS;
    const runEnd = from + j * hopS;
    if (runEnd - runStart < MIN_GAP_S - 1e-4) continue;
    let runMin = Infinity;
    for (let k = i; k < j; k++) if (levels[k] < runMin) runMin = levels[k];
    // Deep trough only: the flat top of speech is not a pause.
    if (runMin >= GAP_DEPTH_RATIO * eMax) continue;
    const center = (runStart + runEnd) / 2;
    const straddles = runStart < edge && runEnd > edge;
    const outwardSide =
      outward === "earlier" ? center < edge : center > edge;
    if (!straddles && !outwardSide) continue;
    const distance = Math.abs(center - edge);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndices = [i, j];
    }
  }
  if (!bestIndices) return null;

  const sharpened = sharpenQuietRun(
    levels,
    from,
    hopS,
    bestIndices[0],
    bestIndices[1],
    eMin,
    eMax,
    edge,
    outward,
    true
  );
  const pStart = Math.max(lo, sharpened.start);
  const pEnd = Math.min(hi, sharpened.end);
  if (pEnd <= pStart) return (pStart + pEnd) / 2;

  const t = clamp01(threshold);
  return outward === "earlier"
    ? pEnd - t * (pEnd - pStart)
    : pStart + t * (pEnd - pStart);
}

/**
 * Look for a short inter-syllable dip (e.g. a 10–25 ms stop closure or voiced
 * transition between back-to-back words) when speech has no full ≥30 ms pause.
 *
 * Requires louder speech peaks on *both* sides of the dip so flat audio and
 * gentle low-frequency modulations never qualify.
 */
function findCoarticulationValley(
  levels: Float32Array,
  from: number,
  hopS: number,
  eMin: number,
  eMax: number,
  edge: number,
  maxSnapS: number,
  outward: "earlier" | "later"
): { start: number; end: number } | null {
  const n = levels.length;
  const radius = Math.min(maxSnapS, VALLEY_SEARCH_S);
  const vFrom = Math.max(from, edge - radius);
  const vTo = Math.min(from + n * hopS, edge + radius);
  const iLo = Math.max(0, Math.floor((vFrom - from) / hopS));
  const iHi = Math.min(n, Math.ceil((vTo - from) / hopS));
  if (iHi - iLo < 1) return null;

  const valleyThresh = eMin + 0.45 * (eMax - eMin);
  const flankRise = 0.2 * (eMax - eMin);
  const flankHops = Math.max(2, Math.round(0.15 / hopS));

  let best: { start: number; end: number } | null = null;
  let bestDistance = Infinity;

  for (let i = iLo; i < iHi; ) {
    if (levels[i] > valleyThresh) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < iHi && levels[j] <= valleyThresh) j++;

    let rMin = Infinity;
    for (let k = i; k < j; k++) if (levels[k] < rMin) rMin = levels[k];

    if (rMin < 0.6 * eMax && i > 0 && j < n) {
      let leftPeak = 0;
      for (let k = Math.max(0, i - flankHops); k < i; k++) {
        if (levels[k] > leftPeak) leftPeak = levels[k];
      }
      let rightPeak = 0;
      for (let k = j; k < Math.min(n, j + flankHops); k++) {
        if (levels[k] > rightPeak) rightPeak = levels[k];
      }
      if (leftPeak >= rMin + flankRise && rightPeak >= rMin + flankRise) {
        const vStart = from + i * hopS;
        const vEnd = from + j * hopS;
        const center = (vStart + vEnd) / 2;
        const straddles = vStart <= edge + hopS && vEnd >= edge - hopS;
        const outwardSide =
          outward === "earlier" ? center <= edge : center >= edge;
        if (straddles || outwardSide) {
          const distance = Math.abs(center - edge);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { start: vStart, end: vEnd };
          }
        }
      }
    }
    i = j;
  }

  return best;
}

/**
 * Place a cut edge *inside the pause next to it*, without ever entering the
 * neighboring word's speech.
 *
 * When `threshold` (`0..1`) is given, `0` places the cut on the deleted-word
 * side of the detected pause (maximum guard for neighboring speech) and `1`
 * moves it across the pause up to the neighboring kept word's speech boundary
 * (swallowing soft onset/offset bleed). When no full pause exists and
 * `threshold > 0`, falls back to a short coarticulation valley or unclaimed
 * inter-word gap if present.
 */
function findSilenceEdge(
  peaks: WaveformPeaks,
  edge: number,
  duration: number,
  maxSnapS: number,
  hopS: number,
  sampleRate: number,
  outward: "earlier" | "later",
  threshold?: number,
  searchBounds?: { lo: number; hi: number },
  neighborBound?: number
): number | null {
  const hardLo = searchBounds ? Math.max(0, searchBounds.lo) : 0;
  const hardHi = searchBounds
    ? searchBounds.hi
    : duration > 0
      ? duration
      : Infinity;
  const from = Math.max(hardLo, edge - maxSnapS);
  const to = Math.min(hardHi, edge + maxSnapS);
  if (to - from < MIN_GAP_S) return null;

  const n = Math.max(2, Math.floor((to - from) / hopS));
  const levels = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    levels[i] = peakBetweenSeconds(
      peaks,
      from + i * hopS,
      from + (i + 1) * hopS,
      sampleRate
    );
  }
  let eMin = Infinity;
  let eMax = 0;
  for (const v of levels) {
    if (v < eMin) eMin = v;
    if (v > eMax) eMax = v;
  }
  // All-quiet: nothing to protect. Flat-loud: no pause to fit into.
  if (eMax < 0.02 || eMax - eMin < 1e-4) return null;

  const quietThresh = eMin + QUIET_TOLERANCE * (eMax - eMin);

  // Contiguous runs of "quiet" hops, as [startIndex, endIndexExclusive).
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < n; ) {
    if (levels[i] > quietThresh) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && levels[j] <= quietThresh) j++;
    runs.push([i, j]);
    i = j;
  }

  // The pause closest to the edge: the one the edge already sits in, else the
  // nearest one on either side (the outward side wins a tie — that is the pause
  // that swallows the deleted word's bleed).
  let bestIndices: [number, number] | null = null;
  let bestDistance = Infinity;
  let bestOutward = false;
  for (const [i, j] of runs) {
    const runStart = from + i * hopS;
    const runEnd = from + j * hopS;
    if (runEnd - runStart < MIN_GAP_S - 1e-4) continue;
    let runMin = Infinity;
    for (let k = i; k < j; k++) if (levels[k] < runMin) runMin = levels[k];
    // Deep trough only: the flat top of speech is not a pause.
    if (runMin >= GAP_DEPTH_RATIO * eMax) continue;
    const distance =
      edge < runStart ? runStart - edge : edge > runEnd ? edge - runEnd : 0;
    const isOutward = outward === "earlier" ? runStart < edge : runEnd > edge;
    if (
      distance < bestDistance - 1e-9 ||
      (Math.abs(distance - bestDistance) <= 1e-9 && isOutward && !bestOutward)
    ) {
      bestDistance = distance;
      bestIndices = [i, j];
      bestOutward = isOutward;
    }
  }

  if (!bestIndices) {
    if (threshold === undefined) return null;
    const t = clamp01(threshold);
    if (t <= 0) return null;

    // Fast / coarticulated speech: look for a short syllable valley first, else
    // bridge any unclaimed inter-word timestamp gap toward the kept neighbor.
    const valley = findCoarticulationValley(
      levels,
      from,
      hopS,
      eMin,
      eMax,
      edge,
      maxSnapS,
      outward
    );
    if (valley) {
      const span = valley.end - valley.start;
      const valleyTarget =
        span > 2 * MIN_FIT_GUARD_S
          ? outward === "earlier"
            ? valley.start + MIN_FIT_GUARD_S
            : valley.end - MIN_FIT_GUARD_S
          : (valley.start + valley.end) / 2;
      const moved =
        outward === "earlier"
          ? Math.min(edge, valleyTarget)
          : Math.max(edge, valleyTarget);
      return Math.min(to, Math.max(from, edge + t * (moved - edge)));
    }

    if (neighborBound !== undefined) {
      if (outward === "earlier") {
        const limit = Math.max(from, neighborBound + MIN_FIT_GUARD_S);
        if (limit < edge) return edge - t * (edge - limit);
      } else {
        const limit = Math.min(to, neighborBound - MIN_FIT_GUARD_S);
        if (limit > edge) return edge + t * (limit - edge);
      }
    }
    return null;
  }

  const best = sharpenQuietRun(
    levels,
    from,
    hopS,
    bestIndices[0],
    bestIndices[1],
    eMin,
    eMax,
    edge,
    outward,
    false
  );

  if (threshold === undefined) {
    // Low-level primitive default: closest point inside the guarded pause.
    const lo = best.start + FIT_GUARD_S;
    const hi = best.end - FIT_GUARD_S;
    const target = lo <= hi ? Math.min(hi, Math.max(lo, edge)) : (lo + hi) / 2;
    return Math.min(to, Math.max(from, target));
  }

  const t = clamp01(threshold);
  const keptGuard =
    MIN_FIT_GUARD_S + (1 - t) * (FIT_GUARD_S - MIN_FIT_GUARD_S);

  let target: number;
  if (outward === "earlier") {
    // Kept word ends at best.start; deleted word begins at best.end.
    const nearKept = best.start + keptGuard;
    const nearDeleted = best.end - FIT_GUARD_S;
    if (nearKept < nearDeleted) {
      target = nearDeleted - t * (nearDeleted - nearKept);
    } else {
      const rawKept = best.start + MIN_FIT_GUARD_S;
      const rawDeleted = best.end - MIN_FIT_GUARD_S;
      target =
        rawKept < rawDeleted
          ? rawDeleted - t * (rawDeleted - rawKept)
          : (best.start + best.end) / 2;
    }
  } else {
    // Deleted word ends at best.start; next kept word begins at best.end.
    const nearDeleted = best.start + FIT_GUARD_S;
    const nearKept = best.end - keptGuard;
    if (nearDeleted < nearKept) {
      target = nearDeleted + t * (nearKept - nearDeleted);
    } else {
      const rawDeleted = best.start + MIN_FIT_GUARD_S;
      const rawKept = best.end - MIN_FIT_GUARD_S;
      target =
        rawDeleted < rawKept
          ? rawDeleted + t * (rawKept - rawDeleted)
          : (best.start + best.end) / 2;
    }
  }

  return Math.min(to, Math.max(from, target));
}

/**
 * Snap a cut range's edges to the audio gaps around them.
 *
 * `range` is the cut as the word bounds give it (a deleted run's first start →
 * last end); in `"gap"` mode `bounds` also clamps how far each edge may reach —
 * `lo` is the previous kept word's end (a cut never eats a kept word's span),
 * `hi` the next kept word's start. In `"fit"` mode the envelope decides where
 * the speech is (`searchBounds`, when supplied, prevents crossing an adjacent
 * kept word's midpoint). Edges never cross each other.
 */
export function snapCutBoundsToAudio(
  peaks: WaveformPeaks,
  range: { start: number; end: number },
  bounds: { lo: number; hi: number },
  {
    maxSnapS = DEFAULT_MAX_SNAP_S,
    hopS = HOP_S,
    sampleRate = CUT_SNAP_SAMPLE_RATE,
    mode = "gap",
    duration = 0,
    startThreshold,
    endThreshold,
    searchBounds,
    neighborBounds,
  }: CutSnapOptions = {}
): { start: number; end: number } {
  if (mode === "bounds") return { start: range.start, end: range.end };

  if (mode === "fit") {
    const rawStart =
      findSilenceEdge(
        peaks,
        range.start,
        duration,
        maxSnapS,
        hopS,
        sampleRate,
        "earlier",
        startThreshold,
        searchBounds,
        neighborBounds?.lo
      ) ?? range.start;
    const rawEnd =
      findSilenceEdge(
        peaks,
        range.end,
        duration,
        maxSnapS,
        hopS,
        sampleRate,
        "later",
        endThreshold,
        searchBounds,
        neighborBounds?.hi
      ) ?? range.end;
    const start = Math.min(rawStart, range.end - MIN_WORD_S);
    const end = Math.max(rawEnd, Math.max(range.start, start) + MIN_WORD_S);
    return { start, end };
  }

  const start = findGapPoint(
    peaks,
    range.start,
    bounds.lo,
    range.end - MIN_WORD_S,
    maxSnapS,
    hopS,
    sampleRate,
    "earlier",
    startThreshold ?? 0.5
  );
  const end = findGapPoint(
    peaks,
    range.end,
    range.start + MIN_WORD_S,
    bounds.hi,
    maxSnapS,
    hopS,
    sampleRate,
    "later",
    endThreshold ?? 0.5
  );
  const resolvedStart = start ?? range.start;
  const resolvedEnd = Math.max(end ?? range.end, resolvedStart + MIN_WORD_S);
  return {
    start: resolvedStart,
    end: resolvedEnd,
  };
}

/**
 * Snap the cut edges of the deleted runs a deletion just produced.
 *
 * `words` is the post-deletion array and `newlyDeletedIds` the words this
 * deletion flipped. Only runs that contain a newly deleted word are touched,
 * and only on edges whose boundary word is itself newly deleted — edges of
 * older runs keep whatever the user (or a previous snap) left there.
 *
 * Returns `words` itself when nothing moved.
 */
export function snapDeletionCutPoints(
  words: Word[],
  newlyDeletedIds: Iterable<number>,
  peaks: WaveformPeaks | null,
  duration: number,
  options?: CutSnapOptions
): Word[] {
  if (!peaks || duration <= 0) return words;
  const newly = new Set(newlyDeletedIds);
  if (newly.size === 0) return words;
  // `fit` measures its search window against the media length.
  const opts: CutSnapOptions = { ...options, duration };

  let out: Word[] | null = null;
  const get = (i: number) => (out ?? words)[i];
  const mutate = (i: number, patch: Partial<Word>) => {
    out ??= words.slice();
    out[i] = { ...out[i], ...patch };
  };

  for (let i = 0; i < words.length; ) {
    if (!words[i].deleted) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < words.length && words[j + 1].deleted) j++;
    // Maximal deleted run = words[i..j]; its neighbors (if any) are kept.
    let touchesNew = false;
    for (let k = i; k <= j; k++) {
      if (newly.has(words[k].id)) {
        touchesNew = true;
        break;
      }
    }
    if (touchesNew) {
      const firstWord = get(i);
      const lastWord = get(j);
      const range = { start: firstWord.start, end: lastWord.end };
      let { start, end } = range;
      if (newly.has(words[i].id)) {
        const prev = i > 0 ? get(i - 1) : null;
        const searchLo = prev
          ? Math.max(prev.start + MIN_WORD_S, (prev.start + prev.end) / 2)
          : 0;
        const searchHi = Math.max(
          firstWord.start + MIN_GAP_S,
          Math.min(lastWord.end - MIN_WORD_S, firstWord.end)
        );
        start = snapCutBoundsToAudio(
          peaks,
          range,
          { lo: prev ? prev.end : 0, hi: lastWord.end },
          {
            ...opts,
            searchBounds: { lo: searchLo, hi: searchHi },
            neighborBounds: { lo: prev ? prev.end : undefined },
          }
        ).start;
      }
      if (newly.has(words[j].id)) {
        const next = j + 1 < words.length ? get(j + 1) : null;
        const searchLo = Math.min(
          lastWord.end - MIN_GAP_S,
          Math.max(firstWord.start + MIN_WORD_S, lastWord.start)
        );
        const searchHi = next
          ? Math.min(next.end - MIN_WORD_S, (next.start + next.end) / 2)
          : duration;
        end = snapCutBoundsToAudio(
          peaks,
          range,
          { lo: firstWord.start, hi: next ? next.start : duration },
          {
            ...opts,
            searchBounds: { lo: searchLo, hi: searchHi },
            neighborBounds: { hi: next ? next.start : undefined },
          }
        ).end;
      }
      if (end - start < MIN_WORD_S) {
        const mid = (start + end) / 2;
        start = Math.max(0, mid - MIN_WORD_S / 2);
        end = Math.min(duration, start + MIN_WORD_S);
      }
      if (start !== firstWord.start) mutate(i, { start });
      if (end !== lastWord.end) mutate(j, { end });
    }
    i = j + 1;
  }
  return out ?? words;
}
