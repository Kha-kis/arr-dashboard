import { describe, expect, it, vi } from "vitest";
import {
	createSharedPlexSafetyContext,
	verifyFreshQuiPhysicalFileSafety,
} from "../shared-plex-safety.js";
import type { CleanupExecutorDeps } from "../types.js";

const log = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
} as unknown as CleanupExecutorDeps["log"];

function quiInstance(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		userId: "user-1",
		service: "QUI",
		label: id,
		baseUrl: `http://${id}.internal:7476`,
		encryptedApiKey: `encrypted-${id}`,
		encryptionIv: `iv-${id}`,
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		hasLocalFilesystemAccess: true,
		pathPrefix: null,
		...overrides,
	};
}

function makeDeps(
	options: {
		instances?: Array<ReturnType<typeof quiInstance>>;
		hashesByInstance?: Record<string, string[]>;
		torrentsByInstance?: Record<
			string,
			Array<{ hash: string; state: string; instanceId?: number }>
		>;
		resolveError?: Error;
		torrentError?: Error;
	} = {},
) {
	const instances = options.instances ?? [quiInstance("qui-1")];
	const resolve = vi.fn(async (instanceId: string) => {
		if (options.resolveError) throw options.resolveError;
		return {
			hashes: options.hashesByInstance?.[instanceId] ?? ["movie-hash"],
			complete: true as const,
		};
	});
	const getTorrentsByHash = vi.fn(async (instanceId: string, hash: string) => {
		if (options.torrentError) throw options.torrentError;
		return (
			options.torrentsByInstance?.[instanceId] ?? [{ hash, state: "pausedUP", instanceId: 7 }]
		).filter((torrent) => torrent.hash.toLowerCase() === hash.toLowerCase());
	});
	const deps = {
		prisma: {
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue(instances),
			},
		},
		quiFileHashIndexFactory: vi.fn(async (instance) => ({
			resolve: vi.fn(() => resolve(instance.id)),
		})),
		quiClientFactory: vi.fn((instance) => ({
			getTorrentsByHash: vi.fn((hash: string) => getTorrentsByHash(instance.id, hash)),
		})),
		log,
	} as unknown as CleanupExecutorDeps;
	return { deps, resolve, getTorrentsByHash };
}

