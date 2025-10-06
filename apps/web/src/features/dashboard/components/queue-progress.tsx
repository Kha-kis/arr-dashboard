"use client";

import { cn } from "../../../lib/utils";

interface QueueProgressProps {
  value?: number;
  size?: "sm" | "md";
}

export const QueueProgress = ({ value, size = "md" }: QueueProgressProps) => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return <span className="text-white/60">–</span>;
  }

  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const height = size === "sm" ? "h-2" : "h-2.5";

  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          "relative overflow-hidden rounded-full bg-white/10",
          height,
        )}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-sky-500"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs text-white/60">{clamped}%</span>
    </div>
  );
};
