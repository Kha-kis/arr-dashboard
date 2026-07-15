import fastifyRateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers";

const { discoverMediaServers } = vi.hoisted(() => ({ discoverMediaServers: vi.fn() }));
vi.mock("../../lib/setup-discovery/udp-discovery.js", () => ({ discoverMediaServers }));

import { registerSetupRoutes } from "../setup";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	discoverMediaServers.mockReset();
	discoverMediaServers.mockResolvedValue({
		candidates: [
			{
				service: "plex",
				name: "Plex",
				baseUrl: "http://192.168.1.2:32400",
				serverId: "plex-1",
				protocol: "plex-gdm",
			},
		],
		scannedProtocols: ["plex-gdm", "plex-ssdp", "jellyfin-udp", "emby-udp"],
		durationMs: 1200,
	});
	app = Fastify({ logger: false });
	setupAuthInjection(app);
	await app.register(fastifyRateLimit, { max: 100, timeWindow: "1 minute" });
	await app.register(registerSetupRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => app.close());

describe("POST /setup/discovery", () => {
	it("returns credential-free candidates without persisting or connecting them", async () => {
		const response = await injectAuthenticated("POST", "/setup/discovery");
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.payload)).toMatchObject({
			candidates: [{ service: "plex", serverId: "plex-1" }],
		});
		expect(discoverMediaServers).toHaveBeenCalledOnce();
	});

	it("coalesces overlapping scans instead of multiplying network broadcasts", async () => {
		let resolveScan!: (value: {
			candidates: never[];
			scannedProtocols: ["plex-gdm", "plex-ssdp", "jellyfin-udp", "emby-udp"];
			durationMs: number;
		}) => void;
		discoverMediaServers.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveScan = resolve;
			}),
		);

		const first = injectAuthenticated("POST", "/setup/discovery");
		const second = injectAuthenticated("POST", "/setup/discovery");
		await vi.waitFor(() => expect(discoverMediaServers).toHaveBeenCalledOnce());
		resolveScan({
			candidates: [],
			scannedProtocols: ["plex-gdm", "plex-ssdp", "jellyfin-udp", "emby-udp"],
			durationMs: 1,
		});

		expect((await first).statusCode).toBe(200);
		expect((await second).statusCode).toBe(200);
		expect(discoverMediaServers).toHaveBeenCalledOnce();
	});

	it("limits repeated scans to avoid noisy local-network broadcasts", async () => {
		for (let request = 0; request < 5; request++) {
			expect((await injectAuthenticated("POST", "/setup/discovery")).statusCode).toBe(200);
		}
		expect((await injectAuthenticated("POST", "/setup/discovery")).statusCode).toBe(429);
	});
});
