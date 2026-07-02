import type {
	TracearrLiveSession,
	TracearrLiveSessionsResponse,
	TracearrLiveSessionsSummary,
	TracearrStream,
} from "@arr/shared";
import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "../../lib/prisma.js";
import { createTracearrClient } from "../../lib/tracearr/client-factory.js";
import { listTracearrInstances } from "../../lib/tracearr/instance-helpers.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";

/**
 * Project a raw Tracearr stream onto the console row shape, tagging it with
 * the owning arr-dashboard instance. `instanceId` is what the kill route
 * needs to resolve + ownership-check the right Tracearr; the rest is the
 * partial media enrichment the row renders.
 */
function toLiveSession(stream: TracearrStream, instance: ServiceInstance): TracearrLiveSession {
	return {
		id: stream.id,
		instanceId: instance.id,
		instanceLabel: instance.label,
		serverName: stream.serverName,
		username: stream.username,
		mediaTitle: stream.mediaTitle,
		showTitle: stream.showTitle,
		mediaType: stream.mediaType,
		seasonNumber: stream.seasonNumber,
		episodeNumber: stream.episodeNumber,
		state: stream.state,
		progressMs: stream.progressMs,
		durationMs: stream.durationMs,
		isTranscode: stream.isTranscode,
		videoDecision: stream.videoDecision,
		player: stream.player,
		platform: stream.platform,
	};
}

/**
 * Aggregate live-session view for the Operator Console "Live Sessions" card
 * (charter §2.1). Tracearr already unifies streams across every media server
 * it monitors (Plex/Jellyfin/Emby), so this route sums the summaries AND
 * flattens the per-session lists across the user's (usually one) enabled
 * Tracearr instances — each session tagged with its owning instance so the
 * kill route (Tracearr-3) can target it.
 *
 * Degradation is deliberate and per-instance: an unreachable Tracearr must
 * NOT error the whole console. A down instance is reported as
 * `reachable: false` and dropped from the aggregate; the card shows an
 * unreachable state rather than a misleading zero (trust rule — never fake a
 * count). When the user has no enabled Tracearr instance, `configured` is
 * false and the frontend omits the card entirely (service gating).
 */
export function registerTracearrStreamsRoutes(app: FastifyInstance): void {
	app.get("/tracearr/streams", async (request, reply) => {
		const userId = request.currentUser!.id;
		const instances = await listTracearrInstances(app, userId);

		if (instances.length === 0) {
			const empty: TracearrLiveSessionsResponse = {
				configured: false,
				instances: [],
				summary: null,
				sessions: [],
			};
			return reply.send(empty);
		}

		// Probe every instance concurrently; a failure on one is contained to
		// that instance rather than rejecting the whole request.
		const probes = await Promise.all(
			instances.map(async (instance) => {
				try {
					const client = createTracearrClient(app, instance);
					const { summary, data } = await client.getStreams();
					return { instance, summary, data, reachable: true as const };
				} catch (error) {
					request.log.warn(
						{ instanceId: instance.id, err: error, reason: getErrorMessage(error) },
						"tracearr streams probe failed; excluding from live-session aggregate",
					);
					return { instance, summary: null, data: [], reachable: false as const };
				}
			}),
		);

		const reachable = probes.filter((p) => p.reachable && p.summary !== null);

		let summary: TracearrLiveSessionsSummary | null = null;
		if (reachable.length > 0) {
			summary = reachable.reduce<TracearrLiveSessionsSummary>(
				(acc, p) => {
					const s = p.summary!;
					acc.total += s.total;
					acc.transcodes += s.transcodes;
					acc.directStreams += s.directStreams;
					acc.directPlays += s.directPlays;
					return acc;
				},
				{ total: 0, transcodes: 0, directStreams: 0, directPlays: 0, totalBitrate: null },
			);
			// totalBitrate is a pre-formatted string per instance; only meaningful
			// to surface when exactly one reachable instance backs the aggregate.
			summary.totalBitrate =
				reachable.length === 1 ? (reachable[0]?.summary?.totalBitrate ?? null) : null;
		}

		// Flatten every reachable instance's sessions, tagged with their owner.
		const sessions: TracearrLiveSession[] = reachable.flatMap((p) =>
			p.data.map((stream) => toLiveSession(stream, p.instance)),
		);

		const response: TracearrLiveSessionsResponse = {
			configured: true,
			instances: probes.map((p) => ({
				id: p.instance.id,
				label: p.instance.label,
				reachable: p.reachable,
			})),
			summary,
			sessions,
		};
		return reply.send(response);
	});
}
