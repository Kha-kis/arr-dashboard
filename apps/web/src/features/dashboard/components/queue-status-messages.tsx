"use client";

/**
 * Component for rendering queue status messages in a compact format
 */

import { cn } from "../../../lib/utils/index";
import type { StatusLine } from "../lib/queue-utils";
import { summarizeLines } from "../lib/queue-utils";

interface QueueStatusMessagesProps {
  lines: StatusLine[];
}

/**
 * Renders status messages in a compact format, grouping duplicate messages
 */
export const QueueStatusMessages = ({ lines }: QueueStatusMessagesProps) => {
  const summary = summarizeLines(lines);

  if (summary.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2 break-words">
      {summary.map((entry) => (
        <div
          key={entry.key}
          className={cn(
            "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
            entry.tone === "error" &&
              "border-red-500/40 bg-red-500/10 text-red-100",
            entry.tone === "warning" &&
              "border-amber-500/40 bg-amber-500/10 text-amber-50",
            entry.tone === "info" && "border-white/15 bg-white/5 text-white/70",
          )}
        >
          <span className="mt-0.5 inline-block h-1.5 w-1.5 rounded-full bg-white/40" />
          <span className="break-words leading-relaxed">{entry.text}</span>
        </div>
      ))}
    </div>
  );
};
