/**
 * Export preferences that outlive a session (localStorage, web + desktop).
 * Kept out of lib/exportArgs.ts so that module stays import-free for the
 * Electron main process bundle.
 */

const MICRO_FADES_STORAGE_KEY = "rescript.micro-fades";

/** Read the micro-fades toggle (default on — cuts shouldn't click). */
export function loadMicroFadesPreference(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(MICRO_FADES_STORAGE_KEY);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch {
    // private mode / disabled storage
  }
  return true;
}

/** Persist the micro-fades toggle for the next visit. */
export function saveMicroFadesPreference(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MICRO_FADES_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // private mode / disabled storage
  }
}
