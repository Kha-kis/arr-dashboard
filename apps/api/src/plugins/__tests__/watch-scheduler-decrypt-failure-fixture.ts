import { expect, vi } from "vitest";

type WatchService = "JELLYFIN" | "EMBY" | "TAUTULLI";

export function watchSchedulerDecryptFailureFixture(service: WatchService) {
	const instance = {
		id: `${service.toLowerCase()}-1`,
		userId: "user-1",
		service,
		label: service,
		baseUrl: `https://${service.toLowerCase()}.example.com`,
		externalUrl: null,
		encryptedApiKey: "encrypted-secret-token",
		encryptionIv: "token-iv",
		encryptedHttpAuthCredentials: "encrypted-proxy-secret",
		httpAuthEncryptionIv: "proxy-iv",
		enabled: true,
		isDefault: false,
		expectedIdentity: `${service.toLowerCase()}-server-a`,
		identityKind: null,
		identityStatus: "VERIFIED",
		identityLastCheckedAt: null,
		identityGeneration: 9,
		connectionGeneration: 4,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const current = { ...instance };
	const successfulAt = new Date("2026-02-01T00:00:00.000Z");
	const status = {
		instanceId: instance.id,
		cacheType: service === "TAUTULLI" ? "tautulli" : "jellyfin",
		lastRefreshedAt: successfulAt,
		lastResult: "success",
		lastErrorMessage: null as string | null,
		itemCount: 37,
		lastAttemptAt: successfulAt,
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null as string | null,
		connectionGeneration: 4,
		identityGeneration: 9,
	};
	const tx = {
		serviceInstance: {
			findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
				Object.entries(where).every(
					([key, value]) => current[key as keyof typeof current] === value,
				)
					? { id: current.id }
					: null,
			),
		},
		cacheRefreshStatus: {
			findUnique: vi.fn(async () => ({
				connectionGeneration: status.connectionGeneration,
				identityGeneration: status.identityGeneration,
			})),
			upsert: vi.fn(async ({ update }: { update: Partial<typeof status> }) => {
				Object.assign(status, update);
				return status;
			}),
		},
	};
	const app = {
		encryptor: {},
		prisma: {
			$transaction: vi.fn(
				async (action: (transaction: typeof tx) => Promise<unknown>) => await action(tx),
			),
		},
		log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
	};
	return { app, current, instance, status, successfulAt, tx };
}

export function expectPreservedSuccessWithSanitizedDecryptFailure(
	state: ReturnType<typeof watchSchedulerDecryptFailureFixture>,
): void {
	expect(state.status).toMatchObject({
		lastRefreshedAt: state.successfulAt,
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: 37,
		lastAttemptResult: "error",
		lastAttemptErrorMessage: "Provider credentials could not be decrypted.",
		connectionGeneration: 4,
		identityGeneration: 9,
	});
	expect(state.status.lastAttemptErrorMessage).not.toContain("secret-token");
	expect(state.status.lastAttemptErrorMessage).not.toContain("proxy-secret");
}
