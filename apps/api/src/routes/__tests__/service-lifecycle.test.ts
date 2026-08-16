/**
 * Service instance lifecycle integration tests.
 *
 * Existing `services.test.ts` mocks requireInstance, formatServiceInstance,
 * tag-manager, update-builder, and testServiceConnection — each route is
 * exercised in isolation against disposable mocks. The full create -> test
 * -> update -> delete trajectory through a single prisma state is never
 * covered, so regressions in side-effect ordering (e.g. an update that
 * silently creates a new row, a delete that ignores ownership) would not
 * be caught by the current suite.
 *
 * This file stands up an in-memory prisma stub whose state persists across
 * requests and walks the real lifecycle:
 *
 *   1. POST /services          → create
 *   2. GET  /services          → list reflects creation
 *   3. POST /services/:id/test → connection success
 *   4. POST /services/:id/test → connection failure (mocked tester)
 *   5. PUT  /services/:id      → update (label, apiKey rotation)
 *   6. DELETE /services/:id    → remove
 *   7. GET  /services          → list reflects deletion
 *
 * The connection tester is the only thing mocked — we want deterministic
 * success/failure without hitting the network, but everything between the
 * HTTP surface and the DB is real.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockTestConnection } = vi.hoisted(() => ({
	mockTestConnection: vi.fn(),
}));

const { mockReadProviderIdentity } = vi.hoisted(() => ({
	mockReadProviderIdentity: vi.fn(),
}));

vi.mock("../../lib/services/connection-tester.js", () => ({
	testServiceConnection: (...args: unknown[]) => mockTestConnection(...args),
}));

vi.mock("../../lib/services/service-identity.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/services/service-identity.js")>()),
	readProviderIdentity: (...args: unknown[]) => mockReadProviderIdentity(...args),
	confirmProviderIdentity: (expected: string, actual: string) => expected === actual,
}));

import {
	createSanitizedProviderEvidence,
	serializeExecutableSafetyPlan,
} from "../../lib/library-cleanup/shared-plex-safety.js";
import {
	providerIdentityAuthorityFingerprint,
	providerInstanceAuthorityFingerprint,
} from "../../lib/services/service-identity.js";
import {
	createDeploymentConnectionBinding,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	isCurrentDeploymentConnectionMapping,
} from "../../lib/trash-guides/deployment-target.js";
import { registerServiceRoutes } from "../services.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const USER_ID = "user-1";
const PLAINTEXT_KEY_V1 = "initial-plaintext-api-key-1234";
const PLAINTEXT_KEY_V2 = "rotated-plaintext-api-key-5678";
const ENCRYPTED_V1 = "encrypted-v1-bytes";
const ENCRYPTED_V2 = "encrypted-v2-bytes";
const IV_V1 = "iv-v1";
const IV_V2 = "iv-v2";

function providerSafetySnapshot(source: {
	service: "PLEX" | "JELLYFIN" | "EMBY" | "TAUTULLI";
	instanceFingerprint?: string;
	identityKind: string;
	identityFingerprint: string;
	connectionGeneration: number;
	identityGeneration: number;
}) {
	return serializeExecutableSafetyPlan(
		{
			kind: "verified_arr_target",
			target: {
				serviceFingerprint: "a".repeat(64),
				externalId: 42,
				mediaPath: { value: "/movies/Example", windows: false },
			},
		},
		createSanitizedProviderEvidence(
			[source.service.toLowerCase()],
			[
				{
					...source,
					cacheType: source.service === "TAUTULLI" ? "tautulli" : "plex",
					completedAt: "2026-08-15T04:00:00.000Z",
					itemCount: 1,
					verifiedAt: "2026-08-15T03:00:00.000Z",
					statusFingerprint: "c".repeat(64),
					rowFingerprint: "d".repeat(64),
				},
			],
		),
	);
}

/**
 * In-memory prisma stub that persists state across requests.
 *
 * Models only the surfaces registerServiceRoutes touches. Tag-related
 * methods are stubbed to empty arrays because this lifecycle suite uses
 * tag-less payloads — the tag path has dedicated coverage elsewhere.
 */
