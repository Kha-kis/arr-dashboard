import {
	type QuiAction,
	type QuiCapabilities,
	type QuiCrossSeedMatch,
	type QuiInstance,
	type QuiMediaInfo,
	type QuiMonitoredTorrent,
	type QuiTorrent,
	type QuiTorrentFile,
	type QuiTorrentProperties,
	type QuiTracker,
	type QuiTransferInfo,
	quiCapabilitiesSchema,
	quiInstanceSchema,
	quiMediaInfoSchema,
	quiMonitoredTorrentSchema,
	quiTorrentStateSchema,
} from "@arr/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServiceInstance } from "../prisma.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import {
	extractHostnameSafe,
	type QuiRequestContext,
	quiHealthProbe,
	quiRequest,
} from "./client-helpers.js";
import { mapTrackerHealth } from "./tracker-health-mapper.js";

export interface QuiTorrentInventory {
	torrents: QuiTorrent[];
	/** True only when qUI pagination metadata proved every page was observed. */
	complete: boolean;
}

export interface QuiClient {
	/** Return every exact-hash match across all qBit instances behind this qUI. */
	getTorrentsByHash(hash: string): Promise<QuiTorrent[]>;
	getTorrentByHash(hash: string): Promise<QuiTorrent | null>;
	getTrackers(instanceId: number, hash: string): Promise<QuiTracker[]>;
	/**
	 * Fetch qui's per-user tracker-icon map. Returns a record of
	 * `hostname` → `data:image/png;base64,...` URLs. qui builds this from
	 * a combination of community-curated favicons (downloaded from the
	 * tracker site) and user-uploaded custom icons. Empty record when
	 * qui has nothing configured for the user.
	 *
	 * Response is small (~50KB total for a typical user's tracker set)
	 * but cacheable for an hour — icons change rarely. Callers should
	 * cache aggressively rather than refetch per panel load.
	 */
	getTrackerIcons(): Promise<Record<string, string>>;
	/**
	 * Fetch qui's per-user tracker display-name customizations. Each entry
	 * pairs a human-friendly `displayName` ("Beyond-HD") with one or more
	 * canonical domains. Multiple domains per entry handle tracker
	 * subdomain aliases (`tracker.foo.me` AND `foo.me` map to the same
	 * display name). The caller inverts this into a flat
	 * `Record<hostname, displayName>` for lookup.
	 */
	getTrackerCustomizations(): Promise<
		Array<{
			id: number;
			displayName: string;
			domains: string[];
		}>
	>;
	getCrossSeedMatches(instanceId: number, hash: string): Promise<QuiCrossSeedMatch[]>;
	listInstances(): Promise<QuiInstance[]>;
	/**
	 * List every torrent qui knows about, aggregated across every qBit
	 * instance behind this qui. Used by the periodic state-snapshot job;
	 * NOT for per-page UI calls (qui returns large payloads here).
	 */
	listAllTorrents(options?: { requireComplete?: boolean }): Promise<QuiTorrent[]>;
	/**
	 * Return the read-only torrent inventory plus whether qUI proved it was
	 * complete. Positive observations remain useful when false; absence does
	 * not authorize clearing state or destructive work.
	 */
	listTorrentInventory(): Promise<QuiTorrentInventory>;
	testConnection(): Promise<{ ok: true } | { ok: false; reason: string }>;
	/**
	 * Apply a bulk action to one-or-more torrents on a specific qBit
	 * instance. Maps to qui's `POST /api/instances/{instanceID}/torrents/bulk-action`
	 * with the `{ action, hashes, tags? }` body shape from qui's openapi.
	 *
	 * Despite the `bulk-action` name, qui uses this single endpoint as the
	 * transport for most per-torrent mutations (including settings that
	 * accept exactly one hash). The per-action body extras live in `extras`
	 * as a free-form object — the caller has already validated them against
	 * `quiActionPayloadSchemas[action]`, so we trust the shape here. Each
	 * extras-key is spread directly into qui's POST body alongside `action`
	 * + `hashes`. Examples:
	 *   - setTags:        { tags: "label,foo" }
	 *   - setCategory:    { category: "media" }
	 *   - setShareLimit:  { ratioLimit: 2.0, seedingTimeLimit: 86400 }
	 *   - setLocation:    { location: "/data/torrents/new-path" }
	 *   - delete:         { deleteFiles: false }
	 */
	bulkAction(args: {
		qbitInstanceId: number;
		hashes: string[];
		action: QuiAction;
		/** Action-specific extras spread into qui's POST body. */
		extras?: Record<string, unknown>;
	}): Promise<void>;
	/**
	 * Fetch extended properties for a single torrent (speeds, limits,
	 * save path, comment, share-limit settings). Maps to qui's
	 * `GET /api/instances/:id/torrents/:hash/properties`.
	 */
	getTorrentProperties(instanceId: number, hash: string): Promise<QuiTorrentProperties>;
	/**
	 * Fetch the file inventory for a single torrent. Maps to qui's
	 * `GET /api/instances/:id/torrents/:hash/files`. Optional `refresh`
	 * forces qui to bypass its sync cache and re-query qBit.
	 */
	getTorrentFiles(
		instanceId: number,
		hash: string,
		options?: { refresh?: boolean },
	): Promise<QuiTorrentFile[]>;
	/**
	 * Fetch all qBit categories configured on this instance. Maps to qui's
	 * `GET /api/instances/:id/categories`. qBit returns `{ name: {name, savePath} }`
	 * — we flatten to a `{name, savePath}[]` so callers don't have to undo
	 * qBit's keyed-by-name shape.
	 */
	listCategories(instanceId: number): Promise<Array<{ name: string; savePath: string }>>;
	/**
	 * Fetch all tags configured on this instance. Maps to qui's
	 * `GET /api/instances/:id/tags`. qBit returns a flat string array.
	 */
	listTags(instanceId: number): Promise<string[]>;
	/**
	 * Fetch per-instance feature-support flags. Maps to qui's
	 * `GET /api/instances/:id/capabilities`. qui derives these from the
	 * connected qBittorrent's WebAPI version — the UI gates action
	 * affordances on them so it never offers a control qBit can't honor.
	 */
	getCapabilities(instanceId: number): Promise<QuiCapabilities>;
	/**
	 * Fetch live transfer stats for one qBittorrent instance. Maps to qui's
	 * `GET /api/instances/:id/transfer-info` (qBit's `transfer/info`) —
	 * current up/down speed, session data totals, DHT node count.
	 */
	getTransferInfo(instanceId: number): Promise<QuiTransferInfo>;
	/**
	 * Fetch the MediaInfo report for one file inside a torrent. Maps to qui's
	 * `GET /api/instances/:id/torrents/:hash/files/:index/mediainfo`. qui runs
	 * MediaInfo against the on-disk file — only works when qui has local
	 * filesystem access to the torrent's data.
	 */
	getFileMediaInfo(instanceId: number, hash: string, fileIndex: number): Promise<QuiMediaInfo>;
	/**
	 * Fetch torrents qui's reannounce monitor currently flags — those with a
	 * tracker problem or still waiting for their first tracker contact. Maps
	 * to qui's `GET /api/instances/:id/reannounce/candidates`. Returns an
	 * empty list when qui's reannounce service is disabled.
	 */
	getReannounceCandidates(instanceId: number): Promise<QuiMonitoredTorrent[]>;
	/**
	 * Rename a torrent's display name. Maps to qui's
	 * `POST /api/instances/:id/torrents/:hash/rename`. Per-torrent only —
	 * qui has no bulk rename.
	 */
	renameTorrent(instanceId: number, hash: string, name: string): Promise<void>;
	/**
	 * Add one or more tracker URLs to a torrent. Maps to qui's
	 * `POST /api/instances/:id/torrents/:hash/trackers`. qui takes a
	 * newline-separated string; we accept an array for caller ergonomics
	 * and join here.
	 */
	addTrackers(instanceId: number, hash: string, urls: string[]): Promise<void>;
	/**
	 * Remove tracker URLs from a torrent. Maps to qui's
	 * `DELETE /api/instances/:id/torrents/:hash/trackers`.
	 */
	removeTrackers(instanceId: number, hash: string, urls: string[]): Promise<void>;
	/**
	 * Replace a tracker URL. Maps to qui's
	 * `PUT /api/instances/:id/torrents/:hash/trackers`.
	 */
	editTracker(instanceId: number, hash: string, oldURL: string, newURL: string): Promise<void>;
	/**
	 * Create or update arr-dashboard's notification target inside qui.
	 * Discovers prior registrations by name and reconciles ambiguous create
	 * responses so retrying registration stays idempotent.
	 */
	ensureNotificationTarget(args: {
		name: string;
		url: string;
		/** Stable local owner marker used to reconcile a renamed target. */
		ownerId?: string;
		/** Evidence required before migrating a fixed-name, ownerless target. */
		legacyTargetAdoption?: "secret" | "never";
		/** Report an unowned enabled legacy target so the operator can remove it manually. */
		reportLegacyCleanupRequired?: boolean;
		eventTypes?: string[];
		enabled?: boolean;
	}): Promise<{ id: number; cleanupPending?: boolean; legacyCleanupRequired?: boolean }>;
	/**
	 * Trigger a qui dir-scan for a specific path. Maps to qui's
	 * `POST /api/dirscan/webhook` endpoint, which accepts a simple
	 * `{"path": "..."}` body. qui finds the longest-prefix-matching
	 * configured dir-scan directory, starts a scan rooted at the
	 * provided path, and returns the run id. On match qui auto-injects
	 * the cross-seed torrent against the existing file.
	 *
	 * Throws `QuiApiError` with 404 status when no configured dir-scan
	 * covers the path (operator hasn't set up dir-scan for this volume).
	 * Throws with 409 when a scan is already in progress for the
	 * matching directory.
	 */
	triggerDirScan(path: string): Promise<{
		runId: number;
		directoryId: number;
		directoryPath: string;
		scanRoot: string;
	}>;
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

const wireCrossInstanceLookupResponseSchema = z.object({
	cross_instance_torrents: z.array(wireTorrentSchema).nullable(),
});

const wireCrossInstanceInventoryResponseSchema = wireCrossInstanceLookupResponseSchema.extend({
	hasMore: z.boolean().optional(),
	partialResults: z.boolean().optional(),
	total: z.number().int().nonnegative().optional(),
});

const wireCrossInstanceResponseSchema = wireCrossInstanceLookupResponseSchema.extend({
	hasMore: z.boolean(),
	partialResults: z.boolean(),
	total: z.number().int().nonnegative(),
});

function crossInstanceTorrentIdentity(torrent: QuiTorrent, operation: string): string {
	if (
		!Number.isSafeInteger(torrent.instanceId) ||
		torrent.instanceId === undefined ||
		torrent.instanceId <= 0
	) {
		throw new Error(`qUI ${operation} returned a torrent without a valid instance identity`);
	}
	const hash = torrent.hash.trim().toLowerCase();
	if (!hash) throw new Error(`qUI ${operation} returned a torrent without a hash`);
	return `${torrent.instanceId}:${hash}`;
}

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
			tracker: extractHostnameSafe(w.tracker),
			trackerHealth: w.tracker_health,
			matchType: w.match_type,
			tags: w.tags,
		}),
	);

