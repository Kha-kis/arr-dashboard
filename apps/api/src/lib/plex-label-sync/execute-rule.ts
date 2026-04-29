/**
 * Plex Label Sync — rule execution engine (issue #384, phase C)
 *
 * Walks a rule end-to-end:
 *   1. Resolve the *arr instance(s) the rule targets (specific instance,
 *      or all enabled instances of the rule's service).
 *   2. For each instance, look up the tag ID matching `arrTagName`.
 *   3. Fetch all *arr items (series for Sonarr, movies for Radarr) and
 *      filter to those carrying the resolved tag ID.
 *   4. For each tagged item, look up its matching Plex item by `tmdbId`
 *      against PlexCache.
 *   5. Apply the configured Plex label via the Plex client.
 *   6. Return a structured result; the caller persists it as the rule's
 *      lastRunStatus / lastRunMessage.
 */

import { ArrError } from "arr-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClient, ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { createPlexClient } from "../plex/plex-client.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";

export interface PlexLabelSyncRuleInput {
	id: string;
	userId: string;
	arrService: string; // "sonarr" | "radarr"
	arrInstanceId: string | null;
	arrTagName: string;
	plexInstanceId: string;
	plexLabel: string;
}

export interface PlexLabelSyncRunResult {
	status: "success" | "partial" | "failed";
	message: string;
	totals: {
		arrInstancesScanned: number;
		taggedItemsFound: number;
		plexMatchesFound: number;
		labelsApplied: number;
		failures: number;
	};
}

