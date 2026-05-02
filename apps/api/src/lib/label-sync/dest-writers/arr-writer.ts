/**
 * Destination writer for Sonarr / Radarr instances.
 *
 * Get-or-create the destination tag, fetch matching items by tmdbId, then
 * merge the tag id into each item's `tags` array via `series.update` /
 * `movie.update`.
 */

import { ArrError } from "arr-sdk";
import type { ArrClient } from "../../arr/client-factory.js";
import type { ServiceType } from "../../prisma.js";
import type {
	DestWriteResult,
	DestWriter,
	DestWriterOpts,
	MatchCandidate,
} from "../strategy-types.js";

interface ArrWriterConfig {
	prismaService: Extract<ServiceType, "SONARR" | "RADARR">;
	mediaType: "series" | "movie";
	itemsAccessor: "series" | "movie";
}

const SONARR: ArrWriterConfig = {
	prismaService: "SONARR",
	mediaType: "series",
	itemsAccessor: "series",
};

const RADARR: ArrWriterConfig = {
	prismaService: "RADARR",
	mediaType: "movie",
	itemsAccessor: "movie",
};

export const sonarrDestWriter: DestWriter = createWriter(SONARR);
export const radarrDestWriter: DestWriter = createWriter(RADARR);

function createWriter(config: ArrWriterConfig): DestWriter {
	return {
		prismaService: config.prismaService,
		async applyLabels(opts: DestWriterOpts): Promise<DestWriteResult> {
			const { rule, destInstance, candidates, arrClientFactory, log } = opts;

			// Skip candidates whose mediaType doesn't match this writer — a
			// Plex-source rule can yield mixed series + movie matches; we only
			// apply to the ones this *arr instance handles.
			const relevant = candidates.filter((c) => c.mediaType === config.mediaType);
			if (relevant.length === 0) {
				return { matchesFound: 0, labelsApplied: 0, failures: 0 };
			}

			let arrClient: ArrClient;
			try {
				arrClient = arrClientFactory.create({
					id: destInstance.id,
					baseUrl: destInstance.baseUrl,
					encryptedApiKey: destInstance.encryptedApiKey,
					encryptionIv: destInstance.encryptionIv,
					service: destInstance.service,
					label: destInstance.label,
				});
			} catch (err) {
				log.warn({ err }, "Failed to initialize destination *arr client");
				return { matchesFound: 0, labelsApplied: 0, failures: relevant.length };
			}

			let tagId: number;
			try {
				tagId = await ensureTag(arrClient, rule.destTagName);
			} catch (err) {
				const reason = err instanceof ArrError ? err.message : String(err);
				log.warn(
					{ err: reason, tag: rule.destTagName },
					"Failed to get-or-create destination *arr tag",
				);
				return { matchesFound: 0, labelsApplied: 0, failures: relevant.length };
			}

			let arrItems: Array<{ id: number; tmdbId?: number | null; tags?: number[] | null }>;
			try {
				// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
				const resource = (arrClient as any)[config.itemsAccessor];
				arrItems = (await resource.getAll()) as typeof arrItems;
			} catch (err) {
				log.warn({ err }, "Failed to fetch destination *arr items");
				return { matchesFound: 0, labelsApplied: 0, failures: relevant.length };
			}

			const wantTmdbIds = new Set(relevant.map((c: MatchCandidate) => c.tmdbId));
			const matched = arrItems.filter(
				(item) => typeof item.tmdbId === "number" && wantTmdbIds.has(item.tmdbId),
			);

			let labelsApplied = 0;
			let failures = 0;
			for (const item of matched) {
				const existingTags = Array.isArray(item.tags) ? item.tags : [];
				if (existingTags.includes(tagId)) {
					labelsApplied++; // idempotent — already applied
					continue;
				}

				const mergedTags = [...existingTags, tagId];
				try {
					// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
					const resource = (arrClient as any)[config.itemsAccessor];
					// Radarr/Sonarr PUT endpoints require the full resource —
					// validators reject partial bodies with errors like
					// "'Quality Profile Id' must be greater than '0'". Fetch the
					// current item so the update preserves every field the *arr
					// expects.
					const fullItem = await resource.getById(item.id);
					await resource.update(item.id, {
						...fullItem,
						id: item.id,
						tags: mergedTags,
					});
					labelsApplied++;
				} catch (err) {
					const reason = err instanceof ArrError ? err.message : String(err);
					log.warn(
						{ err: reason, itemId: item.id, tmdbId: item.tmdbId },
						"Failed to update *arr item tags",
					);
					failures++;
				}
			}

			return { matchesFound: matched.length, labelsApplied, failures };
		},
	};
}

async function ensureTag(client: ArrClient, label: string): Promise<number> {
	const tags = (await client.tag.getAll()) as Array<{ id: number; label: string }>;
	const existing = tags.find((t) => t.label === label);
	if (existing) return existing.id;
	// biome-ignore lint/suspicious/noExplicitAny: SDK Tag union typing requires the cast
	const created = (await (client.tag as any).create({ label })) as { id: number; label: string };
	return created.id;
}
