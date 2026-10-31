interface SeerrEnrichmentNoticeProps {
	configured: boolean;
	isError: boolean;
	issueCountsAvailable?: boolean;
	enrichmentFailures?: number;
}

/** Keep partial Seerr reads visible without suppressing verified Library rows. */
export function SeerrEnrichmentNotice({
	configured,
	isError,
	issueCountsAvailable,
	enrichmentFailures,
}: SeerrEnrichmentNoticeProps) {
	if (!configured) return null;
	if (!isError && issueCountsAvailable !== false && !enrichmentFailures) return null;

	return (
		<div
			role="status"
			className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300"
		>
			{isError ? (
				"Seerr Library enrichment unavailable"
			) : (
				<>
					Seerr Library enrichment incomplete
					{issueCountsAvailable === false ? "; issue counts unavailable" : ""}
					{enrichmentFailures ? `; ${enrichmentFailures} media lookups unavailable` : ""}
				</>
			)}
		</div>
	);
}
