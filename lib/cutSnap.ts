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
 * Conservative by design: an edge only moves when a pause-like trough (≥30 ms,
 * well below the surrounding speech) is found within `maxSnapS`, and never
 * past a neighboring kept word's own bounds — contiguous speech with no gap to
 * anchor on keeps the ASR bounds untouched rather than guessing.
 *
 * Three placement modes, chosen in the player settings ({@link CutFitMode}):
 *
 * - `"fit"` (default) — the edge is fitted *inside the silence*: it moves to
 *   the nearest pause and stays there, a guard away from the speech on either
 *   side. An edge that overshot into the next word (loose bounds) is pulled
 *   back into the pause; one that sits in the deleted word's tail crosses the
 *   bleed and stops in the pause after it. Word timestamps run tight, which
 *   means trusting the next word's `start` is what eats the beginning of that
 *   word — this mode asks the envelope instead.
 * - `"gap"` — the previous behaviour: snap to the middle of the nearest pause,
 *   bounded by the neighboring words' timestamps.
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

/** A run must dip below this fraction of the window's peak to count as a gap. */
const GAP_DEPTH_RATIO = 0.4;

/** A run is "quiet" up to this fraction of the window's min→max span. */
const QUIET_TOLERANCE = 0.35;

/** Deleted words (and cuts) never collapse below this (seconds). */
const MIN_WORD_S = 0.02;

/**
 * Distance kept from the neighboring speech when fitting a cut inside a pause
 * (seconds). Ten to twenty milliseconds is below the threshold of hearing at a
 * splice and well inside the precision of the envelope, so the cut stops in
 * silence without clipping an onset.
 */
const FIT_GUARD_S = 0.02;

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
 * Locate the gap a cut edge should sit in, as the center of the nearest
 * pause-like trough in `[edge - maxSnapS, edge + maxSnapS] ∩ [lo, hi]`.
 *
 * Candidate troughs are the ones that could delimit the deleted speech: runs
 * whose center is on the outward side of the edge (so the cut grows and
 * leftover fragments are swallowed), plus any run the edge already sits inside
 * (so loose bounds are trimmed back to the gap's middle). A trough on the far
 * side of the edge, inside the speech being deleted, is deliberately not a
 * candidate — snapping there would leave a larger fragment, not remove one.
 *
 * Returns null when no qualifying gap exists (contiguous speech, all-quiet
 * windows, flat energy): the edge then keeps its ASR value.
 */
function findGapCenter(
  peaks: WaveformPeaks,
  edge: number,
  lo: number,
  hi: number,
  maxSnapS: number,
  hopS: number,
  sampleRate: number,
  outward: "earlier" | "later"
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

  let best: number | null = null;
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
    // Outward runs grow the cut (swallow leftover fragments); the run the edge
    // already sits in lets loose bounds be trimmed to its middle. A run wholly
    // on the far side of the edge would grow the fragment instead.
    const straddles = runStart < edge && runEnd > edge;
    const outwardSide =
      outward === "earlier" ? center < edge : center > edge;
    if (!straddles && !outwardSide) continue;
    const distance = Math.abs(center - edge);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = center;
    }
  }
  return best;
}

/**
 * Place a cut edge *inside the pause next to it*, without ever entering the
 * neighboring word's speech.
 *
 * Sounds out the window around the edge and picks the nearest pause-like
 * trough, then moves the edge to its closest point inside that pause — kept
 * {@link FIT_GUARD_S} away from both ends, so neither the word that was deleted
 * nor the word beside it loses an onset or an offset. An edge that already sits
 * in a pause stays where it is; an edge that overshot into speech (loose word
 * bounds) comes back into the silence, which is what makes a deletion stop
 * shaving the beginning of the next word.
 *
 * The answer comes from the envelope, not from the neighboring word's
 * timestamp — that timestamp is the value that runs early on tight ASR bounds
 * and ends up cutting the word's first milliseconds.
 *
 * Returns null when there is no qualifying pause (contiguous speech, or a
 * window with no dynamics): the caller then keeps the ASR bound.
 */
function findSilenceEdge(
  peaks: WaveformPeaks,
  edge: number,
  duration: number,
  maxSnapS: number,
  hopS: number,
  sampleRate: number,
  outward: "earlier" | "later"
): number | null {
  const from = Math.max(0, edge - maxSnapS);
  const to = Math.min(duration > 0 ? duration : Infinity, edge + maxSnapS);
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
  let best: { start: number; end: number } | null = null;
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
      best = { start: runStart, end: runEnd };
      bestOutward = isOutward;
    }
  }
  if (!best) return null;

  // Move the edge to its closest point inside the pause, guarded on both ends.
  const lo = best.start + FIT_GUARD_S;
  const hi = best.end - FIT_GUARD_S;
  const target = lo <= hi ? Math.min(hi, Math.max(lo, edge)) : (lo + hi) / 2;
  return Math.min(to, Math.max(from, target));
}

/**
 * Snap a cut range's edges to the audio gaps around them.
 *
 * `range` is the cut as the word bounds give it (a deleted run's first start →
 * last end); in `"gap"` mode `bounds` also clamps how far each edge may reach —
 * `lo` is the previous kept word's end (a cut never eats a kept word's span),
 * `hi` the next kept word's start. In `"fit"` mode the envelope decides where
 * the speech is and `bounds` is not needed. Edges never cross each other.
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
  }: CutSnapOptions = {}
): { start: number; end: number } {
  if (mode === "bounds") return { start: range.start, end: range.end };

  if (mode === "fit") {
    // Audio decides both edges; the only guarantee kept from the word bounds is
    // that the cut cannot turn inside out.
    const start =
      findSilenceEdge(
        peaks,
        range.start,
        duration,
        maxSnapS,
        hopS,
        sampleRate,
        "earlier"
      ) ?? range.start;
    const end =
      findSilenceEdge(
        peaks,
        range.end,
        duration,
        maxSnapS,
        hopS,
        sampleRate,
        "later"
      ) ?? range.end;
    return {
      start: Math.min(start, range.end - MIN_WORD_S),
      end: Math.max(end, range.start + MIN_WORD_S),
    };
  }

  const start = findGapCenter(
    peaks,
    range.start,
    bounds.lo,
    range.end - MIN_WORD_S,
    maxSnapS,
    hopS,
    sampleRate,
    "earlier"
  );
  const end = findGapCenter(
    peaks,
    range.end,
    range.start + MIN_WORD_S,
    bounds.hi,
    maxSnapS,
    hopS,
    sampleRate,
    "later"
  );
  return {
    start: start ?? range.start,
    end: end ?? range.end,
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
      const range = { start: get(i).start, end: get(j).end };
      let { start, end } = range;
      if (newly.has(words[i].id)) {
        start = snapCutBoundsToAudio(
          peaks,
          range,
          { lo: i > 0 ? get(i - 1).end : 0, hi: get(j).end },
          opts
        ).start;
      }
      if (newly.has(words[j].id)) {
        end = snapCutBoundsToAudio(
          peaks,
          range,
          { lo: get(i).start, hi: j + 1 < words.length ? get(j + 1).start : duration },
          opts
        ).end;
      }
      if (start !== get(i).start) mutate(i, { start });
      if (end !== get(j).end) mutate(j, { end });
    }
    i = j + 1;
  }
  return out ?? words;
}
