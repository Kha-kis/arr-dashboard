import type {
	PlexCanonicalDomain,
	PlexCoverageReasonCode,
	PlexEvidenceSummary,
	PlexPartialReason,
	PlexPositiveGenerationMetadataV4,
} from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import { evidenceFingerprint } from "../evidence-fingerprint.js";
import type { PrismaClientInstance, ServiceInstance } from "../prisma.js";
import {
	collectPlexCacheLiveEvidence,
	collectSettledPlexCacheLiveEvidence,
	isPersonalMediaSection,
} from "./plex-cache-refresher.js";
import type { PlexCacheRowSelection } from "./plex-cache-storage.js";
import {
	createPlexSelectionProjection,
	type PlexCanonicalObservation,
	type PlexCanonicalSelection,
} from "./plex-canonical-projection.js";
import { createPlexClient, type PlexClient, PlexRequestError } from "./plex-client.js";
import {
	classifyPlexMetadataTagEvidenceFailure,
	PlexMetadataTagWriteError,
	type PlexMetadataTagMutationFailureReason,
} from "./plex-label-sync-logging.js";
import {
	collectPlexEpisodeLiveEvidence,
	createPositivePlexEpisodeDigest,
	type PlexEpisodeRow,
	type PlexPositiveEpisodeParentTarget,
} from "./plex-episode-live-collector.js";
import {
	type AvailablePlexInstanceEvidence,
	type AvailableSelectedPlexEvidence,
	isCurrentAuthoritativePlexEvidence,
	loadInstanceEpisodeEvidence,
	loadInstanceEvidence,
	loadInstanceSelectedEpisodeEvidence,
	loadInstanceSelectedEvidence,
	loadPositiveEpisodeEvidence,
	loadPositiveEpisodeParentEvidence,
	type PlexEpisodeParentPolicyBatchHandler,
	type PlexInstanceEvidence,
	type PlexPolicyBatchHandler,
	type PlexPolicyScanEvidence,
	type SelectedPlexEpisodeEvidence,
	type SelectedPlexEvidence,
	scanInstanceEpisodeParentPolicyEvidence,
	scanInstancePolicyEvidence,
	type UnavailablePlexInstanceEvidence,
} from "./plex-evidence-repository.js";
import type { DecodedPlexGenerationMetadata } from "./plex-generation-metadata.js";
import {
	normalizePlexGenerationTargets,
	type PlexGenerationTarget,
	readPlexGenerationTargetsForSelection,
	requirePlexTargetLedgerBinding,
	samePlexGenerationBinding,
	samePlexGenerationTargetSet,
	selectSinglePlexGenerationTarget,
	verifyPersistedPlexGenerationTargets,
} from "./plex-generation-target-ledger.js";
import {
	evaluatePlexLiveSettlement,
	type PlexLiveActivity,
	type PlexLiveSection,
} from "./plex-live-settlement.js";
import { plexConnectionFingerprint } from "./service-instance-fingerprint.js";

export type {
	AvailablePlexInstanceEvidence,
	AvailablePlexPolicyEvidence,
	PlexInstanceEvidence,
	PlexPolicyScanEvidence,
	SelectedPlexEpisodeEvidence,
	SelectedPlexEvidence,
} from "./plex-evidence-repository.js";
export {
	DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
	hasAuthoritativePlexEvidence,
	hasAuthoritativeSelectedPlexEvidence,
	hasCompleteAuthoritativePlexEvidence,
	isCurrentAuthoritativePlexEvidence,
	listPublishedSections,
	summarizePlexEvidence,
} from "./plex-evidence-repository.js";

export type PlexPersistedSelectionObservation = {
	generationId: string;
	connectionGeneration: number;
	identityGeneration: number;
	providerIdentity: string;
	metadata: DecodedPlexGenerationMetadata;
	rows: readonly PlexCanonicalObservation[];
};

export type PlexAuthorityProbe = {
	activities: readonly PlexLiveActivity[];
	sections: readonly PlexLiveSection[];
};

export class PlexAuthorityUnavailableError extends Error {
	constructor(readonly reasonCode: PlexCoverageReasonCode) {
		super(reasonCode);
		this.name = "PlexAuthorityUnavailableError";
	}
}

export {
	PlexMetadataTagWriteError,
	type PlexMetadataTagMutationFailureReason,
} from "./plex-label-sync-logging.js";

export type PlexMetadataTagMutationResult =
	| { ok: true }
	| {
			ok: false;
			reasonCode: PlexMetadataTagMutationFailureReason;
			evidence: PlexEvidenceSummary;
	  };

function failedMetadataTagMutation(
	evidence: PlexEvidenceSummary,
	reasonCode: PlexMetadataTagMutationFailureReason,
): PlexMetadataTagMutationResult {
	return { ok: false, reasonCode, evidence };
}

export type PlexAuthorityWindowResult =
	| { ok: true; persisted: PlexPersistedSelectionObservation }
	| { ok: false; reasonCode: PlexCoverageReasonCode };

export type PositiveEpisodeParentAuthority =
	| {
			available: true;
			instanceId: string;
			generationId: string;
			connectionGeneration: number;
			identityGeneration: number;
			capability: PlexPositiveGenerationMetadataV4["capabilities"][number];
			partialReasons: readonly PlexPartialReason[];
			provenance: {
				publicationLevel: "authoritative" | "positive-only";
				completeness: "complete" | "partial";
				parentTargetDigest: string;
				parentTargetCount: number;
			};
			rows: Array<{ instanceId: string; tmdbId: number; sectionId: string; ratingKey: string }>;
			targets: PlexGenerationTarget[];
			evidence: PlexEvidenceSummary;
	  }
	| UnavailablePlexInstanceEvidence;

export type PositiveEpisodeAuthority =
	| {
			available: true;
			instanceId: string;
			generationId: string;
			connectionGeneration: number;
			identityGeneration: number;
			capability: {
				domain: "episodes";
				field: "watchCount";
				semantics: "lower-bound";
				operator: "greater_than";
			};
			partialReasons: ReadonlyArray<{ code: string; count: number }>;
			provenance: {
				publicationLevel: "positive-only";
				completeness: "partial";
				connectionGeneration: number;
				identityGeneration: number;
				parentPlexGenerationId: string;
				parentTargetDigest: string;
				parentTargetCount: number;
				episodeGenerationId: string;
				episodeDigest: string;
				publishedAt: string;
			};
			rows: Array<{
				showTmdbId: number;
				seasonNumber: number;
				episodeNumber: number;
				ratingKey: string;
				lowerBound: number;
				sourceFingerprint: string;
				soleParentTarget: PlexPositiveEpisodeParentTarget;
			}>;
			evidence: PlexEvidenceSummary;
	  }
	| UnavailablePlexInstanceEvidence;

function sectionCatalogIdentity(
	sections: ReadonlyArray<{ key: string; uuid: string; type: string; title: string }>,
): string {
	return JSON.stringify(
		sections
			.map(
				(section) =>
					[section.key, section.uuid, section.type, section.title] as [
						string,
						string,
						string,
						string,
					],
			)
			.sort(
				(left, right) =>
					left[0].localeCompare(right[0]) ||
					left[1].localeCompare(right[1]) ||
					left[2].localeCompare(right[2]) ||
					left[3].localeCompare(right[3]),
			),
	);
}

