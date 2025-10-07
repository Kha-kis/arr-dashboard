"use client";

import type { ServiceInstanceSummary, DiscoverSearchResult } from "@arr/shared";
import { CheckCircle2 } from "lucide-react";

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
 * Displays a badge showing the status of a media item in a service instance.
 * Shows different states: offline, exists (in library), or available.
 *
 * @component
 * @example
 * <InstanceBadge instance={radarrInstance} result={movieResult} />
 */
export const InstanceBadge: React.FC<InstanceBadgeProps> = ({ instance, result }) => {
	const state = result.instanceStates.find((entry) => entry.instanceId === instance.id);

	if (!state) {
		return (
			<span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/60">
				{instance.label}
				<span className="text-white/40">offline</span>
			</span>
		);
	}

	if (state.exists) {
		return (
			<span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
				{instance.label}
				<CheckCircle2 className="h-3 w-3" />
			</span>
		);
	}

	return (
		<span className="inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-xs text-sky-200">
			{instance.label}
			<span className="text-white/70">available</span>
		</span>
	);
};
