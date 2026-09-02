/**
 * Connection Warmer Service
 *
 * Pre-warms HTTP connections to ARR instances after user authentication.
 * This eliminates cold-start latency when users navigate to data-heavy pages.
 */

import { ARR_SERVICES_UPPER } from "@arr/shared";
import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "../../lib/prisma.js";
import { isProwlarrClient, isRadarrClient, isSonarrClient } from "./client-helpers.js";

/**
 * Warm up connections to all enabled instances for a user.
 * Makes lightweight status requests to establish HTTP keep-alive connections.
 *
 * This runs in the background and doesn't block the authentication response.
 */
export async function warmConnectionsForUser(app: FastifyInstance, userId: string): Promise<void> {
	try {
		// Fetch all enabled instances for the user
		const instances = await app.prisma.serviceInstance.findMany({
			where: {
				userId,
				enabled: true,
				service: { in: [...ARR_SERVICES_UPPER] },
			},
		});

		if (instances.length === 0) {
			return;
		}

		// Warm connections in parallel. Each ARR client owns a bounded request
		// timeout; do not race these promises with an uncancelling outer timer.
		// Callers may retain a restore-exclusion lease until every request settles.
		const warmPromises = instances.map((instance) =>
			warmSingleConnection(app, instance).catch((error) => {
				// Log but don't fail - this is best-effort
				app.log.debug(
					{ instanceId: instance.id, error: error.message },
					"Connection warm-up failed (non-critical)",
				);
			}),
		);

		await Promise.all(warmPromises);

		app.log.info({ userId, instanceCount: instances.length }, "Connections pre-warmed for user");
	} catch (error) {
		// Never fail on warm-up errors
		app.log.debug({ error }, "Connection warm-up error (non-critical)");
	}
}

/**
 * Warm a single instance connection with a lightweight status request.
 */
async function warmSingleConnection(
	app: FastifyInstance,
	instance: ServiceInstance,
): Promise<void> {
	const client = app.arrClientFactory.create(instance);

	// Make a lightweight request to establish the connection
	// system.get() is fast and available on all ARR apps
	if (isSonarrClient(client)) {
		await client.system.get();
	} else if (isRadarrClient(client)) {
		await client.system.get();
	} else if (isProwlarrClient(client)) {
		await client.system.get();
	}
}
