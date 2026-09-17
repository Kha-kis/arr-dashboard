/**
 * Tautulli Activity Routes
 *
 * Real-time session data from Tautulli (richer than Plex native sessions).
 * Provides LAN/WAN bandwidth breakdown, resolution, and codec info.
 */

import type { SessionAvailability, TautulliActivityResponse, TautulliSession } from "@arr/shared";
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

		const configured = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "TAUTULLI", enabled: true },
			select: { id: true },
		});
		const result = await executeOnTautulliInstances(app, userId, async (client, instance) => {
			const activity = await client.getActivity();

			return {
				streamCount: Number(activity.stream_count) || 0,
				totalBandwidth: activity.total_bandwidth || 0,
				lanBandwidth: activity.lan_bandwidth || 0,
				wanBandwidth: activity.wan_bandwidth || 0,
				sessions: activity.sessions.map(
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
				),
			};
		});
		const configuredIds = new Set(configured.map(({ id }) => id));
		const availableSources = result.instances.filter(
			(instance) => instance.success && configuredIds.has(instance.instanceId),
		).length;
		const availability: SessionAvailability = {
			status:
				configured.length === 0
					? "not-configured"
					: availableSources === 0
						? "unavailable"
						: availableSources === configured.length
							? "complete"
							: "partial",
			configuredSources: configured.length,
			availableSources,
		};
		if (availability.status === "unavailable") {
			return reply.status(503).send({ error: "Tautulli activity is unavailable", availability });
		}

		const sessions: TautulliSession[] = [];
		let totalStreamCount = 0;
		let totalBandwidth = 0;
		let lanBandwidth = 0;
		let wanBandwidth = 0;
		for (const instanceResult of result.instances) {
			if (!instanceResult.success || !configuredIds.has(instanceResult.instanceId)) continue;
			sessions.push(...instanceResult.data.sessions);
			totalStreamCount += instanceResult.data.streamCount;
			totalBandwidth += instanceResult.data.totalBandwidth;
			lanBandwidth += instanceResult.data.lanBandwidth;
			wanBandwidth += instanceResult.data.wanBandwidth;
		}

		const response: TautulliActivityResponse = {
			sessions,
			streamCount: totalStreamCount,
			totalBandwidth,
			lanBandwidth,
			wanBandwidth,
			availability,
		};

		return reply.send(response);
	});
}
