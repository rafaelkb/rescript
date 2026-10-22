/**
 * Cut-point refinement against the audio, applied when text is deleted.
 *
 * Word timestamps are only estimates: ASR routinely clips a word's bounds
 * tight, so cutting exactly at `[word.start, word.end]` leaves fragments of the
 * deleted speech audible at the cut edges (or, when the bounds run loose,
 * swallows silence that did not need to go). The decoded PCM is long gone by
 * edit time (the store keeps only the min/max envelope, see lib/waveform.ts),
 * but that envelope is enough: real pauses read as deep, wide troughs next to
 * speech. Each cut edge is therefore snapped to the center of the nearby gap —
 * the "exact" cut point — which removes the leftover fragments and trims the
 * cut back when the bounds were loose.
 *
 * Conservative by design: an edge only moves when a pause-like trough (≥30 ms,
 * well below the surrounding speech) is found within `maxSnapS`, and never
 * past a neighboring kept word's own bounds — contiguous speech with no gap to
 * anchor on keeps the ASR bounds untouched rather than guessing.
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

export interface CutSnapOptions {
  /** Widest an edge may move (seconds). Default {@link DEFAULT_MAX_SNAP_S}. */
  maxSnapS?: number;
  /** Envelope analysis hop (seconds). Default 0.01. */
  hopS?: number;
  /** Sample rate the envelope was built at. Default 16 kHz. */
  sampleRate?: number;
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
 * Snap a cut range's edges to the audio gaps around them.
 *
 * `range` is the cut as the word bounds give it (a deleted run's first start →
 * last end); `bounds` clamps how far each edge may reach — `lo` is the previous
 * kept word's end (a cut never eats a kept word's span), `hi` the next kept
 * word's start. Edges never cross each other.
 */
export function snapCutBoundsToAudio(
  peaks: WaveformPeaks,
  range: { start: number; end: number },
  bounds: { lo: number; hi: number },
  { maxSnapS = DEFAULT_MAX_SNAP_S, hopS = HOP_S, sampleRate = CUT_SNAP_SAMPLE_RATE }: CutSnapOptions = {}
): { start: number; end: number } {
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
          options
        ).start;
      }
      if (newly.has(words[j].id)) {
        end = snapCutBoundsToAudio(
          peaks,
          range,
          { lo: get(i).start, hi: j + 1 < words.length ? get(j + 1).start : duration },
          options
        ).end;
      }
      if (start !== get(i).start) mutate(i, { start });
      if (end !== get(j).end) mutate(j, { end });
    }
    i = j + 1;
  }
  return out ?? words;
}
