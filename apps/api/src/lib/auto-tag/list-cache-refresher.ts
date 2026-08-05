/**
 * List-cache refreshers — TMDb v3 + Trakt.
 *
 * For each enabled `AutoTagRule` with `ruleType` `tmdb_list_member` or
 * `trakt_list_member` (or composite rule containing such a condition),
 * extract the list identifier, fetch the live membership from the
 * upstream API, and atomically replace `TmdbListCache` / `TraktListCache`
 * alongside a successful-generation pointer.
 *
 * Refresh cadence: every 4 hours (registry-declared `intervalMs`).
 * Stale rows for lists that aren't referenced by any enabled rule
 * anymore are garbage-collected at the end of each run.
 */

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient } from "../prisma.js";
import { createTmdbV3Client } from "../tmdb/list-client.js";
import { createTraktClient } from "../trakt/list-client.js";
import { safeJsonParse } from "../utils/json.js";

interface RefresherDeps {
	prisma: PrismaClient;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

interface RefresherResult {
	usersScanned: number;
	listsRefreshed: number;
	itemsUpserted: number;
	failures: number;
	orphansDeleted: number;
}

// ============================================================================
// TMDb refresher
// ============================================================================

export async function refreshTmdbListCache(deps: RefresherDeps): Promise<RefresherResult> {
	const { prisma, encryptor, log } = deps;

	// Collect (userId, listId) pairs from every enabled rule that uses tmdb_list_member.
	const targets = await collectListTargets(prisma, "tmdb_list_member", "listId");

	let usersScanned = 0;
	let listsRefreshed = 0;
	let itemsUpserted = 0;
	let failures = 0;

	for (const [userId, listIds] of targets) {
		usersScanned++;

		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { encryptedTmdbApiKey: true, tmdbEncryptionIv: true },
		});
		if (!user?.encryptedTmdbApiKey || !user.tmdbEncryptionIv) {
			log.debug({ userId }, "User has no TMDb API key — skipping their list refresh");
			for (const listId of listIds) {
				failures++;
				await recordListRefreshFailure(
					prisma,
					userId,
					"tmdb",
					listId,
					"TMDb credentials are unavailable",
				);
			}
			continue;
		}

		let apiKey: string;
		try {
			apiKey = encryptor.decrypt({
				value: user.encryptedTmdbApiKey,
				iv: user.tmdbEncryptionIv,
			});
		} catch (err) {
			log.warn({ err, userId }, "Failed to decrypt TMDb API key");
			for (const listId of listIds) {
				failures++;
				await recordListRefreshFailure(
					prisma,
					userId,
					"tmdb",
					listId,
					"TMDb credentials could not be decrypted",
				);
			}
			continue;
		}

		const client = createTmdbV3Client(apiKey, log);

		for (const listId of listIds) {
			try {
				const items = await client.getListItems(listId);
				await publishTmdbListGeneration(prisma, userId, listId, items);
				listsRefreshed++;
				itemsUpserted += items.length;
			} catch (err) {
				failures++;
				await recordListRefreshFailure(
					prisma,
					userId,
					"tmdb",
					listId,
					getRefreshErrorMessage(err),
				).catch((statusError) => {
					log.warn({ err: statusError, userId, listId }, "Failed to record TMDb list failure");
				});
				log.warn({ err, userId, listId }, "Failed to refresh TMDb list");
			}
		}
	}

	const orphansDeleted = await deleteOrphanedTmdbCacheRows(prisma, targets);

	log.info(
		{ usersScanned, listsRefreshed, itemsUpserted, failures, orphansDeleted },
		"TMDb list cache refresh complete",
	);
	return { usersScanned, listsRefreshed, itemsUpserted, failures, orphansDeleted };
}

// ============================================================================
// Trakt refresher
// ============================================================================

