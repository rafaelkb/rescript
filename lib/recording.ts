/**
 * Helpers for the upload screen's built-in audio recorder.
 *
 * Recording itself is plain MediaRecorder; everything a unit test can pin
 * lives here — container negotiation (browsers disagree about what they can
 * encode) and the naming/formatting around it.
 */

/** Containers worth trying, best (most editable) first. */
export const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

/**
 * The recorder container to request, or null to let the browser pick its
 * default (which always works, just maybe in a less convenient container).
 */
export function pickRecorderMimeType(
  isTypeSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)
): string | null {
  for (const type of RECORDER_MIME_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // A throwing isTypeSupported means "not this one".
    }
  }
  return null;
}

/**
 * File name for a finished recording, with an extension that matches the
 * container (so the drop zone's type sniffing and the export defaults agree).
 */
export function recordingFileName(mimeType: string | null | undefined): string {
  const type = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  const ext =
    type === "audio/mp4" || type === "audio/m4a"
      ? "m4a"
      : type === "audio/ogg"
        ? "ogg"
        : type === "audio/wav"
          ? "wav"
          : "webm";
  return `Recording.${ext}`;
}

/** Elapsed recording time as `mm:ss` (clamped at 99:59 for the label). */
export function formatRecordingTime(seconds: number): string {
  const total = Math.max(0, Math.min(5999, Math.floor(seconds)));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Which mime the finished Blob actually carries: the recorder's, or whatever
 * chunk type it emitted when the recorder was started without one.
 */
export function recordingMimeType(
  requested: string | null | undefined,
  chunkType: string | undefined
): string {
  const type = (requested || chunkType || "audio/webm").split(";")[0].trim();
  return type || "audio/webm";
}
