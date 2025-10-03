"use client";

import { AlertTriangle } from "lucide-react";
import { cn } from "../../../lib/utils";

export type MessageTone = "info" | "warning" | "error";

export interface IssueSummary {
  tone: MessageTone;
  count: number;
}

interface QueueIssueBadgeProps {
  summary: IssueSummary[];
  size?: "sm" | "md";
}

const toneClasses: Record<MessageTone, string> = {
  info: "bg-white/10 text-white/70",
  warning: "bg-amber-500/20 text-amber-50",
  error: "bg-red-500/20 text-red-100",
};

export const QueueIssueBadge = ({ summary, size = "md" }: QueueIssueBadgeProps) => {
  if (!summary.length) {
    return <span className="text-xs uppercase tracking-wide text-white/40">No issues</span>;
  }

  const total = summary.reduce((acc, item) => acc + item.count, 0);
  const mostSevere = summary.reduce<MessageTone>((current, item) => {
    if (item.tone === "error") {
      return "error";
    }
    if (item.tone === "warning" && current === "info") {
      return "warning";
    }
    return current;
  }, "info");

  const className = toneClasses[mostSevere];
  const textSize = size === "sm" ? "text-[11px]" : "text-xs";
  const padding = size === "sm" ? "px-2 py-0.5" : "px-2.5 py-0.5";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium",
        padding,
        textSize,
        className,
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      {total} issue{total === 1 ? "" : "s"}
    </span>
  );
};
