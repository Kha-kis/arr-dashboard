import type { PlexCanonicalDomain, PlexCoverageReasonCode, PlexEvidenceSummary } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import { evidenceFingerprint } from "../evidence-fingerprint.js";
import type { PrismaClientInstance, ServiceInstance } from "../prisma.js";
import { collectPlexCacheLiveEvidence, isPersonalMediaSection } from "./plex-cache-refresher.js";
import type { PlexCacheRowSelection } from "./plex-cache-storage.js";
import { createPlexClient, type PlexClient } from "./plex-client.js";
import { collectPlexEpisodeLiveEvidence } from "./plex-episode-live-collector.js";
import {
	createPlexSelectionProjection,
	type PlexCanonicalObservation,
	type PlexCanonicalSelection,
} from "./plex-canonical-projection.js";
import type { DecodedPlexGenerationMetadata } from "./plex-generation-metadata.js";
import {
	evaluatePlexLiveSettlement,
	type PlexLiveActivity,
	type PlexLiveSection,
} from "./plex-live-settlement.js";
import {
	isCurrentAuthoritativePlexEvidence,
	loadInstanceEpisodeEvidence,
	loadInstanceEvidence,
	loadInstanceSelectedEpisodeEvidence,
	loadInstanceSelectedEvidence,
	scanInstanceEpisodeParentPolicyEvidence,
	scanInstancePolicyEvidence,
	type AvailablePlexInstanceEvidence,
	type AvailableSelectedPlexEvidence,
	type PlexInstanceEvidence,
	type PlexPolicyBatchHandler,
	type PlexEpisodeParentPolicyBatchHandler,
	type PlexPolicyScanEvidence,
	type SelectedPlexEvidence,
	type SelectedPlexEpisodeEvidence,
	type UnavailablePlexInstanceEvidence,
} from "./plex-evidence-repository.js";
import { plexConnectionFingerprint } from "./service-instance-fingerprint.js";

export {
	hasAuthoritativePlexEvidence,
	hasAuthoritativeSelectedPlexEvidence,
	hasCompleteAuthoritativePlexEvidence,
	isCurrentAuthoritativePlexEvidence,
	listPublishedSections,
	summarizePlexEvidence,
} from "./plex-evidence-repository.js";
export type {
	AvailablePlexInstanceEvidence,
	AvailablePlexPolicyEvidence,
	PlexInstanceEvidence,
	PlexPolicyScanEvidence,
	SelectedPlexEvidence,
	SelectedPlexEpisodeEvidence,
} from "./plex-evidence-repository.js";
export { DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS } from "./plex-evidence-repository.js";

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

export type PlexAuthorityWindowResult =
	| { ok: true; persisted: PlexPersistedSelectionObservation }
	| { ok: false; reasonCode: PlexCoverageReasonCode };

function selectedSectionIdentity(
	sections: readonly PlexLiveSection[],
	selectedSectionKeys: readonly string[],
): string | null {
	const byKey = new Map(sections.map((section) => [section.key, section]));
	const identity: Array<[string, string, string, string]> = [];
	for (const key of [...new Set(selectedSectionKeys)].sort()) {
		const section = byKey.get(key);
		if (!section) return null;
		identity.push([section.key, section.uuid, section.type, section.title]);
	}
	return JSON.stringify(identity);
}

function persistedSectionIdentity(
	metadata: DecodedPlexGenerationMetadata,
	selectedSectionKeys: readonly string[],
): string | null {
	if (metadata.version !== 3) return null;
	return selectedSectionIdentity(metadata.sections, selectedSectionKeys);
}

