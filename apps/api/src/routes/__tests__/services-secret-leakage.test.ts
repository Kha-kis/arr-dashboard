/**
 * Service-instance secret non-leakage contract tests.
 *
 * Existing services.test.ts covers create/update/delete and SSRF, but does
 * NOT assert that API responses never leak `encryptedApiKey`, `encryptionIv`,
 * or the raw key on ANY service endpoint. This file locks that contract in
 * across GET /services, POST /services, and PUT /services/:id.
 *
 * Why this matters: formatServiceInstance is the single chokepoint that
 * strips secrets. A future refactor that bypasses it (e.g. `reply.send(instance)`
 * directly) would silently leak secrets to the authenticated admin UI — and
 * to any log pipeline that captures response bodies.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireInstance, mockBuildUpdateData, mockUpsertTags, mockUpdateInstanceTags } =
	vi.hoisted(() => ({
		mockRequireInstance: vi.fn(),
		mockBuildUpdateData: vi.fn().mockReturnValue({}),
		mockUpsertTags: vi.fn().mockResolvedValue([]),
		mockUpdateInstanceTags: vi.fn().mockResolvedValue(undefined),
	}));

vi.mock("../../lib/arr/instance-helpers.js", () => ({
	requireInstance: (...args: unknown[]) => mockRequireInstance(...args),
}));

vi.mock("../../lib/services/update-builder.js", () => ({
	buildUpdateData: (...args: unknown[]) => mockBuildUpdateData(...args),
}));

vi.mock("../../lib/services/tag-manager.js", () => ({
	upsertTags: (...args: unknown[]) => mockUpsertTags(...args),
	updateInstanceTags: (...args: unknown[]) => mockUpdateInstanceTags(...args),
}));

import Fastify from "fastify";
import { registerServiceRoutes } from "../services.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const SECRET_KEY = "super-secret-plaintext-api-key-xxxx";
const ENCRYPTED_VALUE = "encrypted-base64-value";
const ENCRYPTION_IV = "random-iv-bytes";

function makeInstanceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "inst-1",
		userId: "user-1",
		service: "SONARR",
		label: "My Sonarr",
		baseUrl: "http://sonarr:8989",
		externalUrl: null,
		encryptedApiKey: ENCRYPTED_VALUE,
		encryptionIv: ENCRYPTION_IV,
		enabled: true,
		isDefault: false,
		createdAt: new Date("2024-01-01T00:00:00Z"),
		updatedAt: new Date("2024-01-01T00:00:00Z"),
		storageGroupId: null,
		tags: [],
		...overrides,
	};
}

/**
 * Recursively assert that NONE of the forbidden secret fields appear anywhere
 * in the response body — including inside nested objects or arrays. This
 * catches regressions that pass objects through untransformed.
 */
function assertNoSecretLeakage(body: unknown): void {
	const FORBIDDEN = ["encryptedApiKey", "encryptionIv", "apiKey"];
	const serialized = JSON.stringify(body);
	for (const field of FORBIDDEN) {
		expect(serialized).not.toContain(`"${field}"`);
	}
	// Also check that the plaintext secret value itself never appears —
	// guards against accidentally serializing a decrypted form.
	expect(serialized).not.toContain(SECRET_KEY);
	expect(serialized).not.toContain(ENCRYPTED_VALUE);
	expect(serialized).not.toContain(ENCRYPTION_IV);
}

let app: ReturnType<typeof Fastify>;
let mockPrisma: any;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();

	mockPrisma = {
		serviceInstance: {
			findMany: vi
				.fn()
				.mockResolvedValue([
					makeInstanceRow(),
					makeInstanceRow({ id: "inst-2", service: "RADARR", label: "My Radarr" }),
				]),
			findFirst: vi.fn().mockResolvedValue(makeInstanceRow()),
			create: vi.fn().mockImplementation(({ data }: any) => ({
				...makeInstanceRow(),
				...data,
				id: "inst-new",
				tags: [],
			})),
			updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		serviceTag: {
			findMany: vi.fn().mockResolvedValue([]),
			upsert: vi.fn(),
			delete: vi.fn(),
		},
		serviceInstanceTag: { findFirst: vi.fn().mockResolvedValue(null) },
	};

	mockRequireInstance.mockResolvedValue(makeInstanceRow());
	mockBuildUpdateData.mockReturnValue({});

	app = Fastify();
	app.decorate("prisma", mockPrisma);
	// Encryptor returns exactly the values that would leak if passed through
	app.decorate("encryptor", {
		encrypt: vi.fn().mockReturnValue({ value: ENCRYPTED_VALUE, iv: ENCRYPTION_IV }),
		decrypt: vi.fn().mockReturnValue(SECRET_KEY),
	});
	app.decorate("notificationService", { notify: vi.fn().mockResolvedValue(undefined) } as never);

	setupAuthInjection(app);
	registerTestErrorHandler(app);

	await app.register(registerServiceRoutes);
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

describe("Service instance secret non-leakage", () => {
	it("GET /services never exposes encrypted fields or the plaintext key", async () => {
		const res = await injectAuthenticated("GET", "/services");
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);

		expect(body.services).toHaveLength(2);
		assertNoSecretLeakage(body);

		// Positive contract: hasApiKey must be present and truthy (existing UI depends on it)
		for (const svc of body.services) {
			expect(svc.hasApiKey).toBe(true);
			expect(svc.id).toBeDefined();
			expect(svc.label).toBeDefined();
		}
	});

	it("POST /services response carries hasApiKey but never the secret that was just sent", async () => {
		const res = await injectAuthenticated("POST", "/services", {
			body: {
				label: "Fresh Sonarr",
				baseUrl: "http://sonarr:8989",
				apiKey: SECRET_KEY,
				service: "sonarr",
			},
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.payload);

		expect(body.service.hasApiKey).toBe(true);
		assertNoSecretLeakage(body);
	});

	it("PUT /services/:id response does not echo the updated secret back to the caller", async () => {
		mockBuildUpdateData.mockReturnValue({
			encryptedApiKey: ENCRYPTED_VALUE,
			encryptionIv: ENCRYPTION_IV,
		});
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeInstanceRow({ label: "Rotated" }));

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { apiKey: SECRET_KEY },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		assertNoSecretLeakage(body);
	});

	it("Prisma create is called with encrypted values — the raw key never touches the DB layer", async () => {
		await injectAuthenticated("POST", "/services", {
			body: {
				label: "Encrypt Check",
				baseUrl: "http://sonarr:8989",
				apiKey: SECRET_KEY,
				service: "sonarr",
			},
		});

		const createCall = mockPrisma.serviceInstance.create.mock.calls[0][0];
		// Raw plaintext must never appear in the data payload
		expect(JSON.stringify(createCall.data)).not.toContain(SECRET_KEY);
		expect(createCall.data.encryptedApiKey).toBe(ENCRYPTED_VALUE);
		expect(createCall.data.encryptionIv).toBe(ENCRYPTION_IV);
	});
});
