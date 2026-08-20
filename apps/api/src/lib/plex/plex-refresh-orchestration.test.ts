import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	beginAttempt: vi.fn(),
	finishAttempt: vi.fn(),
	createSnapshot: vi.fn(),
	refreshCacheWithAttempt: vi.fn(),
	refreshEpisodesWithAttempt: vi.fn(),
}));

vi.mock("../services/provider-cache-status.js", () => ({
	beginPlexCacheRefreshAttempt: mocks.beginAttempt,
	finishPlexCacheRefreshAttemptFailure: mocks.finishAttempt,
}));

vi.mock("./plex-cache-refresher.js", () => ({
	createOwnedPlexPublicationSnapshot: mocks.createSnapshot,
	refreshPlexCacheWithAttempt: mocks.refreshCacheWithAttempt,
}));

vi.mock("./plex-episode-cache-refresher.js", () => ({
	refreshPlexEpisodeCacheWithAttempt: mocks.refreshEpisodesWithAttempt,
}));

import {
	refreshOwnedPlexCache,
	refreshOwnedPlexEpisodeCache,
} from "./plex-refresh-orchestration.js";

const log = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
const instance = {
	id: "plex-1",
	userId: "user-1",
	service: "PLEX",
	label: "Primary Plex",
	baseUrl: "https://plex.invalid?token=url-secret",
	enabled: true,
	encryptedApiKey: "ciphertext-secret",
	encryptionIv: "iv-secret",
	encryptedHttpAuthCredentials: "basic-ciphertext",
	httpAuthEncryptionIv: "basic-iv",
	expectedIdentity: "raw-provider-identity",
	identityStatus: "VERIFIED",
	connectionGeneration: 7,
	identityGeneration: 11,
} as const;
const authority = {
	id: instance.id,
	userId: instance.userId,
	service: instance.service,
	baseUrl: instance.baseUrl,
	enabled: instance.enabled,
	encryptedApiKey: instance.encryptedApiKey,
	encryptionIv: instance.encryptionIv,
	encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
	httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
	expectedIdentity: instance.expectedIdentity,
	identityStatus: instance.identityStatus,
	connectionGeneration: instance.connectionGeneration,
	identityGeneration: instance.identityGeneration,
};
const snapshot = {
	...authority,
	apiKey: "api-key-secret",
	httpAuthHeaders: { authorization: "Basic username:password" },
};
const attempt = {
	attemptedAt: new Date("2026-08-20T12:00:00.000Z"),
	resultMarker: "in_progress:attempt-a",
};
const context = {
	prisma: {} as never,
	encryptor: {} as never,
	instance: instance as never,
	log,
};

beforeEach(() => {
	mocks.beginAttempt.mockReset().mockResolvedValue(attempt);
	mocks.finishAttempt.mockReset().mockResolvedValue("recorded");
	mocks.createSnapshot.mockReset().mockReturnValue(snapshot);
	mocks.refreshCacheWithAttempt.mockReset().mockResolvedValue({
		complete: true,
		completedAt: new Date("2026-08-20T12:01:00.000Z"),
		upserted: 1,
		errors: 0,
		errorMessages: [],
	});
	mocks.refreshEpisodesWithAttempt.mockReset().mockResolvedValue({
		complete: true,
		completedAt: new Date("2026-08-20T12:01:00.000Z"),
		upserted: 1,
		errors: 0,
		errorMessages: [],
		eligibleShows: 1,
		refreshedShows: 1,
		coverageIncomplete: false,
		capacityDegraded: false,
	});
});

describe("Plex refresh preparation authority", () => {
	it.each([
		["Plex", "plex", refreshOwnedPlexCache],
		["Plex episode", "plex_episode", refreshOwnedPlexEpisodeCache],
	] as const)(
		"revokes %s authority before a credential-preparation failure and records only safe diagnostics",
		async (_label, cacheType, refresh) => {
			mocks.createSnapshot.mockImplementation(() => {
				throw new Error(
					"api-key-secret ciphertext-secret iv-secret Basic username:password https://plex.invalid?token=url-secret raw-provider-identity",
				);
			});

			const result = await refresh(context);

			expect(mocks.beginAttempt).toHaveBeenCalledWith(context.prisma, cacheType, authority, {});
			expect(mocks.finishAttempt).toHaveBeenCalledWith(
				context.prisma,
				cacheType,
				"Plex refresh preparation failed before publication",
				authority,
				attempt,
				context.log,
				{},
			);
			expect(result).toMatchObject({ complete: false, errors: 1, upserted: 0 });
			const diagnostics = JSON.stringify({
				result,
				storedFailureMessage: mocks.finishAttempt.mock.calls[0]?.[2],
			});
			for (const secret of [
				"api-key-secret",
				"ciphertext-secret",
				"iv-secret",
				"username:password",
				"url-secret",
				"raw-provider-identity",
			]) {
				expect(diagnostics).not.toContain(secret);
			}
		},
	);

	it("transfers the exact pre-acquired Plex attempt into the lower-level refresher", async () => {
		await refreshOwnedPlexCache(context);

		expect(mocks.refreshCacheWithAttempt).toHaveBeenCalledWith(
			{
				prisma: context.prisma,
				instance: snapshot,
				log: context.log,
			},
			attempt,
		);
	});

	it("does not let an older preparation failure overwrite a newer attempt", async () => {
		mocks.createSnapshot.mockImplementation(() => {
			throw new Error("credentials unavailable");
		});
		mocks.finishAttempt.mockResolvedValue("superseded");

		const result = await refreshOwnedPlexCache(context);

		expect(result).toMatchObject({ complete: false, errors: 0, upserted: 0, superseded: true });
	});
});

describe("Plex refresh orchestration boundary", () => {
	it("requires every production refresh entrypoint to use the pre-decryption boundary", async () => {
		const sourceRoot = path.resolve(process.cwd(), "src");
		const requiredBoundaryCalls = [
			["plugins/plex-cache-scheduler.ts", "refreshOwnedPlexCache"],
			["plugins/plex-episode-cache-scheduler.ts", "refreshOwnedPlexEpisodeCache"],
			["routes/plex/cache-routes.ts", "refreshOwnedPlexCache"],
			["lib/pulse/actions.ts", "refreshOwnedPlexCache"],
			["lib/library-cleanup/cleanup-executor.ts", "refreshOwnedPlexCache"],
			["lib/library-cleanup/cleanup-executor.ts", "refreshOwnedPlexEpisodeCache"],
		] as const;

		for (const [relativePath, boundary] of requiredBoundaryCalls) {
			const source = await readFile(path.join(sourceRoot, relativePath), "utf8");
			expect(source, `${relativePath} must use ${boundary}`).toContain(boundary);
		}
	});
});