function persistedSectionCatalogIdentity(metadata: DecodedPlexGenerationMetadata): string | null {
	if (metadata.version !== 3) return null;
	return sectionCatalogIdentity(metadata.sections);
}

function evaluateProbe(
	probe: PlexAuthorityProbe,
	expectedSectionIdentity: string,
): PlexCoverageReasonCode | null {
	const supportedSections = probe.sections.filter(
		(section) =>
			(section.type === "movie" || section.type === "show") && !isPersonalMediaSection(section),
	);
	const settlementSectionKeys = supportedSections.map((section) => section.key);
	const settlement = evaluatePlexLiveSettlement({
		activities: probe.activities,
		sections: probe.sections,
		selectedSectionKeys: settlementSectionKeys,
	});
	if (!settlement.settled) return settlement.reasonCodes[0] ?? "plex_section_state_unavailable";
	const identity = sectionCatalogIdentity(supportedSections);
	if (identity !== expectedSectionIdentity) {
		return "plex_library_revision_changed";
	}
	return null;
}

function stateChanged(
	before: PlexPersistedSelectionObservation,
	after: PlexPersistedSelectionObservation,
): PlexCoverageReasonCode | null {
	if (after.connectionGeneration !== before.connectionGeneration) {
		return "connection_generation_mismatch";
	}
	if (
		after.identityGeneration !== before.identityGeneration ||
		after.providerIdentity !== before.providerIdentity
	) {
		return "identity_generation_mismatch";
	}
	if (after.generationId !== before.generationId) return "generation_changed";
	if (JSON.stringify(after.metadata) !== JSON.stringify(before.metadata))
		return "generation_changed";
	return null;
}

export function plexEpisodeParentAuthorityChanged(
	before: PlexPersistedSelectionObservation,
	after: PlexPersistedSelectionObservation,
	targets: Array<{ mediaType: string; tmdbId: number }>,
): PlexCoverageReasonCode | null {
	const changed = stateChanged(before, after);
	if (changed) return changed;
	const selection = { kind: "targets" as const, targets };
	const domains: PlexCanonicalDomain[] = ["membership", "episode-parents", "watch"];
	const beforeProjection = createPlexSelectionProjection({
		rows: before.rows,
		selection,
		domains,
	});
	const afterProjection = createPlexSelectionProjection({
		rows: after.rows,
		selection,
		domains,
	});
	return beforeProjection.digest === afterProjection.digest ? null : "plex_content_digest_changed";
}

function completeEpisodeParentAuthorityChanged(
	before: PlexPersistedSelectionObservation,
	after: PlexPersistedSelectionObservation,
): PlexCoverageReasonCode | null {
	const changed = stateChanged(before, after);
	if (changed) return changed;
	const domains: PlexCanonicalDomain[] = ["membership", "episode-parents"];
	const beforeProjection = createPlexSelectionProjection({
		rows: before.rows,
		selection: { kind: "all" },
		domains,
	});
	const afterProjection = createPlexSelectionProjection({
		rows: after.rows,
		selection: { kind: "all" },
		domains,
	});
	return beforeProjection.digest === afterProjection.digest ? null : "plex_content_digest_changed";
}

/**
 * Executes the approved live observation window. Callers supply complete live
 * rows; this function owns ordering and never exposes an intermediate success.
 * The final row pass is the terminal upstream observation. Plex provides no
 * atomic snapshot or scan lock, so a new change can begin after that pass; the
 * function proves only the observed fixed point and immediately follows it with
 * the persisted-generation reread.
 */
export async function settlePlexAuthorityWindow(input: {
	persisted: PlexPersistedSelectionObservation;
	selection: PlexCanonicalSelection;
	domains: readonly PlexCanonicalDomain[];
	mutation: boolean;
	loadProbe: (options: { uncached: boolean }) => Promise<PlexAuthorityProbe>;
	loadFreshRows: (options: { uncached: boolean }) => Promise<readonly PlexCanonicalObservation[]>;
	rereadPersisted: () => Promise<PlexPersistedSelectionObservation>;
}): Promise<PlexAuthorityWindowResult> {
	if (input.persisted.metadata.version !== 3) {
		return { ok: false, reasonCode: "plex_settlement_metadata_missing" };
	}
	const expectedSectionIdentity = persistedSectionCatalogIdentity(input.persisted.metadata);
	if (expectedSectionIdentity === null) {
		return { ok: false, reasonCode: "plex_settlement_metadata_missing" };
	}
	const options = { uncached: input.mutation };
	try {
		const startProbe = await input.loadProbe(options);
		const startReason = evaluateProbe(startProbe, expectedSectionIdentity);
		if (startReason) return { ok: false, reasonCode: startReason };

		const preliminaryRows = await input.loadFreshRows(options);
		const endProbe = await input.loadProbe(options);
		const endReason = evaluateProbe(endProbe, expectedSectionIdentity);
		if (endReason) return { ok: false, reasonCode: endReason };

		const preliminary = createPlexSelectionProjection({
			rows: preliminaryRows,
			selection: input.selection,
			domains: input.domains,
		});
		const finalProbe = await input.loadProbe(options);
		const finalReason = evaluateProbe(finalProbe, expectedSectionIdentity);
		if (finalReason) return { ok: false, reasonCode: finalReason };
		const finalRows = await input.loadFreshRows(options);

		const final = createPlexSelectionProjection({
			rows: finalRows,
			selection: input.selection,
			domains: input.domains,
		});
		if (final.digest !== preliminary.digest) {
			return { ok: false, reasonCode: "plex_content_digest_changed" };
		}
		const persisted = createPlexSelectionProjection({
			rows: input.persisted.rows,
			selection: input.selection,
			domains: input.domains,
		});
		if (final.digest !== persisted.digest) {
			return { ok: false, reasonCode: "plex_content_digest_changed" };
		}

		const reread = await input.rereadPersisted();
		const changed = stateChanged(input.persisted, reread);
		if (changed) return { ok: false, reasonCode: changed };
		return { ok: true, persisted: input.persisted };
	} catch (error) {
		if (error instanceof PlexAuthorityUnavailableError) {
			return { ok: false, reasonCode: error.reasonCode };
		}
		return { ok: false, reasonCode: "plex_content_digest_changed" };
	}
}

type PlexAuthorityPrisma = Pick<
	PrismaClientInstance,
	| "serviceInstance"
	| "cacheRefreshStatus"
	| "plexCache"
	| "plexEpisodeCache"
	| "plexGenerationTarget"
>;

type AvailablePersistedEvidence = AvailablePlexInstanceEvidence | AvailableSelectedPlexEvidence;

async function verifyExactGenerationTargets(
	prisma: Pick<PrismaClientInstance, "plexGenerationTarget">,
	input: {
		instanceId: string;
		generationId: string;
		connectionGeneration: number;
		identityGeneration: number;
		metadata: DecodedPlexGenerationMetadata;
	},
): Promise<
	| { ok: true; expected: { instanceId: string; generationId: string } }
	| { ok: false; reasonCode: PlexCoverageReasonCode }
