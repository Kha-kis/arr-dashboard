/**
 * Source reader for Sonarr/Radarr instances.
 *
 * Walks the *arr instance for tags, finds the one matching `sourceTagName`,
 * fetches all items, filters by tag, and yields tmdbId-keyed candidates.
 */

import { ArrError } from "arr-sdk";
import type { ArrClient } from "../../arr/client-factory.js";
import type { ServiceType } from "../../prisma.js";
import type {
	MatchCandidate,
	SourceReader,
	SourceReaderOpts,
	SourceReadResult,
} from "../strategy-types.js";

interface ArrReaderConfig {
	prismaService: Extract<ServiceType, "SONARR" | "RADARR">;
	mediaType: "series" | "movie";
	itemsAccessor: "series" | "movie";
}

const SONARR: ArrReaderConfig = {
	prismaService: "SONARR",
	mediaType: "series",
	itemsAccessor: "series",
};

const RADARR: ArrReaderConfig = {
	prismaService: "RADARR",
	mediaType: "movie",
	itemsAccessor: "movie",
};

export const sonarrSourceReader: SourceReader = createArrReader(SONARR);
export const radarrSourceReader: SourceReader = createArrReader(RADARR);

function createArrReader(config: ArrReaderConfig): SourceReader {
	return {
		prismaService: config.prismaService,
		async readTaggedItems(opts: SourceReaderOpts): Promise<SourceReadResult> {
			const { rule, sourceInstance, arrClientFactory, log } = opts;

			let arrClient: ArrClient;
			try {
				arrClient = arrClientFactory.create({
					id: sourceInstance.id,
					baseUrl: sourceInstance.baseUrl,
					encryptedApiKey: sourceInstance.encryptedApiKey,
					encryptionIv: sourceInstance.encryptionIv,
					service: sourceInstance.service,
					label: sourceInstance.label,
				});
			} catch (err) {
				log.warn({ err }, "Failed to create source *arr client; skipping instance");
				return { matches: [], failed: true };
			}

			let tagId: number | undefined;
			try {
				// arr-sdk's Sonarr/Radarr Tag types are structurally identical
				// ({ id, label }) but the union return type doesn't unify cleanly,
				// so we narrow via a local cast to the shared shape.
				const tags = (await arrClient.tag.getAll()) as Array<{ id: number; label: string }>;
				tagId = tags.find((t) => t.label === rule.sourceTagName)?.id;
			} catch (err) {
				const arrErr = err instanceof ArrError ? err.message : String(err);
				log.warn({ err: arrErr }, "Failed to fetch tags from source *arr instance");
				return { matches: [], failed: true };
			}

			if (tagId === undefined) {
				log.info({ tagName: rule.sourceTagName }, "Tag not found on this source instance");
				return { matches: [], failed: false };
			}

			let arrItems: Array<{ tmdbId?: number | null; tags?: number[] | null; title?: string }>;
			try {
				// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
				const resource = (arrClient as any)[config.itemsAccessor];
				arrItems = (await resource.getAll()) as typeof arrItems;
			} catch (err) {
				log.warn({ err }, "Failed to fetch items from source *arr instance");
				return { matches: [], failed: true };
			}

			const tagged = arrItems.filter(
				(item) => Array.isArray(item.tags) && item.tags.includes(tagId),
			);

			const matches: MatchCandidate[] = tagged
				.map((item) => ({
					tmdbId: item.tmdbId ?? 0,
					title: item.title ?? "(untitled)",
					mediaType: config.mediaType,
				}))
				.filter((m) => m.tmdbId > 0);

			return { matches, failed: false };
		},
	};
}
