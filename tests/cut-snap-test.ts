/**
 * Cut edges snapped to the audio (lib/cutSnap.ts): when text is deleted, the
 * cut bounds follow the real speech gaps so leftover fragments go with it.
 */
import {
  snapCutBoundsToAudio,
  snapDeletionCutPoints,
} from "../lib/cutSnap";
import type { Word } from "../lib/types";
import { buildWaveformPeaks, type WaveformPeaks } from "../lib/waveform";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function near(a: number, b: number, eps = 0.02, label = ""): void {
  assert(
    Math.abs(a - b) < eps,
    `${label} expected ~${b}, got ${a}`
  );
}

const SR = 16_000;

/** Envelope built from constant-amplitude speech/silence spans. */
function peaksFrom(
  spans: Array<[from: number, to: number, amp: number]>,
  duration: number
): WaveformPeaks {
  const n = Math.round(duration * SR);
  const audio = new Float32Array(n);
  for (const [from, to, amp] of spans) {
    const a = Math.max(0, Math.round(from * SR));
    const b = Math.min(n, Math.round(to * SR));
    audio.fill(amp, a, b);
  }
  return buildWaveformPeaks(audio);
}

function w(
  id: number,
  start: number,
  end: number,
  deleted = false
): Word {
  return { id, text: `w${id}`, start, end, speaker: 0, deleted };
}

{
  // Tight ASR bounds: speech runs past the word timestamps on both sides.
  // Cut edges must grow to the middle of the neighboring gaps.
  const peaks = peaksFrom(
    [
      [1.0, 1.35, 0.8], // kept word 1
      [1.42, 2.05, 0.8], // deleted word's true speech
      [2.15, 2.6, 0.8], // kept word 2
    ],
    3
  );
  const snapped = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 2.0 },
    { lo: 1.35, hi: 2.3 }
  );
  near(snapped.start, 1.385, 0.02, "tight start snaps into leading gap");
  near(snapped.end, 2.1, 0.02, "tight end snaps into trailing gap");
  assert(snapped.start < 1.5 && snapped.end > 2.0, "both edges grow");
  console.log("tight bounds swallow speech bleed: ok");
}

{
  // Loose ASR bounds: the cut already covers silence at both edges. Snap back
  // to the gap centers — still no speech on the kept side is touched.
  const peaks = peaksFrom(
    [
      [1.0, 1.35, 0.8],
      [1.48, 2.05, 0.8],
      [2.15, 2.6, 0.8],
    ],
    3
  );
  const snapped = snapCutBoundsToAudio(
    peaks,
    { start: 1.42, end: 2.12 },
    { lo: 1.35, hi: 2.3 }
  );
  near(snapped.start, 1.415, 0.02, "loose start trims to gap center");
  near(snapped.end, 2.1, 0.02, "loose end trims to gap center");
  console.log("loose bounds trim back to gaps: ok");
}

{
  // Contiguous speech across the cut (no gap to anchor on): trust ASR.
  const n = Math.round(3 * SR);
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    audio[i] = 0.5 + 0.1 * Math.sin((2 * Math.PI * 2 * i) / SR);
  }
  const peaks = buildWaveformPeaks(audio);
  const snapped = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 2.0 },
    { lo: 1.0, hi: 2.5 }
  );
  near(snapped.start, 1.5, 1e-6, "no-gap start unchanged");
  near(snapped.end, 2.0, 1e-6, "no-gap end unchanged");
  console.log("contiguous speech left alone: ok");
}

{
  // A gap farther than maxSnapS away is not an invitation to jump.
  const peaks = peaksFrom(
    [
      [0.0, 1.9, 0.8],
      [2.1, 3.0, 0.8],
    ],
    3
  );
  const snapped = snapCutBoundsToAudio(
    peaks,
    { start: 2.5, end: 2.8 },
    { lo: 0.0, hi: 3.0 }
  );
  near(snapped.start, 2.5, 1e-6, "distant gap ignored (start)");
  near(snapped.end, 2.8, 1e-6, "distant gap ignored (end)");
  console.log("maxSnap window respected: ok");
}