> {
	if (input.metadata.version !== 3) {
		return { ok: false, reasonCode: "target_ledger_binding_missing" };
	}
	const binding = requirePlexTargetLedgerBinding(input.metadata);
	if (!binding.ok) return { ok: false, reasonCode: "target_ledger_binding_missing" };
	const verified = await verifyPersistedPlexGenerationTargets(prisma, {
		expected: {
			instanceId: input.instanceId,
			generationId: input.generationId,
			connectionGeneration: input.connectionGeneration,
			identityGeneration: input.identityGeneration,
			...binding.binding,
		},
		sections: input.metadata.sections,
	});
	return verified.ok
		? { ok: true, expected: { instanceId: input.instanceId, generationId: input.generationId } }
		: { ok: false, reasonCode: verified.reason as PlexCoverageReasonCode };
}

function unavailableEvidence(
	instanceId: string,
	base: PlexEvidenceSummary,
	reasonCode: PlexCoverageReasonCode,
): UnavailablePlexInstanceEvidence {
	return {
		available: false,
		instanceId,
		evidence: {
			availability: "unavailable",
			authority: "unavailable",
			attemptState: base.attemptState ?? "unknown",
			publicationLevel: "unavailable",
			completeness: "unknown",
			reasonCodes: [reasonCode],
			...(base.publishedGeneration ? { publishedGeneration: base.publishedGeneration } : {}),
		},
	};
}

function canonicalSelection(selection: PlexCacheRowSelection): PlexCanonicalSelection {
	if (selection.kind === "targets") {
		return {
			kind: "targets",
			targets: selection.targets.map((target) => ({
				mediaType: target.mediaType,
				tmdbId: target.tmdbId,
			})),
		};
	}
	return selection;
}

function persistedObservation(
	evidence: AvailablePersistedEvidence,
	instance: ServiceInstance,
): PlexPersistedSelectionObservation {
	if (!instance.expectedIdentity)
		throw new PlexAuthorityUnavailableError("identity_generation_mismatch");
	return {
		generationId: evidence.generationId,
		connectionGeneration: evidence.connectionGeneration,
		identityGeneration: evidence.identityGeneration,
		providerIdentity: instance.expectedIdentity,
		metadata: evidence.metadata,
		rows: evidence.rows,
	};
}

function canonicalEpisodeRows(
	rows: ReadonlyArray<{
		showTmdbId: number;
		seasonNumber: number;
		episodeNumber: number;
		ratingKey: string;
		title: string;
		watched: boolean;
		watchedByUsers: string;
		lastWatchedAt: Date | null;
		watchCount: number | null;
	}>,
	parentRows: readonly PlexCanonicalObservation[],
): PlexCanonicalObservation[] {
	const sectionsByShow = new Map<number, Set<string>>();
	for (const parent of parentRows) {
		const sections = sectionsByShow.get(parent.tmdbId) ?? new Set<string>();
		sections.add(parent.sectionId);
		sectionsByShow.set(parent.tmdbId, sections);
	}
	return rows.flatMap((row) => {
		if (row.watchCount === null) throw new Error("Incomplete Plex episode watch count");
		return [...(sectionsByShow.get(row.showTmdbId) ?? [])].sort().map((sectionId) => ({
			sectionId,
			mediaType: "episode",
			tmdbId: row.showTmdbId,
			ratingKey: row.ratingKey,
			title: row.title,
			seasonNumber: row.seasonNumber,
			episodeNumber: row.episodeNumber,
			watched: row.watched,
			watchedByUsers: row.watchedByUsers,
			lastWatchedAt: row.lastWatchedAt,
			watchCount: row.watchCount,
		}));
	});
}

/** Central production composition boundary for current Plex authority. */
export class PlexAuthorityService {
	constructor(
		private readonly deps: {
			prisma: PlexAuthorityPrisma;
			encryptor?: Encryptor;
			log: FastifyBaseLogger;
			createClient?: (instance: ServiceInstance) => PlexClient;
		},
	) {}

