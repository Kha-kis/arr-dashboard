import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { registerScanRoutes } from "../scan-routes.js";
import { sectionCatalogFixture } from "./section-catalog-fixture.js";

const provider = vi.hoisted(() => ({
	request: vi.fn(),
	getIdentity: vi.fn(),
	getLibrarySettlementSections: vi.fn(),
}));
vi.mock("../../../lib/plex/plex-client.js", async (original) => ({
	...(await original<typeof import("../../../lib/plex/plex-client.js")>()),
	createPlexClient: vi.fn(() => provider),
}));

describe("Plex section scan execution safety", () => {
	let fixture: ReturnType<typeof sectionCatalogFixture>;
	let app: ReturnType<typeof Fastify>;
	const endpoint = "/api/plex/plex-1/sections/1/refresh";
	beforeEach(async () => {
		vi.resetAllMocks();
		fixture = sectionCatalogFixture();
		provider.request.mockResolvedValue(undefined);
		provider.getIdentity.mockResolvedValue({ machineIdentifier: "machine-1" });
		provider.getLibrarySettlementSections.mockResolvedValue([fixture.section]);
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", fixture.prisma as never);
		app.decorate("encryptor", {} as never);
		await app.register(registerScanRoutes, { prefix: "/api/plex" });
	});
	afterEach(async () => {
		await app.close();
	});
	const post = (body: unknown = { sectionUuid: "section-uuid" }) =>
		createInjectAuthenticated(app)("POST", endpoint, { body });

	it("rejects a missing section UUID before any upstream operation", async () => {
		const response = await post({});
		expect(response.statusCode).toBe(400);
		expect(provider.request).not.toHaveBeenCalled();
		expect(provider.getIdentity).not.toHaveBeenCalled();
	});
	it("does not report success when the numeric key was reused by a different section", async () => {
		provider.getLibrarySettlementSections.mockResolvedValue([
			{ ...fixture.section, uuid: "replacement-uuid" },
		]);
		const response = await post();
		expect(response.statusCode).toBe(409);
		expect(provider.request).not.toHaveBeenCalled();
	});
	it("does not scan a server with a different live identity", async () => {
		provider.getIdentity.mockResolvedValue({ machineIdentifier: "replacement-machine" });
		const response = await post();
		expect(response.statusCode).toBe(409);
		expect(provider.request).not.toHaveBeenCalled();
	});
	it("does not trust a UUID different from the reloaded owned catalog", async () => {
		const response = await post({ sectionUuid: "not-selected" });
		expect(response.statusCode).toBe(409);
		expect(provider.request).not.toHaveBeenCalled();
	});
	it("rejects ambiguous live section keys", async () => {
		provider.getLibrarySettlementSections.mockResolvedValue([
			fixture.section,
			{ ...fixture.section, uuid: "another" },
		]);
		const response = await post();
		expect(response.statusCode).toBe(409);
		expect(provider.request).not.toHaveBeenCalled();
	});
	it("rechecks the stored connection after provider reads", async () => {
		provider.getLibrarySettlementSections.mockImplementation(async () => {
			fixture.instance.connectionGeneration++;
			return [fixture.section];
		});
		const response = await post();
		expect(response.statusCode).toBe(409);
		expect(provider.request).not.toHaveBeenCalled();
	});
	it("does not scan an instance owned by someone else", async () => {
		fixture.instance.userId = "other-user";
		const response = await post();
		expect(response.statusCode).toBe(404);
		expect(provider.request).not.toHaveBeenCalled();
	});
	it("returns unavailable on a failed current-catalog read without writing upstream", async () => {
		provider.getLibrarySettlementSections.mockRejectedValue(new Error("synthetic provider outage"));
		const response = await post();
		expect(response.statusCode).toBe(503);
		expect(provider.request).not.toHaveBeenCalled();
	});
	it("acknowledges exactly one selected scan only after current identity, catalog and stored connection checks", async () => {
		const response = await post();
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: true });
		expect(provider.getLibrarySettlementSections).toHaveBeenCalledWith(
			expect.objectContaining({ uncached: true }),
		);
		expect(provider.getIdentity).toHaveBeenCalledTimes(2);
		expect(provider.request).toHaveBeenCalledExactlyOnceWith("/library/sections/1/refresh", {
			method: "POST",
		});
	});
	it("does not automatically retry a failed write or claim success; a new explicit request revalidates", async () => {
		provider.request.mockRejectedValueOnce(new Error("synthetic write failure"));
		const first = await post();
		expect(first.statusCode).toBe(502);
		expect(first.json()).not.toHaveProperty("success", true);
		expect(provider.request).toHaveBeenCalledTimes(1);
		const second = await post();
		expect(second.statusCode).toBe(200);
		expect(provider.getIdentity).toHaveBeenCalledTimes(4);
		expect(provider.request).toHaveBeenCalledTimes(2);
	});

	it.each(["", " ", "invalid\0uuid", 12, null])(
		"rejects malformed section UUID %j before provider I/O",
		async (sectionUuid) => {
			const response = await post({ sectionUuid });
			expect(response.statusCode).toBe(400);
			expect(provider.request).not.toHaveBeenCalled();
			expect(provider.getIdentity).not.toHaveBeenCalled();
		},
	);
	it("rejects a live type change for the selected section", async () => {
		provider.getLibrarySettlementSections.mockResolvedValue([{ ...fixture.section, type: "show" }]);
		const response = await post();
		expect(response.statusCode).toBe(409);
		expect(provider.request).not.toHaveBeenCalled();
	});
	it("rejects an identity change observed after the catalog probe", async () => {
		provider.getIdentity
			.mockResolvedValueOnce({ machineIdentifier: "machine-1" })
			.mockResolvedValueOnce({ machineIdentifier: "replacement" });
		const response = await post();
		expect(response.statusCode).toBe(409);
		expect(provider.request).not.toHaveBeenCalled();
	});
	it("rejects a disabled instance without provider I/O", async () => {
		fixture.instance.enabled = false;
		const response = await post();
		expect(response.statusCode).toBe(404);
		expect(provider.request).not.toHaveBeenCalled();
		expect(provider.getIdentity).not.toHaveBeenCalled();
	});
	it("does not scan when current cached identity is unverified", async () => {
		fixture.instance.identityStatus = "UNVERIFIED";
		const response = await post();
		expect(response.statusCode).toBe(503);
		expect(provider.request).not.toHaveBeenCalled();
		expect(provider.getIdentity).not.toHaveBeenCalled();
	});
	it("revalidates each concurrent explicit scan request and never replays an individual POST", async () => {
		const responses = await Promise.all([post(), post()]);
		expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
		expect(provider.getIdentity).toHaveBeenCalledTimes(4);
		expect(provider.request).toHaveBeenCalledTimes(2);
	});
});