{
  // Snap never crosses a kept word's bounds: the gap between words is the
  // only territory an edge may reach into.
  const peaks = peaksFrom(
    [
      [1.0, 1.55, 0.8], // kept word 1 (speech through 1.55)
      [1.62, 2.05, 0.8], // deleted word
      [2.15, 2.6, 0.8],
    ],
    3
  );
  // ASR says kept word 1 ends at 1.5; its speech (and the gap) start later.
  const snapped = snapCutBoundsToAudio(
    peaks,
    { start: 1.56, end: 2.0 },
    { lo: 1.5, hi: 2.3 }
  );
  assert(snapped.start >= 1.5, `start ${snapped.start} respects lo bound`);
  console.log("kept word bounds are clamped: ok");
}

{
  // snapDeletionCutPoints: only runs containing newly deleted words move, and
  // only on edges owned by newly deleted words.
  const peaks = peaksFrom(
    [
      [1.0, 1.35, 0.8],
      [1.42, 2.05, 0.8],
      [2.15, 2.55, 0.8],
      [2.7, 3.0, 0.8],
    ],
    3.5
  );
  const base: Word[] = [
    w(1, 1.0, 1.35),
    w(2, 1.5, 2.0), // already deleted earlier
    w(3, 2.2, 2.5), // newly deleted now
    w(4, 2.8, 3.0),
  ];
  const words = base.map((x) => ({ ...x }));
  words[1]!.deleted = true;
  words[2]!.deleted = true;

  const out = snapDeletionCutPoints(words, [3], peaks, 3.5);
  near(out[1]!.start, 1.5, 1e-6, "old run edge untouched");
  near(out[2]!.end, 2.625, 0.02, "new run edge snapped");
  assert(out !== words, "a snap produces a new array");
  console.log("only newly deleted edges snap: ok");
}

{
  // No envelope (silent media / pre-decode): pass the words through.
  const words = [w(1, 1.0, 1.5, true), w(2, 2.0, 2.5)];
  const out = snapDeletionCutPoints(words, [1], null, 3);
  assert(out === words, "no waveform returns the input array");
  console.log("missing envelope passthrough: ok");
}

{
  // Interior deletions (filling a hole between deleted words) move no edges.
  const peaks = peaksFrom(
    [
      [1.0, 1.3, 0.8],
      [1.35, 1.8, 0.8],
      [1.85, 2.3, 0.8],
      [2.35, 2.5, 0.8],
      [2.7, 3.0, 0.8],
    ],
    3.5
  );
  const words = [
    w(1, 1.0, 1.3),
    w(2, 1.35, 1.8, true),
    w(3, 1.85, 2.3), // newly deleted: interior of the merged run
    w(4, 2.35, 2.5, true),
    w(5, 2.7, 3.0),
  ];
  const out = snapDeletionCutPoints(words, [3], peaks, 3.5);
  near(out[1]!.start, 1.35, 1e-6, "run start (old) unchanged");
  near(out[3]!.end, 2.5, 1e-6, "run end (old) unchanged");
  console.log("interior deletions leave edges alone: ok");
}

{
  // The complaint this mode fixes: the deleted word's bound runs past the next
  // word's audible onset, so the cut takes the beginning of that word with it.
  // "gap" only ever searches outward, so it cannot pull the edge back. "fit"
  // finds the pause in the envelope and stops before the word starts.
  const peaks = peaksFrom(
    [
      [1.2, 1.85, 0.8], // deleted word's speech
      [2.0, 2.6, 0.8], // next kept word's speech (audible from 2.0)
    ],
    3
  );
  const range = { start: 1.5, end: 2.05 }; // loose end: 50 ms into the next word
  const bounds = { lo: 1.2, hi: 2.1 };
  const gapMode = snapCutBoundsToAudio(peaks, range, bounds, { mode: "gap" });
  const fitMode = snapCutBoundsToAudio(peaks, range, bounds, {
    mode: "fit",
    duration: 3,
  });
  assert(
    gapMode.end > 2.0,
    `gap mode lands inside the next word (${gapMode.end})`
  );
  assert(fitMode.end <= 2.0, `fit mode keeps the next word's start (${fitMode.end})`);
  near(fitMode.end, 1.98, 0.02, "fit end stops just short of the next speech");
  console.log("fit mode protects the next word's beginning: ok");
}

