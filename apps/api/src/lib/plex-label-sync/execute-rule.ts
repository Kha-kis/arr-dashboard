/**
 * Label Sync — rule execution engine (issue #384)
 *
 * Walks a rule end-to-end:
 *   1. Resolve the source instance(s) the rule targets.
 *   2. For each source instance, look up the tag matching `sourceTagName`.
 *   3. Fetch the source items carrying that tag.
 *   4. Match them to destination items (currently by tmdbId for movies/TV
 *      against PlexCache).
 *   5. Apply the configured destination tag/label.
 *   6. Return a structured result; the caller persists it as the rule's
 *      lastRunStatus / lastRunMessage.
 *
 * Sub-arc 1: source = Sonarr/Radarr, destination = Plex.
 * Sub-arcs 2-3 expand source/destination service support.
 */

import { ArrError } from "arr-sdk";
import type { FastifyBaseLogger } from "fastify";
import type { ArrClient, ArrClientFactory } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { createPlexClient } from "../plex/plex-client.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";

export interface LabelSyncRuleInput {
	id: string;
	userId: string;
	sourceService: string; // "sonarr" | "radarr"
	sourceInstanceId: string | null;
	sourceTagName: string;
	destService: string; // "plex" (sub-arc 1)
	destInstanceId: string;
	destTagName: string;
}

export interface LabelSyncRunResult {
	status: "success" | "partial" | "failed";
	message: string;
	totals: {
		sourceInstancesScanned: number;
		taggedItemsFound: number;
		destMatchesFound: number;
		labelsApplied: number;
		failures: number;
	};
}

interface ExecuteOpts {
	rule: LabelSyncRuleInput;
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	encryptor: Encryptor;
	log: FastifyBaseLogger;
}

const SOURCE_SERVICE_TO_PRISMA: Record<string, "SONARR" | "RADARR"> = {
	sonarr: "SONARR",
	radarr: "RADARR",
};

const SOURCE_SERVICE_TO_MEDIA_TYPE: Record<string, "series" | "movie"> = {
	sonarr: "series",
	radarr: "movie",
};

/**
 * Execute a label-sync rule. Pure-execution function — does NOT persist
 * the result. Callers should write `lastRunAt` / `lastRunStatus` /
 * `lastRunMessage` themselves so the rule's persistence model stays
 * decoupled from the engine.
 */
