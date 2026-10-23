"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Mic, Square, X } from "lucide-react";
import {
  formatRecordingTime,
  pickRecorderMimeType,
  recordingFileName,
  recordingMimeType,
} from "@/lib/recording";
import { useI18n } from "./I18nProvider";
import type { MessageKey } from "@/lib/i18n";

type RecordErrorKey = Extract<
  MessageKey,
  "upload.recordUnsupported" | "upload.recordPermission" | "upload.recordError"
>;

/**
 * Built-in audio recorder for the upload screen: pick a microphone, record
 * with MediaRecorder, and hand the finished clip to the same pipeline a
 * dropped file takes. Stopping loads the recording straight into the editor;
 * Discard throws it away.
 */
export default function RecordAudio({
  onFile,
  disabled,
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<RecordErrorKey | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const requestedMimeRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const levelRafRef = useRef(0);
  const levelElRef = useRef<HTMLDivElement | null>(null);

  const stopMeter = useCallback(() => {
    cancelAnimationFrame(levelRafRef.current);
    levelRafRef.current = 0;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    if (levelElRef.current) levelElRef.current.style.width = "0%";
  }, []);

  /** Release the mic and any recording machinery without producing a file. */
  const cleanup = useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    stopMeter();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setRecording(false);
    setElapsed(0);
  }, [stopMeter]);

  useEffect(() => cleanup, [cleanup]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === "audioinput");
      setDevices(inputs);
      setDeviceId((prev) =>
        prev && inputs.some((d) => d.deviceId === prev)
          ? prev
          : (inputs[0]?.deviceId ?? "")
      );
    } catch {
      // Device listing is a nicety; recording can proceed with the default.
    }
  }, []);

  const openPanel = useCallback(() => {
    setOpen(true);
    setError(null);
    void refreshDevices();
  }, [refreshDevices]);

  const closePanel = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      discardRef.current = true;
      recorderRef.current.stop();
    }
    cleanup();
    setOpen(false);
    setError(null);
  }, [cleanup]);

  const startMeter = useCallback((stream: MediaStream) => {
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const v = (samples[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / samples.length);
        const level = Math.min(1, rms * 3);
        if (levelElRef.current) {
          levelElRef.current.style.width = `${Math.round(level * 100)}%`;
        }
        levelRafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // No meter is no reason to block recording.
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("upload.recordUnsupported");
      return;
    }
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
      streamRef.current = stream;
      // Permission granted → device labels populate; show the real names.
      void refreshDevices();

      const mimeType = pickRecorderMimeType();
      requestedMimeRef.current = mimeType;
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );
      recorderRef.current = recorder;
      chunksRef.current = [];
      discardRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        const discarded = discardRef.current;
        const type = recordingMimeType(
          requestedMimeRef.current,
          chunks[0]?.type
        );
        cleanup();
        if (discarded || chunks.length === 0) return;
        const file = new File(chunks, recordingFileName(type), { type });
        setOpen(false);
        onFile(file);
      };

      recorder.start(250);
      startedAtRef.current = Date.now();
      setElapsed(0);
      setRecording(true);
      timerRef.current = setInterval(() => {
        setElapsed((Date.now() - startedAtRef.current) / 1000);
      }, 200);
      startMeter(stream);
    } catch (err) {
      cleanup();
      const name = err instanceof Error ? err.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "upload.recordPermission"
          : "upload.recordError"
      );
    }
  }, [cleanup, deviceId, onFile, refreshDevices, startMeter]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  const discard = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      discardRef.current = true;
      recorderRef.current.stop();
    } else {
      cleanup();
    }
    setOpen(false);
    setError(null);
  }, [cleanup]);

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={openPanel}
        title={t("upload.recordTitle")}
        className="mx-auto mt-3 flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-default disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <Mic size={13} />
        {t("upload.recordAudio")}
      </button>
    );
  }

  return (
    <div className="mx-auto mt-3 w-full max-w-sm rounded-xl border border-zinc-200 bg-white/90 p-3 text-left dark:border-zinc-700 dark:bg-zinc-900/90">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
          <Mic size={14} className="text-zinc-400 dark:text-zinc-500" />
          {t("upload.recordTitle")}
        </p>
        {!recording && (
          <button
            type="button"
            aria-label={t("upload.recordCancel")}
            onClick={closePanel}
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={13} />
          </button>
        )}
      </div>

      <label className="mb-2 block">
        <span className="mb-1 block text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
          {t("upload.recordMic")}
        </span>
        <select
          value={deviceId}
          disabled={recording}
          onChange={(e) => setDeviceId(e.target.value)}
          className="h-8 w-full appearance-none rounded-lg border border-zinc-200 bg-white px-2 text-xs text-zinc-700 outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        >
          {devices.length === 0 && (
            <option value="">{t("upload.recordDefaultMic")}</option>
          )}
          {devices.map((device, i) => (
            <option key={device.deviceId || i} value={device.deviceId}>
              {device.label ||
                `${t("upload.recordMic")} ${i + 1}`}
            </option>
          ))}
        </select>
      </label>

      <div className="mb-2.5 flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            recording
              ? "animate-pulse bg-red-500"
              : "bg-zinc-300 dark:bg-zinc-600"
          }`}
        />
        <span className="w-10 shrink-0 text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-300">
          {formatRecordingTime(elapsed)}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            ref={levelElRef}
            className="h-full w-0 rounded-full bg-neutral-500 transition-[width] duration-75 dark:bg-neutral-400"
          />
        </div>
      </div>

      {error && (
        <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-2 text-xs leading-relaxed text-red-700 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle size={13} className="mt-px shrink-0" />
          {t(error)}
        </p>
      )}

      <div className="flex items-center gap-2">
        {recording ? (
          <>
            <button
              type="button"
              onClick={stop}
              className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-zinc-900 text-xs font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
            >
              <Square size={11} fill="currentColor" />
              {t("upload.recordStop")}
            </button>
            <button
              type="button"
              onClick={discard}
              className="flex h-8 cursor-pointer items-center justify-center rounded-lg px-3 text-xs text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              {t("upload.recordDiscard")}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-zinc-900 text-xs font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            <Mic size={12} />
            {t("upload.recordStart")}
          </button>
        )}
      </div>
    </div>
  );
}
