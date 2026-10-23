"use client";

import { useEditorStore } from "@/lib/store";

/**
 * The "Remove silences" gap threshold (seconds).
 *
 * Backed by the editor store so the Tools menu and the player settings can't
 * drift apart; the store seeds it from localStorage and persists every change.
 */
export function useSilenceThreshold() {
  const threshold = useEditorStore((s) => s.silenceThreshold);
  const setThreshold = useEditorStore((s) => s.setSilenceThreshold);
  return { threshold, setThreshold };
}
