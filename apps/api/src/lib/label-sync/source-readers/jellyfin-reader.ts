/**
 * Source reader for Jellyfin / Emby instances.
 *
 * Jellyfin/Emby don't have an equivalent of `PlexCache.labels` — the cache
 * tracks tmdbId / collections / playback but not per-item Tags. So we hit the
 * live `/Users/{userId}/Items?Tags=...` API. Server-side filter, fast even
 * for large libraries, and stays current without a cache rebuild.
 */

import type { Encryptor } from "../../auth/encryption.js";
import { JellyfinClient } from "../../jellyfin/jellyfin-client.js";
import type { ServiceInstance, ServiceType } from "../../prisma.js";
import type {
	MatchCandidate,
	SourceReader,
	SourceReaderOpts,
	SourceReadResult,
} from "../strategy-types.js";

interface JellyfinReaderConfig {
	prismaService: Extract<ServiceType, "JELLYFIN" | "EMBY">;
}

const JELLYFIN: JellyfinReaderConfig = { prismaService: "JELLYFIN" };
const EMBY: JellyfinReaderConfig = { prismaService: "EMBY" };

export const jellyfinSourceReader: SourceReader = createReader(JELLYFIN);
export const embySourceReader: SourceReader = createReader(EMBY);

function createReader(config: JellyfinReaderConfig): SourceReader {
	return {
		prismaService: config.prismaService,
		async readTaggedItems(opts: SourceReaderOpts): Promise<SourceReadResult> {
			const { rule, sourceInstance, encryptor, log } = opts;

			let client: JellyfinClient;
			try {
				client = createJellyfinClient(encryptor, sourceInstance, log);
			} catch (err) {
				log.warn({ err }, "Failed to initialize Jellyfin/Emby source client");
				return { matches: [], failed: true };
			}

			let userId: string;
			try {
				userId = await pickUserId(client);
			} catch (err) {
				log.warn({ err }, "Failed to resolve a Jellyfin/Emby user id");
				return { matches: [], failed: true };
			}

			let items: Awaited<ReturnType<JellyfinClient["getItemsByTag"]>>;
			try {
				items = await client.getItemsByTag(userId, rule.sourceTagName);
			} catch (err) {
				log.warn({ err }, "Failed to fetch tagged items from Jellyfin/Emby");
				return { matches: [], failed: true };
			}

			const matches: MatchCandidate[] = [];
			for (const item of items) {
				const mediaType = mapItemTypeToMediaType(item.type);
				if (!mediaType) continue;
				if (!item.tmdbId || item.tmdbId <= 0) continue;
				matches.push({ tmdbId: item.tmdbId, title: item.name, mediaType });
			}

			return { matches, failed: false };
		},
	};
}

function createJellyfinClient(
	encryptor: Encryptor,
	instance: ServiceInstance,
	log: SourceReaderOpts["log"],
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

function mapItemTypeToMediaType(type: string): "series" | "movie" | undefined {
	if (type === "Movie") return "movie";
	if (type === "Series") return "series";
	return undefined;
}
