"use client";

/**
 * Component for rendering queue status messages in a compact format
 * Features graduated severity styling with smooth transitions
 */

import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, AlertCircle, AlertTriangle, Info } from "lucide-react";
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

	const toneStyles = {
		error: {
			container: "border-red-500/30 bg-red-500/10 text-red-300",
			icon: AlertCircle,
			iconClass: "text-red-400",
		},
		warning: {
			container: "border-amber-500/30 bg-amber-500/10 text-amber-300",
			icon: AlertTriangle,
			iconClass: "text-amber-400",
		},
		info: {
			container: "border-border/30 bg-muted/20 text-muted-foreground",
			icon: Info,
			iconClass: "text-muted-foreground",
		},
	};

	const renderMessage = (entry: CompactLine, index?: number) => {
		const style = toneStyles[entry.tone];
		const Icon = style.icon;
		return (
			<div
				key={entry.key}
				className={cn(
					"group flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs transition-all duration-300",
					"hover:shadow-sm",
					style.container,
				)}
				style={{
					animationDelay: index !== undefined ? `${index * 50}ms` : undefined,
					animationFillMode: "backwards",
				}}
			>
				<Icon className={cn("mt-0.5 h-3.5 w-3.5 flex-shrink-0 transition-transform duration-300 group-hover:scale-110", style.iconClass)} />
				<span className="break-words leading-relaxed">
					{incognitoMode ? anonymizeStatusMessage(entry.text) : entry.text}
				</span>
			</div>
		);
	};

	return (
		<div className="space-y-2 break-words">
			{/* Render standalone messages with staggered animation */}
			{standalone.map((entry, index) => renderMessage(entry, index))}

			{/* Render collapsible groups */}
			{groups.map((group) => {
				const isExpanded = expandedGroups.has(group.pattern);
				const style = toneStyles[group.tone];
				const Icon = style.icon;
				return (
					<div key={group.pattern} className="animate-in fade-in slide-in-from-top-1 duration-300">
						<button
							type="button"
							onClick={() => toggleGroup(group.pattern)}
							className={cn(
								"group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-xs text-left transition-all duration-300",
								"hover:shadow-sm",
								style.container,
							)}
						>
							<Icon className={cn("h-3.5 w-3.5 flex-shrink-0", style.iconClass)} />
							<span className="flex-1 leading-relaxed font-medium">
								{group.pattern}
							</span>
							<span className="rounded-full bg-black/20 px-2 py-0.5 text-[10px] font-medium">
								{group.items.length} episodes
							</span>
							<div className={cn("transition-transform duration-200", isExpanded && "rotate-180")}>
								<ChevronDown className="h-3.5 w-3.5" />
							</div>
						</button>
						{isExpanded && (
							<div className="mt-2 space-y-1.5 pl-6 animate-in fade-in slide-in-from-top-2 duration-200">
								{group.items.map((item, index) => renderMessage(item, index))}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
};