	private async ownedInstance(userId: string, instanceId: string): Promise<ServiceInstance | null> {
		return await this.deps.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId, service: "PLEX", enabled: true },
		});
	}

	private client(instance: ServiceInstance): PlexClient {
		if (this.deps.createClient) return this.deps.createClient(instance);
		if (!this.deps.encryptor) {
			throw new PlexAuthorityUnavailableError("plex_activity_unavailable");
		}
		return createPlexClient(this.deps.encryptor, instance, this.deps.log);
	}

	private async probe(client: PlexClient, uncached: boolean): Promise<PlexAuthorityProbe> {
		let activities: PlexAuthorityProbe["activities"];
		try {
			activities = await client.getActivities({ uncached });
		} catch {
			throw new PlexAuthorityUnavailableError("plex_activity_unavailable");
		}
		let sections: PlexAuthorityProbe["sections"];
		try {
			sections = await client.getLibrarySettlementSections({ uncached });
		} catch {
			throw new PlexAuthorityUnavailableError("plex_section_state_unavailable");
		}
		return { activities, sections };
	}

	private async freshRows(client: PlexClient, instanceId: string) {
		const result = await collectPlexCacheLiveEvidence(client, instanceId, this.deps.log, {
			preserveProviderDuplicates: true,
		});
		if (!result.complete || !result.snapshot) {
			throw new PlexAuthorityUnavailableError("plex_content_digest_changed");
		}
		return result.snapshot.rows;
	}

	private async settle<TAvailable extends AvailablePersistedEvidence>(input: {
		userId: string;
		instanceId: string;
		before: TAvailable;
		instance: ServiceInstance;
		selection: PlexCacheRowSelection | { kind: "all" };
		domains: readonly PlexCanonicalDomain[];
		mutation: boolean;
		reread: () => Promise<PlexInstanceEvidence | SelectedPlexEvidence>;
		client?: PlexClient;
	}): Promise<TAvailable | SelectedPlexEvidence> {
		if (
			input.before.metadata.version !== 3 ||
			!isCurrentAuthoritativePlexEvidence(input.before.evidence)
		) {
			return unavailableEvidence(
				input.instanceId,
				input.before.evidence,
				input.before.metadata.version === 3
					? (input.before.evidence.reasonCodes[0] ?? "mutation_authority_unavailable")
					: "plex_settlement_metadata_missing",
			);
		}
		const client = input.client ?? this.client(input.instance);
		const before = persistedObservation(input.before, input.instance);
		const selection =
			input.selection.kind === "all"
				? ({ kind: "all" } as const)
				: canonicalSelection(input.selection);
		const window = await settlePlexAuthorityWindow({
			persisted: before,
			selection,
			domains: input.domains,
			mutation: input.mutation,
			loadProbe: async ({ uncached }) => await this.probe(client, uncached),
			loadFreshRows: async () => await this.freshRows(client, input.instanceId),
			rereadPersisted: async () => {
				const afterEvidence = await input.reread();
				if (!afterEvidence.available) {
					throw new PlexAuthorityUnavailableError(
						afterEvidence.evidence.reasonCodes[0] ?? "generation_changed",
					);
				}
				const afterInstance = await this.ownedInstance(input.userId, input.instanceId);
				if (!afterInstance) {
					throw new PlexAuthorityUnavailableError("identity_generation_mismatch");
				}
				return persistedObservation(afterEvidence, afterInstance);
			},
		});
		return window.ok
			? input.before
			: unavailableEvidence(input.instanceId, input.before.evidence, window.reasonCode);
	}

	async readInstanceSelected(input: {
		userId: string;
		instanceId: string;
		selection: PlexCacheRowSelection;
		domains: readonly PlexCanonicalDomain[];
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
	}): Promise<SelectedPlexEvidence> {
		const instance = await this.ownedInstance(input.userId, input.instanceId);
		if (!instance) {
			return unavailableEvidence(
				input.instanceId,
				{
					availability: "unavailable",
					authority: "unavailable",
					attemptState: "unknown",
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: ["missing_status"],
				},
				"missing_status",
			);
		}
		const before = await loadInstanceSelectedEvidence(this.deps.prisma, {
			userId: input.userId,
			instanceId: input.instanceId,
			selection: input.selection,
			...(input.now ? { now: input.now } : {}),
			...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
		});
		if (!before.available) return before;
		return await this.settle({
			...input,
			before,
			instance,
			mutation: input.mutation === true,
			reread: async () =>
				await loadInstanceSelectedEvidence(this.deps.prisma, {
					userId: input.userId,
					instanceId: input.instanceId,
					selection: input.selection,
					...(input.now ? { now: input.now } : {}),
					...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
				}),
		});
	}

	async readInstance(input: {
		userId: string;
		instanceId: string;
		domains: readonly PlexCanonicalDomain[];
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
	}): Promise<PlexInstanceEvidence> {
		const instance = await this.ownedInstance(input.userId, input.instanceId);
		if (!instance) {
			return unavailableEvidence(
				input.instanceId,
				{
					availability: "unavailable",
					authority: "unavailable",
					attemptState: "unknown",
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: ["missing_status"],
				},
				"missing_status",
			);
		}
		const before = await loadInstanceEvidence(this.deps.prisma, input);
		if (!before.available) return before;
		return (await this.settle({
			...input,
			before,
			instance,
			selection: { kind: "all" },
			mutation: input.mutation === true,
			reread: async () => await loadInstanceEvidence(this.deps.prisma, input),
		})) as PlexInstanceEvidence;
	}

	/**
	 * The sole persisted positive-episode reader. Its rows are explicit lower
	 * bounds, never an exact episode universe: omitted episodes are unknown.
	 */
	async readPositiveEpisodeEvidence(input: {
		userId: string;
		instanceId: string;
		now?: Date;
		maxAgeMs?: number;
	}): Promise<PositiveEpisodeAuthority> {
		const observed = await loadPositiveEpisodeEvidence(this.deps.prisma, input);
		if (!observed.available) return observed;
		const binding = requirePlexTargetLedgerBinding(observed.parentMetadata);
		if (!binding.ok) {
			return unavailableEvidence(
				input.instanceId,
				observed.evidence,
				"target_ledger_binding_missing",
			);
		}
		if (binding.binding.targetDigest !== observed.metadata.parentTargetDigest) {
			return unavailableEvidence(input.instanceId, observed.evidence, "target_digest_mismatch");
		}
		const ledgerTargets = await readPlexGenerationTargetsForSelection(this.deps.prisma, {
			instanceId: observed.instanceId,
			generationId: observed.parentGenerationId,
		});
		const targetLedger = await verifyPersistedPlexGenerationTargets(this.deps.prisma, {
			expected: {
				instanceId: observed.instanceId,
				generationId: observed.parentGenerationId,
				connectionGeneration: observed.connectionGeneration,
				identityGeneration: observed.identityGeneration,
				...binding.binding,
			},
			sections: observed.parentMetadata.sections,
		});
		if (!targetLedger.ok) {
			return unavailableEvidence(
				input.instanceId,
				observed.evidence,
				targetLedger.reason as PlexCoverageReasonCode,
			);
		}
		const soleParentGroups = new Map<number, PlexGenerationTarget[]>();
		for (const target of ledgerTargets) {
			if (target.mediaType !== "series") continue;
			const group = soleParentGroups.get(target.tmdbId) ?? [];
			group.push(target);
			soleParentGroups.set(target.tmdbId, group);
		}
		const soleParentTargets = [...soleParentGroups.values()]
			.filter((group) => group.length === 1)
			.map((group) => {
				const target = group[0]!;
				return {
					instanceId: target.instanceId,
					generationId: target.generationId,
					showTmdbId: target.tmdbId,
					sectionId: target.sectionId,
					sectionUuid: target.sectionUuid,
					mediaType: "series" as const,
					tvdbId: target.tvdbId,
					ratingKey: target.ratingKey,
				};
			});
		const rows: PlexEpisodeRow[] = [];
		for (const row of observed.rows) {
			if (
				typeof row.sourceFingerprint !== "string" ||
				row.sourceFingerprint.trim() === "" ||
				!(row.refreshedAt instanceof Date) ||
				!Number.isFinite(row.refreshedAt.getTime()) ||
				typeof row.watchCount !== "number" ||
				!Number.isSafeInteger(row.watchCount) ||
				row.watchCount <= 0
			) {
				return unavailableEvidence(
					input.instanceId,
					observed.evidence,
					"plex_content_digest_changed",
				);
			}
			rows.push({
				instanceId: row.instanceId,
				showTmdbId: row.showTmdbId,
				seasonNumber: row.seasonNumber,
				episodeNumber: row.episodeNumber,
				ratingKey: row.ratingKey,
				title: row.title,
				watched: row.watched,
				watchedByUsers: row.watchedByUsers,
				lastWatchedAt: row.lastWatchedAt,
				watchCount: row.watchCount,
				refreshedAt: row.refreshedAt,
				sourceFingerprint: row.sourceFingerprint,
			});
		}
		if (
			createPositivePlexEpisodeDigest(soleParentTargets, rows) !== observed.metadata.episodeDigest
		) {
			return unavailableEvidence(
				input.instanceId,
				observed.evidence,
				"plex_content_digest_changed",
			);
		}
		const soleParentByShow = new Map(
			soleParentTargets.map((target) => [target.showTmdbId, target]),
		);
		return {
			available: true,
			instanceId: observed.instanceId,
			generationId: observed.generationId,
			connectionGeneration: observed.connectionGeneration,
			identityGeneration: observed.identityGeneration,
			capability: observed.metadata.capability,
			partialReasons: observed.metadata.partialReasons,
			provenance: {
				publicationLevel: "positive-only",
				completeness: "partial",
				connectionGeneration: observed.connectionGeneration,
				identityGeneration: observed.identityGeneration,
				parentPlexGenerationId: observed.parentGenerationId,
				parentTargetDigest: observed.metadata.parentTargetDigest,
				parentTargetCount: binding.binding.targetCount,
				episodeGenerationId: observed.generationId,
				episodeDigest: observed.metadata.episodeDigest,
				publishedAt: observed.publishedAt.toISOString(),
			},
			rows: rows.flatMap((row) => {
				const soleParentTarget = soleParentByShow.get(row.showTmdbId);
				return soleParentTarget
					? [
							{
								showTmdbId: row.showTmdbId,
								seasonNumber: row.seasonNumber,
								episodeNumber: row.episodeNumber,
								ratingKey: row.ratingKey,
								lowerBound: row.watchCount,
								sourceFingerprint: row.sourceFingerprint,
								soleParentTarget,
							},
						]
					: [];
			}),
			evidence: observed.evidence,
		};
	}

	/**
	 * The sole V4 parent-reader. It intentionally returns only observed Show
	 * parents and ledger targets. A requested Show absent from those arrays is
	 * unknown; this method never produces a negative, zero, or exact-universe
	 * assertion.
	 */
	async readPositiveEpisodeParents(input: {
		userId: string;
		instanceId: string;
		showTmdbIds?: readonly number[];
		now?: Date;
		maxAgeMs?: number;
	}): Promise<PositiveEpisodeParentAuthority> {
		const observed = await loadPositiveEpisodeParentEvidence(this.deps.prisma, input);
		if (!observed.available) return observed;
		const binding = requirePlexTargetLedgerBinding(observed.metadata);
		if (!binding.ok) {
			return unavailableEvidence(
				input.instanceId,
				observed.evidence,
				"target_ledger_binding_missing",
			);
		}
		const ledgerTargets = await readPlexGenerationTargetsForSelection(this.deps.prisma, {
			instanceId: observed.instanceId,
			generationId: observed.generationId,
		});
		const targetLedger = await verifyPersistedPlexGenerationTargets(this.deps.prisma, {
			expected: {
				instanceId: observed.instanceId,
				generationId: observed.generationId,
				connectionGeneration: observed.connectionGeneration,
				identityGeneration: observed.identityGeneration,
				...binding.binding,
			},
			sections: observed.metadata.sections,
		});
		if (!targetLedger.ok) {
			return unavailableEvidence(
				input.instanceId,
				observed.evidence,
				targetLedger.reason as PlexCoverageReasonCode,
			);
		}
		const selectedIds = input.showTmdbIds
			? [...new Set(input.showTmdbIds)].filter(
					(tmdbId) => Number.isSafeInteger(tmdbId) && tmdbId > 0,
				)
			: undefined;
		if (input.showTmdbIds && selectedIds?.length !== input.showTmdbIds.length) {
			return unavailableEvidence(input.instanceId, observed.evidence, "target_ledger_invalid");
		}
		const targets = ledgerTargets.filter(
			(target) =>
				target.mediaType === "series" &&
				(selectedIds === undefined || selectedIds.includes(target.tmdbId)),
		);
		const targetsByRatingKey = new Map(targets.map((target) => [target.ratingKey, target]));
		const targetsByCoordinate = new Map<string, PlexGenerationTarget[]>();
		for (const target of targets) {
			const key = JSON.stringify([target.tmdbId, target.sectionId]);
			const group = targetsByCoordinate.get(key) ?? [];
			group.push(target);
			targetsByCoordinate.set(key, group);
		}
		const observedTargets = new Map<string, PlexGenerationTarget>();
		let unmatchedObservedRow = false;
		const rows = observed.rows.flatMap((row) => {
			if (!row.ratingKey) {
				unmatchedObservedRow = true;
				return [];
			}
			const target = targetsByRatingKey.get(row.ratingKey);
			if (
				target &&
				target.mediaType === "series" &&
				target.tmdbId === row.tmdbId &&
				target.sectionId === row.sectionId
			) {
				for (const observedTarget of targetsByCoordinate.get(
					JSON.stringify([row.tmdbId, row.sectionId]),
				) ?? []) {
					observedTargets.set(observedTarget.ratingKey, observedTarget);
				}
				return [
					{
						instanceId: row.instanceId,
						tmdbId: row.tmdbId,
						sectionId: row.sectionId,
						ratingKey: row.ratingKey,
					},
				];
			}
			unmatchedObservedRow = true;
			return [];
		});
		if (unmatchedObservedRow) {
			return unavailableEvidence(input.instanceId, observed.evidence, "target_ledger_invalid");
		}
		return {
			available: true,
			instanceId: observed.instanceId,
			generationId: observed.generationId,
			connectionGeneration: observed.connectionGeneration,
			identityGeneration: observed.identityGeneration,
			capability: {
				domain: "episode-parents",
				field: "membership",
				semantics: "observed-targets-only",
				operators: [],
			},
			partialReasons: observed.metadata.version === 4 ? observed.metadata.partialReasons : [],
			provenance: {
				publicationLevel: observed.metadata.publicationLevel,
				completeness: observed.metadata.completeness,
				parentTargetDigest: binding.binding.targetDigest,
				parentTargetCount: binding.binding.targetCount,
			},
			rows,
			targets: [...observedTargets.values()],
			evidence: observed.evidence,
		};
	}

	async scanInstancePolicy(input: {
		userId: string;
		instanceId: string;
		domains: readonly PlexCanonicalDomain[];
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexPolicyBatchHandler;
	}): Promise<PlexPolicyScanEvidence> {
		const current = await this.readInstance(input);
		if (!current.available) return current;
		const scanned = await scanInstancePolicyEvidence(this.deps.prisma, input);
		if (!scanned.available) return scanned;
		if (scanned.generationId !== current.generationId) {
			return unavailableEvidence(input.instanceId, current.evidence, "generation_changed");
		}
		return scanned;
	}

	async scanInstanceExactPolicy(input: {
		userId: string;
		instanceId: string;
		domains: readonly PlexCanonicalDomain[];
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexPolicyBatchHandler;
	}): Promise<PlexPolicyScanEvidence> {
		const current = await this.readInstance(input);
		if (!current.available) return current;
		const exactTargets = await verifyExactGenerationTargets(this.deps.prisma, current);
		if (!exactTargets.ok) {
			return unavailableEvidence(input.instanceId, current.evidence, exactTargets.reasonCode);
		}
		const scanned = await scanInstancePolicyEvidence(this.deps.prisma, input);
		if (!scanned.available) return scanned;
		if (scanned.generationId !== current.generationId) {
			return unavailableEvidence(input.instanceId, current.evidence, "generation_changed");
		}
		return scanned;
	}

	/**
	 * Revalidates persisted policy rows and their exact target ledger without
	 * contacting Plex. This is reserved for the final database transaction after
	 * the caller has already completed live settlement and identity checks.
	 */
	async scanInstanceExactPolicyPersisted(input: {
		userId: string;
		instanceId: string;
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexPolicyBatchHandler;
	}): Promise<PlexPolicyScanEvidence> {
		const current = await loadInstanceEvidence(this.deps.prisma, input);
		if (!current.available) return current;
		const exactTargets = await verifyExactGenerationTargets(this.deps.prisma, current);
		if (!exactTargets.ok) {
			return unavailableEvidence(input.instanceId, current.evidence, exactTargets.reasonCode);
		}
		const scanned = await scanInstancePolicyEvidence(this.deps.prisma, input);
		if (!scanned.available) return scanned;
		if (scanned.generationId !== current.generationId) {
			return unavailableEvidence(input.instanceId, current.evidence, "generation_changed");
		}
		return scanned;
	}

	async scanInstanceEpisodeParentPolicy(input: {
		userId: string;
		instanceId: string;
		domains: readonly PlexCanonicalDomain[];
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexEpisodeParentPolicyBatchHandler;
		onTargets?: (targets: readonly PlexGenerationTarget[]) => void | Promise<void>;
	}): Promise<PlexPolicyScanEvidence> {
		const current = await this.readInstance(input);
		if (!current.available) return current;
		const exactTargets = await verifyExactGenerationTargets(this.deps.prisma, current);
		if (!exactTargets.ok) {
			return unavailableEvidence(input.instanceId, current.evidence, exactTargets.reasonCode);
		}
		const selectedShowTmdbIds = new Set<number>();
		const scanned = await scanInstanceEpisodeParentPolicyEvidence(this.deps.prisma, {
			...input,
			onBatch: async (batch) => {
				for (const row of batch.rows) {
					if (row.mediaType === "series" && row.ratingKey?.trim()) {
						selectedShowTmdbIds.add(row.tmdbId);
					}
				}
				await input.onBatch?.(batch);
			},
		});
		if (!scanned.available) return scanned;
		if (scanned.generationId !== current.generationId) {
			return unavailableEvidence(input.instanceId, current.evidence, "generation_changed");
		}
		await input.onTargets?.(
			await readPlexGenerationTargetsForSelection(
				this.deps.prisma,
				exactTargets.expected,
				[...selectedShowTmdbIds].map((tmdbId) => ({ mediaType: "series" as const, tmdbId })),
			),
		);
		return scanned;
	}

	/**
	 * Revalidates one already-authorized persisted snapshot without contacting
	 * Plex. This is intentionally boolean-only so callers cannot treat the
	 * database observation as live authority.
	 */
	async revalidatePersistedSnapshot(input: {
		userId: string;
		instanceId: string;
		cacheType: "plex" | "plex_episode";
		expected: {
			statusFingerprint: string;
			rowCount: number;
			rowFingerprint: string;
		};
		now?: Date;
		maxAgeMs?: number;
	}): Promise<boolean> {
		const instance = await this.ownedInstance(input.userId, input.instanceId);
		if (!instance) return false;
		let rowCount: number;
		let rowFingerprint: string;
		let generationStatus: AvailablePlexInstanceEvidence["generationStatus"];
		if (input.cacheType === "plex") {
			const current = await scanInstancePolicyEvidence(this.deps.prisma, input);
			if (!current.available) return false;
			rowCount = current.rowCount;
			rowFingerprint = current.rowFingerprint;
			generationStatus = current.generationStatus;
		} else {
			const current = await loadInstanceEpisodeEvidence(this.deps.prisma, {
				...input,
				instance,
			});
			if (!current.available) return false;
			rowCount = current.rows.length;
			rowFingerprint = evidenceFingerprint(
				[...current.rows].sort((left, right) => left.id.localeCompare(right.id)),
			);
			generationStatus = current.generationStatus;
		}
		const statusFingerprint = evidenceFingerprint({
			instance: {
				id: instance.id,
				expectedIdentity: instance.expectedIdentity,
				identityKind: instance.identityKind,
				identityVerifiedAt: instance.identityVerifiedAt,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
				updatedAt: instance.updatedAt,
			},
			status: generationStatus,
		});
		return (
			statusFingerprint === input.expected.statusFingerprint &&
			rowCount === input.expected.rowCount &&
			rowFingerprint === input.expected.rowFingerprint
		);
	}

	async readUserSelected(input: {
		userId: string;
		selection: PlexCacheRowSelection;
		domains: readonly PlexCanonicalDomain[];
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
	}): Promise<SelectedPlexEvidence[]> {
		let instances: Array<{ id: string }>;
		try {
			instances = await this.deps.prisma.serviceInstance.findMany({
				where: { userId: input.userId, service: "PLEX", enabled: true },
				select: { id: true },
				orderBy: { id: "asc" },
			});
		} catch {
			return [
				unavailableEvidence(
					"",
					{
						availability: "unavailable",
						authority: "unavailable",
						attemptState: "unknown",
						publicationLevel: "unavailable",
						completeness: "unknown",
						reasonCodes: ["query_failed"],
					},
					"query_failed",
				),
			];
		}
		const evidence: SelectedPlexEvidence[] = [];
		for (const instance of instances) {
			evidence.push(
				await this.readInstanceSelected({
					...input,
					instanceId: instance.id,
				}),
			);
		}
		return evidence;
	}

	async scanUserPolicy(input: {
		userId: string;
		domains: readonly PlexCanonicalDomain[];
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexPolicyBatchHandler;
	}): Promise<PlexPolicyScanEvidence[]> {
		let instances: Array<{ id: string }>;
		try {
			instances = await this.deps.prisma.serviceInstance.findMany({
				where: { userId: input.userId, service: "PLEX", enabled: true },
				select: { id: true },
				orderBy: { id: "asc" },
			});
		} catch {
			return [
				unavailableEvidence(
					"",
					{
						availability: "unavailable",
						authority: "unavailable",
						attemptState: "unknown",
						publicationLevel: "unavailable",
						completeness: "unknown",
						reasonCodes: ["query_failed"],
					},
					"query_failed",
				),
			];
		}
		const evidence: PlexPolicyScanEvidence[] = [];
		for (const instance of instances) {
			evidence.push(await this.scanInstancePolicy({ ...input, instanceId: instance.id }));
		}
		return evidence;
	}

	/** Uncached selected fixed point followed immediately by Plex tag I/O. */
	async mutateMetadataTag(input: {
		userId: string;
		instanceId: string;
		target: { tmdbId: number; mediaType: "movie" | "series" };
		expectedRatingKey?: string;
		type: "collection" | "label";
		action: "add" | "remove";
		name: string;
	}): Promise<PlexMetadataTagMutationResult> {
		const instance = await this.ownedInstance(input.userId, input.instanceId);
		if (!instance) {
			return failedMetadataTagMutation(
				unavailableEvidence(
					input.instanceId,
					{
						availability: "unavailable",
						authority: "unavailable",
						attemptState: "unknown",
						publicationLevel: "unavailable",
						completeness: "unknown",
						reasonCodes: ["missing_status"],
					},
					"missing_status",
				).evidence,
				"provider_authority_unavailable",
			);
		}
		const selection: PlexCacheRowSelection = { kind: "targets", targets: [input.target] };
		const before = await loadInstanceSelectedEvidence(this.deps.prisma, {
			userId: input.userId,
			instanceId: input.instanceId,
			selection,
		});
		if (!before.available) {
			return failedMetadataTagMutation(
				before.evidence,
				classifyPlexMetadataTagEvidenceFailure(before.evidence),
			);
		}
		const client = this.client(instance);
		const current = await this.settle({
			userId: input.userId,
			instanceId: input.instanceId,
			before,
			instance,
			selection,
			domains: ["membership", input.type === "label" ? "labels" : "collections"],
			mutation: true,
			client,
			reread: async () =>
				await loadInstanceSelectedEvidence(this.deps.prisma, {
					userId: input.userId,
					instanceId: input.instanceId,
					selection,
				}),
		});
		if (!current.available) {
			return failedMetadataTagMutation(
				current.evidence,
				classifyPlexMetadataTagEvidenceFailure(current.evidence),
			);
		}
		const targetBinding = requirePlexTargetLedgerBinding(current.metadata);
		if (!targetBinding.ok) {
			return failedMetadataTagMutation(
				unavailableEvidence(input.instanceId, current.evidence, "target_ledger_binding_missing")
					.evidence,
				"provider_authority_unavailable",
			);
		}
		const targetLedger = await verifyPersistedPlexGenerationTargets(this.deps.prisma, {
			expected: {
				instanceId: input.instanceId,
				generationId: current.generationId,
				connectionGeneration: current.connectionGeneration,
				identityGeneration: current.identityGeneration,
				...targetBinding.binding,
			},
			sections: current.metadata.sections as Array<{
				key: string;
				uuid: string;
				type: "movie" | "show";
			}>,
		});
		if (!targetLedger.ok) {
			const reasonCode = targetLedger.reason as PlexCoverageReasonCode;
			return failedMetadataTagMutation(
				unavailableEvidence(input.instanceId, current.evidence, reasonCode).evidence,
				"provider_authority_unavailable",
			);
		}
		const persistedTargets = await readPlexGenerationTargetsForSelection(
			this.deps.prisma,
			{ instanceId: input.instanceId, generationId: current.generationId },
			[input.target],
		);
		const live = await collectSettledPlexCacheLiveEvidence(client, input.instanceId, this.deps.log);
		if (!live.complete || !live.inventoryTargets) {
			const evidence = unavailableEvidence(
				input.instanceId,
				current.evidence,
				"plex_content_digest_changed",
			).evidence;
			return failedMetadataTagMutation(evidence, "live_evidence_unavailable");
		}
		let liveTargets: PlexGenerationTarget[];
		try {
			liveTargets = normalizePlexGenerationTargets(
				live.inventoryTargets
					.filter(
						(target) =>
							target.tmdbId === input.target.tmdbId && target.mediaType === input.target.mediaType,
					)
					.map((target) => ({
						instanceId: input.instanceId,
						generationId: current.generationId,
						sectionId: target.sectionId,
						sectionUuid: target.sectionUuid ?? "",
						mediaType: target.mediaType,
						tmdbId: target.tmdbId,
						tvdbId: target.tvdbId ?? null,
						ratingKey: target.ratingKey,
					})),
				{ instanceId: input.instanceId, generationId: current.generationId },
			);
		} catch {
			return failedMetadataTagMutation(
				unavailableEvidence(input.instanceId, current.evidence, "target_ledger_invalid").evidence,
				"provider_authority_unavailable",
			);
		}
		if (!samePlexGenerationTargetSet(persistedTargets, liveTargets)) {
			const reasonCode =
				liveTargets.length === 0
					? "live_target_missing"
					: liveTargets.length > 1 || persistedTargets.length > 1
						? "live_target_ambiguous"
						: "live_target_changed";
			return failedMetadataTagMutation(
				unavailableEvidence(input.instanceId, current.evidence, "plex_content_digest_changed")
					.evidence,
				reasonCode,
			);
		}
		const after = await loadInstanceSelectedEvidence(this.deps.prisma, {
			userId: input.userId,
			instanceId: input.instanceId,
			selection,
		});
		const afterInstance = await this.ownedInstance(input.userId, input.instanceId);
		if (
			!after.available ||
			!afterInstance ||
			after.generationId !== current.generationId ||
			!samePlexGenerationBinding(current, after) ||
			!samePlexGenerationBinding(current, afterInstance)
		) {
			const reasonCode = !after.available
				? classifyPlexMetadataTagEvidenceFailure(after.evidence)
				: !afterInstance
					? "provider_authority_unavailable"
					: after.connectionGeneration !== current.connectionGeneration ||
							afterInstance.connectionGeneration !== current.connectionGeneration
						? "provider_connection_changed"
						: after.identityGeneration !== current.identityGeneration ||
								afterInstance.identityGeneration !== current.identityGeneration
							? "provider_identity_changed"
							: "publication_superseded";
			return failedMetadataTagMutation(
				unavailableEvidence(input.instanceId, current.evidence, "generation_changed").evidence,
				reasonCode,
			);
		}
		const singleTarget = selectSinglePlexGenerationTarget(persistedTargets);
		if (!singleTarget.ok) {
			return failedMetadataTagMutation(
				unavailableEvidence(input.instanceId, current.evidence, "mutation_authority_unavailable")
					.evidence,
				persistedTargets.length === 0 ? "live_target_missing" : "live_target_ambiguous",
			);
		}
		const ratingKeys = [
			...new Set(
				current.rows
					.filter(
						(row) =>
							row.tmdbId === input.target.tmdbId &&
							row.mediaType === input.target.mediaType &&
							row.ratingKey !== null &&
							row.thumb?.match(/\/library\/metadata\/(\d+)/)?.[1] === row.ratingKey.trim(),
					)
					.map((row) => row.ratingKey?.trim())
					.filter((ratingKey): ratingKey is string => Boolean(ratingKey)),
			),
		];
		if (
			ratingKeys.length !== 1 ||
			ratingKeys[0] !== singleTarget.target.ratingKey ||
			(input.expectedRatingKey !== undefined && ratingKeys[0] !== input.expectedRatingKey)
		) {
			return failedMetadataTagMutation(
				unavailableEvidence(input.instanceId, current.evidence, "mutation_authority_unavailable")
					.evidence,
				"live_target_changed",
			);
		}
		// This I/O immediately follows the terminal selected live observation.
		// Plex has no mutation lock, so a change can begin afterward; the fixed
		// point eliminates stale/cached authorization but cannot make Plex atomic.
		try {
			await client.updateMetadataTags(
				ratingKeys[0]!,
				input.target.mediaType,
				input.type,
				input.action,
				input.name,
			);
		} catch (error) {
			throw new PlexMetadataTagWriteError(
				error instanceof PlexRequestError ? error.responseCategory : "unavailable",
			);
		}
		return { ok: true };
	}

	async readInstanceSelectedEpisodes(input: {
		userId: string;
		instanceId: string;
		showTmdbIds: number[];
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
	}): Promise<SelectedPlexEpisodeEvidence> {
		const showTargets = [...new Set(input.showTmdbIds)].map((tmdbId) => ({
			tmdbId,
			mediaType: "series" as const,
		}));
		const parent = await this.readInstanceSelected({
			...input,
			selection: { kind: "targets", targets: showTargets },
			domains: ["membership", "episode-parents", "watch"],
		});
		if (!parent.available) return parent;
		const instance = await this.ownedInstance(input.userId, input.instanceId);
		if (!instance?.expectedIdentity) {
			return unavailableEvidence(input.instanceId, parent.evidence, "identity_generation_mismatch");
		}
		const parentTargets = await verifyExactGenerationTargets(this.deps.prisma, parent);
		if (!parentTargets.ok) {
			return unavailableEvidence(input.instanceId, parent.evidence, parentTargets.reasonCode);
		}
		const before = await loadInstanceSelectedEpisodeEvidence(this.deps.prisma, input);
		if (!before.available) return before;
		if (before.parentGenerationId !== parent.generationId) {
			return unavailableEvidence(
				input.instanceId,
				before.evidence,
				"parent_generation_unavailable",
			);
		}
		const showMap = new Map<number, Set<string>>();
		const selectedParentTargets = await readPlexGenerationTargetsForSelection(
			this.deps.prisma,
			parentTargets.expected,
			showTargets,
		);
		for (const target of selectedParentTargets) {
			if (target.mediaType !== "series" || !input.showTmdbIds.includes(target.tmdbId)) continue;
			const ratingKeys = showMap.get(target.tmdbId) ?? new Set<string>();
			ratingKeys.add(target.ratingKey);
			showMap.set(target.tmdbId, ratingKeys);
		}
		if (showTargets.some((target) => !showMap.has(target.tmdbId))) {
			return unavailableEvidence(
				input.instanceId,
				before.evidence,
				"parent_generation_unavailable",
			);
		}
		const client = this.client(instance);
		const initialObservation: PlexPersistedSelectionObservation = {
			generationId: `${parent.generationId}\u0000${before.generationId}`,
			connectionGeneration: before.connectionGeneration,
			identityGeneration: before.identityGeneration,
			providerIdentity: instance.expectedIdentity,
			metadata: parent.metadata,
			rows: canonicalEpisodeRows(before.rows, parent.rows),
		};
		const window = await settlePlexAuthorityWindow({
			persisted: initialObservation,
			selection: { kind: "all" },
			domains: ["episodes"],
			mutation: input.mutation === true,
			loadProbe: async ({ uncached }) => await this.probe(client, uncached),
			loadFreshRows: async () => {
				const collected = await collectPlexEpisodeLiveEvidence(
					client,
					showMap,
					instance.id,
					this.deps.log,
					plexConnectionFingerprint(instance),
				);
				if (!collected.complete || !collected.rows) {
					throw new PlexAuthorityUnavailableError("plex_content_digest_changed");
				}
				return canonicalEpisodeRows(collected.rows, parent.rows);
			},
			rereadPersisted: async () => {
				const [parentAfter, episodeAfter, instanceAfter] = await Promise.all([
					loadInstanceSelectedEvidence(this.deps.prisma, {
						userId: input.userId,
						instanceId: input.instanceId,
						selection: { kind: "targets", targets: showTargets },
					}),
					loadInstanceSelectedEpisodeEvidence(this.deps.prisma, input),
					this.ownedInstance(input.userId, input.instanceId),
				]);
				if (!parentAfter.available || !episodeAfter.available || !instanceAfter?.expectedIdentity) {
					throw new PlexAuthorityUnavailableError("generation_changed");
				}
				const parentAfterTargets = await verifyExactGenerationTargets(
					this.deps.prisma,
					parentAfter,
				);
				if (!parentAfterTargets.ok || !samePlexGenerationBinding(parent, parentAfter)) {
					throw new PlexAuthorityUnavailableError("generation_changed");
				}
				return {
					generationId: `${parentAfter.generationId}\u0000${episodeAfter.generationId}`,
					connectionGeneration: episodeAfter.connectionGeneration,
					identityGeneration: episodeAfter.identityGeneration,
					providerIdentity: instanceAfter.expectedIdentity,
					metadata: parentAfter.metadata,
					rows: canonicalEpisodeRows(episodeAfter.rows, parentAfter.rows),
				};
			},
		});
		if (!window.ok) {
			return unavailableEvidence(input.instanceId, before.evidence, window.reasonCode);
		}

		// Re-establish the parent fixed point after the episode observation. A
		// completed parent-library change in the gap must not leave old episode
		// rows bound to a parent generation that is only still present in SQLite.
		const parentAfter = await this.readInstanceSelected({
			...input,
			selection: { kind: "targets", targets: showTargets },
			domains: ["membership", "episode-parents", "watch"],
		});
		if (!parentAfter.available) return parentAfter;
		const parentAfterTargets = await verifyExactGenerationTargets(this.deps.prisma, parentAfter);
		if (!parentAfterTargets.ok || !samePlexGenerationBinding(parent, parentAfter)) {
			return unavailableEvidence(input.instanceId, before.evidence, "generation_changed");
		}
		const parentInstanceAfter = await this.ownedInstance(input.userId, input.instanceId);
		if (!parentInstanceAfter?.expectedIdentity) {
			return unavailableEvidence(input.instanceId, before.evidence, "identity_generation_mismatch");
		}
		const parentChanged = plexEpisodeParentAuthorityChanged(
			persistedObservation(parent, instance),
			persistedObservation(parentAfter, parentInstanceAfter),
			showTargets,
		);
		return parentChanged
			? unavailableEvidence(input.instanceId, before.evidence, parentChanged)
			: before;
	}

	async readInstanceEpisodes(input: {
		userId: string;
		instanceId: string;
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
	}): Promise<SelectedPlexEpisodeEvidence> {
		const parent = await this.readInstance({
			...input,
			domains: ["membership", "episode-parents"],
		});
		if (!parent.available) return parent;
		const parentInstance = await this.ownedInstance(input.userId, input.instanceId);
		if (!parentInstance?.expectedIdentity) {
			return unavailableEvidence(input.instanceId, parent.evidence, "identity_generation_mismatch");
		}
		const showTmdbIds = [
			...new Set(parent.rows.filter((row) => row.mediaType === "series").map((row) => row.tmdbId)),
		];
		const episodes = await this.readInstanceSelectedEpisodes({ ...input, showTmdbIds });
		if (!episodes.available) return episodes;

		const parentAfter = await this.readInstance({
			...input,
			domains: ["membership", "episode-parents"],
		});
		if (!parentAfter.available) return parentAfter;
		const parentInstanceAfter = await this.ownedInstance(input.userId, input.instanceId);
		if (!parentInstanceAfter?.expectedIdentity) {
			return unavailableEvidence(
				input.instanceId,
				episodes.evidence,
				"identity_generation_mismatch",
			);
		}
		const parentChanged = completeEpisodeParentAuthorityChanged(
			persistedObservation(parent, parentInstance),
			persistedObservation(parentAfter, parentInstanceAfter),
		);
		return parentChanged
			? unavailableEvidence(input.instanceId, episodes.evidence, parentChanged)
			: episodes;
	}

	/** Database-only companion used by the final cleanup approval transaction. */
	async readInstanceEpisodesPersisted(input: {
		userId: string;
		instanceId: string;
		now?: Date;
		maxAgeMs?: number;
	}): Promise<SelectedPlexEpisodeEvidence> {
		const parent = await this.scanInstanceExactPolicyPersisted(input);
		if (!parent.available) return parent;
		const episodes = await loadInstanceEpisodeEvidence(this.deps.prisma, input);
		if (!episodes.available) return episodes;
		if (episodes.parentGenerationId !== parent.generationId) {
			return unavailableEvidence(
				input.instanceId,
				episodes.evidence,
				"parent_generation_unavailable",
			);
		}
		return episodes;
	}
}
