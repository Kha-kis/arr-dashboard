/**
 * Plex Now Playing Routes
 *
 * Real-time session data from Plex Media Server(s).
 * Aggregates across all user's Plex instances.
 */

import type { PlexNowPlayingResponse, PlexSession } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { executeOnPlexInstances } from "../../lib/plex/plex-helpers.js";

export async function registerNowPlayingRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/now-playing
	 *
	 * Returns all active Plex sessions across user's instances.
	 * Frontend polls this at 15s intervals.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		const result = await executeOnPlexInstances(app, userId, async (client, instance) => {
			const sessions = await client.getSessions();
			return sessions.map(
				(s): PlexSession => ({
					sessionKey: s.sessionKey,
					ratingKey: s.ratingKey,
					title: s.title,
					grandparentTitle: s.grandparentTitle,
					type: s.type,
					user: s.user,
					player: s.player,
					state: s.state,
					viewOffset: s.viewOffset,
					duration: s.duration,
					videoDecision: s.videoDecision,
					audioDecision: s.audioDecision,
					bandwidth: s.bandwidth,
					thumb: s.thumb,
					instanceId: instance.id,
					instanceName: instance.label,
				}),
			);
		});

		// aggregated is flattened by executeOnPlexInstances (uses flatMap)
		const sessions = result.aggregated as unknown as PlexSession[];
		let totalBandwidth = 0;
		for (const session of sessions) {
			totalBandwidth += session.bandwidth ?? 0;
		}

		const response: PlexNowPlayingResponse = {
			sessions,
			totalBandwidth,
		};

		return reply.send(response);
	});
}
