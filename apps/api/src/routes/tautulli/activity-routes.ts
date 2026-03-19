/**
 * Tautulli Activity Routes
 *
 * Real-time session data from Tautulli (richer than Plex native sessions).
 * Provides LAN/WAN bandwidth breakdown, resolution, and codec info.
 */

import type { TautulliActivityResponse, TautulliSession } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { executeOnTautulliInstances } from "../../lib/tautulli/tautulli-helpers.js";

export async function registerActivityRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/tautulli/activity
	 *
	 * Returns all active sessions across user's Tautulli instances.
	 * Frontend polls this at 15s intervals alongside Plex sessions.
	 */
	app.get("/", async (request, reply) => {
		const userId = request.currentUser!.id;

		let totalStreamCount = 0;
		let totalBandwidth = 0;
		let lanBandwidth = 0;
		let wanBandwidth = 0;

		const result = await executeOnTautulliInstances(app, userId, async (client, instance) => {
			const activity = await client.getActivity();

			totalStreamCount += Number(activity.stream_count) || 0;
			totalBandwidth += activity.total_bandwidth || 0;
			lanBandwidth += activity.lan_bandwidth || 0;
			wanBandwidth += activity.wan_bandwidth || 0;

			return activity.sessions.map(
				(s): TautulliSession => ({
					sessionKey: s.session_key,
					ratingKey: s.rating_key,
					title: s.title,
					grandparentTitle: s.grandparent_title,
					mediaType: s.media_type,
					user: s.friendly_name || s.user,
					player: s.player,
					platform: s.platform,
					product: s.product,
					state: s.state as "playing" | "paused" | "buffering",
					progressPercent: Number(s.progress_percent) || 0,
					transcodeDecision: s.transcode_decision,
					videoDecision: s.stream_video_decision || s.transcode_decision,
					audioDecision: s.stream_audio_decision || "direct play",
					videoResolution: s.video_resolution,
					audioCodec: s.audio_codec,
					videoCodec: s.video_codec || "",
					bandwidth: Number(s.bandwidth) || 0,
					location: s.location as "lan" | "wan",
					thumb: s.thumb,
					instanceId: instance.id,
					instanceName: instance.label,
				}),
			);
		});

		// aggregated is flattened by executeOnTautulliInstances (uses flatMap)
		const sessions = result.aggregated as unknown as TautulliSession[];

		const response: TautulliActivityResponse = {
			sessions,
			streamCount: totalStreamCount,
			totalBandwidth,
			lanBandwidth,
			wanBandwidth,
		};

		return reply.send(response);
	});
}
