"use client";

import { useId, useState } from "react";
import { Gauge, Settings2 } from "lucide-react";
import { useEditorStore } from "@/lib/store";
import { formatPlaybackRate, PLAYBACK_RATES } from "@/lib/playerPrefs";
import { SILENCE_THRESHOLD_MAX, SILENCE_THRESHOLD_MIN } from "@/lib/silences";
import Popover, { PopoverContent, PopoverTrigger } from "./Popover";
import { useI18n } from "./I18nProvider";

/**
 * Miscellaneous player preferences: preview speed, silence threshold, and
 * micro fades. Word-deletion cut options live in their own {@link CutOptionsMenu}
 * beside this trigger in the timeline toolbar.
 */
export default function PlayerSettingsMenu() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const sliderId = useId();

  const playbackRate = useEditorStore((s) => s.playbackRate);
  const setPlaybackRate = useEditorStore((s) => s.setPlaybackRate);
  const silenceThreshold = useEditorStore((s) => s.silenceThreshold);
  const setSilenceThreshold = useEditorStore((s) => s.setSilenceThreshold);
  const microFades = useEditorStore((s) => s.microFades);
  const setMicroFades = useEditorStore((s) => s.setMicroFades);

  return (
    <Popover open={open} onOpenChange={setOpen} placement="top-end" backdrop>
      <div className="relative z-30 shrink-0">
        <PopoverTrigger>
          <button
            type="button"
            aria-label={t("player.settings")}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={panelId}
            title={t("player.settings")}
            onClick={() => setOpen((v) => !v)}
            className={`flex h-7 cursor-pointer items-center justify-center gap-1 rounded-lg px-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${
              playbackRate !== 1 ? "w-auto" : "w-7"
            }`}
          >
            <Settings2 size={14} />
            {playbackRate !== 1 && (
              <span className="text-[10px] font-medium tabular-nums">
                {formatPlaybackRate(playbackRate)}
              </span>
            )}
          </button>
        </PopoverTrigger>

        <PopoverContent
          id={panelId}
          role="dialog"
          aria-label={t("player.settings")}
          className="z-40 w-[16.5rem] overflow-hidden"
        >
          <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500">
              <Gauge size={12} />
              {t("player.speed")}
            </p>
            <div
              className="grid grid-cols-3 gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800"
              role="radiogroup"
              aria-label={t("player.speed")}
            >
              {PLAYBACK_RATES.map((rate) => (
                <RateOption
                  key={rate}
                  rate={rate}
                  selected={rate === playbackRate}
                  onSelect={setPlaybackRate}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              {t("player.speedHelp")}
            </p>
          </section>

          <section className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <label
                htmlFor={sliderId}
                className="text-[11px] font-medium tracking-wide text-zinc-400 dark:text-zinc-500"
              >
                {t("tools.silenceThreshold")}
              </label>
              <span className="text-[11px] font-medium tabular-nums text-zinc-600 dark:text-zinc-300">
                {silenceThreshold.toFixed(1)}s
              </span>
            </div>
            <input
              id={sliderId}
              type="range"
              min={SILENCE_THRESHOLD_MIN}
              max={SILENCE_THRESHOLD_MAX}
              step={0.05}
              value={silenceThreshold}
              onChange={(e) => setSilenceThreshold(Number(e.target.value))}
              // Keep the popover open while dragging the slider.
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-200 accent-neutral-600 dark:bg-zinc-700 dark:accent-neutral-400"
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              {t("tools.silenceThresholdHelp")}
            </p>
          </section>

          <section className="px-3 py-2.5">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={microFades}
                onChange={(e) => setMicroFades(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-zinc-300 accent-transparent dark:border-zinc-600"
              />
              <span>
                <span className="block text-[12px] text-zinc-700 dark:text-zinc-300">
                  {t("export.microFades")}
                </span>
                <span className="mt-0.5 block text-[10px] leading-snug text-zinc-400 dark:text-zinc-500">
                  {t("export.microFadesHelp")}
                </span>
              </span>
            </label>
          </section>
        </PopoverContent>
      </div>
    </Popover>
  );
}

function RateOption({
  rate,
  selected,
  onSelect,
}: {
  rate: number;
  selected: boolean;
  onSelect: (rate: number) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={formatPlaybackRate(rate)}
      onClick={() => onSelect(rate)}
      className={`cursor-pointer rounded-md px-1 py-1 text-[12px] font-medium tabular-nums transition ${
        selected
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50"
          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      }`}
    >
      {formatPlaybackRate(rate)}
    </button>
  );
}
