import { describe, expect, it, vi } from "vitest";
import { prepareMediaServerRescans } from "../media-server-rescan.js";

const log = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
	child: vi.fn(),
	silent: vi.fn(),
	level: "info",
};

function approval(overrides: Record<string, unknown> = {}) {
	return {
		id: "approval-1",
		configId: "config-1",
		instanceId: "radarr-1",
		arrItemId: 42,
		itemType: "movie",
		targetScope: "series",
		arrEpisodeId: null,
		episodeFileId: null,
		seasonNumber: null,
		episodeNumber: null,
		episodeTitle: null,
		title: "Movie",
		matchedRuleId: "rule-1",
		matchedRuleName: "Old media",
		reason: "Matched",
		action: "delete",
		scanMediaServerAfterDelete: true,
		scanMediaServerInstanceIds: '["jellyfin-1","plex-1"]',
		sizeOnDisk: 1n,
		year: 2020,
		rating: null,
		status: "executed",
		terminalAuditRecordedAt: new Date(),
		...overrides,
	};
}

function instance(
	id: string,
	service: "PLEX" | "JELLYFIN" | "EMBY",
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		userId: "user-1",
		service,
		label: id,
		baseUrl: `http://${id}`,
		externalUrl: null,
		encryptedApiKey: "encrypted",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		isDefault: false,
		enabled: true,
		connectionGeneration: 1,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		expectedIdentity: service === "PLEX" ? "plex-server" : "jellyfin-server",
		identityKind:
			service === "PLEX"
				? "PLEX_MACHINE_IDENTIFIER"
				: service === "JELLYFIN"
					? "JELLYFIN_SERVER_ID"
					: "EMBY_SERVER_ID",
		identityStatus: "VERIFIED",
		identityGeneration: 1,
		identityVerifiedAt: new Date(),
		identityLastCheckedAt: new Date(),
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function createDeps(
	instances: ReturnType<typeof instance>[],
	options: { failCreateAt?: number } = {},
) {
	const created: Array<Record<string, unknown>> = [];
	let createCalls = 0;
	const plexClient = {
		getIdentity: vi.fn().mockResolvedValue({ machineIdentifier: "plex-server" }),
		getLibrarySections: vi.fn().mockResolvedValue([
			{ key: "shows", title: "Shows", type: "show" },
			{ key: "movies-b", title: "Movies B", type: "movie" },
			{ key: "movies-a", title: "Movies A", type: "movie" },
		]),
		refreshSection: vi.fn(),
	};
	const jellyfinClient = {
		getPublicInfo: vi.fn().mockResolvedValue({ id: "jellyfin-server" }),
		getServerInfo: vi.fn().mockResolvedValue({ id: "jellyfin-server" }),
		refreshLibrary: vi.fn(),
	};
	const prisma = {
		serviceInstance: {
			findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
				instances.filter((candidate) => where.id.in.includes(candidate.id)),
			),
		},
		libraryCleanupMediaServerScan: {
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				createCalls++;
				if (createCalls === options.failCreateAt) throw new Error("database write failed");
				created.push(data);
				return data;
			}),
			findMany: vi.fn().mockResolvedValue(created),
			findUnique: vi.fn(),
		},
	};
	Object.assign(prisma, {
		$transaction: vi.fn(async (operation: (tx: typeof prisma) => Promise<unknown>) => {
			const startLength = created.length;
			try {
				return await operation(prisma);
			} catch (error) {
				created.splice(startLength);
				throw error;
			}
		}),
	});
	return {
		created,
		plexClient,
		jellyfinClient,
		prisma,
		deps: {
			prisma,
			log,
			plexRescanClientFactory: vi.fn(() => plexClient),
			jellyfinRescanClientFactory: vi.fn(() => jellyfinClient),
		},
	};
}

