import type { ProviderNativeWatchCoverage } from "@arr/shared";

const reasonCopy = {
	"unit-evidence-incomplete": "Collection or verification units were incomplete.",
	"provider-count-changed": "Provider counts differed between collection and verification.",
	"staging-coverage-incomplete": "Recorded staging coverage was incomplete.",
	"excluded-observations": "Some observations were excluded during collection or verification.",
	"invalid-observations": "Some observations were invalid.",
	"ambiguous-identity": "Some native identities were ambiguous.",
	"duplicate-observations": "Duplicate observations could not be verified.",
	"missing-verification": "Some collected observations had no matching verification.",
	"changed-observations": "Observations changed between collection and verification.",
	"verification-only-observations": "Some observations appeared only during verification.",
	"diagnostics-unavailable": "Detailed reasons are unavailable for some recorded scopes.",
	"coverage-incomplete": "Some watch observations were not verified.",
} as const;

/** Scope-level explanation; row values and freshness retain their own semantics. */
export function NativeWatchCoverageNotice({ coverage }: { coverage: ProviderNativeWatchCoverage }) {
	return (
		<div
			className="space-y-1 rounded-lg border border-border/60 p-3 text-xs text-muted-foreground"
			role="status"
		>
			<p className="font-medium text-foreground">Recorded watch coverage</p>
			{coverage.status === "available" ? (
				<>
					<p>
						{coverage.verifiedScopes} of {coverage.expectedScopes} scopes verified;{" "}
						{coverage.incompleteScopes} incomplete. Recorded at{" "}
						{new Date(coverage.observedAt).toLocaleString()}.
					</p>
					{coverage.reasonCodes.length > 0 ? (
						<ul className="list-inside list-disc">
							{coverage.reasonCodes.map((reason) => (
								<li key={reason}>{reasonCopy[reason]}</li>
							))}
						</ul>
					) : null}
					<p>
						Watch refresh: {coverage.refreshPhase}. These are recorded scope-level reasons, not
						explanations for a particular episode.
					</p>
				</>
			) : (
				<p>
					Recorded watch coverage is unavailable. Existing watch badges retain their own evidence.
				</p>
			)}
			<a className="underline underline-offset-2" href="/pulse">
				View watch refresh in Pulse
			</a>
		</div>
	);
}
