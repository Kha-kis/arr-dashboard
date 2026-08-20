import type { PlexEvidenceSummary } from "@arr/shared";
import { AlertTriangle, RefreshCw } from "lucide-react";
import {
	getPlexEvidenceFromError,
	isCurrentAuthoritativePlexEvidence,
} from "../../lib/plex-evidence";

export function PlexEvidenceNotice({
	evidence,
	label,
}: {
	evidence?: PlexEvidenceSummary;
	label?: string;
}) {
	const refreshing = evidence?.attemptState === "in_progress";
	const Icon = refreshing ? RefreshCw : AlertTriangle;
	return (
		<div
			role="status"
			className="flex items-start gap-2 border-t border-border/30 bg-muted/10 px-4 py-3 text-sm text-muted-foreground"
		>
			<Icon className={`mt-0.5 h-4 w-4 shrink-0 ${refreshing ? "animate-spin" : ""}`} />
			<div>
				<p className="font-medium text-foreground">
					{refreshing ? "Plex refresh in progress" : "Plex values are unavailable"}
				</p>
				<p className="text-xs">
					{label ? `${label}: ` : ""}
					{refreshing
						? "Current values will return after a complete refresh publishes."
						: "Stored results are not being presented as current values."}
				</p>
			</div>
		</div>
	);
}

export function PlexQueryEvidenceNotice({
	error,
	evidence,
	label,
}: {
	error?: unknown;
	evidence?: PlexEvidenceSummary;
	label?: string;
}) {
	const resolvedEvidence = evidence ?? getPlexEvidenceFromError(error);
	if (!error && (!resolvedEvidence || isCurrentAuthoritativePlexEvidence(resolvedEvidence))) {
		return null;
	}
	return <PlexEvidenceNotice evidence={resolvedEvidence} label={label} />;
}
