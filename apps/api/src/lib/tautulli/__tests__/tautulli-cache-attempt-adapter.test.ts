import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const coordinator = vi.hoisted(() => ({
	runProviderObservationAttempt: vi.fn(),
	runClaimedProviderObservationAttempt: vi.fn(),
	ProviderObservationCoordinatorError: class extends Error {},
}));

vi.mock("../../provider-observation/coordinator.js", () => coordinator);

import {
	refreshOwnedTautulliCache,
	refreshOwnedTautulliCacheWithAttempt,
} from "../tautulli-cache-refresher.js";

const instance = {
	id: "tautulli-1",
	userId: "user-1",
	service: "TAUTULLI" as const,
	label: "Tautulli",
	baseUrl: "https://tautulli.example.test",
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
		kind: "positive-observation",
		complete: false,
		upserted: 1,
		errors: 0,
		errorMessages: [],
		completedAt: new Date("2026-08-20T12:01:00.000Z"),
		receipt: {},
	});
	coordinator.runClaimedProviderObservationAttempt.mockResolvedValue({
		kind: "positive-observation",
		complete: false,
		upserted: 1,
		errors: 0,
		errorMessages: [],
		completedAt: new Date("2026-08-20T12:01:00.000Z"),
		receipt: {},
	});
});

describe("Tautulli owned refresh attempt adapters", () => {
	it("uses the shared claim-and-run entry point for legacy callers", async () => {
		await refreshOwnedTautulliCache(context);

		expect(coordinator.runProviderObservationAttempt).toHaveBeenCalledOnce();
		expect(coordinator.runClaimedProviderObservationAttempt).not.toHaveBeenCalled();
	});

	it("continues the exact caller-supplied attempt without beginning another claim", async () => {
		await refreshOwnedTautulliCacheWithAttempt(context, attempt);

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