{
  // Loose deletion bounds that already run past the next word's onset: fit mode
  // pulls the edge back into the pause instead of trusting the timestamp.
  const peaks = peaksFrom(
    [
      [1.2, 1.8, 0.8],
      [1.9, 2.6, 0.8],
    ],
    3
  );
  const fit = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 2.1 },
    { lo: 1.2, hi: 2.4 },
    { mode: "fit", duration: 3 }
  );
  near(fit.end, 1.88, 0.02, "fit pulls a loose end back into the pause");
  assert(fit.end < 2.1, "loose end shrinks");
  console.log("fit mode trims loose bounds: ok");
}

{
  // Fit mode still swallows the deleted word's own bleed: it crosses the loud
  // tail, then stops on the far side of the pause, before the next word.
  const peaks = peaksFrom(
    [
      [1.2, 1.98, 0.8], // deleted word, audible past its end timestamp
      [2.1, 2.6, 0.8],
    ],
    3
  );
  const fit = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 1.95 },
    { lo: 1.2, hi: 2.02 },
    { mode: "fit", duration: 3 }
  );
  assert(fit.end > 1.98, `fit end crosses the bleed (${fit.end})`);
  assert(fit.end < 2.1, `fit end stays out of the next word (${fit.end})`);
  near(fit.end, 2.0, 0.02, "fit end lands inside the pause");
  console.log("fit mode fills the pause: ok");
}

{
  // Same for the leading edge: the previous word's audio runs past its
  // timestamp, so the cut starts after the audio stops — not at the timestamp.
  const peaks = peaksFrom(
    [
      [0.6, 1.05, 0.8], // previous kept word, audible until 1.05
      [1.15, 2.0, 0.8], // deleted word
    ],
    3
  );
  const fit = snapCutBoundsToAudio(
    peaks,
    { start: 1.18, end: 1.9 },
    { lo: 1.0, hi: 2.0 },
    { mode: "fit", duration: 3 }
  );
  assert(fit.start >= 1.05, `fit start keeps the previous word (${fit.start})`);
  near(fit.start, 1.13, 0.02, "fit start sits just inside the pause");
  console.log("fit mode protects the previous word's end: ok");
}

{
  // The user's audio-search distance controls how far a cut edge may look for
  // a pause: the short radius misses this one, while the wider radius finds it.
  const peaks = peaksFrom(
    [
      [0.8, 1.35, 0.8],
      [1.42, 2.05, 0.8],
      [2.15, 2.6, 0.8],
    ],
    3
  );
  const nearCut = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 2.0 },
    { lo: 1.35, hi: 2.15 },
    { mode: "fit", duration: 3, maxSnapS: 0.1 }
  );
  const farCut = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 2.0 },
    { lo: 1.35, hi: 2.15 },
    { mode: "fit", duration: 3, maxSnapS: 0.35 }
  );
  near(nearCut.start, 1.5, 1e-6, "short audio-search distance leaves edge");
  assert(farCut.start < 1.5, "wider audio-search distance reaches the pause");
  console.log("audio cut-search distance controls snapping: ok");
}

{
  // Contiguous speech (no pause to fit into): the ASR bounds stand.
  const n = Math.round(3 * SR);
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) audio[i] = 0.5;
  const peaks = buildWaveformPeaks(audio);
  const fit = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 2.0 },
    { lo: 1.0, hi: 2.5 },
    { mode: "fit", duration: 3 }
  );
  near(fit.start, 1.5, 1e-6, "no-pause fit start unchanged");
  near(fit.end, 2.0, 1e-6, "no-pause fit end unchanged");
  console.log("fit mode leaves contiguous speech alone: ok");
}

{
  // "bounds" mode: no analysis at all.
  const peaks = peaksFrom([[1.42, 2.05, 0.8]], 3);
  const out = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 2.0 },
    { lo: 1.35, hi: 2.3 },
    { mode: "bounds" }
  );
  near(out.start, 1.5, 1e-6, "bounds mode start");
  near(out.end, 2.0, 1e-6, "bounds mode end");
  console.log("bounds mode is a passthrough: ok");
}

