"use client";

import { useCallback, useEffect, useRef } from "react";
import { useEditorStore } from "@/lib/store";
import { cutRangeAt, PLAYHEAD_EPSILON_S } from "@/lib/edits";
import { useCutRanges } from "@/hooks/useCutRanges";

/**
 * Owns the <video>/<audio> element and the cut-skipping playback loop.
 * In video mode this is the visual preview; in audio mode it mounts a hidden
 * <audio> so playback still works when the preview panel is omitted.
 */
export default function MediaPreview() {
  const mediaUrl = useEditorStore((s) => s.mediaUrl);
  const mediaKind = useEditorStore((s) => s.mediaKind);
  const setVideoEl = useEditorStore((s) => s.setVideoEl);
  const setDuration = useEditorStore((s) => s.setDuration);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const setCurrentTime = useEditorStore((s) => s.setCurrentTime);
  const cuts = useCutRanges();

  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const isAudio = mediaKind === "audio";
  const cutsRef = useRef(cuts);
  useEffect(() => {
    cutsRef.current = cuts;
  }, [cuts]);

  // Set while *we* dip the volume around a cut skip; never clobber a mute the
  // user (or the browser) asked for.
  const autoMutedRef = useRef(false);

  const refCb = useCallback(
    (el: HTMLMediaElement | null) => {
      mediaRef.current = el;
      setVideoEl(el);
    },
    [setVideoEl]
  );

  // Playback loop: mirror time into the store and skip over cut ranges.
  useEffect(() => {
    let raf = 0;
    let unmuteAt = Infinity;
    const tick = () => {
      const media = mediaRef.current;
      if (media) {
        let t = media.currentTime;
        if (!media.paused) {
          const cut = cutRangeAt(t, cutsRef.current);
          if (cut) {
            // Dip the volume across the splice so the discontinuity doesn't
            // click — the same idea as the export's micro fades. Start the dip
            // just before a cut is reached and hold it past the landing point.
            if (!media.muted) {
              media.muted = true;
              autoMutedRef.current = true;
            }
            const target = cut.end + PLAYHEAD_EPSILON_S;
            if (target >= media.duration - 0.05) {
              media.pause();
              media.currentTime = cut.start;
              t = cut.start;
            } else {
              media.currentTime = target;
              t = target;
            }
            unmuteAt = t + 0.03;
          } else {
            const cutStart = cutsRef.current.find((c) => c.start > t)?.start;
            if (cutStart != null && cutStart - t < 0.045) {
              if (!media.muted) {
                media.muted = true;
                autoMutedRef.current = true;
              }
            } else if (autoMutedRef.current && t >= unmuteAt) {
              media.muted = false;
              autoMutedRef.current = false;
            }
          }
        }
        const prev = useEditorStore.getState().currentTime;
        if (Math.abs(prev - t) > 0.005) setCurrentTime(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setCurrentTime]);

  const togglePlay = useCallback(() => {
    useEditorStore.getState().togglePlayback();
  }, []);

  const handlePlay = useCallback(() => setPlaying(true), [setPlaying]);
  // A paused element can't hold a pending dip; hand the volume back so the
  // next play doesn't start silent.
  const handlePause = useCallback(() => {
    setPlaying(false);
    const media = mediaRef.current;
    if (media && autoMutedRef.current) {
      media.muted = false;
      autoMutedRef.current = false;
    }
  }, [setPlaying]);

  if (!mediaUrl) return null;

  if (isAudio) {
    return (
      <audio
        ref={refCb}
        src={mediaUrl}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onPlay={handlePlay}
        onPause={handlePause}
        className="hidden"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-50/70 p-3 sm:p-4 dark:bg-zinc-950/70">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <video
          ref={refCb}
          src={mediaUrl}
          playsInline
          onClick={togglePlay}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onPlay={handlePlay}
          onPause={handlePause}
          className="max-h-full max-w-full cursor-pointer rounded-sm bg-black shadow-lg shadow-zinc-900/10 dark:shadow-black/40"
        />
      </div>
    </div>
  );
}