function createPrismaStub() {
	const instances = new Map<string, any>();
	const mappings = new Map<string, any>();
	const overrides = new Map<string, any>();
	const approvals = new Map<string, any>();
	let nextId = 1;

	const serviceInstance = {
		count: vi.fn(async ({ where }: any) => {
			return [...instances.values()].filter(
				(row) =>
					(!where.userId || row.userId === where.userId) &&
					(!where.service || row.service === where.service) &&
					(where.enabled === undefined || row.enabled === where.enabled),
			).length;
		}),
		findMany: vi.fn(async ({ where }: any) => {
			return [...instances.values()]
				.filter(
					(row) =>
						(!where.userId || row.userId === where.userId) &&
						(!where.service || row.service === where.service),
				)
				.map((row) => ({ ...row, tags: [] }));
		}),
		findFirst: vi.fn(async ({ where }: any) => {
			// This lifecycle fake has no durable TRaSH deployment relations.
			if (where.OR) return null;
			for (const row of instances.values()) {
				if (where.id && row.id !== where.id) continue;
				if (where.userId && row.userId !== where.userId) continue;
				return { ...row, tags: [] };
			}
			return null;
		}),
		create: vi.fn(async ({ data }: any) => {
			const id = `inst-${nextId++}`;
			// `data.tags` is a nested-create directive; drop it for the stored row.
			const { tags: _tags, ...rest } = data;
			const row = {
				id,
				connectionGeneration: 0,
				createdAt: new Date("2026-04-13T00:00:00Z"),
				updatedAt: new Date("2026-04-13T00:00:00Z"),
				storageGroupId: null,
				externalUrl: null,
				...rest,
			};
			instances.set(id, row);
			return { ...row, tags: [] };
		}),
		updateMany: vi.fn(async ({ where, data }: any) => {
			let count = 0;
			for (const row of instances.values()) {
				if (where.id && row.id !== where.id) continue;
				if (where.userId && row.userId !== where.userId) continue;
				if (where.NOT?.id && row.id === where.NOT.id) continue;
				if (where.service && row.service !== where.service) continue;
				for (const [key, value] of Object.entries(data)) {
					if (
						value &&
						typeof value === "object" &&
						"increment" in value &&
						typeof value.increment === "number"
					) {
						row[key] = (row[key] ?? 0) + value.increment;
					} else {
						row[key] = value;
					}
				}
				count++;
			}
			return { count };
		}),
		delete: vi.fn(async ({ where }: any) => {
			const row = instances.get(where.id);
			if (!row || (where.userId && row.userId !== where.userId)) {
				const err = new Error("not found");
				(err as any).code = "P2025";
				throw err;
			}
			instances.delete(where.id);
			return row;
		}),
	};

	const prisma = {
		_instances: instances,
		_mappings: mappings,
		_overrides: overrides,
		_approvals: approvals,
		plexCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		plexEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		tautulliCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		jellyfinCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		jellyfinEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		cacheRefreshStatus: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		systemSettings: {
			findUnique: vi.fn().mockResolvedValue({
				analyticsProvider: "tautulli",
				analyticsProviderSource: "explicit",
			}),
			upsert: vi.fn(),
		},
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config-1" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		serviceInstance,
		serviceTag: {
			findMany: vi.fn().mockResolvedValue([]),
			upsert: vi.fn(async ({ where }: any) => ({ id: `tag-${where.name}`, name: where.name })),
			delete: vi.fn(),
		},
		serviceInstanceTag: {
			findFirst: vi.fn().mockResolvedValue(null),
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			createMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
		trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		templateQualityProfileMapping: {
			findMany: vi.fn(async ({ where }: any) =>
				[...mappings.values()].filter((row) => {
					if (where.instanceId?.in && !where.instanceId.in.includes(row.instanceId)) return false;
					if (where.instanceId && typeof where.instanceId === "string") {
						if (row.instanceId !== where.instanceId) return false;
					}
					if (where.template?.userId && row.template.userId !== where.template.userId) {
						return false;
					}
					return true;
				}),
			),
			updateMany: vi.fn(async ({ where, data }: any) => {
				const row = mappings.get(where.id);
				if (!row || row.instanceId !== where.instanceId) return { count: 0 };
				Object.assign(row, data);
				return { count: 1 };
			}),
			deleteMany: vi.fn(async ({ where }: any) => {
				const row = mappings.get(where.id);
				if (!row || row.instanceId !== where.instanceId) return { count: 0 };
				mappings.delete(where.id);
				return { count: 1 };
			}),
		},
		instanceQualityProfileOverride: {
			findMany: vi.fn(async ({ where }: any) =>
				[...overrides.values()].filter((row) => {
					if (where.instanceId?.in && !where.instanceId.in.includes(row.instanceId)) return false;
					if (where.instanceId && typeof where.instanceId === "string") {
						if (row.instanceId !== where.instanceId) return false;
					}
					if (where.userId && row.userId !== where.userId) return false;
					if (where.status?.in && !where.status.in.includes(row.status)) return false;
					return true;
				}),
			),
			updateMany: vi.fn(async ({ where, data }: any) => {
				const row = overrides.get(where.id);
				if (!row || row.instanceId !== where.instanceId) return { count: 0 };
				Object.assign(row, data);
				return { count: 1 };
			}),
			deleteMany: vi.fn(async ({ where }: any) => {
				const row = overrides.get(where.id);
				if (!row || row.instanceId !== where.instanceId) return { count: 0 };
				overrides.delete(where.id);
				return { count: 1 };
			}),
		},
		libraryCleanupApproval: {
			findMany: vi.fn(async ({ where }: any) =>
				[...approvals.values()].filter((row) => {
					if (where.config?.userId && row.config?.userId !== where.config.userId) return false;
					if (where.status?.in && !where.status.in.includes(row.status)) return false;
					return true;
				}),
			),
			updateMany: vi.fn(async ({ where, data }: any) => {
				let count = 0;
				for (const row of approvals.values()) {
					if (where.id && row.id !== where.id) continue;
					if (where.config?.userId && row.config?.userId !== where.config.userId) continue;
					if (where.status?.in && !where.status.in.includes(row.status)) continue;
					if (typeof where.status === "string" && row.status !== where.status) continue;
					Object.assign(row, data);
					count++;
				}
				return { count };
			}),
		},
	};
	return Object.assign(prisma, {
		$transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => {
			const snapshots = [instances, mappings, overrides, approvals].map(
				(map) => new Map([...map.entries()].map(([key, value]) => [key, { ...value }])),
			);
			try {
				return await callback(prisma);
			} catch (error) {
				for (const [map, snapshot] of [instances, mappings, overrides, approvals].map(
					(map, index) => [map, snapshots[index]!] as const,
				)) {
					map.clear();
					for (const [key, value] of snapshot) map.set(key, value);
				}
				throw error;
			}
		}),
	});
}

/**
 * Encryptor stub that returns different ciphertexts for different
 * plaintexts, so we can tell whether a rotation actually persisted.
 */
function createEncryptorStub() {
	const encryptedValues = new Map<string, string>();
	const encryptionCounts = new Map<string, number>();
	return {
		encrypt: vi.fn((plain: string) => {
			const count = (encryptionCounts.get(plain) ?? 0) + 1;
			encryptionCounts.set(plain, count);
			const encrypted =
				plain === PLAINTEXT_KEY_V1
					? {
							value: count === 1 ? ENCRYPTED_V1 : `${ENCRYPTED_V1}-fresh-${count}`,
							iv: count === 1 ? IV_V1 : `${IV_V1}-fresh-${count}`,
						}
					: plain === PLAINTEXT_KEY_V2
						? {
								value: count === 1 ? ENCRYPTED_V2 : `${ENCRYPTED_V2}-fresh-${count}`,
								iv: count === 1 ? IV_V2 : `${IV_V2}-fresh-${count}`,
							}
						: {
								value: count === 1 ? `enc:${plain}` : `enc:${count}:${plain}`,
								iv: count === 1 ? "iv" : `iv-${count}`,
							};
			encryptedValues.set(`${encrypted.value}:${encrypted.iv}`, plain);
			return encrypted;
		}),
		decrypt: vi.fn(({ value, iv }: { value: string; iv: string }) =>
			encryptedValues.get(`${value}:${iv}`),
		),
	};
}

const FORBIDDEN_SECRET_FIELDS = [
	"encryptedApiKey",
	"encryptionIv",
	"apiKey",
	"encryptedHttpAuthCredentials",
	"httpAuthEncryptionIv",
	"httpAuth",
] as const;
const FORBIDDEN_SECRET_VALUES = [
	PLAINTEXT_KEY_V1,
	PLAINTEXT_KEY_V2,
	ENCRYPTED_V1,
	ENCRYPTED_V2,
	IV_V1,
	IV_V2,
] as const;

/**
 * Lightweight check — lifecycle-adjacent only. PR #315's
 * services-secret-leakage.test.ts owns exhaustive secret-leakage coverage;
 * we repeat the shape check here only to lock the lifecycle chain itself
 * (an update that leaks a *rotated* key is a distinct regression class).
 */
function expectNoSecretsIn(body: unknown) {
	const serialized = JSON.stringify(body);
	for (const field of FORBIDDEN_SECRET_FIELDS) {
		expect(serialized).not.toContain(`"${field}"`);
	}
	for (const value of FORBIDDEN_SECRET_VALUES) {
		expect(serialized).not.toContain(value);
	}
}

