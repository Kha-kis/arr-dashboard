import {
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
	testConnection(): Promise<{ ok: true } | { ok: false; reason: string }>;
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
	};
}