{
  // The store asks for "fit" by default; the deletion pipeline honours it.
  const peaks = peaksFrom(
    [
      [1.0, 1.35, 0.8],
      [1.42, 2.0, 0.8],
      [2.06, 2.6, 0.8],
    ],
    3.5
  );
  const words = [w(1, 1.0, 1.35), w(2, 1.5, 1.95, true), w(3, 2.05, 2.5)];
  const out = snapDeletionCutPoints(words, [2], peaks, 3.5, { mode: "fit" });
  assert(out[1]!.end < 2.05, `fit deletion end ${out[1]!.end} keeps word 3`);
  assert(out[1]!.end > 1.95, `fit deletion end ${out[1]!.end} crosses the bleed`);
  console.log("deletion snapping honours fit mode: ok");
}

{
  // Start and end thresholds independently slide the cut between the deleted
  // word (0%) and the neighboring kept words (100%).
  const peaks = peaksFrom(
    [
      [0.6, 1.0, 0.8], // previous kept word ends at 1.0
      [1.2, 1.8, 0.8], // deleted word [1.2, 1.8]
      [2.0, 2.5, 0.8], // next kept word starts at 2.0
    ],
    3
  );
  const words0 = [w(1, 0.6, 1.0), w(2, 1.25, 1.75, true), w(3, 2.0, 2.5)];
  const tight = snapDeletionCutPoints(words0, [2], peaks, 3, {
    mode: "fit",
    startThreshold: 0,
    endThreshold: 0,
  });
  const mid = snapDeletionCutPoints(words0, [2], peaks, 3, {
    mode: "fit",
    startThreshold: 0.5,
    endThreshold: 0.5,
  });
  const wide = snapDeletionCutPoints(words0, [2], peaks, 3, {
    mode: "fit",
    startThreshold: 1,
    endThreshold: 1,
  });
  assert(
    wide[1]!.start < mid[1]!.start && mid[1]!.start < tight[1]!.start,
    `start moves monotonically toward kept word: ${wide[1]!.start} < ${mid[1]!.start} < ${tight[1]!.start}`
  );
  assert(
    tight[1]!.end < mid[1]!.end && mid[1]!.end < wide[1]!.end,
    `end moves monotonically toward kept word: ${tight[1]!.end} < ${mid[1]!.end} < ${wide[1]!.end}`
  );
  assert(wide[1]!.start > 1.0, `100% start still keeps word 1 (${wide[1]!.start})`);
  assert(wide[1]!.end < 2.0, `100% end still keeps word 3 (${wide[1]!.end})`);

  // Asymmetric thresholds: start at 100%, end at 0%.
  const asym = snapDeletionCutPoints(words0, [2], peaks, 3, {
    mode: "fit",
    startThreshold: 1,
    endThreshold: 0,
  });
  near(asym[1]!.start, wide[1]!.start, 1e-6, "asymmetric start matches 100%");
  near(asym[1]!.end, tight[1]!.end, 1e-6, "asymmetric end matches 0%");
  console.log("start and end thresholds adjust cuts independently: ok");
}

{
  // Soft fricative onset/offset (/s/, /f/, /h/ around 20% of vowel peak) next
  // to true silence: inner-core sharpening excludes the consonant from the
  // pause so no speech sound is left behind at either cut edge.
  const peaks = peaksFrom(
    [
      [0.6, 1.0, 0.8], // kept word 1
      [1.0, 1.08, 0.01], // true room silence before deleted word
      [1.08, 1.2, 0.18], // deleted word's quiet /s/ onset
      [1.2, 1.75, 0.8], // deleted word's loud vowel
      [1.75, 1.88, 0.18], // deleted word's quiet /s/ release
      [1.88, 1.98, 0.01], // true room silence after deleted word
      [1.98, 2.5, 0.8], // kept word 3
    ],
    3
  );
  const words = [w(1, 0.6, 1.0), w(2, 1.18, 1.77, true), w(3, 1.98, 2.5)];
  const out = snapDeletionCutPoints(words, [2], peaks, 3, {
    mode: "fit",
    startThreshold: 0.5,
    endThreshold: 0.5,
  });
  assert(
    out[1]!.start < 1.08,
    `cut start ${out[1]!.start} swallows quiet /s/ onset at 1.08`
  );
  assert(
    out[1]!.start > 1.0,
    `cut start ${out[1]!.start} stays after kept word 1`
  );
  assert(
    out[1]!.end > 1.88,
    `cut end ${out[1]!.end} swallows quiet /s/ tail ending at 1.88`
  );
  assert(
    out[1]!.end < 1.98,
    `cut end ${out[1]!.end} stops before kept word 3`
  );
  console.log("soft consonant onsets and tails are swallowed cleanly: ok");
}

