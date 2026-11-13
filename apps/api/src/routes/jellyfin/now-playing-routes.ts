/**
 * Jellyfin Now Playing Routes
 *
 * Real-time session data from Jellyfin server(s).
 * Aggregates across all user's Jellyfin instances.
 */

import {
	type JellyfinNowPlayingResponse,
	type JellyfinSessionInfo,
	measureSessionBandwidth,
	type SessionAvailability,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { executeOnJellyfinInstances } from "../../lib/jellyfin/jellyfin-helpers.js";
import { projectJellyfinSessionMeasurements } from "../../lib/jellyfin/jellyfin-session-measurements.js";

export async function registerNowPlayingRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/now-playing
	 *
	 * Returns all active Jellyfin sessions across user's instances.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const result = await executeOnJellyfinInstances(app, userId, async (client, instance) => {
			const sessions = await client.getSessions();
			return sessions.map((s): JellyfinSessionInfo => {
				const item = s.nowPlayingItem;

				return {
					sessionId: s.id,
					title: item?.name ?? "Unknown",
					seriesName: item?.seriesName,
					type: item?.type ?? "Unknown",
					user: s.userName ?? "Unknown",
					player: s.client ?? "Unknown",
					deviceName: s.deviceName ?? "Unknown",
					state: s.isPaused ? "paused" : "playing",
					viewOffset: s.positionMs,
					duration: s.durationMs,
					...projectJellyfinSessionMeasurements(s),
					thumb: item?.imageTags?.Primary ? `/Items/${item.id}/Images/Primary` : undefined,
					instanceId: instance.id,
					instanceName: instance.label,
				};
			});
		});
		const configuredSources = result.instances.length;
		const availableSources = result.instances.filter((instance) => instance.success).length;
		const availability: SessionAvailability = {
			status:
				configuredSources === 0
					? "not-configured"
					: availableSources === 0
						? "unavailable"
						: availableSources === configuredSources
							? "complete"
							: "partial",
			configuredSources,
			availableSources,
		};
		if (availability.status === "unavailable") {
			return reply.status(503).send({ error: "Jellyfin now-playing is unavailable", availability });
		}

		const sessions = result.aggregated as unknown as JellyfinSessionInfo[];
		const bandwidthCoverage = measureSessionBandwidth(sessions);
		if (configuredSources === 0) {
			bandwidthCoverage.status = "unavailable";
			bandwidthCoverage.knownTotalKbps = null;
		}

		const response: JellyfinNowPlayingResponse = {
			sessions,
			totalBandwidth: bandwidthCoverage.knownTotalKbps ?? 0,
			availability,
			bandwidthCoverage,
			bandwidthBasis: "encoding-estimate",
		};

		return reply.send(response);
	});
}
