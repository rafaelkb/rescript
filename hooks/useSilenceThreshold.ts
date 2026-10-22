"use client";

import { useCallback, useState } from "react";
import {
  clampSilenceThreshold,
  loadSilenceThreshold,
  saveSilenceThreshold,
} from "@/lib/silences";

/**
 * The "Remove silences" gap threshold (seconds), persisted across sessions.
 * Safe to read in the initializer because the whole editor tree is client-only
 * (`ssr: false`).
 */
export function useSilenceThreshold() {
  const [threshold, setThresholdState] = useState(() => loadSilenceThreshold());

  const setThreshold = useCallback((next: number) => {
    setThresholdState(saveSilenceThreshold(clampSilenceThreshold(next)));
  }, []);

  return { threshold, setThreshold };
}
