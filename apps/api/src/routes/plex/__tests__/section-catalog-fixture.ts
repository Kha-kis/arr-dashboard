import type { ProviderCoverageUnitV1 } from "@arr/shared";
import { vi } from "vitest";

/** Synthetic provider/database boundaries; no credentials or live connections. */
export function sectionCatalogFixture() {
	const observedAt = new Date(Date.now() - 60_000);
	const instance = {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		enabled: true,
		label: "Primary",
		baseUrl: "http://plex.invalid",
		encryptedApiKey: "synthetic",
		encryptionIv: "synthetic",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		expectedIdentity: "machine-1",
		identityStatus: "VERIFIED",
		identityKind: "PLEX_MACHINE_IDENTIFIER",
		identityGeneration: 9,
		connectionGeneration: 4,
		identityVerifiedAt: observedAt,
		updatedAt: observedAt,
	};
	const section = {
		key: "1",
		uuid: "section-uuid",
		title: "Movies",
		type: "movie",
		refreshing: false,
		scannedAt: 1_777_000_000,
		updatedAt: 1_777_000_100,
	};
	const unit = (scopeKey: string): ProviderCoverageUnitV1 => ({
		scopeKey,
		expectedRawCount: 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
	});
	const metadata = {
		version: 6,
		publicationLevel: "positive-only",
		completeness: "partial",
		itemCount: 1,
		canonicalizationVersion: 1,
		sections: [section],
		observedRoots: [],
		ambiguousTmdbCandidates: [],
		capabilities: [
			{
				domain: "episode-parents",
				field: "membership",
				semantics: "observed-targets-only",
				operators: [],
			},
		],
		targetLedgerVersion: 1,
		targetCount: 1,
		targetDigest: "b".repeat(64),
		partialReasons: [],
		coverageReceipt: {
			version: 2,
			provider: "plex",
			attemptStartedAt: new Date(observedAt.getTime() - 1_000).toISOString(),
			observedAt: observedAt.toISOString(),
			evidence: "positive-only",
			units: [
				{
					...unit("plex:aggregate"),
					expectedRawCount: 2,
					rawObserved: 2,
					acceptedSkips: [{ reason: "missing-supported-mapping", count: 1 }],
				},
			],
			publishedCanonicalEntities: 1,
			domains: ["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"].map(
				(domain) => ({
					domain,
					evidence: "complete",
					valueSemantics: "exact",
					units: [unit(domain === "library-inventory" ? "section:1:inventory" : `plex:${domain}`)],
					...(domain === "mapping" || domain === "watch-count"
						? { publishedCanonicalEntities: 1 }
						: {}),
				}),
			),
		},
	};
	metadata.coverageReceipt.domains[0]!.units[0]!.expectedRawCount = 2;
	metadata.coverageReceipt.domains[0]!.units[0]!.rawObserved = 2;
	metadata.coverageReceipt.domains[0]!.units[0]!.sourceBindings = 2;
	Object.assign(metadata.coverageReceipt.domains[1]!, {
		evidence: "positive-only",
		valueSemantics: "lower-bound",
	});
	metadata.coverageReceipt.domains[1]!.units = [
		{
			...unit("section:1:mapping"),
			expectedRawCount: 2,
			rawObserved: 2,
			acceptedSkips: [{ reason: "missing-supported-mapping", count: 1 }],
		},
	];
	const status = {
		id: "status-1",
		instanceId: instance.id,
		cacheType: "plex",
		lastRefreshedAt: observedAt,
		lastResult: "success",
		lastErrorMessage: null,
		generationId: "generation-1",
		generationMetadata: JSON.stringify(metadata),
		itemCount: 1,
		lastAttemptAt: observedAt,
		lastAttemptResult: "partial",
		lastAttemptErrorMessage: null,
		connectionGeneration: 4,
		identityGeneration: 9,
	};
	const instances = [instance];
	const selectInstances = ({ where }: { where: Record<string, unknown> }) =>
		instances.filter((row) =>
			Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value),
		);
	const prisma = {
		serviceInstance: {
			findMany: vi.fn(async (input) => selectInstances(input)),
			findFirst: vi.fn(async (input) => selectInstances(input)[0] ?? null),
		},
		cacheRefreshStatus: {
			findMany: vi.fn(async (_input: { where: { instanceId: string } }) => [status]),
		},
		plexCache: { count: vi.fn(async () => 1), findMany: vi.fn(async () => []) },
	};
	const publishMetadata = () => {
		status.generationMetadata = JSON.stringify(metadata);
	};
	return { instance, instances, section, metadata, status, prisma, publishMetadata };
}