export async function refreshTraktListCache(
	deps: RefresherDeps,
	options: { traktClientId: string | null },
): Promise<RefresherResult> {
	const { prisma, encryptor, log } = deps;

	if (!options.traktClientId) {
		log.debug("TRAKT_CLIENT_ID not configured — skipping Trakt list cache refresh");
		return {
			usersScanned: 0,
			listsRefreshed: 0,
			itemsUpserted: 0,
			failures: 0,
			orphansDeleted: 0,
		};
	}

	const targets = await collectListTargets(prisma, "trakt_list_member", "listSlug");

	let usersScanned = 0;
	let listsRefreshed = 0;
	let itemsUpserted = 0;
	let failures = 0;

	for (const [userId, listSlugs] of targets) {
		usersScanned++;

		const user = await prisma.user.findUnique({
			where: { id: userId },
			select: { encryptedTraktAccessToken: true, traktTokenIv: true },
		});
		if (!user?.encryptedTraktAccessToken || !user.traktTokenIv) {
			log.debug({ userId }, "User has no Trakt PAT — skipping their list refresh");
			for (const listSlug of listSlugs) {
				failures++;
				await recordListRefreshFailure(
					prisma,
					userId,
					"trakt",
					listSlug,
					"Trakt credentials are unavailable",
				);
			}
			continue;
		}

		let accessToken: string;
		try {
			accessToken = encryptor.decrypt({
				value: user.encryptedTraktAccessToken,
				iv: user.traktTokenIv,
			});
		} catch (err) {
			log.warn({ err, userId }, "Failed to decrypt Trakt access token");
			for (const listSlug of listSlugs) {
				failures++;
				await recordListRefreshFailure(
					prisma,
					userId,
					"trakt",
					listSlug,
					"Trakt credentials could not be decrypted",
				);
			}
			continue;
		}

		const client = createTraktClient(accessToken, options.traktClientId, log);

		for (const listSlug of listSlugs) {
			try {
				const items = await client.getListItems(listSlug);
				await publishTraktListGeneration(prisma, userId, listSlug, items);
				listsRefreshed++;
				itemsUpserted += items.length;
			} catch (err) {
				failures++;
				await recordListRefreshFailure(
					prisma,
					userId,
					"trakt",
					listSlug,
					getRefreshErrorMessage(err),
				).catch((statusError) => {
					log.warn({ err: statusError, userId, listSlug }, "Failed to record Trakt list failure");
				});
				log.warn({ err, userId, listSlug }, "Failed to refresh Trakt list");
			}
		}
	}

	const orphansDeleted = await deleteOrphanedTraktCacheRows(prisma, targets);

	log.info(
		{ usersScanned, listsRefreshed, itemsUpserted, failures, orphansDeleted },
		"Trakt list cache refresh complete",
	);
	return { usersScanned, listsRefreshed, itemsUpserted, failures, orphansDeleted };
}

// ============================================================================
// Helpers
// ============================================================================

type ListItem = { tmdbId: number; mediaType: "movie" | "series"; title: string };

function getRefreshErrorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function dedupeListItems(items: ListItem[]): ListItem[] {
	const byTypedId = new Map<string, ListItem>();
	for (const item of items) {
		const key = `${item.mediaType}:${item.tmdbId}`;
		if (byTypedId.has(key)) {
			throw new Error(`List returned duplicate membership ${key}`);
		}
		byTypedId.set(key, item);
	}
	return [...byTypedId.values()].sort(
		(left, right) =>
			left.mediaType.localeCompare(right.mediaType) ||
			left.tmdbId - right.tmdbId ||
			left.title.localeCompare(right.title),
	);
}

