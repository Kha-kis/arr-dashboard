import type { DashboardStatisticsEnvelope } from "@arr/shared";
import { Alert, AlertDescription } from "../ui";

function observedUtc(iso: string): string {
	return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

export function DashboardStatisticsNotice({ state }: { state: DashboardStatisticsEnvelope }) {
	if (state.availability === "current") return null;
	let message: string;
	switch (state.availability) {
		case "collecting":
			message = "Collecting statistics from configured services. Totals are not available yet.";
			break;
		case "unavailable":
			message = "Statistics are unavailable. The dashboard will retry automatically.";
			break;
		case "partial":
			message = `Statistics are partial: unavailable sources are excluded from totals. Observed ${observedUtc(state.observedAt)}.`;
			break;
		case "last-known":
			message = `Showing last-known statistics observed ${observedUtc(state.observedAt)} while refresh is pending.`;
			break;
	}
	return (
		<Alert variant="warning" role="status">
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}
