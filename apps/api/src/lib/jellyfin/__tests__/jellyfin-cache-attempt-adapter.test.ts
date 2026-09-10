import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const coordinator = vi.hoisted(() => ({
	runProviderObservationAttempt: vi.fn(),
	runClaimedProviderObservationAttempt: vi.fn(),
	ProviderObservationCoordinatorError: class extends Error {},
}));

vi.mock("../../provider-observation/coordinator.js", () => coordinator);

import {
	refreshOwnedJellyfinCache,
	refreshOwnedJellyfinCacheWithAttempt,
} from "../jellyfin-cache-refresher.js";

const instance = {
	id: "jellyfin-1",
	userId: "user-1",
	service: "JELLYFIN" as const,
	label: "Jellyfin",
	baseUrl: "https://jellyfin.example.test",
	enabled: true,
	encryptedApiKey: "encrypted-key",
	encryptionIv: "key-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	expectedIdentity: "server-a",
	identityStatus: "VERIFIED" as const,
	connectionGeneration: 2,
	identityGeneration: 3,
};
const context = {
	prisma: {} as never,
	encryptor: { decrypt: vi.fn(() => "decrypted-key") },
	instance: instance as never,
	log: { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger,
};
const attempt = {
	attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
	resultMarker: "in_progress:11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
	vi.clearAllMocks();
	coordinator.runProviderObservationAttempt.mockResolvedValue({
		complete: true,
		upserted: 1,
		errors: 0,
		errorMessages: [],
	});
	coordinator.runClaimedProviderObservationAttempt.mockResolvedValue({
		complete: true,
		upserted: 1,
		errors: 0,
		errorMessages: [],
	});
});

describe("Jellyfin owned refresh attempt adapters", () => {
	it("uses the shared claim-and-run entry point for legacy callers", async () => {
		await refreshOwnedJellyfinCache(context);

		expect(coordinator.runProviderObservationAttempt).toHaveBeenCalledOnce();
		expect(coordinator.runClaimedProviderObservationAttempt).not.toHaveBeenCalled();
	});

	it("continues the exact caller-supplied attempt without beginning another claim", async () => {
		await refreshOwnedJellyfinCacheWithAttempt(context, attempt);

		expect(coordinator.runProviderObservationAttempt).not.toHaveBeenCalled();
		expect(coordinator.runClaimedProviderObservationAttempt).toHaveBeenCalledOnce();
		expect(coordinator.runClaimedProviderObservationAttempt.mock.calls[0]?.[1]).toBe(attempt);
		expect(context.encryptor.decrypt).not.toHaveBeenCalled();

		const input = coordinator.runClaimedProviderObservationAttempt.mock.calls[0]?.[0] as {
			prepare: () => unknown;
		};
		await input.prepare();
		expect(context.encryptor.decrypt).toHaveBeenCalledOnce();
	});
});