const wireLocalMatchesResponseSchema = z.object({
	matches: z.array(wireCrossSeedMatchSchema).nullable(),
});

const quiNotificationTargetSchema = z
	.object({
		id: z.number().int(),
		name: z.string(),
		url: z.string(),
		enabled: z.boolean(),
		eventTypes: z.array(z.string()),
	})
	.passthrough();

// qUI's Go store returns a nil slice when no targets exist, which encodes
// as JSON null rather than []. Normalize both wire shapes at the boundary.
const quiNotificationTargetListSchema = z
	.array(quiNotificationTargetSchema)
	.nullable()
	.transform((targets) => targets ?? []);

const quiNotificationEventDefinitionSchema = z
	.object({
		type: z.string(),
	})
	.passthrough();

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
		httpAuthHeaders: getStoredHttpAuthHeaders(app.encryptor, instance),
		log: app.log,
	};

	const PAGE_SIZE = 2000;
	const MAX_PAGES = 50;
	const PER_PAGE_TIMEOUT_MS = 30_000;

	const fetchTorrentInventory = async (requireComplete: boolean): Promise<QuiTorrentInventory> => {
		const torrents: QuiTorrent[] = [];
		const identities = new Set<string>();
		let expectedTotal: number | null = null;
		let rowsRead = 0;
		let exhausted = false;
		let complete = true;
		for (let page = 0; page < MAX_PAGES; page++) {
			const data = requireComplete
				? await quiRequest(ctx, "/api/torrents/cross-instance", wireCrossInstanceResponseSchema, {
						query: { limit: String(PAGE_SIZE), page: String(page) },
						timeoutMs: PER_PAGE_TIMEOUT_MS,
					})
				: await quiRequest(
						ctx,
						"/api/torrents/cross-instance",
						wireCrossInstanceInventoryResponseSchema,
						{
							query: { limit: String(PAGE_SIZE), page: String(page) },
							timeoutMs: PER_PAGE_TIMEOUT_MS,
						},
					);
			if (
				data.hasMore === undefined ||
				data.partialResults === undefined ||
				data.total === undefined
			)
				complete = false;
			if (data.partialResults === true)
				throw new Error("qUI torrent inventory returned partial results");
			if (data.total !== undefined && expectedTotal === null) expectedTotal = data.total;
			else if (data.total !== undefined && data.total !== expectedTotal)
				throw new Error("qUI torrent inventory total changed during pagination");
			const batch = data.cross_instance_torrents ?? [];
			rowsRead += batch.length;
			for (const torrent of batch) {
				const identity = crossInstanceTorrentIdentity(torrent, "torrent inventory");
				if (identities.has(identity))
					throw new Error("qUI torrent inventory returned a duplicate torrent across pages");
				identities.add(identity);
			}
			if (data.total !== undefined && rowsRead > data.total)
				throw new Error("qUI torrent inventory returned more rows than its total");
			torrents.push(...batch);
			if (data.hasMore !== true) {
				if (data.total !== undefined && rowsRead !== data.total)
					throw new Error("qUI torrent inventory ended before its declared total");
				exhausted = true;
				break;
			}
			if (batch.length === 0)
				throw new Error("qUI torrent inventory returned an empty page with more results");
		}
		if (!exhausted)
			throw new Error(
				`qUI torrent inventory exceeded the ${MAX_PAGES * PAGE_SIZE} torrent safety limit`,
			);
		return { torrents, complete };
	};

	return {
		async getTorrentsByHash(hash) {
			const exact: QuiTorrent[] = [];
			const identities = new Set<string>();
			let expectedTotal: number | null = null;
			let rowsRead = 0;
			let exhausted = false;
			for (let page = 0; page < MAX_PAGES; page++) {
				const data = await quiRequest(
					ctx,
					"/api/torrents/cross-instance",
					wireCrossInstanceResponseSchema,
					{
						query: { search: hash, limit: String(PAGE_SIZE), page: String(page) },
						timeoutMs: PER_PAGE_TIMEOUT_MS,
					},
				);
				if (data.partialResults) throw new Error("qUI exact-hash lookup returned partial results");
				if (expectedTotal === null) expectedTotal = data.total;
				else if (data.total !== expectedTotal)
					throw new Error("qUI exact-hash lookup total changed during pagination");
				const batch = data.cross_instance_torrents ?? [];
				rowsRead += batch.length;
				for (const torrent of batch) {
					const identity = crossInstanceTorrentIdentity(torrent, "exact-hash lookup");
					if (identities.has(identity))
						throw new Error("qUI exact-hash lookup returned a duplicate torrent across pages");
					identities.add(identity);
				}
				if (rowsRead > data.total)
					throw new Error("qUI exact-hash lookup returned more rows than its total");
				exact.push(...batch.filter((torrent) => torrent.hash.toLowerCase() === hash.toLowerCase()));
				if (!data.hasMore) {
					if (rowsRead !== data.total)
						throw new Error("qUI exact-hash lookup ended before its declared total");
					exhausted = true;
					break;
				}
				if (batch.length === 0)
					throw new Error("qUI exact-hash lookup returned an empty page with more results");
			}
			if (!exhausted)
				throw new Error(
					`qUI exact-hash lookup exceeded the ${MAX_PAGES * PAGE_SIZE} torrent safety limit`,
				);
			return exact;
		},

		async getTorrentByHash(hash) {
			const data = await quiRequest(
				ctx,
				"/api/torrents/cross-instance",
				wireCrossInstanceLookupResponseSchema,
				{ query: { search: hash, limit: "20" } },
			);
			const exact = (data.cross_instance_torrents ?? []).filter(
				(torrent) => torrent.hash.toLowerCase() === hash.toLowerCase(),
			);
			for (const torrent of exact) {
				crossInstanceTorrentIdentity(torrent, "exact-hash point lookup");
			}
			return exact[0] ?? null;
		},

		async listAllTorrents(options) {
			return (await fetchTorrentInventory(options?.requireComplete === true)).torrents;
		},

		async listTorrentInventory() {
			return fetchTorrentInventory(false);
		},

		async getTrackers(instanceId, hash) {
			return quiRequest(
				ctx,
				`/api/instances/${instanceId}/torrents/${hash}/trackers`,
				z.array(wireTrackerSchema),
			);
		},

		async getTrackerIcons() {
			// qui returns a flat Record<hostname, dataUrl>. We accept any
			// object whose values are strings — qui may add new fields here
			// in future versions (e.g., per-icon `updatedAt`), but at the
			// data level we only need the data-URL string.
			return quiRequest(ctx, "/api/tracker-icons", z.record(z.string(), z.string()));
		},

		async getTrackerCustomizations() {
			// qui returns an array; each entry has displayName + one or more
			// domain aliases. Other fields (id, createdAt, updatedAt) are
			// metadata we don't use — passthrough() keeps the schema lenient.
			return quiRequest(
				ctx,
				"/api/tracker-customizations",
				z.array(
					z
						.object({
							id: z.number(),
							displayName: z.string(),
							domains: z.array(z.string()),
						})
						.passthrough(),
				),
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

		async getTorrentProperties(instanceId, hash) {
			// qui returns qBit's TorrentProperties shape verbatim — snake_case
			// keys (`addition_date`, `total_size`, `share_ratio`, …). Define a
			// wire schema that accepts the snake_case fields and transforms
			// into our canonical camelCase QuiTorrentProperties via .transform.
			// Defaults handle qBit's "not set" sentinels (-1 / -2) and
			// optional fields that qui doesn't always emit.
			const wireSchema = z
				.object({
					addition_date: z.number().int(),
					completion_date: z.number().int(),
					comment: z.string().default(""),
					total_size: z.number().int(),
					total_downloaded: z.number().int(),
					total_uploaded: z.number().int(),
					share_ratio: z.number(),
					up_speed: z.number().int(),
					dl_speed: z.number().int(),
					up_limit: z.number().int().default(-1),
					dl_limit: z.number().int().default(-1),
					seeds: z.number().int().default(0),
					peers: z.number().int().default(0),
					eta: z.number().int().default(-1),
					ratio_limit: z.number().default(-2),
					seeding_time_limit: z.number().int().default(-2),
					inactive_seeding_time_limit: z.number().int().default(-2),
					save_path: z.string().default(""),
				})
				.passthrough()
				.transform((wire) => ({
					additionDate: wire.addition_date,
					completionDate: wire.completion_date,
					comment: wire.comment,
					totalSize: wire.total_size,
					totalDownloaded: wire.total_downloaded,
					totalUploaded: wire.total_uploaded,
					shareRatio: wire.share_ratio,
					uploadSpeed: wire.up_speed,
					downloadSpeed: wire.dl_speed,
					uploadLimit: wire.up_limit,
					downloadLimit: wire.dl_limit,
					seedsActual: wire.seeds,
					peersActual: wire.peers,
					eta: wire.eta,
					ratioLimit: wire.ratio_limit,
					seedingTimeLimit: wire.seeding_time_limit,
					inactiveSeedingTimeLimit: wire.inactive_seeding_time_limit,
					savePath: wire.save_path,
				}));
			return quiRequest(
				ctx,
				`/api/instances/${instanceId}/torrents/${hash}/properties`,
				wireSchema,
			);
		},

		async getTorrentFiles(instanceId, hash, options) {
			// qui returns qBit's files-list shape — direct JSON array, with
			// snake_case keys per file (`availability`, `index`, `is_seed`,
			// `name`, `piece_range`, `priority`, `progress`, `size`).
			// Confirmed via live diagnostic 2026-05-19. Transform inline to
			// our canonical QuiTorrentFile camelCase shape.
			const query = options?.refresh ? "?refresh=true" : "";
			const wireItemSchema = z
				.object({
					index: z.number().int().optional(),
					name: z.string(),
					size: z.number().int(),
					progress: z.number().min(0).max(1),
					priority: z.number().int(),
					is_seed: z.boolean().optional(),
				})
				.passthrough();
			const wireArraySchema = z.array(wireItemSchema).transform((arr) =>
				arr.map((wire, i) => ({
					index: wire.index ?? i,
					name: wire.name,
					size: wire.size,
					progress: wire.progress,
					priority: wire.priority,
					isSeeding: wire.is_seed,
				})),
			);
			return quiRequest(
				ctx,
				`/api/instances/${instanceId}/torrents/${hash}/files${query}`,
				wireArraySchema,
			);
		},

		async listCategories(instanceId) {
			// qBit returns `{ <name>: { name, savePath } }`. Flatten into an
			// array sorted by name for stable UI ordering. qui's response
			// passes the qBit shape through verbatim. `save_path` may be in
			// snake_case from qBit; tolerate both.
			const raw = await quiRequest(
				ctx,
				`/api/instances/${instanceId}/categories`,
				z.record(
					z.string(),
					z
						.object({
							name: z.string().optional(),
							savePath: z.string().optional(),
							save_path: z.string().optional(),
						})
						.passthrough(),
				),
			);
			return Object.entries(raw)
				.map(([key, value]) => ({
					name: value.name ?? key,
					savePath: value.savePath ?? value.save_path ?? "",
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
		},

		async listTags(instanceId) {
			// qBit returns a flat array of tag-name strings.
			return quiRequest(ctx, `/api/instances/${instanceId}/tags`, z.array(z.string()));
		},

		async getCapabilities(instanceId) {
			// qui emits camelCase JSON for this endpoint already — no
			// snake_case transform needed, parse straight into the schema.
			return quiRequest(ctx, `/api/instances/${instanceId}/capabilities`, quiCapabilitiesSchema);
		},

		async getTransferInfo(instanceId) {
			// qBit's transfer/info is snake_case — transform to canonical
			// camelCase. These are observed speeds/totals, always >= 0.
			const wireSchema = z
				.object({
					dl_info_speed: z.number().int().default(0),
					up_info_speed: z.number().int().default(0),
					dl_info_data: z.number().int().default(0),
					up_info_data: z.number().int().default(0),
					dht_nodes: z.number().int().default(0),
					connection_status: z.string().default("disconnected"),
				})
				.passthrough()
				.transform(
					(w): QuiTransferInfo => ({
						dlSpeed: w.dl_info_speed,
						upSpeed: w.up_info_speed,
						dlData: w.dl_info_data,
						upData: w.up_info_data,
						dhtNodes: w.dht_nodes,
						connectionStatus: w.connection_status,
					}),
				);
			return quiRequest(ctx, `/api/instances/${instanceId}/transfer-info`, wireSchema);
		},

		async getFileMediaInfo(instanceId, hash, fileIndex) {
			// qui returns camelCase JSON already (`fileIndex`, `relativePath`,
			// `streams`); the heavy `rawJSON` field is dropped by the schema.
			return quiRequest(
				ctx,
				`/api/instances/${instanceId}/torrents/${hash}/files/${fileIndex}/mediainfo`,
				quiMediaInfoSchema,
			);
		},

		async getReannounceCandidates(instanceId) {
			// camelCase JSON array; a reannounce-disabled instance returns [].
			return quiRequest(
				ctx,
				`/api/instances/${instanceId}/reannounce/candidates`,
				z.array(quiMonitoredTorrentSchema),
			);
		},

		async renameTorrent(instanceId, hash, name) {
			await quiRequest(ctx, `/api/instances/${instanceId}/torrents/${hash}/rename`, z.unknown(), {
				method: "POST",
				body: { name },
			});
		},

		async addTrackers(instanceId, hash, urls) {
			// qui takes a newline-separated string (mirrors qBit's wire
			// format). Accept an array from callers and join here so the
			// drawer doesn't need to know the wire detail.
			await quiRequest(ctx, `/api/instances/${instanceId}/torrents/${hash}/trackers`, z.unknown(), {
				method: "POST",
				body: { urls: urls.join("\n") },
			});
		},

		async removeTrackers(instanceId, hash, urls) {
			await quiRequest(ctx, `/api/instances/${instanceId}/torrents/${hash}/trackers`, z.unknown(), {
				method: "DELETE",
				body: { urls: urls.join("\n") },
			});
		},

		async editTracker(instanceId, hash, oldURL, newURL) {
			await quiRequest(ctx, `/api/instances/${instanceId}/torrents/${hash}/trackers`, z.unknown(), {
				method: "PUT",
				body: { oldURL, newURL },
			});
		},

		async bulkAction({ qbitInstanceId, hashes, action, extras }) {
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
					...(extras ?? {}),
				},
			});
		},

		async ensureNotificationTarget({
			name,
			url,
			ownerId,
			legacyTargetAdoption = "never",
			reportLegacyCleanupRequired = false,
			eventTypes,
			enabled = true,
		}) {
			type NotificationTarget = z.infer<typeof quiNotificationTargetSchema>;
			const redactSecret = (message: string) => message.replace(/secret=[^&\s"']+/g, "secret=***");
			const requestOptions = {
				redactErrorMessage: redactSecret,
			};
			// qUI interprets an explicit [] as "all events" and expands it to
			// the concrete event list in target responses. Resolve that list
			// up front so an existing subset cannot be mistaken for all events
			// and ambiguous PUT responses remain verifiable. Omitted eventTypes
			// retains qUI's current subscription on update.
			const desiredEventTypes =
				eventTypes?.length === 0
					? (
							await quiRequest(
								ctx,
								"/api/notifications/events",
								z.array(quiNotificationEventDefinitionSchema),
								requestOptions,
							)
						).map((definition) => definition.type)
					: eventTypes;
			const desired = { name, url, eventTypes: desiredEventTypes, enabled };

			const listTargets = () =>
				quiRequest(
					ctx,
					"/api/notifications/targets",
					quiNotificationTargetListSchema,
					requestOptions,
				);
			const updateTarget = (targetId: number, body: typeof desired) =>
				quiRequest(ctx, `/api/notifications/targets/${targetId}`, quiNotificationTargetSchema, {
					...requestOptions,
					method: "PUT",
					body,
				});
			const sameEventTypes = (actual: string[]): boolean => {
				if (desiredEventTypes === undefined) return true;
				const expected = [...new Set(desiredEventTypes)].sort();
				const received = [...new Set(actual)].sort();
				return (
					expected.length === received.length &&
					expected.every((value, index) => value === received[index])
				);
			};
			const matchesDesired = (target: NotificationTarget): boolean =>
				target.name === name &&
				target.url === url &&
				target.enabled === enabled &&
				sameEventTypes(target.eventTypes);
			const callbackIdentity = (value: string): string | null => {
				try {
					const callback = new URL(value);
					callback.hash = "";
					for (const key of ["secret", "instanceId", "deploymentId", "owner"]) {
						callback.searchParams.delete(key);
					}
					callback.searchParams.sort();
					return callback.toString();
				} catch {
					return null;
				}
			};
			const desiredCallbackIdentity = callbackIdentity(url);
			const desiredSecret = (() => {
				try {
					return new URL(url).searchParams.get("secret");
				} catch {
					return null;
				}
			})();
			const isLegacyCandidate = (target: NotificationTarget): boolean => {
				if (!target.enabled || target.name !== "arr-dashboard") return false;
				try {
					const targetUrl = new URL(target.url);
					return (
						!targetUrl.searchParams.has("owner") &&
						desiredCallbackIdentity !== null &&
						callbackIdentity(target.url) === desiredCallbackIdentity
					);
				} catch {
					return false;
				}
			};
			const isOwned = (target: NotificationTarget): boolean => {
				if (target.name === name) return true;
				try {
					const targetUrl = new URL(target.url);
					if (ownerId && targetUrl.searchParams.get("owner") === ownerId) {
						return true;
					}
					return (
						isLegacyCandidate(target) &&
						legacyTargetAdoption === "secret" &&
						desiredSecret !== null &&
						targetUrl.searchParams.get("secret") === desiredSecret
					);
				} catch {
					return false;
				}
			};

			const reconcile = async (
				targets: NotificationTarget[],
			): Promise<{ target: NotificationTarget; cleanupPending: boolean } | null> => {
				let matches = targets.filter(isOwned).sort((left, right) => left.id - right.id);
				const primary = matches.find(matchesDesired) ?? matches[0];
				if (!primary) return null;

				let reconciled = primary;
				if (!matchesDesired(primary)) {
					try {
						reconciled = await updateTarget(primary.id, desired);
						if (!matchesDesired(reconciled)) {
							throw new Error("qUI returned a notification target that does not match the update");
						}
					} catch (updateError) {
						// A lost response can happen after qui commits the PUT.
						// Re-read before surfacing a retryable upstream failure.
						// A concurrent registration may also have created a
						// different owned target that already satisfies the
						// desired state; prefer that valid target over a false
						// total failure and reconcile the stale primary below.
						matches = (await listTargets())
							.filter(isOwned)
							.sort((left, right) => left.id - right.id);
						const afterUpdate = matches.find((target) => target.id === primary.id);
						const validTarget =
							(afterUpdate && matchesDesired(afterUpdate) ? afterUpdate : null) ??
							matches.find(matchesDesired);
						if (!validTarget) {
							throw updateError;
						}
						reconciled = validTarget;
					}
				}

				// Old retries may already have created more than one target.
				// Keep the oldest as the canonical registration and disable
				// every other enabled copy so stale secrets cannot keep firing
				// rejected callbacks or consume the receiver's rate limit.
				let cleanupPending = false;
				for (const duplicate of matches.filter((target) => target.id !== reconciled.id)) {
					if (!duplicate.enabled) continue;
					try {
						const disabled = await updateTarget(duplicate.id, {
							name: duplicate.name,
							url: duplicate.url,
							eventTypes: duplicate.eventTypes,
							enabled: false,
						});
						if (disabled.enabled) {
							throw new Error("qUI did not disable a duplicate notification target");
						}
					} catch {
						let cleanupConfirmed = false;
						try {
							const afterDisable = (await listTargets()).find(
								(target) => target.id === duplicate.id,
							);
							cleanupConfirmed = afterDisable?.enabled === false;
						} catch {
							// The canonical target is already valid. Preserve
							// that success and report cleanup as retryable.
						}
						if (!cleanupConfirmed) {
							cleanupPending = true;
							ctx.log.warn(
								{ targetId: duplicate.id },
								"qUI notification target registered but duplicate cleanup remains pending",
							);
						}
					}
				}

				return { target: reconciled, cleanupPending };
			};

			const initialTargets = await listTargets();
			const legacyCleanupRequired =
				reportLegacyCleanupRequired &&
				initialTargets.some((target) => isLegacyCandidate(target) && !isOwned(target));
			const resultStatus = (cleanupPending = false) => ({
				...(cleanupPending ? { cleanupPending: true as const } : {}),
				...(legacyCleanupRequired ? { legacyCleanupRequired: true as const } : {}),
			});

			const existing = await reconcile(initialTargets);
			if (existing) {
				return {
					id: existing.target.id,
					...resultStatus(existing.cleanupPending),
				};
			}

			let created: NotificationTarget;
			try {
				created = await quiRequest(ctx, "/api/notifications/targets", quiNotificationTargetSchema, {
					...requestOptions,
					method: "POST",
					body: desired,
				});
			} catch (createError) {
				// The POST may have committed even if its response was lost.
				// Discover and reconcile that target before deciding the
				// registration failed; the next click must not create another.
				try {
					const recovered = await reconcile(await listTargets());
					if (recovered) {
						return {
							id: recovered.target.id,
							...resultStatus(recovered.cleanupPending),
						};
					}
				} catch {
					// Preserve the original, already-redacted create failure.
				}
				throw createError;
			}

			// A concurrent registration can race the initial list. Re-list
			// after a successful create and collapse any enabled duplicates.
			let afterCreate: NotificationTarget[];
			try {
				afterCreate = await listTargets();
			} catch {
				return { id: created.id, ...resultStatus(true) };
			}
			const reconciled = await reconcile(afterCreate);
			return {
				id: reconciled?.target.id ?? created.id,
				...resultStatus(reconciled?.cleanupPending),
			};
		},

		async triggerDirScan(path) {
			// qui's webhook endpoint accepts native *arr webhook shapes
			// OR a simplified `{"path": "..."}` body. We use the latter
			// (the "simple mode" branch in qui's WebhookTriggerScan
			// handler). qui responds 202 with the run id when the scan
			// is queued, 404 if no configured dir-scan covers the path,
			// 409 if a scan is already in progress for the directory.
			//
			// Path nuances confirmed against qui internal/api/server.go:
			//   r.Route("/dir-scan/webhook", ...).Post("/scan", ...)
			// So the full route is `/api/dir-scan/webhook/scan` —
			// note the HYPHEN in "dir-scan" and the trailing "/scan".
			// Easy to get wrong; pin tightly.
			//
			// camelCase response shape — qui's dirScanTriggerResponse
			// already uses camelCase JSON keys, so we don't need a
			// snake_case → camelCase transform here.
			return quiRequest(
				ctx,
				"/api/dir-scan/webhook/scan",
				z.object({
					runId: z.number().int(),
					directoryId: z.number().int(),
					directoryPath: z.string(),
					scanRoot: z.string(),
				}),
				{
					method: "POST",
					body: { path },
				},
			);
		},
	};
}