interface ExecuteOpts {
	rule: PlexLabelSyncRuleInput;
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

const ARR_SERVICE_TO_PRISMA: Record<string, "SONARR" | "RADARR"> = {
	sonarr: "SONARR",
	radarr: "RADARR",
};

const ARR_SERVICE_TO_MEDIA_TYPE: Record<string, "series" | "movie"> = {
	sonarr: "series",
	radarr: "movie",
};

/**
 * Execute a label-sync rule. Pure-execution function — does NOT persist
 * the result. Callers should write `lastRunAt` / `lastRunStatus` /
 * `lastRunMessage` themselves so the rule's persistence model stays
 * decoupled from the engine.
 */
export async function executeLabelSyncRule(opts: ExecuteOpts): Promise<PlexLabelSyncRunResult> {
	const { rule, prisma, arrClientFactory, encryptor, log } = opts;
	const childLog = log.child({ ruleId: rule.id, arrService: rule.arrService });

	const prismaService = ARR_SERVICE_TO_PRISMA[rule.arrService];
	const mediaType = ARR_SERVICE_TO_MEDIA_TYPE[rule.arrService];
	if (!prismaService || !mediaType) {
		return failure(`Unsupported arrService: ${rule.arrService}`);
	}

	// Resolve *arr instances
	const arrInstanceWhere = rule.arrInstanceId
		? { id: rule.arrInstanceId, userId: rule.userId, service: prismaService, enabled: true }
		: { userId: rule.userId, service: prismaService, enabled: true };

	const arrInstances = await prisma.serviceInstance.findMany({ where: arrInstanceWhere });
	if (arrInstances.length === 0) {
		return failure(`No enabled ${rule.arrService} instance${rule.arrInstanceId ? "" : "s"} found.`);
	}

	// Resolve Plex instance + client
	const plexInstance = await prisma.serviceInstance.findFirst({
		where: { id: rule.plexInstanceId, userId: rule.userId, service: "PLEX", enabled: true },
	});
	if (!plexInstance) {
		return failure("Plex instance not found or disabled.");
	}

	let plexClient: ReturnType<typeof createPlexClient>;
	try {
		plexClient = createPlexClient(encryptor, plexInstance, childLog);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return failure(`Failed to initialize Plex client: ${message}`);
	}

	// Aggregate counters
	let taggedItemsFound = 0;
	let plexMatchesFound = 0;
	let labelsApplied = 0;
	let failures = 0;

	for (const arrInstance of arrInstances) {
		const result = await processArrInstance({
			rule,
			arrInstance,
			mediaType,
			prisma,
			arrClientFactory,
			plexClient,
			log: childLog.child({ arrInstanceId: arrInstance.id }),
		});
		taggedItemsFound += result.taggedItemsFound;
		plexMatchesFound += result.plexMatchesFound;
		labelsApplied += result.labelsApplied;
		failures += result.failures;
	}

	const totals = {
		arrInstancesScanned: arrInstances.length,
		taggedItemsFound,
		plexMatchesFound,
		labelsApplied,
		failures,
	};

	if (taggedItemsFound === 0) {
		return {
			status: "success",
			message: `No items in ${rule.arrService} carry tag "${rule.arrTagName}".`,
			totals,
		};
	}

	if (failures > 0 && labelsApplied === 0) {
		return {
			status: "failed",
			message: `All ${failures} label applications failed.`,
			totals,
		};
	}

	if (failures > 0) {
		return {
			status: "partial",
			message: `Applied ${labelsApplied} label${labelsApplied === 1 ? "" : "s"}, ${failures} failure${failures === 1 ? "" : "s"}.`,
			totals,
		};
	}

	return {
		status: "success",
		message: `Applied label "${rule.plexLabel}" to ${labelsApplied} item${labelsApplied === 1 ? "" : "s"} (${plexMatchesFound} Plex match${plexMatchesFound === 1 ? "" : "es"} from ${taggedItemsFound} tagged ${mediaType} item${taggedItemsFound === 1 ? "" : "s"}).`,
		totals,
	};
}

interface ProcessInstanceArgs {
	rule: PlexLabelSyncRuleInput;
	arrInstance: ServiceInstance;
	mediaType: "series" | "movie";
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	plexClient: ReturnType<typeof createPlexClient>;
	log: FastifyBaseLogger;
}

interface ProcessInstanceResult {
	taggedItemsFound: number;
	plexMatchesFound: number;
	labelsApplied: number;
	failures: number;
}

async function processArrInstance(args: ProcessInstanceArgs): Promise<ProcessInstanceResult> {
	const { rule, arrInstance, mediaType, prisma, arrClientFactory, plexClient, log } = args;

	let arrClient: ArrClient;
	try {
		arrClient = arrClientFactory.create({
			id: arrInstance.id,
			baseUrl: arrInstance.baseUrl,
			encryptedApiKey: arrInstance.encryptedApiKey,
			encryptionIv: arrInstance.encryptionIv,
			service: arrInstance.service,
			label: arrInstance.label,
		});
	} catch (err) {
		log.warn({ err }, "Failed to create *arr client; skipping instance");
		return { taggedItemsFound: 0, plexMatchesFound: 0, labelsApplied: 0, failures: 0 };
	}

	// Look up the tag ID matching arrTagName.
	// arr-sdk's Sonarr/Radarr Tag types are structurally identical
	// ({ id, label }) but the union return type doesn't unify cleanly,
	// so we narrow via a local cast to the shared shape.
	let tagId: number | undefined;
	try {
		const tags = (await arrClient.tag.getAll()) as Array<{ id: number; label: string }>;
		const match = tags.find((t: { id: number; label: string }) => t.label === rule.arrTagName);
		tagId = match?.id;
	} catch (err) {
		const arrErr = err instanceof ArrError ? err.message : String(err);
		log.warn({ err: arrErr }, "Failed to fetch tags from *arr instance");
		return { taggedItemsFound: 0, plexMatchesFound: 0, labelsApplied: 0, failures: 1 };
	}

	if (tagId === undefined) {
		log.info("Tag not found on this *arr instance; nothing to do");
		return { taggedItemsFound: 0, plexMatchesFound: 0, labelsApplied: 0, failures: 0 };
	}

	// Fetch all items and filter by tag
	let arrItems: Array<{ tmdbId?: number | null; tags?: number[] | null; title?: string }>;
	try {
		const itemsAccessor = mediaType === "series" ? "series" : "movie";
		// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
		const resource = (arrClient as any)[itemsAccessor];
		arrItems = (await resource.getAll()) as typeof arrItems;
	} catch (err) {
		log.warn({ err }, "Failed to fetch items from *arr instance");
		return { taggedItemsFound: 0, plexMatchesFound: 0, labelsApplied: 0, failures: 1 };
	}

	const tagged = arrItems.filter((item) => Array.isArray(item.tags) && item.tags.includes(tagId));
	if (tagged.length === 0) {
		return { taggedItemsFound: 0, plexMatchesFound: 0, labelsApplied: 0, failures: 0 };
	}

	const tmdbIds = tagged
		.map((item) => item.tmdbId)
		.filter((id): id is number => typeof id === "number" && id > 0);

	if (tmdbIds.length === 0) {
		log.info({ taggedCount: tagged.length }, "Tagged items have no tmdbId; cannot match to Plex");
		return {
			taggedItemsFound: tagged.length,
			plexMatchesFound: 0,
			labelsApplied: 0,
			failures: 0,
		};
	}

	// Match against PlexCache for the rule's plex instance
	const plexMatches = await prisma.plexCache.findMany({
		where: {
			instanceId: rule.plexInstanceId,
			mediaType,
			tmdbId: { in: tmdbIds },
		},
		select: { thumb: true, title: true, tmdbId: true },
	});

	let labelsApplied = 0;
	let failures = 0;
	for (const match of plexMatches) {
		// PlexCache stores `thumb` containing the rating-key path; extract it.
		// The shape is "/library/metadata/<ratingKey>/thumb/..." so we parse it out.
		const ratingKey = extractRatingKey(match.thumb);
		if (!ratingKey) {
			log.warn({ tmdbId: match.tmdbId, title: match.title }, "Could not extract ratingKey");
			failures++;
			continue;
		}

		try {
			await plexClient.updateMetadataTags(ratingKey, "label", "add", rule.plexLabel);
			labelsApplied++;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			log.warn({ ratingKey, err: reason }, "Failed to apply Plex label");
			failures++;
		}
	}

	return {
		taggedItemsFound: tagged.length,
		plexMatchesFound: plexMatches.length,
		labelsApplied,
		failures,
	};
}

function extractRatingKey(thumb: string | null): string | undefined {
	if (!thumb) return undefined;
	// Plex thumb paths look like "/library/metadata/65486/thumb/..." — pull the digits after metadata/
	const match = thumb.match(/\/library\/metadata\/(\d+)/);
	return match?.[1];
}

function failure(message: string): PlexLabelSyncRunResult {
	return {
		status: "failed",
		message,
		totals: {
			arrInstancesScanned: 0,
			taggedItemsFound: 0,
			plexMatchesFound: 0,
			labelsApplied: 0,
			failures: 0,
		},
	};
}
