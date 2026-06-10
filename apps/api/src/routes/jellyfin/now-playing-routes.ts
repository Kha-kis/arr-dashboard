/**
 * Jellyfin Now Playing Routes
 *
 * Real-time session data from Jellyfin server(s).
 * Aggregates across all user's Jellyfin instances.
 */

import type { JellyfinNowPlayingResponse, JellyfinSessionInfo } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { executeOnJellyfinInstances } from "../../lib/jellyfin/jellyfin-helpers.js";

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
				const isTranscoding = s.transcodingInfo && !s.transcodingInfo.isVideoDirect;

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
					videoDecision: isTranscoding ? "Transcode" : s.playMethod ?? "DirectPlay",
					audioDecision:
						s.transcodingInfo && !s.transcodingInfo.isAudioDirect
							? "Transcode"
							: "Direct",
					bandwidth: s.transcodingInfo?.bitrate
						? Math.round(s.transcodingInfo.bitrate / 1000)
						: undefined,
					videoCodec: s.transcodingInfo?.videoCodec,
					audioCodec: s.transcodingInfo?.audioCodec,
					thumb: item?.imageTags?.Primary
						? `/Items/${item.id}/Images/Primary`
						: undefined,
					instanceId: instance.id,
					instanceName: instance.label,
				};
			});
		});

		const sessions = result.aggregated as unknown as JellyfinSessionInfo[];
		let totalBandwidth = 0;
		for (const s of sessions) {
			totalBandwidth += s.bandwidth ?? 0;
		}

		const response: JellyfinNowPlayingResponse = {
			sessions,
			totalBandwidth,
		};

		return reply.send(response);
	});
}
