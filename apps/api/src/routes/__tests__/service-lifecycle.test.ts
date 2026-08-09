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

vi.mock("../../lib/services/connection-tester.js", () => ({
	testServiceConnection: (...args: unknown[]) => mockTestConnection(...args),
}));

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
	let nextId = 1;

	const serviceInstance = {
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
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config-1" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		serviceInstance,
		serviceTag: {
			findMany: vi.fn().mockResolvedValue([]),
			upsert: vi.fn(),
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
	};
	return Object.assign(prisma, {
		$transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
			callback(prisma),
		),
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
				callback(createDeploymentEndpointKey(lockedUserId, target)),
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
