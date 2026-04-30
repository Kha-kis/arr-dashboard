/**
 * Destination writer for Jellyfin / Emby instances.
 *
 * Resolves match candidates against JellyfinCache (keyed on tmdbId) to find
 * each item's `jellyfinId`, then calls `addItemTag` on the live API. Unlike
 * Plex, Jellyfin/Emby don't distinguish "label" vs "tag" — the single Tags
 * collection plays both roles.
 */

import type { Encryptor } from "../../auth/encryption.js";
import { JellyfinClient } from "../../jellyfin/jellyfin-client.js";
import type { ServiceInstance, ServiceType } from "../../prisma.js";
import type {
	DestWriteResult,
	DestWriter,
	DestWriterOpts,
	MatchCandidate,
} from "../strategy-types.js";

interface JellyfinWriterConfig {
	prismaService: Extract<ServiceType, "JELLYFIN" | "EMBY">;
}

export const jellyfinDestWriter: DestWriter = createWriter({ prismaService: "JELLYFIN" });
export const embyDestWriter: DestWriter = createWriter({ prismaService: "EMBY" });

function createWriter(config: JellyfinWriterConfig): DestWriter {
	return {
		prismaService: config.prismaService,
		async applyLabels(opts: DestWriterOpts): Promise<DestWriteResult> {
			const { rule, destInstance, candidates, prisma, encryptor, log } = opts;

			if (candidates.length === 0) {
				return { matchesFound: 0, labelsApplied: 0, failures: 0 };
			}

			let client: JellyfinClient;
			try {
				client = createJellyfinClient(encryptor, destInstance, log);
			} catch (err) {
				log.warn({ err }, "Failed to initialize destination Jellyfin/Emby client");
				return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
			}

			let userId: string;
			try {
				userId = await pickUserId(client);
			} catch (err) {
				log.warn({ err }, "Failed to resolve a Jellyfin/Emby user id for write");
				return { matchesFound: 0, labelsApplied: 0, failures: candidates.length };
			}

			const tmdbIds = unique(candidates.map((c) => c.tmdbId));
			const candidatesByTmdb = new Map<number, MatchCandidate>();
			for (const c of candidates) {
				candidatesByTmdb.set(c.tmdbId, c);
			}

			const cacheRows = await prisma.jellyfinCache.findMany({
				where: {
					instanceId: rule.destInstanceId,
					tmdbId: { in: tmdbIds },
				},
				select: { jellyfinId: true, title: true, tmdbId: true, mediaType: true },
			});

			const matched = cacheRows.filter((row) => {
				const candidate = candidatesByTmdb.get(row.tmdbId);
				return candidate && candidate.mediaType === row.mediaType;
			});

			let labelsApplied = 0;
			let failures = 0;
			for (const row of matched) {
				if (!row.jellyfinId) {
					log.warn(
						{ tmdbId: row.tmdbId, title: row.title },
						"Cached row missing jellyfinId; cannot apply tag",
					);
					failures++;
					continue;
				}

				try {
					await client.addItemTag(userId, row.jellyfinId, rule.destTagName);
					labelsApplied++;
				} catch (err) {
					log.warn({ jellyfinId: row.jellyfinId, err }, "Failed to apply Jellyfin/Emby tag");
					failures++;
				}
			}

			return { matchesFound: matched.length, labelsApplied, failures };
		},
	};
}

function createJellyfinClient(
	encryptor: Encryptor,
	instance: ServiceInstance,
	log: DestWriterOpts["log"],
): JellyfinClient {
	const apiKey = encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});
	return new JellyfinClient(instance.baseUrl, apiKey, log);
}

async function pickUserId(client: JellyfinClient): Promise<string> {
	const users = await client.getUsers();
	const first = users[0];
	if (!first) {
		throw new Error("No Jellyfin/Emby users available");
	}
	return first.id;
}

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}
