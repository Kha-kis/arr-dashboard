import type { HistorySourceV2 } from "@arr/shared";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";

export const HistorySourceStatus = ({ source }: { readonly source: HistorySourceV2 }) => {
	const [incognito] = useIncognitoMode();
	const instanceName = incognito ? getLinuxInstanceName(source.instanceName) : source.instanceName;
	const availability = source.providerStatus.availability;
	const message =
		availability === "partial"
			? "Coverage is partial."
			: availability === "last-known"
				? "Using last-known retained observations."
				: availability === "unavailable"
					? "No retained observations published."
					: "Available.";
	return (
		<div
			role="status"
			className="min-w-0 flex flex-wrap items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-xs"
		>
			<span className="min-w-0 truncate">{instanceName}</span>
			<span className="text-muted-foreground">{message}</span>
			<span className="text-muted-foreground">{source.retainedObservationCount} retained</span>
		</div>
	);
};
