import {
	type TracearrActivity,
	type TracearrActivityQuery,
	type TracearrHealth,
	type TracearrHistoryQuery,
	type TracearrHistoryResponse,
	type TracearrStats,
	type TracearrStatsQuery,
	type TracearrStatsToday,
	type TracearrStreamsQuery,
	type TracearrStreamsResponse,
	type TracearrTerminateResponse,
	type TracearrUsersQuery,
	type TracearrUsersResponse,
	type TracearrViolationsQuery,
	type TracearrViolationsResponse,
	tracearrActivitySchema,
	tracearrHealthSchema,
	tracearrHistoryResponseSchema,
	tracearrStatsSchema,
	tracearrStatsTodaySchema,
	tracearrStreamsResponseSchema,
	tracearrTerminateResponseSchema,
	tracearrUsersResponseSchema,
	tracearrViolationsResponseSchema,
} from "@arr/shared";
import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "../prisma.js";
import {
	type TracearrRequestContext,
	tracearrHealthProbe,
	tracearrRequest,
} from "./client-helpers.js";

/**
 * Request-scoped client for a single Tracearr instance. The 8 GET endpoints
 * of the Public API plus the one mutating endpoint (`POST
 * /streams/{id}/terminate`, the kill-session action) are wired here.
 *
 * Every method returns a Zod-validated shape from `@arr/shared` — handlers
 * never see Tracearr's raw wire format. Query params are optional filter
 * bags mapped 1:1 onto the Public API's documented query strings.
 */
export interface TracearrClient {
	/** `GET /health` — reachability, version, and attached media servers. */
	getHealth(): Promise<TracearrHealth>;
	/** `GET /stats` — all-time rollup counters. */
	getStats(query?: TracearrStatsQuery): Promise<TracearrStats>;
	/** `GET /stats/today` — today's counters (the spec-drift endpoint). */
	getStatsToday(query?: TracearrStatsQuery): Promise<TracearrStatsToday>;
	/** `GET /activity` — aggregated play/concurrency series for charts. */
	getActivity(query?: TracearrActivityQuery): Promise<TracearrActivity>;
	/** `GET /streams` — live sessions + aggregate summary. */
	getStreams(query?: TracearrStreamsQuery): Promise<TracearrStreamsResponse>;
	/** `GET /users` — paginated Tracearr-tracked media-server users. */
	getUsers(query?: TracearrUsersQuery): Promise<TracearrUsersResponse>;
	/** `GET /violations` — paginated account-sharing detections. */
	getViolations(query?: TracearrViolationsQuery): Promise<TracearrViolationsResponse>;
	/** `GET /history` — paginated watch history (Statistics / C2 source). */
	getHistory(query?: TracearrHistoryQuery): Promise<TracearrHistoryResponse>;
	/**
	 * `POST /streams/{id}/terminate` — the kill-session action. Terminates a
	 * live playback session by Tracearr stream id. `reason`, when given, is
	 * forwarded by Tracearr to the terminated user's player. Resolves to the
	 * validated success payload; a non-2xx (e.g. the session already ended)
	 * throws TracearrApiError with the mapped status.
	 */
	terminateStream(streamId: string, opts?: { reason?: string }): Promise<TracearrTerminateResponse>;
	/**
	 * Probe `/health` without throwing. Returns a discriminated result for
	 * the connection-tester surface where unreachable is expected, not an error.
	 */
	testConnection(): Promise<
		{ ok: true; version?: string; serverCount: number } | { ok: false; reason: string }
	>;
}

/**
 * Build a Tracearr client bound to one ServiceInstance. Decrypts the stored
 * Public API key per call-site (no caching of plaintext), mirroring
 * `createQuiClient`. Cheap to construct; make one per request.
 */
export function createTracearrClient(
	app: FastifyInstance,
	instance: ServiceInstance,
): TracearrClient {
	const apiKey = app.encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});

	const ctx: TracearrRequestContext = {
		instanceId: instance.id,
		baseUrl: instance.baseUrl,
		apiKey,
		log: app.log,
	};

	return {
		getHealth: () => tracearrRequest(ctx, "/health", tracearrHealthSchema),
		getStats: (query) => tracearrRequest(ctx, "/stats", tracearrStatsSchema, { query }),
		getStatsToday: (query) =>
			tracearrRequest(ctx, "/stats/today", tracearrStatsTodaySchema, { query }),
		getActivity: (query) => tracearrRequest(ctx, "/activity", tracearrActivitySchema, { query }),
		getStreams: (query) =>
			tracearrRequest(ctx, "/streams", tracearrStreamsResponseSchema, { query }),
		getUsers: (query) => tracearrRequest(ctx, "/users", tracearrUsersResponseSchema, { query }),
		getViolations: (query) =>
			tracearrRequest(ctx, "/violations", tracearrViolationsResponseSchema, { query }),
		getHistory: (query) =>
			tracearrRequest(ctx, "/history", tracearrHistoryResponseSchema, { query }),
		terminateStream: (streamId, opts) =>
			tracearrRequest(
				ctx,
				`/streams/${encodeURIComponent(streamId)}/terminate`,
				tracearrTerminateResponseSchema,
				{ method: "POST", body: opts?.reason ? { reason: opts.reason } : {} },
			),
		testConnection: async () => {
			const probe = await tracearrHealthProbe(ctx);
			if (!probe.ok) return { ok: false, reason: probe.reason };
			return { ok: true, version: probe.version, serverCount: probe.serverCount };
		},
	};
}
