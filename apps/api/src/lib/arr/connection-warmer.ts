/**
 * Connection Warmer Service
 *
 * Pre-warms HTTP connections to ARR instances after user authentication.
 * This eliminates cold-start latency when users navigate to data-heavy pages.
 */

import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "@prisma/client";
import { isSonarrClient, isRadarrClient, isProwlarrClient } from "./client-helpers.js";

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
			},
		});

		if (instances.length === 0) {
			return;
		}

		// Warm connections in parallel with short timeout
		const warmPromises = instances.map((instance) =>
			warmSingleConnection(app, instance).catch((error) => {
				// Log but don't fail - this is best-effort
				app.log.debug(
					{ instanceId: instance.id, error: error.message },
					"Connection warm-up failed (non-critical)",
				);
			}),
		);

		// Wait for all with a reasonable timeout
		await Promise.race([
			Promise.all(warmPromises),
			new Promise((resolve) => setTimeout(resolve, 5000)), // 5s max
		]);

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
