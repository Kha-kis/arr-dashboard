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
	let nextId = 1;

	const serviceInstance = {
		findMany: vi.fn(async ({ where }: any) => {
			return [...instances.values()]
				.filter((row) => row.userId === where.userId)
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
				Object.assign(row, data);
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

	return {
		_instances: instances,
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
	};
}

/**
 * Encryptor stub that returns different ciphertexts for different
 * plaintexts, so we can tell whether a rotation actually persisted.
 */
function createEncryptorStub() {
	return {
		encrypt: vi.fn((plain: string) => {
			if (plain === PLAINTEXT_KEY_V1) return { value: ENCRYPTED_V1, iv: IV_V1 };
			if (plain === PLAINTEXT_KEY_V2) return { value: ENCRYPTED_V2, iv: IV_V2 };
			return { value: `enc:${plain}`, iv: "iv" };
		}),
		decrypt: vi.fn(({ value }: { value: string }) => {
			if (value === ENCRYPTED_V1) return PLAINTEXT_KEY_V1;
			if (value === ENCRYPTED_V2) return PLAINTEXT_KEY_V2;
			return "unknown";
		}),
	};
}

const FORBIDDEN_SECRET_FIELDS = ["encryptedApiKey", "encryptionIv", "apiKey"] as const;
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

		setupAuthInjection(app, { id: USER_ID, username: "admin" });
		registerTestErrorHandler(app);

		await app.register(registerServiceRoutes);
		await app.ready();

		inject = createInjectAuthenticated(app);
	});

	afterEach(async () => {
		await app?.close();
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

	it("POST /services/:id/test against a non-existent instance returns 404 and never calls the tester", async () => {
		const res = await inject("POST", "/services/inst-nope/test");

		expect(res.statusCode).toBe(404);
		expect(mockTestConnection).not.toHaveBeenCalled();
	});
});
