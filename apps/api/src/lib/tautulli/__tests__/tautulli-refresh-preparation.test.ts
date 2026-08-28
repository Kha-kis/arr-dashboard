import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";
import { refreshOwnedTautulliCache } from "../tautulli-cache-refresher.js";

const publishedAt = new Date("2026-08-27T12:00:00.000Z");
const metadata = JSON.stringify({ publicationLevel: "positive-only", generationId: "G1" });

function instance(): ServiceInstance {
	return {
		id: "tautulli-1",
		userId: "user-1",
		service: "TAUTULLI",
		label: "Private Tautulli",
		baseUrl: "https://private.invalid",
		externalUrl: null,
		encryptedApiKey: "encrypted-api-key-canary",
		encryptionIv: "encryption-iv-canary",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		connectionGeneration: 4,
		expectedIdentity: "tautulli-server-a",
		identityKind: "TAUTULLI_PMS_IDENTIFIER",
		identityStatus: "VERIFIED",
		identityGeneration: 9,
		identityVerifiedAt: publishedAt,
		identityLastCheckedAt: publishedAt,
		createdAt: publishedAt,
		updatedAt: publishedAt,
	};
}

type Status = {
	instanceId: string;
	cacheType: string;
	lastRefreshedAt: Date;
	lastResult: string;
	lastErrorMessage: string | null;
	itemCount: number;
	generationId: string | null;
	generationMetadata: string | null;
	lastAttemptAt: Date | null;
	lastAttemptResult: string | null;
	lastAttemptErrorMessage: string | null;
	connectionGeneration: number | null;
	identityGeneration: number | null;
};

function preparationFixture(initialStatus: Status | null) {
	const current = instance();
	let status = initialStatus ? { ...initialStatus } : null;
	const aggregateRows = [{ generationId: "G1", tmdbId: 42, watchCount: 3 }];
	const exactRows = [{ generationId: "G1", ratingKey: "private-rating-key" }];
	const tx = {
		libraryCleanupConfig: {
			upsert: vi.fn(async () => ({ id: "cleanup-user-1" })),
			findUnique: vi.fn(async () => ({ id: "cleanup-user-1", runClaimToken: null })),
		},
		serviceInstance: {
			findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
				Object.entries(where).every(
					([key, value]) => current[key as keyof ServiceInstance] === value,
				)
					? { id: current.id }
					: null,
			),
		},
		cacheRefreshStatus: {
			findUnique: vi.fn(async () => status),
			upsert: vi.fn(async ({ create, update }: { create: Status; update: Partial<Status> }) => {
				status = status ? { ...status, ...update } : { ...create };
				return status;
			}),
			updateMany: vi.fn(
				async ({ where, data }: { where: Record<string, unknown>; data: Partial<Status> }) => {
					if (
						!status ||
						!Object.entries(where).every(([key, value]) => status?.[key as keyof Status] === value)
					)
						return { count: 0 };
					status = { ...status, ...data };
					return { count: 1 };
				},
			),
		},
	};
	const prisma = {
		$transaction: vi.fn(
			async (callback: (transaction: typeof tx) => Promise<unknown>) => await callback(tx),
		),
	};
	const logRecords: unknown[] = [];
	const log = {
		info: vi.fn((...values: unknown[]) => logRecords.push(values)),
		warn: vi.fn((...values: unknown[]) => logRecords.push(values)),
		error: vi.fn((...values: unknown[]) => logRecords.push(values)),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(),
	} as unknown as FastifyBaseLogger;
	return {
		current,
		prisma,
		tx,
		log,
		logRecords,
		aggregateRows,
		exactRows,
		getStatus: () => status,
		setStatus: (next: Status) => {
			status = { ...next };
		},
	};
}

function positiveStatus(): Status {
	return {
		instanceId: "tautulli-1",
		cacheType: "tautulli",
		lastRefreshedAt: publishedAt,
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: 1,
		generationId: "G1",
		generationMetadata: metadata,
		lastAttemptAt: publishedAt,
		lastAttemptResult: "partial",
		lastAttemptErrorMessage: "observation_count_unavailable",
		connectionGeneration: 4,
		identityGeneration: 9,
	};
}

function authoritativeStatus(): Status {
	return {
		...positiveStatus(),
		generationMetadata: JSON.stringify({ publicationLevel: "authoritative", generationId: "G1" }),
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
	};
}

