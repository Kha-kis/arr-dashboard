import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance } from "../../prisma.js";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	fail: vi.fn(),
	guard: vi.fn(),
	snapshot: vi.fn(),
	collect: vi.fn(),
	publish: vi.fn(),
	getUsers: vi.fn(),
	getLibraries: vi.fn(),
}));

vi.mock("../../services/provider-cache-status.js", () => ({
	claimProviderCacheRefreshAttempt: mocks.claim,
	finishProviderCacheRefreshAttemptFailure: mocks.fail,
}));
vi.mock("../../services/provider-identity-guard.js", () => ({
	createProviderPublicationAuthority: vi.fn((instance) => instance),
	ProviderIdentityGuardError: class extends Error {
		code = "PUBLICATION_SUPERSEDED";
	},
	withGuardedProviderPublication: mocks.guard,
}));
vi.mock("../jellyfin-cache-refresher.js", () => ({
	createOwnedJellyfinPublicationSnapshot: mocks.snapshot,
}));
vi.mock("../jellyfin-client.js", () => ({
	JellyfinClient: class {
		getUsers = mocks.getUsers;
		getLibraries = mocks.getLibraries;
	},
}));
vi.mock("../jellyfin-positive-watch-collector.js", () => ({
	collectJellyfinPositiveWatchCandidates: mocks.collect,
}));
vi.mock("../jellyfin-positive-watch-repository.js", () => ({
	publishJellyfinPositiveWatchGeneration: mocks.publish,
}));

import { refreshOwnedJellyfinPositiveWatch } from "../jellyfin-positive-watch-refresher.js";

const attemptedAt = new Date("2026-09-25T10:00:00Z");
const instance = {
	id: "synthetic-instance",
	userId: "synthetic-owner",
	service: "JELLYFIN",
	enabled: true,
	identityStatus: "VERIFIED",
} as ServiceInstance;
const app = {
	prisma: {} as never,
	encryptor: { decrypt: vi.fn() } as never,
	instance,
	log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.claim.mockResolvedValue({
		status: "acquired",
		attempt: { attemptedAt, resultMarker: "in_progress:11111111-1111-4111-8111-111111111111" },
	});
	mocks.snapshot.mockReturnValue({ baseUrl: "http://jellyfin.invalid", apiKey: "redacted" });
	mocks.getUsers.mockResolvedValue([{ id: "user-a" }]);
	mocks.getLibraries.mockResolvedValue([{ id: "library-a" }]);
	mocks.collect.mockResolvedValue({ scopeCount: 1, candidates: [{ played: true }] });
	mocks.guard.mockImplementation(async (_prisma, _snapshot, _log, collect, publish) =>
		publish({}, await collect()),
	);
	mocks.publish.mockResolvedValue(undefined);
});

describe("Jellyfin positive watch refresh runner", () => {
	it("uses the isolated attempt and guarded two-pass collector before publishing", async () => {
		const result = await refreshOwnedJellyfinPositiveWatch(app);
		expect(result).toMatchObject({ kind: "published", itemCount: 1, scopeCount: 1 });
		expect(mocks.claim).toHaveBeenCalledWith(app.prisma, "jellyfin_episode_positive", instance);
		expect(mocks.collect).toHaveBeenCalledWith(expect.anything(), [
			{ userId: "user-a", libraryId: "library-a" },
		]);
		expect(mocks.publish).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ candidates: [{ played: true }] }),
		);
		expect(mocks.fail).not.toHaveBeenCalled();
	});

	it("records a bounded failure without deleting or publishing prior positives", async () => {
		mocks.collect.mockRejectedValueOnce(new Error("synthetic upstream body must not leak"));
		const result = await refreshOwnedJellyfinPositiveWatch(app);
		expect(result).toEqual({ kind: "failed", reason: "coverage-incomplete" });
		expect(mocks.fail).toHaveBeenCalledWith(
			app.prisma,
			"jellyfin_episode_positive",
			"coverage-incomplete",
			instance,
			expect.anything(),
			app.log,
		);
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("does not read the provider when another attempt owns the cache", async () => {
		mocks.claim.mockResolvedValueOnce({
			status: "already-running",
			attempt: { attemptedAt, resultMarker: "in_progress:11111111-1111-4111-8111-111111111111" },
		});
		expect(await refreshOwnedJellyfinPositiveWatch(app)).toEqual({
			kind: "skipped",
			reason: "running",
		});
		expect(mocks.getUsers).not.toHaveBeenCalled();
	});
});