{
  // Fast coarticulated speech with a brief 20 ms stop-closure valley (< 30 ms)
  // between touching words: positive thresholds pull the cut into the valley.
  const peaks = peaksFrom(
    [
      [0.8, 1.18, 0.8], // kept word 1's vowel
      [1.18, 1.2, 0.08], // 20 ms stop closure between words
      [1.2, 1.7, 0.8], // deleted word's speech (CTC split landed late at 1.24)
      [1.8, 2.3, 0.8], // kept word 3
    ],
    3
  );
  const words = [w(1, 0.8, 1.24), w(2, 1.24, 1.7, true), w(3, 1.8, 2.3)];
  const out = snapDeletionCutPoints(words, [2], peaks, 3, {
    mode: "fit",
    startThreshold: 1,
    endThreshold: 0.5,
  });
  assert(
    out[1]!.start <= 1.2,
    `coarticulated start ${out[1]!.start} reaches the stop-closure valley`
  );
  assert(
    out[1]!.start >= 1.18,
    `coarticulated start ${out[1]!.start} does not eat word 1`
  );
  console.log("coarticulated stop-closure valley is respected: ok");
}

{
  // Short kept neighbor word ("I" = 150 ms) after an earlier pause, followed
  // immediately by a deleted word with no pause between them: snapping must
  // never jump over the kept word into the pause before it.
  const peaks = peaksFrom(
    [
      [0.5, 1.0, 0.8],
      [1.0, 1.2, 0.0], // pause BEFORE kept word "I"
      [1.2, 1.8, 0.8], // "I" [1.2, 1.35] + deleted word [1.35, 1.8] contiguous
      [1.9, 2.4, 0.8],
    ],
    3
  );
  const words = [
    w(1, 0.5, 1.0),
    w(2, 1.2, 1.35), // short kept word "I"
    w(3, 1.35, 1.8, true), // deleted word
    w(4, 1.9, 2.4),
  ];
  const out = snapDeletionCutPoints(words, [3], peaks, 3, {
    mode: "fit",
    maxSnapS: 0.75,
    startThreshold: 1,
    endThreshold: 0.5,
  });
  assert(
    out[2]!.start >= 1.275,
    `cut start ${out[2]!.start} never jumps across short kept word [1.2, 1.35]`
  );
  console.log("short neighboring kept words are never jumped across: ok");
}

{
  // "gap" mode also honours startThreshold and endThreshold across the gap.
  const peaks = peaksFrom(
    [
      [1.0, 1.35, 0.8],
      [1.5, 2.0, 0.8],
      [2.15, 2.6, 0.8],
    ],
    3
  );
  const gapLow = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 2.0 },
    { lo: 1.35, hi: 2.15 },
    { mode: "gap", startThreshold: 0.2, endThreshold: 0.2 }
  );
  const gapHigh = snapCutBoundsToAudio(
    peaks,
    { start: 1.5, end: 2.0 },
    { lo: 1.35, hi: 2.15 },
    { mode: "gap", startThreshold: 0.8, endThreshold: 0.8 }
  );
  assert(gapHigh.start < gapLow.start, "gap mode start follows threshold");
  assert(gapHigh.end > gapLow.end, "gap mode end follows threshold");
  console.log("gap mode honours start and end thresholds: ok");
}

console.log("ALL CUT SNAP TESTS PASSED");
