"use client";

/**
 * Component for rendering queue status messages in a compact format
 */

import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils";
import { useIncognitoMode, anonymizeStatusMessage } from "../../../lib/incognito";
import type { StatusLine } from "../lib/queue-utils";
import { summarizeLines, type CompactLine } from "../lib/queue-utils";

interface QueueStatusMessagesProps {
	lines: StatusLine[];
}

/** Maximum messages to show before collapsing */
const COLLAPSE_THRESHOLD = 3;

/**
 * Groups similar messages (e.g., "Episode 1x02 was not found...", "Episode 1x03 was not found...")
 * into a single collapsible group
 */
function groupSimilarMessages(summary: CompactLine[]): {
	standalone: CompactLine[];
	groups: { pattern: string; items: CompactLine[]; tone: CompactLine["tone"] }[];
} {
	const standalone: CompactLine[] = [];
	const episodeNotFound: CompactLine[] = [];

	for (const entry of summary) {
		// Group "Episode X was not found in the grabbed release" messages
		if (/^Episode\s+\d+x\d+\s+was not found/i.test(entry.text)) {
			episodeNotFound.push(entry);
		} else {
			standalone.push(entry);
		}
	}

	const groups: { pattern: string; items: CompactLine[]; tone: CompactLine["tone"] }[] = [];

	if (episodeNotFound.length > COLLAPSE_THRESHOLD) {
		// Determine the most severe tone in the group
		const groupTone = episodeNotFound.some((e) => e.tone === "error")
			? "error"
			: episodeNotFound.some((e) => e.tone === "warning")
				? "warning"
				: "info";
		groups.push({
			pattern: "Episodes not found in grabbed release",
			items: episodeNotFound,
			tone: groupTone,
		});
	} else {
		// Not enough to group, show individually
		standalone.push(...episodeNotFound);
	}

	return { standalone, groups };
}

/**
 * Renders status messages in a compact format, grouping duplicate messages
 */
export const QueueStatusMessages = ({ lines }: QueueStatusMessagesProps) => {
	const [incognitoMode] = useIncognitoMode();
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
	const summary = summarizeLines(lines);

	const { standalone, groups } = useMemo(() => groupSimilarMessages(summary), [summary]);

	if (summary.length === 0) {
		return null;
	}

	const toggleGroup = (pattern: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(pattern)) {
				next.delete(pattern);
			} else {
				next.add(pattern);
			}
			return next;
		});
	};

	const renderMessage = (entry: CompactLine) => (
		<div
			key={entry.key}
			className={cn(
				"flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
				entry.tone === "error" && "border-red-500/40 bg-red-500/10 text-red-100",
				entry.tone === "warning" && "border-amber-500/40 bg-amber-500/10 text-amber-50",
				entry.tone === "info" && "border-white/15 bg-white/5 text-white/70",
			)}
		>
			<span className="mt-0.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-white/40" />
			<span className="break-words leading-relaxed">
				{incognitoMode ? anonymizeStatusMessage(entry.text) : entry.text}
			</span>
		</div>
	);

	return (
		<div className="space-y-2 break-words">
			{/* Render standalone messages */}
			{standalone.map(renderMessage)}

			{/* Render collapsible groups */}
			{groups.map((group) => {
				const isExpanded = expandedGroups.has(group.pattern);
				return (
					<div key={group.pattern}>
						<button
							type="button"
							onClick={() => toggleGroup(group.pattern)}
							className={cn(
								"flex w-full items-center gap-2 rounded-md border px-3 py-2 text-xs text-left",
								group.tone === "error" && "border-red-500/40 bg-red-500/10 text-red-100",
								group.tone === "warning" && "border-amber-500/40 bg-amber-500/10 text-amber-50",
								group.tone === "info" && "border-white/15 bg-white/5 text-white/70",
							)}
						>
							{isExpanded ? (
								<ChevronDown className="h-3 w-3 flex-shrink-0" />
							) : (
								<ChevronRight className="h-3 w-3 flex-shrink-0" />
							)}
							<span className="leading-relaxed">
								{group.pattern} ({group.items.length} episodes)
							</span>
						</button>
						{isExpanded && (
							<div className="mt-1 space-y-1 pl-4">
								{group.items.map(renderMessage)}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
};