export async function executeLabelSyncRule(opts: ExecuteOpts): Promise<LabelSyncRunResult> {
	const { rule, prisma, arrClientFactory, encryptor, log } = opts;
	const childLog = log.child({
		ruleId: rule.id,
		sourceService: rule.sourceService,
		destService: rule.destService,
	});

	// Sub-arc 1 supports only Plex as a destination
	if (rule.destService !== "plex") {
		return failure(`Unsupported destService for sub-arc 1: ${rule.destService}`);
	}

	const sourcePrismaService = SOURCE_SERVICE_TO_PRISMA[rule.sourceService];
	const mediaType = SOURCE_SERVICE_TO_MEDIA_TYPE[rule.sourceService];
	if (!sourcePrismaService || !mediaType) {
		return failure(`Unsupported sourceService: ${rule.sourceService}`);
	}

	// Resolve source instances
	const sourceInstanceWhere = rule.sourceInstanceId
		? {
				id: rule.sourceInstanceId,
				userId: rule.userId,
				service: sourcePrismaService,
				enabled: true,
			}
		: { userId: rule.userId, service: sourcePrismaService, enabled: true };

	const sourceInstances = await prisma.serviceInstance.findMany({ where: sourceInstanceWhere });
	if (sourceInstances.length === 0) {
		return failure(
			`No enabled ${rule.sourceService} instance${rule.sourceInstanceId ? "" : "s"} found.`,
		);
	}

	// Resolve destination Plex instance + client
	const destInstance = await prisma.serviceInstance.findFirst({
		where: { id: rule.destInstanceId, userId: rule.userId, service: "PLEX", enabled: true },
	});
	if (!destInstance) {
		return failure("Destination Plex instance not found or disabled.");
	}

	let plexClient: ReturnType<typeof createPlexClient>;
	try {
		plexClient = createPlexClient(encryptor, destInstance, childLog);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return failure(`Failed to initialize Plex client: ${message}`);
	}

	// Aggregate counters
	let taggedItemsFound = 0;
	let destMatchesFound = 0;
	let labelsApplied = 0;
	let failures = 0;

	for (const sourceInstance of sourceInstances) {
		const result = await processSourceInstance({
			rule,
			sourceInstance,
			mediaType,
			prisma,
			arrClientFactory,
			plexClient,
			log: childLog.child({ sourceInstanceId: sourceInstance.id }),
		});
		taggedItemsFound += result.taggedItemsFound;
		destMatchesFound += result.destMatchesFound;
		labelsApplied += result.labelsApplied;
		failures += result.failures;
	}

	const totals = {
		sourceInstancesScanned: sourceInstances.length,
		taggedItemsFound,
		destMatchesFound,
		labelsApplied,
		failures,
	};

	if (taggedItemsFound === 0) {
		return {
			status: "success",
			message: `No items in ${rule.sourceService} carry tag "${rule.sourceTagName}".`,
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
		message: `Applied label "${rule.destTagName}" to ${labelsApplied} item${labelsApplied === 1 ? "" : "s"} (${destMatchesFound} match${destMatchesFound === 1 ? "" : "es"} from ${taggedItemsFound} tagged ${mediaType} item${taggedItemsFound === 1 ? "" : "s"}).`,
		totals,
	};
}

interface ProcessInstanceArgs {
	rule: LabelSyncRuleInput;
	sourceInstance: ServiceInstance;
	mediaType: "series" | "movie";
	prisma: PrismaClient;
	arrClientFactory: ArrClientFactory;
	plexClient: ReturnType<typeof createPlexClient>;
	log: FastifyBaseLogger;
}

interface ProcessInstanceResult {
	taggedItemsFound: number;
	destMatchesFound: number;
	labelsApplied: number;
	failures: number;
}

async function processSourceInstance(args: ProcessInstanceArgs): Promise<ProcessInstanceResult> {
	const { rule, sourceInstance, mediaType, prisma, arrClientFactory, plexClient, log } = args;

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
		log.warn({ err }, "Failed to create source client; skipping instance");
		return { taggedItemsFound: 0, destMatchesFound: 0, labelsApplied: 0, failures: 0 };
	}

	// Look up the tag ID matching sourceTagName.
	// arr-sdk's Sonarr/Radarr Tag types are structurally identical
	// ({ id, label }) but the union return type doesn't unify cleanly,
	// so we narrow via a local cast to the shared shape.
	let tagId: number | undefined;
	try {
		const tags = (await arrClient.tag.getAll()) as Array<{ id: number; label: string }>;
		const match = tags.find((t: { id: number; label: string }) => t.label === rule.sourceTagName);
		tagId = match?.id;
	} catch (err) {
		const arrErr = err instanceof ArrError ? err.message : String(err);
		log.warn({ err: arrErr }, "Failed to fetch tags from source instance");
		return { taggedItemsFound: 0, destMatchesFound: 0, labelsApplied: 0, failures: 1 };
	}

	if (tagId === undefined) {
		log.info("Tag not found on this source instance; nothing to do");
		return { taggedItemsFound: 0, destMatchesFound: 0, labelsApplied: 0, failures: 0 };
	}

	// Fetch all items and filter by tag
	let arrItems: Array<{ tmdbId?: number | null; tags?: number[] | null; title?: string }>;
	try {
		const itemsAccessor = mediaType === "series" ? "series" : "movie";
		// biome-ignore lint/suspicious/noExplicitAny: SDK union typing requires runtime accessor
		const resource = (arrClient as any)[itemsAccessor];
		arrItems = (await resource.getAll()) as typeof arrItems;
	} catch (err) {
		log.warn({ err }, "Failed to fetch items from source instance");
		return { taggedItemsFound: 0, destMatchesFound: 0, labelsApplied: 0, failures: 1 };
	}

	const tagged = arrItems.filter((item) => Array.isArray(item.tags) && item.tags.includes(tagId));
	if (tagged.length === 0) {
		return { taggedItemsFound: 0, destMatchesFound: 0, labelsApplied: 0, failures: 0 };
	}

	const tmdbIds = tagged
		.map((item) => item.tmdbId)
		.filter((id): id is number => typeof id === "number" && id > 0);

	if (tmdbIds.length === 0) {
		log.info({ taggedCount: tagged.length }, "Tagged items have no tmdbId; cannot match to Plex");
		return {
			taggedItemsFound: tagged.length,
			destMatchesFound: 0,
			labelsApplied: 0,
			failures: 0,
		};
	}

	// Match against PlexCache for the rule's destination instance
	const plexMatches = await prisma.plexCache.findMany({
		where: {
			instanceId: rule.destInstanceId,
			mediaType,
			tmdbId: { in: tmdbIds },
		},
		select: { thumb: true, title: true, tmdbId: true },
	});

	let labelsApplied = 0;
	let failures = 0;
	for (const match of plexMatches) {
		// PlexCache stores `thumb` containing the rating-key path; extract it.
		const ratingKey = extractRatingKey(match.thumb);
		if (!ratingKey) {
			log.warn({ tmdbId: match.tmdbId, title: match.title }, "Could not extract ratingKey");
			failures++;
			continue;
		}

		try {
			await plexClient.updateMetadataTags(ratingKey, "label", "add", rule.destTagName);
			labelsApplied++;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			log.warn({ ratingKey, err: reason }, "Failed to apply Plex label");
			failures++;
		}
	}

	return {
		taggedItemsFound: tagged.length,
		destMatchesFound: plexMatches.length,
		labelsApplied,
		failures,
	};
}

function extractRatingKey(thumb: string | null): string | undefined {
	if (!thumb) return undefined;
	const match = thumb.match(/\/library\/metadata\/(\d+)/);
	return match?.[1];
}

function failure(message: string): LabelSyncRunResult {
	return {
		status: "failed",
		message,
		totals: {
			sourceInstancesScanned: 0,
			taggedItemsFound: 0,
			destMatchesFound: 0,
			labelsApplied: 0,
			failures: 0,
		},
	};
}
