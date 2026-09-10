import type { PlexEvidenceSummary } from "@arr/shared";
import { AlertTriangle, RefreshCw } from "lucide-react";
import {
	getPlexEvidenceFromError,
	isCurrentAuthoritativePlexEvidence,
} from "../../lib/plex-evidence";

export function PlexEvidenceNotice({
	evidence,
	label,
	hasDisplayedValues = false,
}: {
	evidence?: PlexEvidenceSummary;
	label?: string;
	hasDisplayedValues?: boolean;
}) {
	const refreshing = evidence?.attemptState === "in_progress";
	const partial =
		evidence?.publicationLevel === "positive-only" || evidence?.completeness === "partial";
	const lastKnown = evidence?.availability === "last-known";
	const degradedCoverage = hasDisplayedValues && evidence?.availability === "unavailable";
	const Icon = refreshing ? RefreshCw : AlertTriangle;
	const title = refreshing
		? "Plex refresh in progress"
		: lastKnown
			? "Showing last-known Plex values"
			: partial
				? "Plex values are incomplete"
				: degradedCoverage
					? "Plex coverage is degraded"
					: "Plex values are unavailable";
	const description = refreshing
		? lastKnown && hasDisplayedValues
			? "Showing last-known Plex values while refresh is in progress; omitted rows remain unknown."
			: "Current values will return after a complete refresh publishes."
		: partial || lastKnown || degradedCoverage
			? hasDisplayedValues
				? "Confirmed Plex rows are shown; omitted rows remain unknown."
				: "No Plex rows are being shown; absence remains unknown."
			: "Stored results are not being presented as current values.";
	return (
		<div
			role="status"
			className="flex items-start gap-2 border-t border-border/30 bg-muted/10 px-4 py-3 text-sm text-muted-foreground"
		>
			<Icon className={`mt-0.5 h-4 w-4 shrink-0 ${refreshing ? "animate-spin" : ""}`} />
			<div>
				<p className="font-medium text-foreground">{title}</p>
				<p className="text-xs">
					{label ? `${label}: ` : ""}
					{description}
				</p>
			</div>
		</div>
	);
}

export function PlexQueryEvidenceNotice({
	error,
	evidence,
	label,
	hasDisplayedValues = false,
}: {
	error?: unknown;
	evidence?: PlexEvidenceSummary;
	label?: string;
	hasDisplayedValues?: boolean;
}) {
	const resolvedEvidence = evidence ?? getPlexEvidenceFromError(error);
	if (!error && (!resolvedEvidence || isCurrentAuthoritativePlexEvidence(resolvedEvidence))) {
		return null;
	}
	return (
		<PlexEvidenceNotice
			evidence={resolvedEvidence}
			label={label}
			hasDisplayedValues={hasDisplayedValues}
		/>
	);
}
