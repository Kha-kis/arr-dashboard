import type { TautulliActivityResponse, TautulliActivitySession } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import {
	createCurrentTautulliClient,
	isTautulliConnectionChanged,
} from "../../lib/tautulli/current-tautulli-client.js";

const activityState = (state: string): TautulliActivitySession["state"] =>
	state === "playing" || state === "paused" || state === "buffering" ? state : "unknown";

const activityLocation = (location: string): TautulliActivitySession["location"] =>
	location === "lan" || location === "wan" ? location : "unknown";

export async function registerActivityRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	app.get("/", async (request, reply) => {
		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser!.id, service: "TAUTULLI", enabled: true },
			orderBy: { label: "asc" },
		});
		const results = await Promise.all(
			instances.map(async (instance) => {
				try {
					const { client, ensureCurrent } = createCurrentTautulliClient(app, instance);
					const activity = await client.getActivity();
					await ensureCurrent();
					return {
						instanceId: instance.id,
						instanceLabel: instance.label,
						reachable: true as const,
						sessions: activity.sessions.map(
							(session): TautulliActivitySession => ({
								sessionKey: session.session_key,
								ratingKey: session.rating_key,
								title: session.title,
								grandparentTitle: session.grandparent_title || undefined,
								mediaType: session.media_type,
								user: session.friendly_name || session.user,
								player: session.player,
								platform: session.platform,
								product: session.product,
								state: activityState(session.state),
								progressPercent: Number(session.progress_percent) || 0,
								transcodeDecision: session.transcode_decision,
								videoDecision: session.stream_video_decision || session.transcode_decision,
								audioDecision: session.stream_audio_decision || "direct play",
								videoResolution: session.video_resolution,
								audioCodec: session.audio_codec,
								videoCodec: session.video_codec,
								bandwidth: Number(session.bandwidth) || 0,
								location: activityLocation(session.location),
								thumb: session.thumb,
								instanceId: instance.id,
								instanceLabel: instance.label,
							}),
						),
						streamCount: Number(activity.stream_count) || 0,
						totalBandwidth: activity.total_bandwidth,
						lanBandwidth: activity.lan_bandwidth,
						wanBandwidth: activity.wan_bandwidth,
					};
				} catch (error) {
					request.log.warn(
						{ err: error, instanceId: instance.id },
						"Tautulli activity request failed",
					);
					return {
						instanceId: instance.id,
						instanceLabel: instance.label,
						reachable: false as const,
						incompleteReason: isTautulliConnectionChanged(error)
							? ("connection_changed" as const)
							: ("source_unreachable" as const),
						sessions: [],
						streamCount: 0,
						totalBandwidth: 0,
						lanBandwidth: 0,
						wanBandwidth: 0,
					};
				}
			}),
		);
		const response: TautulliActivityResponse = {
			provider: "tautulli",
			configured: instances.length > 0,
			sources: results,
		};
		return reply.send(response);
	});
}
