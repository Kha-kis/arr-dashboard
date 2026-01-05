"use client";

import type { ServiceInstanceSummary, DiscoverSearchResult } from "@arr/shared";
import { CheckCircle2, WifiOff, Circle } from "lucide-react";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Props for the InstanceBadge component
 */
interface InstanceBadgeProps {
	/** The service instance to display */
	instance: ServiceInstanceSummary;
	/** The search result containing instance states */
	result: DiscoverSearchResult;
}

/**
 * Premium Instance Badge
 *
 * Displays the status of a media item in a service instance with:
 * - Theme-aware styling for "available" state
 * - Semantic colors for "exists" and "offline" states
 * - Icon indicators for each state
 */
export const InstanceBadge: React.FC<InstanceBadgeProps> = ({ instance, result }) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const state = result.instanceStates.find((entry) => entry.instanceId === instance.id);

	// Offline State
	if (!state) {
		return (
			<span
				className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium backdrop-blur-sm"
				style={{
					backgroundColor: "rgba(100, 116, 139, 0.1)",
					border: "1px solid rgba(100, 116, 139, 0.2)",
					color: "rgb(148, 163, 184)",
				}}
			>
				<WifiOff className="h-3 w-3" />
				{instance.label}
				<span className="opacity-60">offline</span>
			</span>
		);
	}

	// Exists in Library State
	if (state.exists) {
		return (
			<span
				className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium backdrop-blur-sm"
				style={{
					backgroundColor: SEMANTIC_COLORS.success.bg,
					border: `1px solid ${SEMANTIC_COLORS.success.border}`,
					color: SEMANTIC_COLORS.success.text,
				}}
			>
				<CheckCircle2 className="h-3 w-3" />
				{instance.label}
			</span>
		);
	}

	// Available State (theme-aware)
	return (
		<span
			className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium backdrop-blur-sm"
			style={{
				backgroundColor: `${themeGradient.from}10`,
				border: `1px solid ${themeGradient.from}25`,
				color: themeGradient.from,
			}}
		>
			<Circle className="h-2.5 w-2.5 fill-current" />
			{instance.label}
			<span className="opacity-70">available</span>
		</span>
	);
};
