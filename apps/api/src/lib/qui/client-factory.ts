import {
	type QuiAction,
	type QuiCrossSeedMatch,
	type QuiInstance,
	type QuiTorrent,
	type QuiTracker,
	quiInstanceSchema,
	quiTorrentStateSchema,
} from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServiceInstance } from "../prisma.js";
import { type QuiRequestContext, quiHealthProbe, quiRequest } from "./client-helpers.js";
import { mapTrackerHealth } from "./tracker-health-mapper.js";

export interface QuiClient {
	getTorrentByHash(hash: string): Promise<QuiTorrent | null>;
	getTrackers(instanceId: number, hash: string): Promise<QuiTracker[]>;
	getCrossSeedMatches(instanceId: number, hash: string): Promise<QuiCrossSeedMatch[]>;
	listInstances(): Promise<QuiInstance[]>;
	/**
	 * List every torrent qui knows about, aggregated across every qBit
	 * instance behind this qui. Used by the periodic state-snapshot job;
	 * NOT for per-page UI calls (qui returns large payloads here).
	 */
	listAllTorrents(): Promise<QuiTorrent[]>;
	testConnection(): Promise<{ ok: true } | { ok: false; reason: string }>;
	/**
	 * Apply a bulk action to one-or-more torrents on a specific qBit
	 * instance. Maps to qui's `POST /api/instances/{instanceID}/torrents/bulk-action`
	 * with the `{ action, hashes, tags? }` body shape from qui's openapi.
	 *
	 * Phase 4 supports a narrow subset of qui's bulk-action vocabulary
	 * (pause/resume/recheck/reannounce/setTags). Other qui actions
	 * (delete, setCategory, setLocation, tracker edits, …) are
	 * deliberately not exposed in v1 — they need their own UI affordances,
	 * audit-log payload schemas, and trust review.
	 */
	bulkAction(args: {
		qbitInstanceId: number;
		hashes: string[];
		action: QuiAction;
		/** Comma-joined tag list; required for `setTags`, ignored otherwise. */
		tags?: string;
	}): Promise<void>;
	/** Create a notification target inside qui. Phase 5.1 — auto-registers arr-dashboard's webhook URL. */
	createNotificationTarget(args: {
		name: string;
		url: string;
		eventTypes?: string[];
		enabled?: boolean;
	}): Promise<{ id: number }>;
}

// ── Wire-format schemas ─────────────────────────────────────────────
// qui returns full snake_case using qBit's native field names. We accept
// the wire format and transform to arr-dashboard's canonical camelCase
// shape at the validation boundary, so downstream code (routes, frontend)
// only ever sees the canonical types declared in @arr/shared.

const splitTags = (raw: string): string[] =>
	raw
		? raw
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
		: [];

const wireTorrentSchema = z
	.object({
		hash: z.string(),
		name: z.string(),
		state: quiTorrentStateSchema,
		ratio: z.number(),
		progress: z.number(),
		num_seeds: z.number().int(),
		num_leechs: z.number().int(),
		tags: z.string().default(""),
		category: z.string().default(""),
		save_path: z.string(),
		added_on: z.number().int(),
		completion_on: z.number().int(),
		seeding_time: z.number().int().default(0),
		eta: z.number().int(),
		dlspeed: z.number().int(),
		upspeed: z.number().int(),
		priority: z.number().int(),
		size: z.number().int(),
		instance_id: z.number().int().optional(),
		instance_name: z.string().optional(),
	})
	.transform(
		(w): QuiTorrent => ({
			hash: w.hash,
			name: w.name,
			state: w.state,
			ratio: w.ratio,
			progress: Math.max(0, Math.min(1, w.progress)),
			numSeeds: w.num_seeds,
			numLeechs: w.num_leechs,
			tags: splitTags(w.tags),
			category: w.category,
			savePath: w.save_path,
			addedOn: w.added_on,
			completedOn: w.completion_on > 0 ? w.completion_on : null,
			seedingTime: w.seeding_time,
			eta: w.eta,
			dlSpeed: w.dlspeed,
			upSpeed: w.upspeed,
			priority: w.priority,
			size: w.size,
			instanceId: w.instance_id,
			instanceName: w.instance_name,
		}),
	);

const wireCrossInstanceResponseSchema = z.object({
	cross_instance_torrents: z.array(wireTorrentSchema).nullable(),
	hasMore: z.boolean().optional(),
	total: z.number().int().optional(),
});

const wireTrackerSchema = z
	.object({
		url: z.string(),
		status: z.number().int(),
		msg: z.string().default(""),
		num_peers: z.number().int().default(0),
		num_seeds: z.number().int().default(0),
		num_leeches: z.number().int().default(0),
		tier: z.number().int().optional(),
	})
	.transform(
		(w): QuiTracker => ({
			url: w.url,
			status: w.status,
			health: mapTrackerHealth(w.status),
			msg: w.msg,
			numSeeds: w.num_seeds,
			numLeeches: w.num_leeches,
			numPeers: w.num_peers,
			tier: w.tier,
		}),
	);

