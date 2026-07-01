/**
 * Tracearr kill-session route (Tracearr-3).
 *
 * Covers POST /tracearr/instances/:id/streams/:streamId/terminate: success
 * passthrough, ownership enforcement (unowned/missing instance → 404), the
 * optional reason forwarded to the client, and upstream error propagation
 * (a session that already ended surfaces Tracearr's mapped status).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRequireTracearrInstance } = vi.hoisted(() => ({
	mockRequireTracearrInstance: vi.fn(),
}));

vi.mock("../../lib/tracearr/instance-helpers.js", () => ({
	requireTracearrInstance: (...args: unknown[]) => mockRequireTracearrInstance(...args),
	listTracearrInstances: vi.fn().mockResolvedValue([]),
}));

const mockTerminateStream = vi.hoisted(() => vi.fn());

vi.mock("../../lib/tracearr/client-factory.js", () => ({
	createTracearrClient: vi.fn(() => ({ terminateStream: mockTerminateStream })),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { InstanceNotFoundError, TracearrApiError } from "../../lib/errors.js";
import { registerTracearrRoutes } from "../tracearr.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

function makeTracearrInstance(overrides: Record<string, unknown> = {}) {
	return {
		id: "trr-1",
		userId: "user-1",
		service: "TRACEARR",
		label: "Dev Tracearr",
		baseUrl: "http://tracearr.test",
		encryptedApiKey: "enc",
		encryptionIv: "iv",
		externalUrl: null,
		isDefault: false,
		enabled: true,
		storageGroupId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

let app: FastifyInstance;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();
	mockRequireTracearrInstance.mockResolvedValue(makeTracearrInstance());

	app = Fastify();
	app.decorate("prisma", {} as never);
	setupAuthInjection(app);
	registerTestErrorHandler(app);

	await app.register(registerTracearrRoutes);
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

describe("POST /tracearr/instances/:id/streams/:streamId/terminate", () => {
	it("terminates a session and returns Tracearr's success payload", async () => {
		mockTerminateStream.mockResolvedValue({
			success: true,
			terminationLogId: "log-9",
			message: "Terminated",
		});

		const res = await injectAuthenticated(
			"POST",
			"/tracearr/instances/trr-1/streams/sess-1/terminate",
			{ body: { reason: "Too many streams" } },
		);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.payload)).toEqual({
			success: true,
			terminationLogId: "log-9",
			message: "Terminated",
		});
		// The stream id + reason must reach the client.
		expect(mockTerminateStream).toHaveBeenCalledWith("sess-1", { reason: "Too many streams" });
	});

	it("forwards no reason when the body omits it", async () => {
		mockTerminateStream.mockResolvedValue({
			success: true,
			terminationLogId: "log-1",
			message: "ok",
		});

		await injectAuthenticated("POST", "/tracearr/instances/trr-1/streams/sess-2/terminate");

		expect(mockTerminateStream).toHaveBeenCalledWith("sess-2", { reason: undefined });
	});

	it("returns 404 for an unowned or missing Tracearr instance", async () => {
		mockRequireTracearrInstance.mockRejectedValue(new InstanceNotFoundError("trr-x"));

		const res = await injectAuthenticated(
			"POST",
			"/tracearr/instances/trr-x/streams/sess-1/terminate",
		);

		expect(res.statusCode).toBe(404);
		expect(mockTerminateStream).not.toHaveBeenCalled();
	});

	it("propagates an upstream Tracearr error (e.g. session already ended → 404)", async () => {
		mockTerminateStream.mockRejectedValue(
			new TracearrApiError("session not found", { upstreamStatus: 404 }),
		);

		const res = await injectAuthenticated(
			"POST",
			"/tracearr/instances/trr-1/streams/gone/terminate",
		);

		expect(res.statusCode).toBe(404);
	});
});