export async function publishTmdbListGeneration(
	prisma: PrismaClient,
	userId: string,
	listId: string,
	items: ListItem[],
): Promise<void> {
	const rows = dedupeListItems(items);
	const generationId = randomUUID();
	const completedAt = new Date();
	await prisma.$transaction(async (tx) => {
		await tx.tmdbListCache.deleteMany({ where: { userId, listId } });
		if (rows.length > 0) {
			await tx.tmdbListCache.createMany({
				data: rows.map((item) => ({
					userId,
					listId,
					tmdbId: item.tmdbId,
					mediaType: item.mediaType,
					title: item.title,
					generation: generationId,
					refreshedAt: completedAt,
				})),
			});
		}
		await tx.listCacheRefreshStatus.upsert({
			where: { userId_provider_listKey: { userId, provider: "tmdb", listKey: listId } },
			create: {
				userId,
				provider: "tmdb",
				listKey: listId,
				generationId,
				lastRefreshedAt: completedAt,
				lastResult: "success",
				itemCount: rows.length,
				lastAttemptAt: completedAt,
				lastAttemptResult: "success",
			},
			update: {
				generationId,
				lastRefreshedAt: completedAt,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: rows.length,
				lastAttemptAt: completedAt,
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
			},
		});
	});
}

export async function publishTraktListGeneration(
	prisma: PrismaClient,
	userId: string,
	listSlug: string,
	items: ListItem[],
): Promise<void> {
	const rows = dedupeListItems(items);
	const generationId = randomUUID();
	const completedAt = new Date();
	await prisma.$transaction(async (tx) => {
		await tx.traktListCache.deleteMany({ where: { userId, listSlug } });
		if (rows.length > 0) {
			await tx.traktListCache.createMany({
				data: rows.map((item) => ({
					userId,
					listSlug,
					tmdbId: item.tmdbId,
					mediaType: item.mediaType,
					title: item.title,
					generation: generationId,
					refreshedAt: completedAt,
				})),
			});
		}
		await tx.listCacheRefreshStatus.upsert({
			where: { userId_provider_listKey: { userId, provider: "trakt", listKey: listSlug } },
			create: {
				userId,
				provider: "trakt",
				listKey: listSlug,
				generationId,
				lastRefreshedAt: completedAt,
				lastResult: "success",
				itemCount: rows.length,
				lastAttemptAt: completedAt,
				lastAttemptResult: "success",
			},
			update: {
				generationId,
				lastRefreshedAt: completedAt,
				lastResult: "success",
				lastErrorMessage: null,
				itemCount: rows.length,
				lastAttemptAt: completedAt,
				lastAttemptResult: "success",
				lastAttemptErrorMessage: null,
			},
		});
	});
}

async function recordListRefreshFailure(
	prisma: PrismaClient,
	userId: string,
	provider: "tmdb" | "trakt",
	listKey: string,
	message: string,
): Promise<void> {
	const attemptedAt = new Date();
	await prisma.listCacheRefreshStatus.upsert({
		where: { userId_provider_listKey: { userId, provider, listKey } },
		create: {
			userId,
			provider,
			listKey,
			lastErrorMessage: message,
			lastAttemptAt: attemptedAt,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: message,
		},
		update: {
			lastErrorMessage: message,
			lastAttemptAt: attemptedAt,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: message,
		},
	});
}

/**
 * Walk every enabled AutoTagRule and extract the (userId, listIdentifier)
 * targets for the given rule type. Handles both leaf rules (`ruleType`
 * matches directly) and composite rules (look in `conditions`).
 */
async function collectListTargets(
	prisma: PrismaClient,
	targetRuleType: "tmdb_list_member" | "trakt_list_member",
	identifierKey: "listId" | "listSlug",
): Promise<Map<string, Set<string>>> {
	const rules = await prisma.autoTagRule.findMany({
		where: { enabled: true },
		select: { userId: true, ruleType: true, parameters: true, conditions: true },
	});

	const out = new Map<string, Set<string>>();
	for (const rule of rules) {
		const collected = collectIdentifiersFromRule(rule, targetRuleType, identifierKey);
		if (collected.length === 0) continue;
		let bucket = out.get(rule.userId);
		if (!bucket) {
			bucket = new Set();
			out.set(rule.userId, bucket);
		}
		for (const id of collected) bucket.add(id);
	}
	return out;
}

