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

console.log("ALL CUT SNAP TESTS PASSED");