const wireCrossSeedMatchSchema = z
	.object({
		hash: z.string(),
		name: z.string(),
		instance_id: z.number().int(),
		instance_name: z.string(),
		state: z.string(),
		progress: z.number(),
		size: z.number().int(),
		category: z.string().default(""),
		save_path: z.string(),
		content_path: z.string(),
		tracker: z.string(),
		tracker_health: z.enum(["unregistered", "tracker_down"]).optional(),
		match_type: z.enum(["content_path", "name", "release"]),
		tags: z.string().default(""),
	})
	.transform(
		(w): QuiCrossSeedMatch => ({
			hash: w.hash,
			name: w.name,
			instanceId: w.instance_id,
			instanceName: w.instance_name,
			state: w.state,
			progress: Math.max(0, Math.min(1, w.progress)),
			size: w.size,
			category: w.category,
			savePath: w.save_path,
			contentPath: w.content_path,
			tracker: w.tracker,
			trackerHealth: w.tracker_health,
			matchType: w.match_type,
			tags: w.tags,
		}),
	);

const wireLocalMatchesResponseSchema = z.object({
	matches: z.array(wireCrossSeedMatchSchema).nullable(),
});

/**
 * Build a request-scoped qui client.
 *
 * The caller passes a hydrated ServiceInstance (already user-scoped via
 * `requireQuiInstance`). The client decrypts the API key once and embeds
 * it into a request context. Clients are not cached — each route handler
 * builds a fresh one. Garbage collection clears the decrypted key once
 * the request completes.
 */
export function createQuiClient(app: FastifyInstance, instance: ServiceInstance): QuiClient {
	const apiKey = app.encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});

	const ctx: QuiRequestContext = {
		instanceId: instance.id,
		baseUrl: instance.baseUrl,
		apiKey,
		log: app.log,
	};

	return {
		async getTorrentByHash(hash) {
			const data = await quiRequest(
				ctx,
				"/api/torrents/cross-instance",
				wireCrossInstanceResponseSchema,
				{ query: { search: hash, limit: "20" } },
			);
			const torrents = data.cross_instance_torrents ?? [];
			return torrents.find((t) => t.hash.toLowerCase() === hash.toLowerCase()) ?? null;
		},

		async listAllTorrents() {
			// Cross-instance endpoint paginates server-side. qui's openapi
			// caps `limit` at 2000 per page; `hasMore` flags when more pages
			// exist. Pre-fix versions sent `limit=10000` once and returned
			// whatever fit in qui's actual server-side cap (often ~300),
			// silently truncating the library for users with >300 torrents.
			//
			// Hard safety cap on iteration: refuse to loop more than 50 pages
			// (100k torrents at limit=2000). Bigger libraries are pathological
			// for this aggregation pattern anyway — they need streaming.
			const PAGE_SIZE = 2000;
			const MAX_PAGES = 50;
			const all: QuiTorrent[] = [];
			for (let page = 0; page < MAX_PAGES; page++) {
				const data = await quiRequest(
					ctx,
					"/api/torrents/cross-instance",
					wireCrossInstanceResponseSchema,
					{ query: { limit: String(PAGE_SIZE), page: String(page) } },
				);
				const batch = data.cross_instance_torrents ?? [];
				all.push(...batch);
				if (!data.hasMore || batch.length === 0) break;
			}
			return all;
		},

		async getTrackers(instanceId, hash) {
			return quiRequest(
				ctx,
				`/api/instances/${instanceId}/torrents/${hash}/trackers`,
				z.array(wireTrackerSchema),
			);
		},

		async getCrossSeedMatches(instanceId, hash) {
			const data = await quiRequest(
				ctx,
				`/api/cross-seed/torrents/${instanceId}/${hash}/local-matches`,
				wireLocalMatchesResponseSchema,
			);
			return data.matches ?? [];
		},

		async listInstances() {
			// qui's Instance shape has a few fields beyond what we surface;
			// passthrough() keeps the schema lenient toward additions.
			return quiRequest(ctx, "/api/instances", z.array(quiInstanceSchema));
		},

		async testConnection() {
			const probe = await quiHealthProbe(ctx);
			if (!probe.ok) return probe;
			try {
				await quiRequest(ctx, "/api/instances", z.array(quiInstanceSchema));
				return { ok: true } as const;
			} catch (error) {
				const reason = error instanceof Error ? error.message : "qui auth check failed";
				return { ok: false, reason };
			}
		},

		async bulkAction({ qbitInstanceId, hashes, action, tags }) {
			// qui's bulk-action returns 200 with no documented body schema on
			// success. We surface the call as void; failures throw via
			// quiRequest's status-mapping pathway (QuiInstanceUnreachableError
			// / QuiApiError) and the action-service layer translates them into
			// audit-log `failed` rows. z.unknown() matches "anything 200".
			await quiRequest(ctx, `/api/instances/${qbitInstanceId}/torrents/bulk-action`, z.unknown(), {
				method: "POST",
				body: {
					action,
					hashes,
					...(tags !== undefined ? { tags } : {}),
				},
			});
		},

		async createNotificationTarget({ name, url, eventTypes, enabled = true }) {
			// qui's `POST /api/notifications/targets` returns the created
			// target — we only need the id back for arr-dashboard's own
			// bookkeeping ("we already registered our webhook against this qui").
			// passthrough() lets future qui fields land without a shared-schema bump.
			return quiRequest(
				ctx,
				"/api/notifications/targets",
				z.object({ id: z.number().int() }).passthrough(),
				{
					method: "POST",
					body: { name, url, eventTypes, enabled },
				},
			);
		},
	};
}
