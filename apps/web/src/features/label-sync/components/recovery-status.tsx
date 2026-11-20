import type { LabelSyncRecovery } from "@arr/shared";
import Link from "next/link";

/** Observation is not acknowledgment; unavailable has no counterfeit counters. */
export function RecoveryStatus({ recovery }: { recovery?: LabelSyncRecovery }) {
	if (recovery?.availability === "known" && recovery.state === "clear") return null;
	const known = recovery?.availability === "known" ? recovery : null;
	return (
		<div className="min-w-0 space-y-2 break-words text-xs">
			<p role="status" className="font-medium text-muted-foreground">
				{!known
					? "Recovery status unavailable"
					: known.state === "restored-held"
						? `${known.heldCount} restored operations held`
						: `${known.reconciledCount} restored operations: desired state observed`}
			</p>
			<p className="text-muted-foreground">
				{!known
					? "Recovery evidence could not be checked. Do not assume there are no held operations."
					: known.state === "restored-held"
						? "Verification is read-only. Uncertain writes are not automatically resent. Missing or unavailable evidence keeps the hold."
						: "The desired state was observed read-only. This does not acknowledge the original send."}
			</p>
			{known?.lastCheckAt ? (
				<p className="text-muted-foreground">
					Last observation:{" "}
					<time dateTime={known.lastCheckAt}>{new Date(known.lastCheckAt).toLocaleString()}</time>
				</p>
			) : null}
			{!known || known.state === "restored-held" ? (
				<>
					<p className="text-muted-foreground">
						Editing and deleting require recovery to be clear. Running the rule can still process
						unrelated targets; it does not release held work.
					</p>
					<Link
						href="/settings"
						className="inline-block underline underline-offset-2 focus-visible:outline focus-visible:outline-2"
					>
						Check connection settings
					</Link>
				</>
			) : null}
		</div>
	);
}