describe("Tautulli credential preparation attempt ownership", () => {
	it("preserves a positive publication while sealing a genuinely later decrypt failure", async () => {
		const state = preparationFixture(positiveStatus());
		const beforeAggregate = structuredClone(state.aggregateRows);
		const beforeExact = structuredClone(state.exactRows);

		const result = await refreshOwnedTautulliCache({
			prisma: state.prisma as never,
			encryptor: {
				decrypt: () => {
					throw new Error("CANARY_DECRYPT token=https://private.invalid");
				},
			},
			instance: state.current,
			log: state.log,
		});

		expect(result).toMatchObject({ kind: "unpublished", reasonCodes: ["credential_unavailable"] });
		expect(state.getStatus()).toMatchObject({
			lastRefreshedAt: publishedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: 1,
			generationId: "G1",
			generationMetadata: metadata,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "credential_unavailable",
			connectionGeneration: 4,
			identityGeneration: 9,
		});
		expect(state.getStatus()?.lastAttemptAt?.getTime()).toBeGreaterThan(publishedAt.getTime());
		expect(state.aggregateRows).toEqual(beforeAggregate);
		expect(state.exactRows).toEqual(beforeExact);
		expect(JSON.stringify(state.logRecords)).not.toMatch(
			/CANARY_DECRYPT|private\.invalid|encrypted-api-key-canary|encryption-iv-canary/,
		);
	});

	it("preserves an authoritative publication while sealing a genuinely later decrypt failure", async () => {
		const state = preparationFixture(authoritativeStatus());
		const beforeStatus = state.getStatus();
		const beforeAggregate = structuredClone(state.aggregateRows);
		const beforeExact = structuredClone(state.exactRows);

		const result = await refreshOwnedTautulliCache({
			prisma: state.prisma as never,
			encryptor: {
				decrypt: () => {
					throw new Error("CANARY_AUTHORITATIVE_DECRYPT");
				},
			},
			instance: state.current,
			log: state.log,
		});

		expect(result).toMatchObject({ kind: "unpublished", reasonCodes: ["credential_unavailable"] });
		expect(state.getStatus()).toMatchObject({
			lastRefreshedAt: beforeStatus?.lastRefreshedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: beforeStatus?.itemCount,
			generationId: beforeStatus?.generationId,
			generationMetadata: beforeStatus?.generationMetadata,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "credential_unavailable",
			connectionGeneration: beforeStatus?.connectionGeneration,
			identityGeneration: beforeStatus?.identityGeneration,
		});
		expect(state.aggregateRows).toEqual(beforeAggregate);
		expect(state.exactRows).toEqual(beforeExact);
		expect(JSON.stringify(state.logRecords)).not.toContain("CANARY_AUTHORITATIVE_DECRYPT");
	});

	it("does not let a stale decrypt failure overwrite a newer partial publication", async () => {
		const state = preparationFixture(positiveStatus());
		const newer = {
			...positiveStatus(),
			generationId: "G3",
			generationMetadata: JSON.stringify({ publicationLevel: "positive-only", generationId: "G3" }),
			lastAttemptAt: new Date("2026-08-27T13:00:00.000Z"),
			lastAttemptResult: "partial",
		};

		const result = await refreshOwnedTautulliCache({
			prisma: state.prisma as never,
			encryptor: {
				decrypt: () => {
					state.setStatus(newer);
					throw new Error("stale secret failure");
				},
			},
			instance: state.current,
			log: state.log,
		});

		expect(result).toMatchObject({ kind: "superseded", superseded: true });
		expect(state.getStatus()).toEqual(newer);
	});

	it("records a bounded first-ever credential failure without fabricating a generation", async () => {
		const state = preparationFixture(null);

		await refreshOwnedTautulliCache({
			prisma: state.prisma as never,
			encryptor: {
				decrypt: () => {
					throw new Error("first secret failure");
				},
			},
			instance: state.current,
			log: state.log,
		});

		expect(state.getStatus()).toMatchObject({
			lastResult: "error",
			itemCount: 0,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: "credential_unavailable",
		});
		expect(state.getStatus()?.generationId ?? null).toBeNull();
		expect(state.getStatus()?.generationMetadata ?? null).toBeNull();
	});
});
