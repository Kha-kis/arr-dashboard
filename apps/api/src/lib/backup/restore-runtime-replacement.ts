import { restorePreparedDatabase } from "./backup-database.js";
import type { PreparedRestoreData } from "./backup-restore-preparation.js";
import {
	getRestoreRuntimeReplacementClientContext,
	type RestoreRuntime,
	withRestoreRuntimeReplacement,
} from "./restore-runtime-admission.js";
import { createRuntimeReplacementPrismaClient } from "./restore-runtime-client.js";

export type RestorePublicationOutcome = "committed" | "not-committed" | "unavailable";
export type RestorePublicationResult = Readonly<{
	restoreId: string;
	outcome: RestorePublicationOutcome;
	restartRequired: true;
	reason:
		| null
		| "state-changed"
		| "ownership-unavailable"
		| "closure-unverified"
		| "commit-unknown";
}>;

/** Internal only: public admission/restart handoff is a separate integration. */
export function publishPreparedRestore(args: {
	runtime: RestoreRuntime;
	prepared: PreparedRestoreData;
}): Promise<RestorePublicationResult> {
	let reported: RestorePublicationResult | undefined;
	return withRestoreRuntimeReplacement(args.runtime, args.prepared, async (scope) => {
		const context = getRestoreRuntimeReplacementClientContext(scope);
		const report = (
			outcome: RestorePublicationOutcome,
			reason: RestorePublicationResult["reason"],
		) =>
			(reported = Object.freeze({
				restoreId: context.restoreId,
				outcome,
				restartRequired: true,
				reason,
			}));
		let writer: ReturnType<typeof createRuntimeReplacementPrismaClient> | undefined;
		let acknowledged = false;
		let reason: RestorePublicationResult["reason"] = "commit-unknown";
		try {
			writer = createRuntimeReplacementPrismaClient(scope);
			await restorePreparedDatabase(
				writer.prisma,
				args.prepared,
				context.destinationInstallationId,
				context.commitRequest,
			);
			acknowledged = true;
		} catch {
			// Never replay or decide rollback from a thrown COMMIT/transport result.
			reason = "commit-unknown";
		}
		try {
			await writer?.close();
		} catch {
			// Controller closure must also reject, keeping actual owner exclusion.
			return report("unavailable", "closure-unverified");
		}
		try {
			const outcome = await context.readClosedPublicationOutcome();
			if (outcome === "committed") return report(outcome, null);
			if (!acknowledged) return report(outcome, "state-changed");
		} catch {
			reason = acknowledged ? "ownership-unavailable" : "commit-unknown";
		}
		return report("unavailable", reason);
	}).catch((error: unknown) => {
		// Preserve preflight/pending refusal when no genuine attempt has reported.
		if (!reported) throw error;
		// A finally-close failure must override even a prospective success, but
		// never turn the controller's rejected lifetime into shutdown authority.
		return Object.freeze({
			...reported,
			outcome: "unavailable",
			reason: "closure-unverified",
		});
	});
}
