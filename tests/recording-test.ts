import {
  formatRecordingTime,
  pickRecorderMimeType,
  recordingFileName,
  recordingMimeType,
  RECORDER_MIME_TYPES,
} from "../lib/recording";

function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  actual   ${a}`);
}

{
  // Preference order: opus-in-webm first, plain webm next, mp4 last resort.
  eq(
    pickRecorderMimeType(() => true),
    RECORDER_MIME_TYPES[0],
    "best container wins"
  );
  eq(
    pickRecorderMimeType((t) => t !== "audio/webm;codecs=opus"),
    "audio/webm",
    "falls through to the next supported container"
  );
  eq(
    pickRecorderMimeType((t) => t === "audio/mp4"),
    "audio/mp4",
    "mp4 as a last resort"
  );
  eq(pickRecorderMimeType(() => false), null, "nothing supported → browser default");
  eq(
    pickRecorderMimeType(() => {
      throw new Error("boom");
    }),
    null,
    "a throwing probe is treated as unsupported"
  );
  console.log("container negotiation: ok");
}

{
  eq(recordingFileName("audio/webm;codecs=opus"), "Recording.webm", "webm name");
  eq(recordingFileName("audio/mp4"), "Recording.m4a", "mp4 name");
  eq(recordingFileName("audio/ogg;codecs=opus"), "Recording.ogg", "ogg name");
  eq(recordingFileName(null), "Recording.webm", "null name");
  eq(recordingFileName("audio/wav"), "Recording.wav", "wav name");
  console.log("file naming: ok");
}

{
  eq(formatRecordingTime(0), "00:00", "zero");
  eq(formatRecordingTime(9.4), "00:09", "floored");
  eq(formatRecordingTime(75), "01:15", "minutes");
  eq(formatRecordingTime(-3), "00:00", "clamped low");
  eq(formatRecordingTime(6000), "99:59", "clamped high");
  console.log("elapsed formatting: ok");
}

{
  eq(
    recordingMimeType("audio/webm;codecs=opus", "audio/ogg"),
    "audio/webm",
    "requested type wins (parameters stripped)"
  );
  eq(recordingMimeType(null, "audio/ogg;codecs=opus"), "audio/ogg", "chunk type");
  eq(recordingMimeType(null, undefined), "audio/webm", "fallback");
  console.log("result mime: ok");
}

console.log("ALL RECORDING TESTS PASSED");
