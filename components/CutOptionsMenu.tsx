"use client";

import { useId, useState } from "react";
import { Scissors } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import type { CutFitMode } from "@/lib/cutSnap";
import type { MessageKey } from "@/lib/i18n";
import {
  CUT_EDGE_THRESHOLD_MAX,
  CUT_EDGE_THRESHOLD_MIN,
  CUT_EDGE_THRESHOLD_STEP,
  CUT_FIT_MODES,
  CUT_SNAP_DISTANCES,
  formatCutEdgeThreshold,
} from "@/lib/playerPrefs";
import Popover, { PopoverContent, PopoverTrigger } from "./Popover";
import { useI18n } from "./I18nProvider";

const CUT_MODE_LABELS: Record<CutFitMode, MessageKey> = {
  fit: "player.cutFit",
  gap: "player.cutGap",
  bounds: "player.cutBounds",
};

const CUT_MODE_HELP: Record<CutFitMode, MessageKey> = {
  fit: "player.cutHelpFit",
  gap: "player.cutHelpGap",
  bounds: "player.cutHelpBounds",
};

/**
 * Word-deletion cut options in the timeline toolbar: cut placement mode,
 * separate start and end thresholds between the deleted word and neighboring
 * kept words, and maximum audio search distance.
 */
export default function CutOptionsMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const startSliderId = useId();
  const endSliderId = useId();

  const cutFitMode = useEditorStore((s) => s.cutFitMode);
  const setCutFitMode = useEditorStore((s) => s.setCutFitMode);
  const cutStartThreshold = useEditorStore((s) => s.cutStartThreshold);
  const setCutStartThreshold = useEditorStore((s) => s.setCutStartThreshold);
  const cutEndThreshold = useEditorStore((s) => s.cutEndThreshold);
  const setCutEndThreshold = useEditorStore((s) => s.setCutEndThreshold);
  const cutSnapDistance = useEditorStore((s) => s.cutSnapDistance);
  const setCutSnapDistance = useEditorStore((s) => s.setCutSnapDistance);

  const audioDisabled = cutFitMode === "bounds";

  return (
    <Popover open={open} onOpenChange={setOpen} placement="top-end" backdrop>
      <div className="relative z-30 shrink-0">
        <PopoverTrigger>
          <button
            type="button"
            aria-label={t("player.cutOptions")}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={panelId}
            title={t("player.cutOptions")}
            onClick={() => setOpen((v) => !v)}
            className="flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Scissors size={13} />
            <span className="hidden xl:inline">{t("player.cutOptionsShort")}</span>
          </button>
        </PopoverTrigger>

        <PopoverContent
          id={panelId}
          role="dialog"
          aria-label={t("player.cutOptions")}
          className="z-40 w-[18.5rem] max-w-[calc(100vw-1rem)] overflow-hidden"
        >
          <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              <Scissors size={12} />
              {t("player.cutPlacement")}
            </p>
            <div
              className="flex flex-col gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
              role="radiogroup"
              aria-label={t("player.cutPlacement")}
            >
              {CUT_FIT_MODES.map((mode) => {
                const selected = mode === cutFitMode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setCutFitMode(mode)}
                    className={`cursor-pointer rounded-md px-2.5 py-1.5 text-left text-[12px] font-medium transition ${
                      selected
                        ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                        : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    {t(CUT_MODE_LABELS[mode])}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              {t(CUT_MODE_HELP[cutFitMode])}
            </p>
          </section>

          <section
            className={`border-b border-zinc-100 px-3 py-2.5 transition-opacity dark:border-zinc-800 ${
              audioDisabled ? "opacity-45" : ""
            }`}
          >
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label
                htmlFor={startSliderId}
                className="text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500"
              >
                {t("player.cutStartThreshold")}
              </label>
              <span className="text-[11px] font-medium tabular-nums text-zinc-600 dark:text-zinc-300">
                {formatCutEdgeThreshold(cutStartThreshold)}
              </span>
            </div>
            <input
              id={startSliderId}
              type="range"
              disabled={audioDisabled}
              min={CUT_EDGE_THRESHOLD_MIN}
              max={CUT_EDGE_THRESHOLD_MAX}
              step={CUT_EDGE_THRESHOLD_STEP}
              value={cutStartThreshold}
              onChange={(e) => setCutStartThreshold(Number(e.target.value))}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-neutral-600 disabled:cursor-not-allowed dark:bg-zinc-700 dark:accent-neutral-400"
            />
            <div className="mt-0.5 flex justify-between text-[9px] text-zinc-400 dark:text-zinc-500">
              <span>{t("player.cutTowardDeleted")}</span>
              <span>{t("player.cutTowardKept")}</span>
            </div>

            <div className="mt-2.5 mb-1 flex items-baseline justify-between gap-2">
              <label
                htmlFor={endSliderId}
                className="text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500"
              >
                {t("player.cutEndThreshold")}
              </label>
              <span className="text-[11px] font-medium tabular-nums text-zinc-600 dark:text-zinc-300">
                {formatCutEdgeThreshold(cutEndThreshold)}
              </span>
            </div>
            <input
              id={endSliderId}
              type="range"
              disabled={audioDisabled}
              min={CUT_EDGE_THRESHOLD_MIN}
              max={CUT_EDGE_THRESHOLD_MAX}
              step={CUT_EDGE_THRESHOLD_STEP}
              value={cutEndThreshold}
              onChange={(e) => setCutEndThreshold(Number(e.target.value))}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-neutral-600 disabled:cursor-not-allowed dark:bg-zinc-700 dark:accent-neutral-400"
            />
            <div className="mt-0.5 flex justify-between text-[9px] text-zinc-400 dark:text-zinc-500">
              <span>{t("player.cutTowardDeleted")}</span>
              <span>{t("player.cutTowardKept")}</span>
            </div>

            <p className="mt-2 text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              {t("player.cutThresholdsHelp")}
            </p>
          </section>

          <section
            className={`px-3 py-2.5 transition-opacity ${
              audioDisabled ? "opacity-45" : ""
            }`}
          >
            <p className="mb-2 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              {t("player.cutDistance")}
            </p>
            <div
              className="grid grid-cols-5 gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
              role="radiogroup"
              aria-label={t("player.cutDistance")}
            >
              {CUT_SNAP_DISTANCES.map((distance) => {
                const selected = distance === cutSnapDistance;
                return (
                  <button
                    key={distance}
                    type="button"
                    role="radio"
                    disabled={audioDisabled}
                    aria-checked={selected}
                    title={`${t("player.cutDistance")}: ±${distance}s`}
                    onClick={() => setCutSnapDistance(distance)}
                    className={`cursor-pointer rounded-md px-1 py-1 text-[11px] font-medium tabular-nums transition disabled:cursor-not-allowed ${
                      selected
                        ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
                        : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                    }`}
                  >
                    {distance}s
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              {t("player.cutDistanceHelp")}
            </p>
          </section>
        </PopoverContent>
      </div>
    </Popover>
  );
}