function collectIdentifiersFromRule(
	rule: { ruleType: string; parameters: string; conditions: string | null },
	targetRuleType: string,
	identifierKey: string,
): string[] {
	const identifiers: string[] = [];

	// Leaf rule
	if (rule.ruleType === targetRuleType) {
		const params = safeJsonParse(rule.parameters) as Record<string, unknown> | null;
		const id = params?.[identifierKey];
		if (typeof id === "string" && id.trim().length > 0) identifiers.push(id);
	}

	// Composite rule — check each condition
	if (rule.ruleType === "composite" && rule.conditions) {
		const conds = safeJsonParse(rule.conditions);
		if (Array.isArray(conds)) {
			for (const cond of conds) {
				if (
					cond &&
					typeof cond === "object" &&
					(cond as Record<string, unknown>).ruleType === targetRuleType
				) {
					const params = (cond as Record<string, unknown>).parameters as
						| Record<string, unknown>
						| undefined;
					const id = params?.[identifierKey];
					if (typeof id === "string" && id.trim().length > 0) identifiers.push(id);
				}
			}
		}
	}

	return identifiers;
}

async function deleteOrphanedTmdbCacheRows(
	prisma: PrismaClient,
	activeTargets: Map<string, Set<string>>,
): Promise<number> {
	// For each user, delete cache rows for listIds no longer referenced
	// by any enabled rule.
	let deleted = 0;
	const [rowUsers, statusUsers] = await Promise.all([
		prisma.tmdbListCache.findMany({
			select: { userId: true },
			distinct: ["userId"],
		}),
		prisma.listCacheRefreshStatus.findMany({
			where: { provider: "tmdb" },
			select: { userId: true },
			distinct: ["userId"],
		}),
	]);
	const userIds = [...new Set([...rowUsers, ...statusUsers].map(({ userId }) => userId))];
	for (const userId of userIds) {
		const activeListIds = [...(activeTargets.get(userId) ?? new Set<string>())];
		const result = await prisma.$transaction(async (tx) => {
			const deletedRows = await tx.tmdbListCache.deleteMany({
				where: {
					userId,
					listId: activeListIds.length > 0 ? { notIn: activeListIds } : undefined,
				},
			});
			await tx.listCacheRefreshStatus.deleteMany({
				where: {
					userId,
					provider: "tmdb",
					listKey: activeListIds.length > 0 ? { notIn: activeListIds } : undefined,
				},
			});
			return deletedRows;
		});
		deleted += result.count;
	}
	return deleted;
}

async function deleteOrphanedTraktCacheRows(
	prisma: PrismaClient,
	activeTargets: Map<string, Set<string>>,
): Promise<number> {
	let deleted = 0;
	const [rowUsers, statusUsers] = await Promise.all([
		prisma.traktListCache.findMany({ select: { userId: true }, distinct: ["userId"] }),
		prisma.listCacheRefreshStatus.findMany({
			where: { provider: "trakt" },
			select: { userId: true },
			distinct: ["userId"],
		}),
	]);
	const userIds = [...new Set([...rowUsers, ...statusUsers].map(({ userId }) => userId))];
	for (const userId of userIds) {
		const activeListSlugs = [...(activeTargets.get(userId) ?? new Set<string>())];
		const result = await prisma.$transaction(async (tx) => {
			const deletedRows = await tx.traktListCache.deleteMany({
				where: {
					userId,
					listSlug: activeListSlugs.length > 0 ? { notIn: activeListSlugs } : undefined,
				},
			});
			await tx.listCacheRefreshStatus.deleteMany({
				where: {
					userId,
					provider: "trakt",
					listKey: activeListSlugs.length > 0 ? { notIn: activeListSlugs } : undefined,
				},
			});
			return deletedRows;
		});
		deleted += result.count;
	}
	return deleted;
}
