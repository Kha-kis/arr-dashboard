/**
 * List-cache refreshers — TMDb v3 + Trakt.
 *
 * For each enabled `AutoTagRule` with `ruleType` `tmdb_list_member` or
 * `trakt_list_member` (or composite rule containing such a condition),
 * extract the list identifier, fetch the live membership from the
 * upstream API, and upsert into `TmdbListCache` / `TraktListCache`.
 *
 * Refresh cadence: every 4 hours (registry-declared `intervalMs`).
 * Stale rows for lists that aren't referenced by any enabled rule
 * anymore are garbage-collected at the end of each run.
 */

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
			failures++;
			continue;
		}

		const client = createTmdbV3Client(apiKey, log);

		for (const listId of listIds) {
			try {
				const items = await client.getListItems(listId);
				listsRefreshed++;

				// Upsert all items, then delete rows for items no longer on the list.
				const seenTmdbIds = new Set<number>();
				for (const item of items) {
					await prisma.tmdbListCache.upsert({
						where: {
							userId_listId_tmdbId: {
								userId,
								listId,
								tmdbId: item.tmdbId,
							},
						},
						update: {
							mediaType: item.mediaType,
							title: item.title,
							refreshedAt: new Date(),
						},
						create: {
							userId,
							listId,
							tmdbId: item.tmdbId,
							mediaType: item.mediaType,
							title: item.title,
						},
					});
					itemsUpserted++;
					seenTmdbIds.add(item.tmdbId);
				}

				// GC stale rows: anything in cache for this list that wasn't on this fetch.
				await prisma.tmdbListCache.deleteMany({
					where: {
						userId,
						listId,
						tmdbId: { notIn: [...seenTmdbIds] },
					},
				});
			} catch (err) {
				failures++;
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
			failures++;
			continue;
		}

		const client = createTraktClient(accessToken, options.traktClientId, log);

		for (const listSlug of listSlugs) {
			try {
				const items = await client.getListItems(listSlug);
				listsRefreshed++;

				const seenTmdbIds = new Set<number>();
				for (const item of items) {
					await prisma.traktListCache.upsert({
						where: {
							userId_listSlug_tmdbId: {
								userId,
								listSlug,
								tmdbId: item.tmdbId,
							},
						},
						update: {
							mediaType: item.mediaType,
							title: item.title,
							refreshedAt: new Date(),
						},
						create: {
							userId,
							listSlug,
							tmdbId: item.tmdbId,
							mediaType: item.mediaType,
							title: item.title,
						},
					});
					itemsUpserted++;
					seenTmdbIds.add(item.tmdbId);
				}

				await prisma.traktListCache.deleteMany({
					where: {
						userId,
						listSlug,
						tmdbId: { notIn: [...seenTmdbIds] },
					},
				});
			} catch (err) {
				failures++;
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
	const userIds = await prisma.tmdbListCache.findMany({
		select: { userId: true },
		distinct: ["userId"],
	});
	for (const { userId } of userIds) {
		const activeListIds = [...(activeTargets.get(userId) ?? new Set<string>())];
		const result = await prisma.tmdbListCache.deleteMany({
			where: {
				userId,
				listId: activeListIds.length > 0 ? { notIn: activeListIds } : undefined, // no active lists → delete all this user's rows
				...(activeListIds.length === 0 ? {} : {}),
			},
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
	const userIds = await prisma.traktListCache.findMany({
		select: { userId: true },
		distinct: ["userId"],
	});
	for (const { userId } of userIds) {
		const activeListSlugs = [...(activeTargets.get(userId) ?? new Set<string>())];
		const result = await prisma.traktListCache.deleteMany({
			where: {
				userId,
				listSlug: activeListSlugs.length > 0 ? { notIn: activeListSlugs } : undefined,
			},
		});
		deleted += result.count;
	}
	return deleted;
}
