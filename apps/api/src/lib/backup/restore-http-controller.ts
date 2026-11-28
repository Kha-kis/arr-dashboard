import { restoreBackupResponseSchema, type RestoreBackupResponse } from "@arr/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { BackupCompatibilityError } from "../errors.js";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
} from "../library-cleanup/cleanup-maintenance-gate.js";
import { assertPreparedRestorePublication } from "./backup-database.js";
import {
	RestorePreparationError,
	type PreparedRestoreData,
	type RestoreDestinationContext,
} from "./backup-restore-preparation.js";
import { BackupPasswordConfigurationError } from "./backup-service.js";
import type { RestoreRuntime } from "./restore-runtime-admission.js";
import { publishPreparedRestore } from "./restore-runtime-replacement.js";
import { readRestoreRuntimeControl } from "./restore-runtime-repository.js";

export type RestoreHttpRejectionCategory =
	| "unauthorized"
	| "restore-busy"
	| "invalid-backup"
	| "destination-unavailable"
	| "maintenance-conflict"
	| "publication-unconfirmed";

/** Bounded operator error; never carries envelope, identity, key or native error. */
export class RestoreHttpRejectionError extends Error {
	constructor(
		readonly statusCode: 400 | 401 | 409 | 503,
		readonly category: RestoreHttpRejectionCategory,
	) {
		super("Restore request could not be completed.");
		this.name = "RestoreHttpRejectionError";
	}
}

// Resource singleflight only. Native ownership and prepared-value authority are
// established independently by the existing exclusive publisher.
const activeControllers = new WeakSet<RestoreRuntime>();

/** Call only from a protected, HTTP-tracked route without an ordinary handler ticket. */
export async function runRestoreHttpController(
	app: FastifyInstance,
	request: FastifyRequest,
	prepare: (destination: RestoreDestinationContext) => Promise<PreparedRestoreData>,
): Promise<RestoreBackupResponse> {
	const userId = request.currentUser?.id;
	if (!userId) throw new RestoreHttpRejectionError(401, "unauthorized");
	const runtime = app.restoreRuntime;
	if (activeControllers.has(runtime)) throw new RestoreHttpRejectionError(409, "restore-busy");
	activeControllers.add(runtime);
	let publicationEntered = false;
	try {
		if (!app.secretsSynchronized)
			throw new RestoreHttpRejectionError(503, "destination-unavailable");
		const prepared = await runtime.runOperation(async () => {
			const record = await readRestoreRuntimeControl(app.prisma);
			if (record.phase !== "running" || !record.destinationInstallationId)
				throw new RestoreHttpRejectionError(503, "destination-unavailable");
			const destination: RestoreDestinationContext = {
				encryptor: app.encryptor,
				installationId: record.destinationInstallationId,
				stableForRestart: app.secretsSynchronized,
			};
			const value = await prepare(destination);
			assertPreparedRestorePublication(value, destination.installationId);
			return value;
		});

		// The initial preHandler identity may have expired or been revoked while
		// decrypting. Finish this real validation ticket before native reservation.
		const authorized = await runtime.runIndependentOperation(() =>
			app.sessionService.validateRequest(request),
		);
		if (!authorized || authorized.session.user.id !== userId)
			throw new RestoreHttpRejectionError(401, "unauthorized");

		const publication = await withCleanupMaintenanceGuard(async () => {
			publicationEntered = true;
			return publishPreparedRestore({ runtime, prepared });
		});
		let response = restoreBackupResponseSchema.parse({
			...publication,
			success: publication.outcome === "committed",
			restart: "manual-required",
		});
		if (response.outcome !== "unavailable" && app.lifecycle.isRestartRequired()) {
			try {
				// Request after actual joined publication, before replying. Socket
				// delivery is not authority and cannot cancel this handoff.
				if (await app.lifecycle.restart("backup-restore")) {
					response = restoreBackupResponseSchema.parse({
						...response,
						restart: "automatic-requested",
					});
				}
			} catch {
				request.log.warn(
					{ category: "restart-request-unavailable" },
					"Restore requires manual runtime recovery",
				);
			}
		}
		return response;
	} catch (error) {
		// No genuine publisher result means no server attempt ID or proof of
		// rollback. Once reservation may have begun, only recovery is honest.
		if (publicationEntered) throw new RestoreHttpRejectionError(503, "publication-unconfirmed");
		if (error instanceof RestoreHttpRejectionError) throw error;
		if (error instanceof CleanupMaintenanceConflictError)
			throw new RestoreHttpRejectionError(409, "maintenance-conflict");
		if (error instanceof RestorePreparationError)
			throw new RestoreHttpRejectionError(
				error.category === "destination-unavailable" ? 503 : 400,
				error.category === "destination-unavailable" ? "destination-unavailable" : "invalid-backup",
			);
		if (error instanceof BackupPasswordConfigurationError)
			throw new RestoreHttpRejectionError(400, "invalid-backup");
		if (error instanceof BackupCompatibilityError)
			throw new RestoreHttpRejectionError(409, "invalid-backup");
		if (
			error instanceof Error &&
			["invalid-upload", "stored-file-unavailable"].includes(error.message)
		)
			throw new RestoreHttpRejectionError(400, "invalid-backup");
		throw new RestoreHttpRejectionError(503, "destination-unavailable");
	} finally {
		activeControllers.delete(runtime);
	}
}