describe("fresh qUI physical-file safety evidence", () => {
	it("does not inspect qUI when protection is disabled", async () => {
		const { deps } = makeDeps();
		const evidence = await verifyFreshQuiPhysicalFileSafety(
			deps,
			createSharedPlexSafetyContext(),
			"user-1",
			["/movies/example.mkv"],
			false,
		);
		expect(evidence).toEqual({ enabled: false, instances: [] });
		expect(deps.prisma.serviceInstance.findMany).not.toHaveBeenCalled();
	});

	it("is a no-op when no enabled qUI instance exists", async () => {
		const { deps } = makeDeps({ instances: [] });
		await expect(
			verifyFreshQuiPhysicalFileSafety(
				deps,
				createSharedPlexSafetyContext(),
				"user-1",
				["/movies/example.mkv"],
				true,
			),
		).resolves.toEqual({ enabled: false, instances: [] });
		expect(deps.quiFileHashIndexFactory).not.toHaveBeenCalled();
	});

	it("records complete safe evidence for every qUI and every physical-file hash", async () => {
		const { deps } = makeDeps({
			instances: [quiInstance("qui-b"), quiInstance("qui-a")],
			hashesByInstance: {
				"qui-a": ["primary", "cross-seed"],
				"qui-b": ["primary"],
			},
			torrentsByInstance: {
				"qui-a": [
					{ hash: "primary", state: "pausedUP", instanceId: 7 },
					{ hash: "cross-seed", state: "error", instanceId: 8 },
				],
				"qui-b": [{ hash: "primary", state: "pausedDL", instanceId: 3 }],
			},
		});
		const evidence = await verifyFreshQuiPhysicalFileSafety(
			deps,
			createSharedPlexSafetyContext(),
			"user-1",
			["/movies/example.mkv"],
			true,
		);
		expect(evidence.enabled).toBe(true);
		expect(evidence.instances.map((instance) => instance.instanceId)).toEqual(["qui-a", "qui-b"]);
		expect(evidence.instances[0]!.files[0]!.hashes).toEqual(["cross-seed", "primary"]);
		expect(evidence.instances[0]!.torrents).toEqual([
			{ hash: "cross-seed", qbitInstanceId: 8, state: "error" },
			{ hash: "primary", qbitInstanceId: 7, state: "pausedUP" },
		]);
	});

	it.each([
		"downloading",
		"uploading",
		"stalledUP",
		"stalledDL",
		"queuedUP",
		"queuedDL",
		"checkingUP",
		"checkingDL",
		"metaDL",
		"moving",
		"forcedUP",
		"forcedDL",
	] as const)("blocks the supported active or transitional qUI state %s", async (state) => {
		const { deps } = makeDeps({
			torrentsByInstance: {
				"qui-1": [{ hash: "movie-hash", state, instanceId: 7 }],
			},
		});
		await expect(
			verifyFreshQuiPhysicalFileSafety(
				deps,
				createSharedPlexSafetyContext(),
				"user-1",
				["/movies/example.mkv"],
				true,
			),
		).rejects.toThrow("active or transitional");
	});

	it.each(["pausedUP", "pausedDL", "error", "missingFiles"] as const)(
		"records the exact supported inactive qUI state %s",
		async (state) => {
			const { deps } = makeDeps({
				torrentsByInstance: {
					"qui-1": [{ hash: "movie-hash", state, instanceId: 7 }],
				},
			});
			const evidence = await verifyFreshQuiPhysicalFileSafety(
				deps,
				createSharedPlexSafetyContext(),
				"user-1",
				["/movies/example.mkv"],
				true,
			);
			expect(evidence.instances[0]!.torrents[0]!.state).toBe(state);
		},
	);

	it("fails closed on an unknown or newly introduced qUI state", async () => {
		const { deps } = makeDeps({
			torrentsByInstance: {
				"qui-1": [{ hash: "movie-hash", state: "unknown", instanceId: 7 }],
			},
		});
		await expect(
			verifyFreshQuiPhysicalFileSafety(
				deps,
				createSharedPlexSafetyContext(),
				"user-1",
				["/movies/example.mkv"],
				true,
			),
		).rejects.toThrow("unknown or unsupported");
	});

	it.each([
		["unreachable qUI", { torrentError: new Error("offline") }],
		["incomplete path inventory", { resolveError: new Error("partial walk") }],
	] as const)("fails closed on %s", async (_label, options) => {
		const { deps } = makeDeps(options);
		await expect(
			verifyFreshQuiPhysicalFileSafety(
				deps,
				createSharedPlexSafetyContext(),
				"user-1",
				["/movies/example.mkv"],
				true,
			),
		).rejects.toThrow();
	});

	it("fails closed when inode ownership and exact-hash inventory disagree", async () => {
		const { deps } = makeDeps({
			torrentsByInstance: { "qui-1": [] },
		});
		await expect(
			verifyFreshQuiPhysicalFileSafety(
				deps,
				createSharedPlexSafetyContext(),
				"user-1",
				["/movies/example.mkv"],
				true,
			),
		).rejects.toThrow("inode ownership did not match");
	});

	it("fails closed when qUI returns a mismatched torrent hash", async () => {
		const { deps } = makeDeps();
		deps.quiClientFactory = vi.fn(() => ({
			getTorrentsByHash: vi
				.fn()
				.mockResolvedValue([{ hash: "different-hash", state: "pausedUP", instanceId: 7 }]),
		})) as never;

		await expect(
			verifyFreshQuiPhysicalFileSafety(
				deps,
				createSharedPlexSafetyContext(),
				"user-1",
				["/movies/example.mkv"],
				true,
			),
		).rejects.toThrow("mismatched torrent identity");
	});

	it("fails closed when qUI cannot identify the owning qBittorrent instance", async () => {
		const { deps } = makeDeps({
			torrentsByInstance: {
				"qui-1": [{ hash: "movie-hash", state: "pausedUP" }],
			},
		});
		await expect(
			verifyFreshQuiPhysicalFileSafety(
				deps,
				createSharedPlexSafetyContext(),
				"user-1",
				["/movies/example.mkv"],
				true,
			),
		).rejects.toThrow("owning qBittorrent instance");
	});

	it("changes the proof when qUI identity or torrent state changes", async () => {
		const first = makeDeps();
		const firstEvidence = await verifyFreshQuiPhysicalFileSafety(
			first.deps,
			createSharedPlexSafetyContext(),
			"user-1",
			["/movies/example.mkv"],
			true,
		);
		const second = makeDeps({
			instances: [quiInstance("qui-1", { pathPrefix: "/downloads>/data" })],
			torrentsByInstance: {
				"qui-1": [{ hash: "movie-hash", state: "error", instanceId: 7 }],
			},
		});
		const secondEvidence = await verifyFreshQuiPhysicalFileSafety(
			second.deps,
			createSharedPlexSafetyContext(),
			"user-1",
			["/movies/example.mkv"],
			true,
		);
		expect(secondEvidence).not.toEqual(firstEvidence);
	});

	it("changes the proof when the physical path or inode-owned hash changes", async () => {
		const first = makeDeps({ hashesByInstance: { "qui-1": ["old-hash"] } });
		const second = makeDeps({ hashesByInstance: { "qui-1": ["new-hash"] } });

		const firstEvidence = await verifyFreshQuiPhysicalFileSafety(
			first.deps,
			createSharedPlexSafetyContext(),
			"user-1",
			["/movies/old/example.mkv"],
			true,
		);
		const secondEvidence = await verifyFreshQuiPhysicalFileSafety(
			second.deps,
			createSharedPlexSafetyContext(),
			"user-1",
			["/movies/new/example.mkv"],
			true,
		);

		expect(secondEvidence).not.toEqual(firstEvidence);
	});

	it("preserves directional state so paused upload to paused download is proof drift", async () => {
		const first = makeDeps({
			torrentsByInstance: {
				"qui-1": [{ hash: "movie-hash", state: "pausedUP", instanceId: 7 }],
			},
		});
		const second = makeDeps({
			torrentsByInstance: {
				"qui-1": [{ hash: "movie-hash", state: "pausedDL", instanceId: 7 }],
			},
		});

		const firstEvidence = await verifyFreshQuiPhysicalFileSafety(
			first.deps,
			createSharedPlexSafetyContext(),
			"user-1",
			["/movies/example.mkv"],
			true,
		);
		const secondEvidence = await verifyFreshQuiPhysicalFileSafety(
			second.deps,
			createSharedPlexSafetyContext(),
			"user-1",
			["/movies/example.mkv"],
			true,
		);

		expect(secondEvidence).not.toEqual(firstEvidence);
	});
});
