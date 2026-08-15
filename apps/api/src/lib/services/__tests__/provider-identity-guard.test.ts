import { beforeEach, describe, expect, it, vi } from "vitest";

const identityModuleMocks = vi.hoisted(() => ({
	readProviderIdentity: vi.fn(),
}));

vi.mock("../service-identity.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../service-identity.js")>()),
	readProviderIdentity: identityModuleMocks.readProviderIdentity,
}));

import {
	createProviderPublicationAuthority,
	hasAuthoritativeProviderCacheGeneration,
	ProviderIdentityGuardError,
	type ProviderIdentityGuardOptions,
	withGuardedProviderPublication,
} from "../provider-identity-guard.js";

const silentLog = { warn: vi.fn() } as never;

beforeEach(() => {
	identityModuleMocks.readProviderIdentity.mockReset();
});

function identity(rawIdentity = "plex-machine-a") {
	return {
		service: "PLEX" as const,
		identityKind: "plex-machine-identifier" as const,
		rawIdentity,
		confirmationDigest: "a".repeat(64),
		fingerprint: "a".repeat(12),
	};
}

function instance(overrides: Record<string, unknown> = {}) {
	return {
		id: "provider-1",
		userId: "user-1",
		service: "PLEX" as const,
		enabled: true,
		baseUrl: "http://plex-a.test",
		encryptedApiKey: "cipher-a",
		encryptionIv: "iv-a",
		encryptedHttpAuthCredentials: "proxy-cipher-a",
		httpAuthEncryptionIv: "proxy-iv-a",
		apiKey: "plaintext-a",
		httpAuthHeaders: { authorization: "Basic aaa" },
		expectedIdentity: "plex-machine-a",
		identityStatus: "VERIFIED" as const,
		connectionGeneration: 4,
		identityGeneration: 8,
		...overrides,
	};
}

function prismaFor(
	row: Record<string, unknown> | undefined,
	options: { runClaimToken?: string | null; lockOrder?: string[]; lockedQueries?: string[] } = {},
) {
	let runClaimToken = options.runClaimToken ?? null;
	const tx = {
		libraryCleanupConfig: {
			upsert: vi.fn(async () => ({ id: "cleanup-1" })),
			findUnique: vi.fn(async () => ({ id: "cleanup-1", runClaimToken })),
		},
		serviceInstance: {
			findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
				if (!row || !matches(row, where)) return null;
				return { ...row };
			}),
			updateMany: vi.fn(
				async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
					if (!row || !matches(row, where)) return { count: 0 };
					Object.assign(row, data);
					return { count: 1 };
				},
			),
		},
		$queryRawUnsafe: vi.fn(async (query: string) => {
			options.lockedQueries?.push(query);
			options.lockOrder?.push(query.includes("library_cleanup_configs") ? "cleanup" : "service");
			return [];
		}),
	};
	return {
		...tx,
		setRunClaimToken(value: string | null) {
			runClaimToken = value;
		},
		$transaction: vi.fn(
			async (action: (transaction: typeof tx) => Promise<unknown>) => await action(tx),
		),
	};
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, value]) => row[key] === value);
}

function expectGuardError(error: unknown, code: ProviderIdentityGuardError["code"]) {
	expect(error).toBeInstanceOf(ProviderIdentityGuardError);
	expect(error).toMatchObject({ code });
	expect(error).not.toHaveProperty("message", expect.stringContaining("plex-machine"));
	expect(error).not.toHaveProperty("message", expect.stringContaining("plaintext-a"));
	return true;
}

