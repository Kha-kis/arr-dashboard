import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	assertCurrentProviderEvidenceAuthority,
	createSanitizedProviderEvidence,
} from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

function fingerprint(value: unknown): string {
	const canonicalize = (input: unknown): unknown => {
		if (input instanceof Date) return input.toISOString();
		if (Array.isArray(input)) return input.map(canonicalize);
		if (typeof input === "object" && input !== null) {
			return Object.fromEntries(
				Object.entries(input as Record<string, unknown>)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, entry]) => [key, canonicalize(entry)]),
			);
		}
		return input;
	};
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function fixture() {
	const now = new Date();
	const instance = {
		id: "plex-1",
		userId: "user-1",
		service: "PLEX",
		name: "Private label",
		label: "Private label",
		baseUrl: "http://private.invalid",
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		expectedIdentity: "plex-machine-a",
		identityKind: "PLEX_MACHINE_IDENTIFIER",
		identityStatus: "VERIFIED",
		identityVerifiedAt: new Date(now.getTime() - 5_000),
		connectionGeneration: 3,
		identityGeneration: 7,
		createdAt: new Date(now.getTime() - 20_000),
		updatedAt: new Date(now.getTime() - 10_000),
	};
	let instances = [instance];
	const status = {
		instanceId: instance.id,
		cacheType: "plex",
		lastRefreshedAt: now,
		lastResult: "success",
		lastErrorMessage: null,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null as string | null,
		itemCount: 1,
		connectionGeneration: 3,
		identityGeneration: 7,
		generationId: "generation-a",
		generationMetadata: "{}",
	};
	let rows = [
		{
			id: "plex-row-1",
			instanceId: instance.id,
			tmdbId: 42,
			mediaType: "movie",
			sectionId: "1",
			sectionTitle: "Movies",
			lastWatchedAt: now,
			watchCount: 2,
			watchedByUsers: "[]",
			onDeck: false,
			userRating: null,
			collections: "[]",
			labels: "[]",
			addedAt: null,
			connectionGeneration: 3,
			identityGeneration: 7,
		},
	];
	const statusFingerprint = fingerprint({
		instance: {
			id: instance.id,
			expectedIdentity: instance.expectedIdentity,
			identityKind: instance.identityKind,
			identityVerifiedAt: instance.identityVerifiedAt,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
			updatedAt: instance.updatedAt,
		},
		status: {
			instanceId: status.instanceId,
			lastRefreshedAt: status.lastRefreshedAt,
			lastResult: status.lastResult,
			lastErrorMessage: status.lastErrorMessage,
			lastAttemptResult: status.lastAttemptResult,
			lastAttemptErrorMessage: status.lastAttemptErrorMessage,
			itemCount: status.itemCount,
			connectionGeneration: status.connectionGeneration,
			identityGeneration: status.identityGeneration,
			generationId: status.generationId,
			generationMetadata: status.generationMetadata,
		},
	});
	const evidence = createSanitizedProviderEvidence(
		["plex"],
		[
			{
				service: "PLEX",
				identityKind: instance.identityKind,
				identityFingerprint: fingerprint({
					service: instance.service,
					identityKind: instance.identityKind,
					expectedIdentity: instance.expectedIdentity,
				}),
				connectionGeneration: 3,
				identityGeneration: 7,
				cacheType: "plex",
				completedAt: now.toISOString(),
				itemCount: 1,
				verifiedAt: instance.identityVerifiedAt.toISOString(),
				statusFingerprint,
				rowFingerprint: fingerprint(rows),
			},
		],
	);
	const tx = {
		$queryRawUnsafe: vi.fn().mockResolvedValue([{ id: instance.id }]),
		serviceInstance: { findMany: vi.fn(async () => instances) },
		cacheRefreshStatus: { findMany: vi.fn(async () => [status]) },
		plexCache: { findMany: vi.fn(async () => rows) },
	};
	const identityReader = vi.fn(async () => ({
		service: "PLEX",
		identityKind: "plex-machine-identifier",
		rawIdentity: instance.expectedIdentity,
		confirmationDigest: "safe",
		fingerprint: "safe",
	}));
	const deps = {
		prisma: {
			serviceInstance: tx.serviceInstance,
			cacheRefreshStatus: tx.cacheRefreshStatus,
			plexCache: tx.plexCache,
			$transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		},
		encryptor: { decrypt: vi.fn(() => "decrypted") },
		providerIdentityReader: identityReader,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as CleanupExecutorDeps;
	return {
		deps,
		evidence,
		instance,
		status,
		identityReader,
		setInstances(next: typeof instances) {
			instances = next;
		},
		setRows(next: typeof rows) {
			rows = next;
		},
	};
}

describe("provider execution authority", () => {
	it("live-checks identity and exact rows, then fences the accepted snapshot", async () => {
		const subject = fixture();
		const assertLease = vi.fn().mockResolvedValue(undefined);

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, assertLease),
		).resolves.toBeUndefined();

		expect(subject.identityReader).toHaveBeenCalledTimes(1);
		expect(assertLease).toHaveBeenCalledTimes(2);
		expect(subject.deps.prisma.$transaction).toHaveBeenCalledTimes(1);
	});

	it("fails closed when the live provider identity does not match", async () => {
		const subject = fixture();
		subject.identityReader.mockResolvedValueOnce({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "plex-machine-b",
			confirmationDigest: "safe",
			fingerprint: "safe",
		});

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.deps.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("rejects row drift even while the status token lags unchanged", async () => {
		const subject = fixture();
		subject.setRows([]);

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.identityReader).not.toHaveBeenCalled();
	});

	it("does not reuse the first target check after rows drift", async () => {
		const subject = fixture();
		const assertLease = vi.fn();
		await assertCurrentProviderEvidenceAuthority(
			subject.deps,
			"user-1",
			subject.evidence,
			assertLease,
		);
		subject.setRows([]);

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, assertLease),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.identityReader).toHaveBeenCalledTimes(1);
	});

	it.each([
		["connection generation", "connectionGeneration"],
		["identity generation", "identityGeneration"],
	] as const)("rejects a changed %s", async (_label, field) => {
		const subject = fixture();
		subject.instance[field]++;

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.identityReader).not.toHaveBeenCalled();
	});

	for (const state of ["disabled", "deleted", "mismatched"] as const) {
		it(`rejects a ${state} contributing instance`, async () => {
			const subject = fixture();
			if (state === "disabled") subject.instance.enabled = false;
			else if (state === "deleted") subject.setInstances([]);
			else subject.instance.identityStatus = "MISMATCH";

			await expect(
				assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
			).rejects.toThrow("Provider execution authority changed");
		});
	}

	it("rejects a same-identity refresh or invalidated cache status", async () => {
		const subject = fixture();
		subject.status.generationId = "generation-b";
		subject.status.lastAttemptErrorMessage = "refresh failed";

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
	});

	it("rejects identity dependency failure without entering the database fence", async () => {
		const subject = fixture();
		subject.identityReader.mockRejectedValueOnce(new Error("private upstream failure"));

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.deps.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("rejects drift after the live read in the final protected fence", async () => {
		const subject = fixture();
		subject.identityReader.mockImplementationOnce(async () => {
			subject.setRows([]);
			return {
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: subject.instance.expectedIdentity,
				confirmationDigest: "safe",
				fingerprint: "safe",
			};
		});

		await expect(
			assertCurrentProviderEvidenceAuthority(subject.deps, "user-1", subject.evidence, vi.fn()),
		).rejects.toThrow("Provider execution authority changed");
		expect(subject.deps.prisma.$transaction).toHaveBeenCalledOnce();
	});
});
