import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
	runPlexRead: vi.fn(),
}));

vi.mock("../bootstrap/index.js", () => ({
	registerInfrastructure(app: { decorate: (name: string, value: unknown) => void }) {
		app.decorate("sessionService", { validateRequest: vi.fn().mockResolvedValue(null) });
	},
	registerSchedulers() {},
	registerProtectedRoutes() {},
	registerPublicRoutes(app: { get: (path: string, handler: () => Promise<unknown>) => void }) {
		app.get("/plex-validation-probe", async () => await routeMocks.runPlexRead());
	},
}));

import { envSchema } from "../config/env.js";
import { PlexClient } from "../lib/plex/plex-client.js";
import { buildServer } from "../server.js";

const log = { warn: vi.fn() } as never;

describe("production Plex validation error handling", () => {
	let app: ReturnType<typeof buildServer>;

	beforeEach(async () => {
		const client = new PlexClient(
			"https://CANARY_ROUTE_HOST_787.invalid",
			"CANARY_ROUTE_TOKEN_787",
			log,
		);
		routeMocks.runPlexRead.mockReset().mockImplementation(async () => await client.getActivities());
		app = buildServer({ logger: false, env: envSchema.parse({ NODE_ENV: "test" }) });
		await app.ready();
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await app.close();
	});

	it("returns a bounded 502 for a schema-invalid successful Plex response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						MediaContainer: {
							size: "CANARY_ROUTE_PAYLOAD_787",
							Activity: [{ type: "CANARY_ROUTE_STATUS_787" }],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			),
		);
		const response = await app.inject({ method: "GET", url: "/plex-validation-probe" });

		expect(response.statusCode).toBe(502);
		expect(response.json()).toEqual({
			error: "PlexRequestError",
			message: "Plex API request failed",
		});
		const serialized = JSON.stringify(response.json());
		for (const canary of [
			"CANARY_ROUTE_HOST_787.invalid",
			"CANARY_ROUTE_TOKEN_787",
			"CANARY_ROUTE_PAYLOAD_787",
			"CANARY_ROUTE_STATUS_787",
			"Zod",
		]) {
			expect(serialized).not.toContain(canary);
		}
	});

	it("preserves an ordinary valid Plex route response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				new Response(JSON.stringify({ MediaContainer: { size: 0, Activity: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		);

		const response = await app.inject({ method: "GET", url: "/plex-validation-probe" });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([]);
	});
});