describe("withGuardedProviderPublication", () => {
	it("builds stored publication authority without decrypted credentials", () => {
		const authority = createProviderPublicationAuthority({
			...instance(),
			label: "Primary Plex",
		} as never);

		expect(authority).toEqual({
			id: "provider-1",
			userId: "user-1",
			service: "PLEX",
			enabled: true,
			expectedIdentity: "plex-machine-a",
			identityStatus: "VERIFIED",
			connectionGeneration: 4,
			identityGeneration: 8,
			baseUrl: "http://plex-a.test",
			encryptedApiKey: "cipher-a",
			encryptionIv: "iv-a",
			encryptedHttpAuthCredentials: "proxy-cipher-a",
			httpAuthEncryptionIv: "proxy-iv-a",
		});
		expect(authority).not.toHaveProperty("apiKey");
		expect(authority).not.toHaveProperty("httpAuthHeaders");
	});

	it("does not expose an identity reader in production options", () => {
		const options: ProviderIdentityGuardOptions = {};
		const optionsHaveNoIdentityReader: "readIdentity" extends keyof ProviderIdentityGuardOptions
			? false
			: true = true;
		expect(optionsHaveNoIdentityReader).toBe(true);
		expect(options).not.toHaveProperty("readIdentity");
	});

	it("publishes only after matching verified identity before and after collection", async () => {
		const row = instance();
		const prisma = prismaFor(row);
		const collect = vi.fn(async () => "snapshot");
		const publish = vi.fn(async (_tx, snapshot: string) => `${snapshot}-published`);
		identityModuleMocks.readProviderIdentity.mockResolvedValue(identity());

		const result = await withGuardedProviderPublication(
			prisma as never,
			row as never,
			silentLog,
			collect,
			publish,
		);

		expect(result).toBe("snapshot-published");
		expect(identityModuleMocks.readProviderIdentity).toHaveBeenCalledTimes(2);
		expect(collect).toHaveBeenCalledOnce();
		expect(publish).toHaveBeenCalledOnce();
		expect(prisma.serviceInstance.findFirst).toHaveBeenLastCalledWith({
			where: expect.objectContaining({
				id: "provider-1",
				userId: "user-1",
				service: "PLEX",
				enabled: true,
				expectedIdentity: "plex-machine-a",
				identityStatus: "VERIFIED",
				connectionGeneration: 4,
				identityGeneration: 8,
				baseUrl: "http://plex-a.test",
				encryptedApiKey: "cipher-a",
				encryptedHttpAuthCredentials: "proxy-cipher-a",
			}),
		});
	});

	it("locks cleanup publication authority before the service row", async () => {
		vi.stubEnv("DATABASE_URL", "postgresql://publication-lock-test");
		const row = instance();
		const lockOrder: string[] = [];
		const lockedQueries: string[] = [];
		const prisma = prismaFor(row, { lockOrder, lockedQueries });
		identityModuleMocks.readProviderIdentity.mockResolvedValue(identity());

		try {
			await withGuardedProviderPublication(
				prisma as never,
				row as never,
				silentLog,
				async () => "snapshot",
				async (_tx, snapshot) => snapshot,
			);

			expect(lockOrder).toEqual(["cleanup", "service"]);
			expect(lockedQueries).toEqual([
				'SELECT "id" FROM "library_cleanup_configs" WHERE "id" = $1 FOR UPDATE',
				'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
			]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("skips publication behind an active cleanup run and succeeds after release", async () => {
		const row = instance();
		const prisma = prismaFor(row, { runClaimToken: "cleanup-run" });
		const publish = vi.fn(async (_tx, snapshot: string) => snapshot);
		identityModuleMocks.readProviderIdentity.mockResolvedValue(identity());

		await expect(
			withGuardedProviderPublication(
				prisma as never,
				row as never,
				silentLog,
				async () => "blocked",
				publish,
			),
		).rejects.toSatisfy((error: unknown) => expectGuardError(error, "PUBLICATION_SUPERSEDED"));
		expect(publish).not.toHaveBeenCalled();

		prisma.setRunClaimToken(null);
		await expect(
			withGuardedProviderPublication(
				prisma as never,
				row as never,
				silentLog,
				async () => "retry",
				publish,
			),
		).resolves.toBe("retry");
		expect(publish).toHaveBeenCalledOnce();
	});

	it("rejects unverified snapshots before collection", async () => {
		const row = instance({ identityStatus: "UNVERIFIED", expectedIdentity: null });
		const collect = vi.fn();

		await expect(
			withGuardedProviderPublication(
				prismaFor(row) as never,
				row as never,
				silentLog,
				collect,
				vi.fn(),
			),
		).rejects.toSatisfy((error: unknown) => expectGuardError(error, "IDENTITY_UNVERIFIED"));
		expect(collect).not.toHaveBeenCalled();
	});

	it("marks an owned identity mismatch without replacing its expected identity", async () => {
		const row = instance();
		const prisma = prismaFor(row);
		identityModuleMocks.readProviderIdentity.mockResolvedValue(identity("plex-machine-b"));

		await expect(
			withGuardedProviderPublication(prisma as never, row as never, silentLog, vi.fn(), vi.fn()),
		).rejects.toSatisfy((error: unknown) => expectGuardError(error, "IDENTITY_MISMATCH"));
		expect(row).toMatchObject({
			expectedIdentity: "plex-machine-a",
			identityStatus: "MISMATCH",
			identityGeneration: 8,
		});
		expect(prisma.serviceInstance.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({ userId: "user-1", identityStatus: "VERIFIED" }),
			data: expect.objectContaining({ identityStatus: "MISMATCH" }),
		});
	});

	it("marks a provider that changes identity during collection as mismatch", async () => {
		const row = instance();
		const prisma = prismaFor(row);
		identityModuleMocks.readProviderIdentity
			.mockResolvedValueOnce(identity("plex-machine-a"))
			.mockResolvedValueOnce(identity("plex-machine-b"));

		await expect(
			withGuardedProviderPublication(
				prisma as never,
				row as never,
				silentLog,
				vi.fn(async () => "snapshot"),
				vi.fn(),
			),
		).rejects.toSatisfy((error: unknown) => expectGuardError(error, "IDENTITY_MISMATCH"));
		expect(row).toMatchObject({ expectedIdentity: "plex-machine-a", identityStatus: "MISMATCH" });
	});

	it.each([
		{ name: "service", value: "TAUTULLI", field: "service" },
		{ name: "enabled state", value: false, field: "enabled" },
		{ name: "expected identity", value: "plex-machine-b", field: "expectedIdentity" },
		{ name: "identity status", value: "MISMATCH", field: "identityStatus" },
		{ name: "connection generation", value: 5, field: "connectionGeneration" },
		{ name: "identity generation", value: 9, field: "identityGeneration" },
		{ name: "URL", value: "http://plex-b.test", field: "baseUrl" },
		{ name: "credentials", value: "cipher-b", field: "encryptedApiKey" },
		{
			name: "proxy credentials",
			value: "proxy-cipher-b",
			field: "encryptedHttpAuthCredentials",
		},
		{ name: "credential IV", value: "iv-b", field: "encryptionIv" },
		{ name: "proxy credential IV", value: "proxy-iv-b", field: "httpAuthEncryptionIv" },
	])("rejects publication after a concurrent $name change", async ({ value, field }) => {
		const owned = instance();
		const row = { ...owned };
		const prisma = prismaFor(row);
		identityModuleMocks.readProviderIdentity.mockResolvedValue(identity());

		await expect(
			withGuardedProviderPublication(
				prisma as never,
				owned as never,
				silentLog,
				async () => {
					Object.assign(row, { [field]: value });
					return "snapshot";
				},
				vi.fn(),
			),
		).rejects.toSatisfy((error: unknown) => expectGuardError(error, "PUBLICATION_SUPERSEDED"));
	});

	it("rejects publication when ownership disappears during collection", async () => {
		const owned = instance();
		const row = { ...owned };
		identityModuleMocks.readProviderIdentity.mockResolvedValue(identity());
		await expect(
			withGuardedProviderPublication(
				prismaFor(row) as never,
				owned as never,
				silentLog,
				async () => {
					row.userId = "other-user";
					return "snapshot";
				},
				vi.fn(),
			),
		).rejects.toSatisfy((error: unknown) => expectGuardError(error, "PUBLICATION_SUPERSEDED"));
	});

	it("preserves expected identity and status on a dependency failure, then allows retry", async () => {
		const row = instance();
		identityModuleMocks.readProviderIdentity.mockRejectedValueOnce(
			new Error("http://secret.test plaintext-a"),
		);

		await expect(
			withGuardedProviderPublication(
				prismaFor(row) as never,
				row as never,
				silentLog,
				vi.fn(),
				vi.fn(),
			),
		).rejects.toSatisfy((error: unknown) => expectGuardError(error, "IDENTITY_UNAVAILABLE"));
		expect(row).toMatchObject({ expectedIdentity: "plex-machine-a", identityStatus: "VERIFIED" });

		identityModuleMocks.readProviderIdentity.mockResolvedValue(identity());
		await expect(
			withGuardedProviderPublication(
				prismaFor(row) as never,
				row as never,
				silentLog,
				vi.fn(async () => "retry"),
				async (_tx, snapshot) => snapshot,
			),
		).resolves.toBe("retry");
	});

	it("never treats nullable legacy cache generations as cleanup authority", () => {
		const authority = { connectionGeneration: 4, identityGeneration: 8 };
		expect(hasAuthoritativeProviderCacheGeneration(null, authority)).toBe(false);
		expect(
			hasAuthoritativeProviderCacheGeneration(
				{ connectionGeneration: null, identityGeneration: 8 },
				authority,
			),
		).toBe(false);
		expect(
			hasAuthoritativeProviderCacheGeneration(
				{ connectionGeneration: 4, identityGeneration: 8 },
				authority,
			),
		).toBe(true);
		// Returning to the same endpoint/credentials still has a newer fence.
		expect(
			hasAuthoritativeProviderCacheGeneration(
				{ connectionGeneration: 4, identityGeneration: 8 },
				{ connectionGeneration: 6, identityGeneration: 8 },
			),
		).toBe(false);
	});
});