function evaluateProbe(
	probe: PlexAuthorityProbe,
	selectedSectionKeys: readonly string[],
	expectedSectionIdentity: string,
	requireCompleteSectionCatalog: boolean,
): PlexCoverageReasonCode | null {
	const supportedSections = probe.sections.filter(
		(section) =>
			(section.type === "movie" || section.type === "show") && !isPersonalMediaSection(section),
	);
	const settlementSectionKeys = requireCompleteSectionCatalog
		? supportedSections.map((section) => section.key)
		: selectedSectionKeys;
	const settlement = evaluatePlexLiveSettlement({
		activities: probe.activities,
		sections: probe.sections,
		selectedSectionKeys: settlementSectionKeys,
	});
	if (!settlement.settled) return settlement.reasonCodes[0] ?? "plex_section_state_unavailable";
	const identity = selectedSectionIdentity(
		requireCompleteSectionCatalog ? supportedSections : probe.sections,
		settlementSectionKeys,
	);
	if (identity === null || identity !== expectedSectionIdentity) {
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
	selectedSectionKeys: readonly string[];
	mutation: boolean;
	requireCompleteSectionCatalog?: boolean;
	loadProbe: (options: { uncached: boolean }) => Promise<PlexAuthorityProbe>;
	loadFreshRows: (options: { uncached: boolean }) => Promise<readonly PlexCanonicalObservation[]>;
	rereadPersisted: () => Promise<PlexPersistedSelectionObservation>;
}): Promise<PlexAuthorityWindowResult> {
	if (input.persisted.metadata.version !== 3) {
		return { ok: false, reasonCode: "plex_settlement_metadata_missing" };
	}
	const expectedSectionIdentity = persistedSectionIdentity(
		input.persisted.metadata,
		input.selectedSectionKeys,
	);
	if (expectedSectionIdentity === null) {
		return { ok: false, reasonCode: "plex_settlement_metadata_missing" };
	}
	const options = { uncached: input.mutation };
	try {
		const startProbe = await input.loadProbe(options);
		const startReason = evaluateProbe(
			startProbe,
			input.selectedSectionKeys,
			expectedSectionIdentity,
			input.requireCompleteSectionCatalog === true,
		);
		if (startReason) return { ok: false, reasonCode: startReason };

		const preliminaryRows = await input.loadFreshRows(options);
		const endProbe = await input.loadProbe(options);
		const endReason = evaluateProbe(
			endProbe,
			input.selectedSectionKeys,
			expectedSectionIdentity,
			input.requireCompleteSectionCatalog === true,
		);
		if (endReason) return { ok: false, reasonCode: endReason };

		const preliminary = createPlexSelectionProjection({
			rows: preliminaryRows,
			selection: input.selection,
			domains: input.domains,
		});
		const finalProbe = await input.loadProbe(options);
		const finalReason = evaluateProbe(
			finalProbe,
			input.selectedSectionKeys,
			expectedSectionIdentity,
			input.requireCompleteSectionCatalog === true,
		);
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
	"serviceInstance" | "cacheRefreshStatus" | "plexCache" | "plexEpisodeCache"
>;

type AvailablePersistedEvidence = AvailablePlexInstanceEvidence | AvailableSelectedPlexEvidence;

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

function selectionSectionKeys(
	persisted: AvailablePersistedEvidence,
	selection: PlexCacheRowSelection | { kind: "all" },
): string[] {
	const all = persisted.metadata.sections.map((section) => section.key).sort();
	if (selection.kind !== "targets") return all;
	const keys = new Set<string>();
	for (const target of selection.targets) {
		const matches = persisted.rows.filter(
			(row) => row.tmdbId === target.tmdbId && row.mediaType === target.mediaType,
		);
		if (matches.length === 0) return all;
		for (const row of matches) keys.add(row.sectionId);
	}
	return [...keys].sort();
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
			selectedSectionKeys: selectionSectionKeys(input.before, input.selection),
			mutation: input.mutation,
			requireCompleteSectionCatalog: input.selection.kind === "authority-only",
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

	async scanInstanceEpisodeParentPolicy(input: {
		userId: string;
		instanceId: string;
		domains: readonly PlexCanonicalDomain[];
		mutation?: boolean;
		now?: Date;
		maxAgeMs?: number;
		onBatch?: PlexEpisodeParentPolicyBatchHandler;
	}): Promise<PlexPolicyScanEvidence> {
		const current = await this.readInstance(input);
		if (!current.available) return current;
		const scanned = await scanInstanceEpisodeParentPolicyEvidence(this.deps.prisma, input);
		if (!scanned.available) return scanned;
		if (scanned.generationId !== current.generationId) {
			return unavailableEvidence(input.instanceId, current.evidence, "generation_changed");
		}
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
	}): Promise<{ ok: true } | { ok: false; evidence: PlexEvidenceSummary }> {
		const instance = await this.ownedInstance(input.userId, input.instanceId);
		if (!instance) {
			return {
				ok: false,
				evidence: unavailableEvidence(
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
			};
		}
		const selection: PlexCacheRowSelection = { kind: "targets", targets: [input.target] };
		const before = await loadInstanceSelectedEvidence(this.deps.prisma, {
			userId: input.userId,
			instanceId: input.instanceId,
			selection,
		});
		if (!before.available) return { ok: false, evidence: before.evidence };
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
		if (!current.available) return { ok: false, evidence: current.evidence };
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
			(input.expectedRatingKey !== undefined && ratingKeys[0] !== input.expectedRatingKey)
		) {
			return {
				ok: false,
				evidence: unavailableEvidence(
					input.instanceId,
					current.evidence,
					"mutation_authority_unavailable",
				).evidence,
			};
		}
		// This I/O immediately follows the terminal selected live observation.
		// Plex has no mutation lock, so a change can begin afterward; the fixed
		// point eliminates stale/cached authorization but cannot make Plex atomic.
		await client.updateMetadataTags(
			ratingKeys[0]!,
			input.target.mediaType,
			input.type,
			input.action,
			input.name,
		);
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
		for (const row of parent.rows) {
			if (row.mediaType !== "series" || !row.ratingKey?.trim()) continue;
			const ratingKeys = showMap.get(row.tmdbId) ?? new Set<string>();
			ratingKeys.add(row.ratingKey);
			showMap.set(row.tmdbId, ratingKeys);
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
		const selectedSectionKeys = selectionSectionKeys(parent, {
			kind: "targets",
			targets: showTargets,
		});
		const window = await settlePlexAuthorityWindow({
			persisted: initialObservation,
			selection: { kind: "all" },
			domains: ["episodes"],
			selectedSectionKeys,
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
}