describe("durable media-server rescan preparation", () => {
	it("persists exactly the selected owned media servers before deletion without dispatching", async () => {
		const fixture = createDeps([
			instance("plex-1", "PLEX"),
			instance("jellyfin-1", "JELLYFIN"),
			instance("unselected-emby", "EMBY"),
		]);

		await expect(
			prepareMediaServerRescans(fixture.deps as never, "user-1", approval() as never, "movie"),
		).resolves.toBe(2);

		expect(fixture.prisma.serviceInstance.findMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["jellyfin-1", "plex-1"] },
				userId: "user-1",
				enabled: true,
				service: { in: ["PLEX", "JELLYFIN", "EMBY"] },
			},
			orderBy: { id: "asc" },
		});
		expect(fixture.created.map((row) => row.instanceId).sort()).toEqual(["jellyfin-1", "plex-1"]);
		expect(fixture.created.find((row) => row.instanceId === "plex-1")).toMatchObject({
			serverIdentity: "PLEX:plex-server",
			plannedSectionIds: '["movies-a","movies-b"]',
		});
		expect(fixture.plexClient.refreshSection).not.toHaveBeenCalled();
		expect(fixture.jellyfinClient.refreshLibrary).not.toHaveBeenCalled();
	});

	it("fails closed when selected media-server ownership or enablement is not exact", async () => {
		const fixture = createDeps([instance("plex-1", "PLEX")]);

		await expect(
			prepareMediaServerRescans(fixture.deps as never, "user-1", approval() as never, "movie"),
		).rejects.toThrow("selected media-server targets could not be verified");
		expect(fixture.prisma.libraryCleanupMediaServerScan.create).not.toHaveBeenCalled();
	});

	it("fails closed on an empty or malformed persisted selection when scanning is enabled", async () => {
		const fixture = createDeps([instance("plex-1", "PLEX")]);

		await expect(
			prepareMediaServerRescans(
				fixture.deps as never,
				"user-1",
				approval({ scanMediaServerInstanceIds: "[]" }) as never,
				"movie",
			),
		).rejects.toThrow("selected media-server targets are invalid");
	});

	it("revalidates an exact durable target set against current ownership and live identity", async () => {
		const fixture = createDeps([instance("plex-1", "PLEX"), instance("jellyfin-1", "JELLYFIN")]);
		fixture.created.push(
			{
				instanceId: "jellyfin-1",
				service: "JELLYFIN",
				serverIdentity: "JELLYFIN:jellyfin-server",
				mediaType: "movie",
				plannedSectionIds: null,
				targetKey: "JELLYFIN:jellyfin-1:movie",
			},
			{
				instanceId: "plex-1",
				service: "PLEX",
				serverIdentity: "PLEX:plex-server",
				mediaType: "movie",
				plannedSectionIds: '["movies-a","movies-b"]',
				targetKey: "PLEX:plex-1:movie",
			},
		);

		await expect(
			prepareMediaServerRescans(fixture.deps as never, "user-1", approval() as never, "movie"),
		).resolves.toBe(2);

		expect(fixture.prisma.serviceInstance.findMany).toHaveBeenCalledOnce();
		expect(fixture.deps.plexRescanClientFactory).toHaveBeenCalledOnce();
		expect(fixture.deps.jellyfinRescanClientFactory).toHaveBeenCalledOnce();
		expect(fixture.prisma.libraryCleanupMediaServerScan.create).not.toHaveBeenCalled();
	});

	it("fails closed before intent persistence when a selected server is not enrolled", async () => {
		const fixture = createDeps([
			instance("plex-1", "PLEX", {
				expectedIdentity: null,
				identityKind: null,
				identityStatus: "UNVERIFIED",
			}),
			instance("jellyfin-1", "JELLYFIN"),
		]);

		await expect(
			prepareMediaServerRescans(fixture.deps as never, "user-1", approval() as never, "movie"),
		).rejects.toThrow("target could not be verified before cleanup");

		expect(fixture.prisma.libraryCleanupMediaServerScan.create).not.toHaveBeenCalled();
	});

	it("fails closed before intent persistence when live identity differs from enrollment", async () => {
		const fixture = createDeps([
			instance("plex-1", "PLEX", { expectedIdentity: "enrolled-plex" }),
			instance("jellyfin-1", "JELLYFIN"),
		]);

		await expect(
			prepareMediaServerRescans(fixture.deps as never, "user-1", approval() as never, "movie"),
		).rejects.toThrow("target could not be verified before cleanup");

		expect(fixture.prisma.libraryCleanupMediaServerScan.create).not.toHaveBeenCalled();
	});

	it("fails closed on retry when a prepared target is disabled or removed", async () => {
		const fixture = createDeps([instance("plex-1", "PLEX")]);
		fixture.created.push(
			{
				instanceId: "jellyfin-1",
				service: "JELLYFIN",
				serverIdentity: "JELLYFIN:jellyfin-server",
				mediaType: "movie",
				plannedSectionIds: null,
				targetKey: "JELLYFIN:jellyfin-1:movie",
			},
			{
				instanceId: "plex-1",
				service: "PLEX",
				serverIdentity: "PLEX:plex-server",
				mediaType: "movie",
				plannedSectionIds: '["movies-a","movies-b"]',
				targetKey: "PLEX:plex-1:movie",
			},
		);

		await expect(
			prepareMediaServerRescans(fixture.deps as never, "user-1", approval() as never, "movie"),
		).rejects.toThrow("selected media-server targets could not be verified");

		expect(fixture.prisma.libraryCleanupMediaServerScan.create).not.toHaveBeenCalled();
	});

	it("fails closed on retry when live identity no longer matches the durable intent", async () => {
		const fixture = createDeps([
			instance("plex-1", "PLEX", { expectedIdentity: "different-enrollment" }),
			instance("jellyfin-1", "JELLYFIN"),
		]);
		fixture.created.push(
			{
				instanceId: "jellyfin-1",
				service: "JELLYFIN",
				serverIdentity: "JELLYFIN:jellyfin-server",
				mediaType: "movie",
				plannedSectionIds: null,
				targetKey: "JELLYFIN:jellyfin-1:movie",
			},
			{
				instanceId: "plex-1",
				service: "PLEX",
				serverIdentity: "PLEX:plex-server",
				mediaType: "movie",
				plannedSectionIds: '["movies-a","movies-b"]',
				targetKey: "PLEX:plex-1:movie",
			},
		);

		await expect(
			prepareMediaServerRescans(fixture.deps as never, "user-1", approval() as never, "movie"),
		).rejects.toThrow("target could not be verified before cleanup");

		expect(fixture.prisma.libraryCleanupMediaServerScan.create).not.toHaveBeenCalled();
	});

	it("rolls back a partial multi-target preparation when one durable write fails", async () => {
		const fixture = createDeps([instance("plex-1", "PLEX"), instance("jellyfin-1", "JELLYFIN")], {
			failCreateAt: 2,
		});

		await expect(
			prepareMediaServerRescans(fixture.deps as never, "user-1", approval() as never, "movie"),
		).rejects.toThrow("database write failed");

		expect(fixture.created).toEqual([]);
	});
});