describe("Service instance lifecycle", () => {
	let app: FastifyInstance;
	let prisma: ReturnType<typeof createPrismaStub>;
	let encryptor: ReturnType<typeof createEncryptorStub>;
	let inject: ReturnType<typeof createInjectAuthenticated>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockTestConnection.mockReset();
		mockReadProviderIdentity.mockReset();

		prisma = createPrismaStub();
		encryptor = createEncryptorStub();

		app = Fastify();
		app.decorate("prisma", prisma as any);
		app.decorate("encryptor", encryptor as any);
		app.decorate("notificationService", {
			notify: vi.fn().mockResolvedValue(undefined),
		} as never);
		app.decorate("arrClientFactory", {
			createConnectionCredentialIdentity: vi.fn((instance: any) => {
				const apiKey = encryptor.decrypt({
					value: instance.encryptedApiKey,
					iv: instance.encryptionIv,
				});
				const httpAuth = instance.encryptedHttpAuthCredentials
					? encryptor.decrypt({
							value: instance.encryptedHttpAuthCredentials,
							iv: instance.httpAuthEncryptionIv,
						})
					: null;
				return JSON.stringify({ apiKey, httpAuth });
			}),
		} as never);
		app.decorate("deploymentExecutor", {
			runWithEndpointMutation: vi.fn(async (lockedUserId, target, _operation, callback) =>
				callback(
					createDeploymentEndpointKey(lockedUserId, {
						...target,
						credentialIdentity: (app as any).arrClientFactory.createConnectionCredentialIdentity(
							target,
						),
					}),
				),
			),
		} as never);

		setupAuthInjection(app, { id: USER_ID, username: "admin" });
		registerTestErrorHandler(app);

		await app.register(registerServiceRoutes);
		await app.ready();

		inject = createInjectAuthenticated(app);
	});

	afterEach(async () => {
		await app?.close();
	});

	async function createExistingUnverifiedProvider(service: "PLEX" | "JELLYFIN" = "PLEX") {
		const created = await inject("POST", "/services", {
			body: {
				label: "Legacy provider",
				baseUrl: "http://legacy-provider.test",
				apiKey: PLAINTEXT_KEY_V1,
				service: "sonarr",
			},
		});
		const id = JSON.parse(created.payload).service.id;
		const instance = prisma._instances.get(id);
		if (!instance) throw new Error("Expected created provider instance");
		instance.service = service;
		instance.expectedIdentity = null;
		instance.identityKind = null;
		instance.identityStatus = "UNVERIFIED";
		instance.identityGeneration = 0;
		instance.identityVerifiedAt = null;
		instance.identityLastCheckedAt = null;
		return id;
	}

	async function createExistingVerifiedProvider() {
		const id = await createExistingUnverifiedProvider();
		const instance = prisma._instances.get(id);
		if (!instance) throw new Error("Expected created provider instance");
		instance.expectedIdentity = "enrolled-plex-machine";
		instance.identityKind = "PLEX_MACHINE_IDENTIFIER";
		instance.identityStatus = "VERIFIED";
		instance.identityGeneration = 3;
		instance.identityVerifiedAt = new Date("2026-08-15T00:00:00.000Z");
		return id;
	}

	it.each([
		["plex", "PLEX", "plex-machine-identifier", "plex-identity"],
		["jellyfin", "JELLYFIN", "jellyfin-server-id", "jellyfin-identity"],
		["emby", "EMBY", "emby-server-id", "emby-identity"],
		["tautulli", "TAUTULLI", "tautulli-pms-identifier", "tautulli-identity"],
	] as const)(
		"enrolls a verified %s connection at identity generation one",
		async (service, serviceEnum, identityKind, rawIdentity) => {
			mockReadProviderIdentity.mockResolvedValueOnce({
				service: serviceEnum,
				identityKind,
				rawIdentity,
				fingerprint: "safe-fingerprint",
				confirmationDigest: "a".repeat(64),
			});

			const response = await inject("POST", "/services", {
				body: {
					label: `${service} server`,
					baseUrl: `http://${service}.test`,
					apiKey: PLAINTEXT_KEY_V1,
					service,
				},
			});

			expect(response.statusCode).toBe(201);
			const id = JSON.parse(response.payload).service.id;
			expect(prisma._instances.get(id)).toMatchObject({
				service: serviceEnum,
				expectedIdentity: rawIdentity,
				identityKind: identityKind.toUpperCase().replaceAll("-", "_"),
				identityStatus: "VERIFIED",
				identityGeneration: 1,
			});
		},
	);

	it("rejects supported-provider creation when its identity cannot be read", async () => {
		mockReadProviderIdentity.mockRejectedValueOnce(new Error("identity unavailable"));

		const response = await inject("POST", "/services", {
			body: {
				label: "Plex server",
				baseUrl: "http://plex.test",
				apiKey: PLAINTEXT_KEY_V1,
				service: "plex",
			},
		});

		expect(response.statusCode).toBe(400);
		expect(prisma._instances.size).toBe(0);
	});

	it("uses submitted reverse-proxy credentials while enrolling a provider", async () => {
		mockReadProviderIdentity.mockResolvedValueOnce({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "plex-machine",
			fingerprint: "safe-fingerprint",
			confirmationDigest: "a".repeat(64),
		});

		const response = await inject("POST", "/services", {
			body: {
				label: "Protected Plex",
				baseUrl: "https://plex.example.test",
				apiKey: PLAINTEXT_KEY_V1,
				service: "plex",
				httpAuth: { username: "proxy-user", password: "proxy-password" },
			},
		});

		expect(response.statusCode).toBe(201);
		expect(mockReadProviderIdentity).toHaveBeenCalledWith(
			expect.objectContaining({
				httpAuthHeaders: { Authorization: "Basic cHJveHktdXNlcjpwcm94eS1wYXNzd29yZA==" },
			}),
			expect.anything(),
		);
	});

	it("inspects an existing unverified provider without exposing its raw identity", async () => {
		const id = await createExistingUnverifiedProvider();
		mockReadProviderIdentity.mockResolvedValueOnce({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "raw-plex-machine-id",
			fingerprint: "safe-fingerprint",
			displayName: "Living Room",
			confirmationDigest: "a".repeat(64),
		});

		const response = await inject("POST", `/services/${id}/identity/inspect`, { body: {} });

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toEqual({
			candidate: {
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				fingerprint: "safe-fingerprint",
				displayName: "Living Room",
				confirmationDigest: "a".repeat(64),
			},
			connectionGeneration: 0,
			identityGeneration: 0,
		});
		expect(response.payload).not.toContain("raw-plex-machine-id");
		expect(response.payload).not.toContain(PLAINTEXT_KEY_V1);
		expect(prisma._instances.get(id)).toMatchObject({
			expectedIdentity: null,
			identityGeneration: 0,
		});
	});

	it("verifies the inspected identity only after a matching second read", async () => {
		const id = await createExistingUnverifiedProvider();
		const observation = {
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "raw-plex-machine-id",
			fingerprint: "safe-fingerprint",
			confirmationDigest: "a".repeat(64),
		};
		mockReadProviderIdentity.mockResolvedValueOnce(observation).mockResolvedValueOnce(observation);

		const inspected = await inject("POST", `/services/${id}/identity/inspect`, { body: {} });
		const verified = await inject("POST", `/services/${id}/identity/verify`, {
			body: {
				confirmationDigest: JSON.parse(inspected.payload).candidate.confirmationDigest,
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 0,
			},
		});

		expect(verified.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({
			expectedIdentity: "raw-plex-machine-id",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityGeneration: 1,
		});
	});

	it("rejects verification when the provider changes after inspection", async () => {
		const id = await createExistingUnverifiedProvider();
		mockReadProviderIdentity
			.mockResolvedValueOnce({
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: "first-machine",
				fingerprint: "first-safe-fingerprint",
				confirmationDigest: "a".repeat(64),
			})
			.mockResolvedValueOnce({
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: "second-machine",
				fingerprint: "second-safe-fingerprint",
				confirmationDigest: "b".repeat(64),
			});

		const inspected = await inject("POST", `/services/${id}/identity/inspect`, { body: {} });
		const verified = await inject("POST", `/services/${id}/identity/verify`, {
			body: {
				confirmationDigest: JSON.parse(inspected.payload).candidate.confirmationDigest,
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 0,
			},
		});

		expect(verified.statusCode).toBe(409);
		expect(JSON.parse(verified.payload).details).toMatchObject({
			code: "IDENTITY_CANDIDATE_CHANGED",
		});
		expect(verified.payload).not.toContain("second-machine");
		expect(prisma._instances.get(id)).toMatchObject({
			expectedIdentity: null,
			identityGeneration: 0,
		});
	});

	it("keeps a verified identity generation while advancing the connection generation for the same provider", async () => {
		const id = await createExistingVerifiedProvider();
		mockReadProviderIdentity.mockResolvedValueOnce({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "enrolled-plex-machine",
			fingerprint: "safe-fingerprint",
			confirmationDigest: "a".repeat(64),
		});

		const response = await inject("PUT", `/services/${id}`, {
			body: { baseUrl: "http://updated-provider.test" },
		});

		expect(response.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({
			baseUrl: "http://updated-provider.test",
			connectionGeneration: 1,
			identityGeneration: 3,
			expectedIdentity: "enrolled-plex-machine",
		});
	});

	it("resets provider identity authority when changing service families so it can be enrolled again", async () => {
		const id = await createExistingVerifiedProvider();

		const switchedAway = await inject("PUT", `/services/${id}`, {
			body: { service: "sonarr" },
		});

		expect(switchedAway.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({
			service: "SONARR",
			expectedIdentity: null,
			identityKind: null,
			identityStatus: "UNVERIFIED",
			identityGeneration: 4,
			identityVerifiedAt: null,
			identityLastCheckedAt: null,
			connectionGeneration: 1,
		});

		const observation = {
			service: "PLEX" as const,
			identityKind: "plex-machine-identifier",
			rawIdentity: "re-enrolled-plex-machine",
			fingerprint: "safe-fingerprint",
			confirmationDigest: "a".repeat(64),
		};
		mockReadProviderIdentity.mockResolvedValue(observation);
		const switchedBack = await inject("PUT", `/services/${id}`, {
			body: { service: "plex" },
		});
		expect(switchedBack.statusCode).toBe(200);

		const inspected = await inject("POST", `/services/${id}/identity/inspect`, { body: {} });
		const verified = await inject("POST", `/services/${id}/identity/verify`, {
			body: {
				confirmationDigest: JSON.parse(inspected.payload).candidate.confirmationDigest,
				expectedConnectionGeneration: 2,
				expectedIdentityGeneration: 4,
			},
		});

		expect(verified.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({
			service: "PLEX",
			expectedIdentity: "re-enrolled-plex-machine",
			identityStatus: "VERIFIED",
			identityGeneration: 5,
		});
	});

	it("keeps an existing unverified provider unverified after an ordinary same-server update", async () => {
		const id = await createExistingUnverifiedProvider();
		mockReadProviderIdentity.mockResolvedValueOnce({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "legacy-plex-machine",
			fingerprint: "safe-fingerprint",
			confirmationDigest: "a".repeat(64),
		});

		const response = await inject("PUT", `/services/${id}`, {
			body: { baseUrl: "http://legacy-provider-updated.test" },
		});

		expect(response.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({
			baseUrl: "http://legacy-provider-updated.test",
			expectedIdentity: null,
			identityStatus: "UNVERIFIED",
			identityGeneration: 0,
			connectionGeneration: 1,
		});
	});

	it("allows a provider to be disabled under the topology lease without requiring it to be reachable", async () => {
		const id = await createExistingVerifiedProvider();
		mockReadProviderIdentity.mockRejectedValueOnce(new Error("provider unavailable"));

		const response = await inject("PUT", `/services/${id}`, { body: { enabled: false } });

		expect(response.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({
			enabled: false,
			connectionGeneration: 1,
			identityGeneration: 3,
		});
	});

	it("does not save a verified provider connection when its candidate identity is unavailable", async () => {
		const id = await createExistingVerifiedProvider();
		const before = { ...prisma._instances.get(id) };
		mockReadProviderIdentity.mockRejectedValueOnce(new Error("provider unavailable"));

		const response = await inject("PUT", `/services/${id}`, {
			body: { baseUrl: "http://unavailable-provider.test" },
		});

		expect(response.statusCode).toBe(400);
		expect(prisma._instances.get(id)).toMatchObject({
			baseUrl: before.baseUrl,
			connectionGeneration: before.connectionGeneration,
			identityGeneration: before.identityGeneration,
		});
	});

	it("returns a safe replacement candidate without saving an ordinary update to a different provider", async () => {
		const id = await createExistingVerifiedProvider();
		const before = { ...prisma._instances.get(id) };
		mockReadProviderIdentity.mockResolvedValueOnce({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "replacement-plex-machine",
			fingerprint: "replacement-fingerprint",
			displayName: "Replacement server",
			confirmationDigest: "b".repeat(64),
		});

		const response = await inject("PUT", `/services/${id}`, {
			body: { baseUrl: "http://replacement-provider.test" },
		});

		expect(response.statusCode).toBe(409);
		expect(JSON.parse(response.payload).details).toEqual({
			code: "IDENTITY_REPLACEMENT_REQUIRED",
			candidate: {
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				fingerprint: "replacement-fingerprint",
				displayName: "Replacement server",
				confirmationDigest: "b".repeat(64),
			},
			connectionGeneration: 0,
			identityGeneration: 3,
		});
		expect(response.payload).not.toContain("replacement-plex-machine");
		expect(prisma._instances.get(id)).toMatchObject({
			baseUrl: before.baseUrl,
			connectionGeneration: before.connectionGeneration,
			identityGeneration: before.identityGeneration,
		});
	});

	it("replaces a verified provider atomically, preserving submitted tags and one default", async () => {
		const id = await createExistingVerifiedProvider();
		prisma._instances.set("other-plex", {
			id: "other-plex",
			userId: USER_ID,
			service: "PLEX",
			isDefault: true,
		});
		prisma._approvals.set("untagged-approval", {
			id: "untagged-approval",
			config: { userId: USER_ID },
			status: "pending",
			safetySnapshot: null,
		});
		prisma._approvals.set("tagged-approval", {
			id: "tagged-approval",
			config: { userId: USER_ID },
			status: "approved",
			safetySnapshot: providerSafetySnapshot({
				service: "PLEX",
				instanceFingerprint: providerInstanceAuthorityFingerprint(id),
				identityKind: "PLEX_MACHINE_IDENTIFIER",
				identityFingerprint: providerIdentityAuthorityFingerprint({
					expectedIdentity: "enrolled-plex-machine",
					identityKind: "PLEX_MACHINE_IDENTIFIER",
					service: "PLEX",
				}),
				connectionGeneration: 0,
				identityGeneration: 3,
			}),
		});
		prisma._approvals.set("unrelated-approval", {
			id: "unrelated-approval",
			config: { userId: USER_ID },
			status: "pending",
			safetySnapshot: providerSafetySnapshot({
				service: "TAUTULLI",
				identityKind: "TAUTULLI_PMS_IDENTIFIER",
				identityFingerprint: "b".repeat(64),
				connectionGeneration: 0,
				identityGeneration: 3,
			}),
		});
		const replacement = {
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "replacement-plex-machine",
			fingerprint: "replacement-fingerprint",
			confirmationDigest: "b".repeat(64),
		};
		mockReadProviderIdentity.mockResolvedValueOnce(replacement).mockResolvedValueOnce(replacement);

		const inspected = await inject("POST", `/services/${id}/identity/inspect`, {
			body: {
				candidate: {
					baseUrl: "http://replacement-provider.test",
					isDefault: true,
					tags: ["movies"],
				},
			},
		});
		const response = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: {
					baseUrl: "http://replacement-provider.test",
					isDefault: true,
					tags: ["movies"],
				},
				confirmationDigest: JSON.parse(inspected.payload).candidate.confirmationDigest,
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});

		expect(response.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({
			baseUrl: "http://replacement-provider.test",
			expectedIdentity: "replacement-plex-machine",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			isDefault: true,
			connectionGeneration: 1,
			identityGeneration: 4,
		});
		expect(prisma._instances.get("other-plex")).toMatchObject({ isDefault: false });
		expect(prisma.serviceInstanceTag.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: id },
		});
		expect(prisma.serviceTag.upsert).toHaveBeenCalledWith({
			where: { name: "movies" },
			update: {},
			create: { name: "movies" },
		});
		expect(prisma.serviceInstanceTag.createMany).toHaveBeenCalledWith({
			data: [{ instanceId: id, tagId: "tag-movies" }],
		});
		for (const cache of [
			prisma.plexCache,
			prisma.plexEpisodeCache,
			prisma.tautulliCache,
			prisma.jellyfinCache,
			prisma.jellyfinEpisodeCache,
			prisma.cacheRefreshStatus,
		]) {
			expect(cache.deleteMany).toHaveBeenCalledWith({ where: { instanceId: id } });
		}
		expect(prisma._approvals.get("untagged-approval")).toMatchObject({ status: "expired" });
		expect(prisma._approvals.get("tagged-approval")).toMatchObject({ status: "expired" });
		expect(prisma._approvals.get("unrelated-approval")).toMatchObject({ status: "pending" });
	});

	it("requires and consumes analytics confirmation when replacing the selected Tautulli identity", async () => {
		const id = await createExistingVerifiedProvider();
		const instance = prisma._instances.get(id);
		if (!instance) throw new Error("Expected Tautulli instance");
		instance.service = "TAUTULLI";
		instance.expectedIdentity = "enrolled-tautulli-server";
		instance.identityKind = "TAUTULLI_PMS_IDENTIFIER";
		const replacement = {
			service: "TAUTULLI",
			identityKind: "tautulli-pms-identifier",
			rawIdentity: "replacement-tautulli-server",
			fingerprint: "replacement-fingerprint",
			confirmationDigest: "c".repeat(64),
		};
		mockReadProviderIdentity.mockResolvedValue(replacement);

		const blocked = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: { baseUrl: "http://replacement-tautulli.test" },
				confirmationDigest: replacement.confirmationDigest,
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});

		expect(blocked.statusCode).toBe(409);
		expect(blocked.json()).toEqual({
			code: "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED",
			selected: "tautulli",
			alternativeEnabled: false,
		});
		expect(instance.expectedIdentity).toBe("enrolled-tautulli-server");

		const replaced = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: { baseUrl: "http://replacement-tautulli.test" },
				confirmationDigest: replacement.confirmationDigest,
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
				confirmAnalyticsUnavailableFor: "tautulli",
			},
		});

		expect(replaced.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({
			expectedIdentity: "replacement-tautulli-server",
			identityGeneration: 4,
		});
		expect(prisma._instances.get(id)).not.toHaveProperty("confirmAnalyticsUnavailableFor");
	});

	it("preserves defaults and tags when a replacement loses its generation race", async () => {
		const id = await createExistingVerifiedProvider();
		prisma._instances.set("other-plex", {
			id: "other-plex",
			userId: USER_ID,
			service: "PLEX",
			isDefault: true,
		});
		const updateMany = prisma.serviceInstance.updateMany;
		const originalUpdateMany = updateMany.getMockImplementation();
		updateMany.mockImplementation(async (args: any) => {
			if (args.where.id === id && args.where.identityGeneration === 3) return { count: 0 };
			return await originalUpdateMany!(args);
		});
		mockReadProviderIdentity.mockResolvedValueOnce({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "replacement-plex-machine",
			fingerprint: "replacement-fingerprint",
			confirmationDigest: "a".repeat(64),
		});

		const response = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: { isDefault: true, tags: ["movies"] },
				confirmationDigest: "a".repeat(64),
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});

		expect(response.statusCode).toBe(409);
		expect(prisma._instances.get(id)).toMatchObject({ isDefault: false, identityGeneration: 3 });
		expect(prisma._instances.get("other-plex")).toMatchObject({ isDefault: true });
		expect(prisma.serviceInstanceTag.deleteMany).not.toHaveBeenCalled();
		expect(prisma.serviceTag.upsert).not.toHaveBeenCalled();
		expect(prisma.serviceInstanceTag.createMany).not.toHaveBeenCalled();
	});

	it("rejects a replacement that is no longer owned before reading a provider", async () => {
		const id = await createExistingVerifiedProvider();
		prisma._instances.get(id).userId = "another-user";

		const response = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: {},
				confirmationDigest: "a".repeat(64),
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});

		expect(response.statusCode).toBe(404);
		expect(mockReadProviderIdentity).not.toHaveBeenCalled();
	});

	it.each([
		["connection", 1, 3],
		["identity", 0, 4],
	] as const)(
		"rejects replacement with a stale %s generation",
		async (_generation, expectedConnectionGeneration, expectedIdentityGeneration) => {
			const id = await createExistingVerifiedProvider();
			mockReadProviderIdentity.mockResolvedValueOnce({
				service: "PLEX",
				identityKind: "plex-machine-identifier",
				rawIdentity: "replacement-plex-machine",
				fingerprint: "replacement-fingerprint",
				confirmationDigest: "a".repeat(64),
			});

			const response = await inject("POST", `/services/${id}/identity/replace`, {
				body: {
					candidate: { baseUrl: "http://stale-candidate-provider.test" },
					confirmationDigest: "a".repeat(64),
					expectedConnectionGeneration,
					expectedIdentityGeneration,
				},
			});

			expect(response.statusCode).toBe(409);
			expect(JSON.parse(response.payload).details).toMatchObject({
				code: "IDENTITY_GENERATION_STALE",
				connectionGeneration: 0,
				identityGeneration: 3,
			});
			expect(prisma._instances.get(id)).toMatchObject({
				expectedIdentity: "enrolled-plex-machine",
				identityGeneration: 3,
			});
			expect(mockReadProviderIdentity).not.toHaveBeenCalled();
		},
	);

	it("rejects a replacement when the inspected candidate digest changed", async () => {
		const id = await createExistingVerifiedProvider();
		mockReadProviderIdentity.mockResolvedValueOnce({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "replacement-plex-machine",
			fingerprint: "replacement-fingerprint",
			confirmationDigest: "b".repeat(64),
		});

		const response = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: {},
				confirmationDigest: "a".repeat(64),
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});

		expect(response.statusCode).toBe(409);
		expect(JSON.parse(response.payload).details).toMatchObject({
			code: "IDENTITY_CANDIDATE_CHANGED",
			candidate: {
				fingerprint: "replacement-fingerprint",
				confirmationDigest: "b".repeat(64),
			},
		});
		expect(prisma._instances.get(id)).toMatchObject({ identityGeneration: 3 });
	});

	it("rolls back a failed replacement and accepts a later retry exactly once", async () => {
		const id = await createExistingVerifiedProvider();
		const replacement = {
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "replacement-plex-machine",
			fingerprint: "replacement-fingerprint",
			confirmationDigest: "a".repeat(64),
		};
		prisma._approvals.set("approval", {
			id: "approval",
			config: { userId: USER_ID },
			status: "pending",
			safetySnapshot: null,
		});
		prisma.plexCache.deleteMany.mockRejectedValueOnce(new Error("cache unavailable"));
		mockReadProviderIdentity.mockResolvedValueOnce(replacement).mockResolvedValueOnce(replacement);

		const failed = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: {},
				confirmationDigest: "a".repeat(64),
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});
		expect(failed.statusCode).toBe(500);
		expect(prisma._instances.get(id)).toMatchObject({
			expectedIdentity: "enrolled-plex-machine",
			identityGeneration: 3,
		});
		expect(prisma._approvals.get("approval")).toMatchObject({ status: "pending" });

		const retried = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: {},
				confirmationDigest: "a".repeat(64),
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});
		expect(retried.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({
			expectedIdentity: "replacement-plex-machine",
			connectionGeneration: 0,
			identityGeneration: 4,
		});
	});

	it("treats an immediately retried replacement as an idempotent success", async () => {
		const id = await createExistingVerifiedProvider();
		const replacement = {
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "replacement-plex-machine",
			fingerprint: "replacement-fingerprint",
			confirmationDigest: "a".repeat(64),
		};
		mockReadProviderIdentity
			.mockResolvedValueOnce(replacement)
			.mockResolvedValueOnce(replacement)
			.mockResolvedValueOnce(replacement);

		const inspected = await inject("POST", `/services/${id}/identity/inspect`, { body: {} });
		const body = {
			candidate: {},
			confirmationDigest: JSON.parse(inspected.payload).candidate.confirmationDigest,
			expectedConnectionGeneration: 0,
			expectedIdentityGeneration: 3,
		};
		const first = await inject("POST", `/services/${id}/identity/replace`, { body });
		const retry = await inject("POST", `/services/${id}/identity/replace`, { body });

		expect(first.statusCode).toBe(200);
		expect(retry.statusCode).toBe(200);
		expect(prisma._instances.get(id)).toMatchObject({ identityGeneration: 4 });
		expect(prisma.serviceInstance.updateMany).toHaveBeenCalledTimes(1);
	});

	it("rejects a concurrent replacement with a different inspected connection for the same provider", async () => {
		const id = await createExistingVerifiedProvider();
		const replacement = {
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "replacement-plex-machine",
			fingerprint: "replacement-fingerprint",
			confirmationDigest: "a".repeat(64),
		};
		mockReadProviderIdentity.mockResolvedValue(replacement);

		const firstCandidate = { baseUrl: "http://first-provider.test" };
		const secondCandidate = { baseUrl: "http://second-provider.test" };
		const firstInspection = await inject("POST", `/services/${id}/identity/inspect`, {
			body: { candidate: firstCandidate },
		});
		const secondInspection = await inject("POST", `/services/${id}/identity/inspect`, {
			body: { candidate: secondCandidate },
		});

		const first = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: firstCandidate,
				confirmationDigest: firstInspection.json().candidate.confirmationDigest,
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});
		const staleSecond = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: secondCandidate,
				confirmationDigest: secondInspection.json().candidate.confirmationDigest,
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});

		expect(first.statusCode).toBe(200);
		expect(staleSecond.statusCode).toBe(409);
		expect(staleSecond.json().details).toMatchObject({
			code: "IDENTITY_GENERATION_STALE",
		});
		expect(prisma._instances.get(id)).toMatchObject({
			baseUrl: "http://first-provider.test",
			identityGeneration: 4,
		});
	});

	it("rejects a stale same-identity replacement requesting a different enabled state", async () => {
		const id = await createExistingVerifiedProvider();
		mockReadProviderIdentity.mockResolvedValue({
			service: "PLEX",
			identityKind: "plex-machine-identifier",
			rawIdentity: "replacement-plex-machine",
			fingerprint: "replacement-fingerprint",
			confirmationDigest: "a".repeat(64),
		});
		const disabledCandidate = { enabled: false };
		const enabledCandidate = { enabled: true };
		const disabledInspection = await inject("POST", `/services/${id}/identity/inspect`, {
			body: { candidate: disabledCandidate },
		});
		const enabledInspection = await inject("POST", `/services/${id}/identity/inspect`, {
			body: { candidate: enabledCandidate },
		});

		const first = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: disabledCandidate,
				confirmationDigest: disabledInspection.json().candidate.confirmationDigest,
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});
		const staleSecond = await inject("POST", `/services/${id}/identity/replace`, {
			body: {
				candidate: enabledCandidate,
				confirmationDigest: enabledInspection.json().candidate.confirmationDigest,
				expectedConnectionGeneration: 0,
				expectedIdentityGeneration: 3,
			},
		});

		expect(first.statusCode).toBe(200);
		expect(staleSecond.statusCode).toBe(409);
		expect(staleSecond.json().details).toMatchObject({ code: "IDENTITY_GENERATION_STALE" });
		expect(prisma._instances.get(id)).toMatchObject({
			enabled: false,
			connectionGeneration: 1,
			identityGeneration: 4,
		});
	});

	it("encrypts HTTP auth credentials and exposes only a configured flag", async () => {
		const response = await inject("POST", "/services", {
			body: {
				label: "Protected Sonarr",
				baseUrl: "https://sonarr.example.test",
				apiKey: PLAINTEXT_KEY_V1,
				service: "sonarr",
				httpAuth: { username: "proxy-user", password: "proxy-pass" },
			},
		});

		expect(response.statusCode).toBe(201);
		const service = JSON.parse(response.payload).service;
		expect(service.hasHttpAuth).toBe(true);
		expect(response.payload).not.toContain("proxy-user");
		expect(response.payload).not.toContain("proxy-pass");

		const stored = prisma._instances.get(service.id);
		expect(stored.encryptedHttpAuthCredentials).toContain("enc:");
		expect(stored.httpAuthEncryptionIv).toBe("iv");
		expect(encryptor.encrypt).toHaveBeenCalledWith(
			JSON.stringify({ v: 1, username: "proxy-user", password: "proxy-pass" }),
		);
	});

	it("preserves omitted HTTP auth credentials and clears them only when requested", async () => {
		const create = await inject("POST", "/services", {
			body: {
				label: "Protected Sonarr",
				baseUrl: "https://sonarr.example.test",
				apiKey: PLAINTEXT_KEY_V1,
				service: "sonarr",
				httpAuth: { username: "proxy-user", password: "proxy-pass" },
			},
		});
		const id = JSON.parse(create.payload).service.id;
		const originalCiphertext = prisma._instances.get(id).encryptedHttpAuthCredentials;

		const preserve = await inject("PUT", `/services/${id}`, {
			body: { label: "Still Protected" },
		});
		expect(preserve.statusCode).toBe(200);
		expect(JSON.parse(preserve.payload).service.hasHttpAuth).toBe(true);
		expect(prisma._instances.get(id).encryptedHttpAuthCredentials).toBe(originalCiphertext);

		const clear = await inject("PUT", `/services/${id}`, {
			body: { httpAuth: null },
		});
		expect(clear.statusCode).toBe(200);
		expect(JSON.parse(clear.payload).service.hasHttpAuth).toBe(false);
		expect(prisma._instances.get(id).encryptedHttpAuthCredentials).toBeNull();
		expect(prisma._instances.get(id).httpAuthEncryptionIv).toBeNull();
	});

	it("keeps ARR ciphertext and saved bindings current when identical credentials are resubmitted", async () => {
		const httpAuth = { username: "proxy-user", password: "proxy-pass" };
		const create = await inject("POST", "/services", {
			body: {
				label: "Protected Sonarr",
				baseUrl: "https://sonarr.example.test",
				apiKey: PLAINTEXT_KEY_V1,
				service: "sonarr",
				httpAuth,
			},
		});
		const id = JSON.parse(create.payload).service.id;
		const storedBefore = { ...prisma._instances.get(id) };
		const binding = createDeploymentConnectionBinding(storedBefore);
		const mapping = {
			id: "mapping-1",
			templateId: "template-1",
			instanceId: id,
			qualityProfileId: 4,
			qualityProfileName: "Any",
			connectionGeneration: binding.connectionGeneration,
			connectionStateToken: binding.connectionStateToken,
			template: { userId: USER_ID },
			instance: { userId: USER_ID },
		};
		prisma._mappings.set(mapping.id, mapping);
		for (const [index, status] of ["APPLIED", "PENDING", "UNCERTAIN"].entries()) {
			prisma._overrides.set(`override-${status}`, {
				id: `override-${status}`,
				instanceId: id,
				qualityProfileId: 4,
				customFormatId: index + 1,
				score: index,
				status,
				intentOperation: status === "APPLIED" ? null : "SET_SCORE",
				intendedScore: status === "APPLIED" ? null : index,
				userId: USER_ID,
				connectionGeneration: binding.connectionGeneration,
				connectionStateToken: binding.connectionStateToken,
				instance: { userId: USER_ID },
			});
		}

		const response = await inject("PUT", `/services/${id}`, {
			body: { apiKey: PLAINTEXT_KEY_V1, httpAuth },
		});

		expect(response.statusCode).toBe(200);
		const storedAfter = prisma._instances.get(id);
		expect(storedAfter).toMatchObject({
			encryptedApiKey: storedBefore.encryptedApiKey,
			encryptionIv: storedBefore.encryptionIv,
			encryptedHttpAuthCredentials: storedBefore.encryptedHttpAuthCredentials,
			httpAuthEncryptionIv: storedBefore.httpAuthEncryptionIv,
			connectionGeneration: 0,
		});
		expect(createDeploymentConnectionStateToken(storedAfter)).toBe(binding.connectionStateToken);
		expect(prisma.instanceQualityProfileOverride.findMany).not.toHaveBeenCalled();

		const currentBinding = createDeploymentConnectionBinding(storedAfter);
		expect(isCurrentDeploymentConnectionMapping(mapping, [currentBinding])).toBe(true);
		for (const status of ["APPLIED", "PENDING", "UNCERTAIN"]) {
			const row = prisma._overrides.get(`override-${status}`);
			expect(row.status).toBe(status);
			expect(isCurrentDeploymentConnectionMapping(row, [currentBinding])).toBe(true);
		}
	});

	it.each(["PENDING", "UNCERTAIN"])(
		"blocks a real credential change while %s score intent is unresolved",
		async (status) => {
			const create = await inject("POST", "/services", {
				body: {
					label: "Sonarr",
					baseUrl: "http://sonarr:8989",
					apiKey: PLAINTEXT_KEY_V1,
					service: "sonarr",
				},
			});
			const id = JSON.parse(create.payload).service.id;
			const storedBefore = { ...prisma._instances.get(id) };
			const binding = createDeploymentConnectionBinding(storedBefore);
			prisma._overrides.set("override-unresolved", {
				id: "override-unresolved",
				instanceId: id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 0,
				status,
				intentOperation: "SET_SCORE",
				intendedScore: 5,
				userId: USER_ID,
				connectionGeneration: binding.connectionGeneration,
				connectionStateToken: binding.connectionStateToken,
				instance: { userId: USER_ID },
			});

			const response = await inject("PUT", `/services/${id}`, {
				body: { apiKey: PLAINTEXT_KEY_V2 },
			});

			expect(response.statusCode).toBe(409);
			expect(prisma._instances.get(id)).toMatchObject({
				encryptedApiKey: storedBefore.encryptedApiKey,
				encryptionIv: storedBefore.encryptionIv,
				connectionGeneration: 0,
			});
			expect(prisma._overrides.get("override-unresolved").status).toBe(status);
			expect(prisma.serviceInstance.updateMany).not.toHaveBeenCalled();
		},
	);

	it("tests staged HTTP auth with the stored API key without persisting it", async () => {
		const create = await inject("POST", "/services", {
			body: {
				label: "Sonarr",
				baseUrl: "https://sonarr.example.test",
				apiKey: PLAINTEXT_KEY_V1,
				service: "sonarr",
			},
		});
		const id = JSON.parse(create.payload).service.id;
		mockTestConnection.mockResolvedValueOnce({ success: true });

		const response = await inject("POST", `/services/${id}/test`, {
			body: { httpAuth: { username: "new-proxy", password: "new-password" } },
		});

		expect(response.statusCode).toBe(200);
		expect(mockTestConnection).toHaveBeenCalledWith(
			"https://sonarr.example.test",
			PLAINTEXT_KEY_V1,
			"sonarr",
			{ username: "new-proxy", password: "new-password" },
		);
		expect(prisma._instances.get(id).encryptedHttpAuthCredentials).toBeUndefined();
	});

	it("walks create → list → test(success) → test(failure) → update → delete with correct side effects", async () => {
		// --- 1. CREATE ---------------------------------------------------------
		const createRes = await inject("POST", "/services", {
			body: {
				label: "Sonarr Main",
				baseUrl: "http://sonarr:8989",
				apiKey: PLAINTEXT_KEY_V1,
				service: "sonarr",
			},
		});

		expect(createRes.statusCode).toBe(201);
		const created = JSON.parse(createRes.payload).service;

		// Response contract: public fields only, no secrets, hasApiKey flag set.
		expect(created).toMatchObject({
			service: "sonarr",
			label: "Sonarr Main",
			baseUrl: "http://sonarr:8989",
			enabled: true,
			isDefault: false,
			hasApiKey: true,
		});
		expect(created.id).toMatch(/^inst-/);
		expectNoSecretsIn(createRes.payload);

		// Side effect: the ciphertext landed in the DB, not the plaintext.
		const storedAfterCreate = prisma._instances.get(created.id);
		expect(storedAfterCreate).toBeDefined();
		expect(storedAfterCreate.encryptedApiKey).toBe(ENCRYPTED_V1);
		expect(storedAfterCreate.encryptionIv).toBe(IV_V1);
		expect(storedAfterCreate.userId).toBe(USER_ID);
		// And encrypt was called with the plaintext exactly once.
		expect(encryptor.encrypt).toHaveBeenCalledWith(PLAINTEXT_KEY_V1);

		// --- 2. LIST reflects creation ----------------------------------------
		const listRes = await inject("GET", "/services");
		expect(listRes.statusCode).toBe(200);
		const listBody = JSON.parse(listRes.payload);
		expect(listBody.services).toHaveLength(1);
		expect(listBody.services[0].id).toBe(created.id);
		expectNoSecretsIn(listRes.payload);

		// --- 3. TEST CONNECTION (success) -------------------------------------
		mockTestConnection.mockResolvedValueOnce({
			success: true,
			message: "Successfully connected to Sonarr",
			version: "4.0.0",
		});

		const testOk = await inject("POST", `/services/${created.id}/test`);
		expect(testOk.statusCode).toBe(200);
		const okBody = JSON.parse(testOk.payload);
		expect(okBody).toEqual({
			success: true,
			message: "Successfully connected to Sonarr",
			version: "4.0.0",
		});

		// Side effect: tester was invoked with the decrypted key — the route
		// is the only caller that decrypts for an outbound call. If this ever
		// regresses to passing ciphertext, all test-connection buttons break.
		expect(mockTestConnection).toHaveBeenCalledWith(
			"http://sonarr:8989",
			PLAINTEXT_KEY_V1,
			"sonarr",
		);

		// --- 4. TEST CONNECTION (failure) -------------------------------------
		mockTestConnection.mockResolvedValueOnce({
			success: false,
			error: "Connection refused",
			details: "Could not connect to the service.",
		});

		const testFail = await inject("POST", `/services/${created.id}/test`);
		// Contract: connection failure is returned as 200 with success:false
		// (the HTTP call succeeded; the *probe* failed). This is what the UI
		// depends on to render the error banner vs. a blown-up toast.
		expect(testFail.statusCode).toBe(200);
		const failBody = JSON.parse(testFail.payload);
		expect(failBody).toMatchObject({
			success: false,
			error: "Connection refused",
		});

		// Failure path must NOT mutate the stored instance.
		const storedAfterFail = prisma._instances.get(created.id);
		expect(storedAfterFail.encryptedApiKey).toBe(ENCRYPTED_V1);
		expect(storedAfterFail.encryptionIv).toBe(IV_V1);

		// --- 5. UPDATE (label + API key rotation) -----------------------------
		const updateRes = await inject("PUT", `/services/${created.id}`, {
			body: {
				label: "Sonarr Renamed",
				apiKey: PLAINTEXT_KEY_V2,
			},
		});

		expect(updateRes.statusCode).toBe(200);
		const updated = JSON.parse(updateRes.payload).service;
		expect(updated.label).toBe("Sonarr Renamed");
		expect(updated.id).toBe(created.id);
		expect(updated.hasApiKey).toBe(true);
		// Rotated secrets must not appear in the response either.
		expectNoSecretsIn(updateRes.payload);

		// Side effect: the NEW ciphertext replaced the old in the store.
		const storedAfterUpdate = prisma._instances.get(created.id);
		expect(storedAfterUpdate.label).toBe("Sonarr Renamed");
		expect(storedAfterUpdate.encryptedApiKey).toBe(ENCRYPTED_V2);
		expect(storedAfterUpdate.encryptionIv).toBe(IV_V2);
		expect(storedAfterUpdate.connectionGeneration).toBe(1);
		expect(encryptor.encrypt).toHaveBeenCalledWith(PLAINTEXT_KEY_V2);

		// --- 6. DELETE --------------------------------------------------------
		const delRes = await inject("DELETE", `/services/${created.id}`);
		expect(delRes.statusCode).toBe(204);
		expect(delRes.payload).toBe("");
		expect(prisma._instances.has(created.id)).toBe(false);

		// --- 7. LIST reflects deletion ----------------------------------------
		const listAfter = await inject("GET", "/services");
		expect(listAfter.statusCode).toBe(200);
		expect(JSON.parse(listAfter.payload).services).toHaveLength(0);
	});

	it("PUT against a non-existent instance id returns 404 (ownership gate via requireInstance)", async () => {
		const res = await inject("PUT", "/services/inst-does-not-exist", {
			body: { label: "nope" },
		});

		expect(res.statusCode).toBe(404);
		// No write should have fired.
		expect(prisma.serviceInstance.updateMany).not.toHaveBeenCalled();
	});

	it("DELETE against a non-existent instance id returns 404 without issuing prisma.delete", async () => {
		const res = await inject("DELETE", "/services/inst-does-not-exist");

		expect(res.statusCode).toBe(404);
		// requireInstance must have short-circuited before the raw delete call.
		expect(prisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it.each(["mapping", "override"] as const)(
		"fails closed before deleting an ARR alias with mismatched %s ownership",
		async (stateKind) => {
			const createSource = await inject("POST", "/services", {
				body: {
					label: "Sonarr source",
					baseUrl: "http://sonarr:8989",
					apiKey: PLAINTEXT_KEY_V1,
					service: "sonarr",
				},
			});
			const createSurvivor = await inject("POST", "/services", {
				body: {
					label: "Sonarr survivor",
					baseUrl: "http://sonarr:8989/",
					apiKey: PLAINTEXT_KEY_V1,
					service: "sonarr",
				},
			});
			const sourceId = JSON.parse(createSource.payload).service.id;
			const survivorId = JSON.parse(createSurvivor.payload).service.id;
			const source = prisma._instances.get(sourceId);
			const binding = createDeploymentConnectionBinding(source);

			if (stateKind === "mapping") {
				prisma._mappings.set("mapping-mismatched-owner", {
					id: "mapping-mismatched-owner",
					templateId: "other-user-template",
					instanceId: sourceId,
					qualityProfileId: 4,
					qualityProfileName: "Any",
					connectionGeneration: binding.connectionGeneration,
					connectionStateToken: binding.connectionStateToken,
					template: { userId: "user-2" },
					instance: { userId: USER_ID },
				});
			} else {
				prisma._overrides.set("override-mismatched-owner", {
					id: "override-mismatched-owner",
					instanceId: sourceId,
					qualityProfileId: 4,
					customFormatId: 7,
					score: 5,
					status: "APPLIED",
					userId: "user-2",
					connectionGeneration: binding.connectionGeneration,
					connectionStateToken: binding.connectionStateToken,
					instance: { userId: USER_ID },
				});
			}

			const response = await inject("DELETE", `/services/${sourceId}`);

			expect(response.statusCode).toBe(409);
			expect(prisma._instances.has(sourceId)).toBe(true);
			expect(prisma._instances.has(survivorId)).toBe(true);
			if (stateKind === "mapping") {
				expect(prisma._mappings.get("mapping-mismatched-owner")?.instanceId).toBe(sourceId);
			} else {
				expect(prisma._overrides.get("override-mismatched-owner")?.instanceId).toBe(sourceId);
			}
			expect(prisma.templateQualityProfileMapping.updateMany).not.toHaveBeenCalled();
			expect(prisma.templateQualityProfileMapping.deleteMany).not.toHaveBeenCalled();
			expect(prisma.instanceQualityProfileOverride.updateMany).not.toHaveBeenCalled();
			expect(prisma.instanceQualityProfileOverride.deleteMany).not.toHaveBeenCalled();
			expect(prisma.serviceInstance.delete).not.toHaveBeenCalled();
		},
	);

	it("POST /services/:id/test against a non-existent instance returns 404 and never calls the tester", async () => {
		const res = await inject("POST", "/services/inst-nope/test");

		expect(res.statusCode).toBe(404);
		expect(mockTestConnection).not.toHaveBeenCalled();
	});
});
