"use client";

import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "../../../lib/utils";
import { getInfoColor } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

export type MessageTone = "info" | "warning" | "error";

export interface IssueSummary {
	tone: MessageTone;
	count: number;
}

interface QueueIssueBadgeProps {
	summary: IssueSummary[];
	size?: "sm" | "md";
}

/**
 * Premium issue badge with theme-aware styling
 * Uses semantic colors for error/warning, theme colors for info
 */
export const QueueIssueBadge = ({ summary, size = "md" }: QueueIssueBadgeProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const themeInfo = getInfoColor("info", themeGradient);

	const textSize = size === "sm" ? "text-[11px]" : "text-xs";
	const padding = size === "sm" ? "px-2.5 py-1" : "px-3 py-1";
	const iconSize = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

	if (!summary.length) {
		return (
			<span
				className={cn(
					"inline-flex items-center gap-1.5 rounded-full font-medium transition-all duration-300",
					"bg-emerald-500/10 text-emerald-400 border border-emerald-500/20",
					padding,
					textSize
				)}
			>
				<CheckCircle2 className={iconSize} />
				No issues
			</span>
		);
	}

	const total = summary.reduce((acc, item) => acc + item.count, 0);
	const mostSevere = summary.reduce<MessageTone>((current, item) => {
		if (item.tone === "error") return "error";
		if (item.tone === "warning" && current === "info") return "warning";
		return current;
	}, "info");

	// For info severity, use theme colors; for error/warning keep semantic colors
	if (mostSevere === "info") {
		return (
			<span
				className={cn(
					"inline-flex items-center gap-1.5 rounded-full font-medium border transition-all duration-300",
					padding,
					textSize
				)}
				style={{
					backgroundColor: themeInfo.bg,
					borderColor: themeInfo.border,
					color: themeInfo.text,
				}}
			>
				<Info className={iconSize} />
				{total} issue{total === 1 ? "" : "s"}
			</span>
		);
	}

	// Semantic colors for error and warning
	const severityStyles = {
		error: {
			classes: "bg-red-500/10 border-red-500/30 text-red-400 shadow-sm shadow-red-500/10",
		},
		warning: {
			classes: "bg-amber-500/10 border-amber-500/30 text-amber-400",
		},
	};

	const style = severityStyles[mostSevere];

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full font-medium border transition-all duration-300",
				style.classes,
				padding,
				textSize
			)}
		>
			<AlertTriangle className={iconSize} />
			{total} issue{total === 1 ? "" : "s"}
		</span>
	);
};
