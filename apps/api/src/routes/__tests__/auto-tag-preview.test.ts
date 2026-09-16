import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), find: vi.fn(), update: vi.fn() }));
vi.mock("../../lib/auto-tag/execute-rule.js", () => ({ executeAutoTagRule: mocks.execute }));
import { registerAutoTagRoutes } from "../auto-tag.js";
let app: FastifyInstance;
beforeEach(async () => {
	vi.clearAllMocks();
	app = Fastify();
	app.decorate("prisma", { autoTagRule: { findFirst: mocks.find, update: mocks.update } } as never);
	app.decorate("arrClientFactory", {} as never);
	app.decorate("encryptor", {} as never);
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	await app.register(registerAutoTagRoutes);
	await app.ready();
});
afterEach(async () => {
	await app.close();
});
describe("read-only auto-tag preview route", () => {
	it("previews an owned rule without persisting a run", async () => {
		mocks.find.mockResolvedValue({
			id: "rule",
			userId: "user-1",
			name: "Preview",
			enabled: false,
			ruleType: "media_server_presence",
			parameters: JSON.stringify({ instanceId: "plex" }),
			operator: null,
			conditions: null,
			serviceFilter: null,
			instanceFilter: null,
			excludeTags: null,
			excludeTitles: null,
			plexLibraryFilter: null,
			tagName: "present",
			lastRunAt: null,
			lastRunStatus: null,
			lastRunMessage: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const preview = {
			itemsScanned: 3,
			itemsMatched: 1,
			itemsUnknown: 2,
			items: [],
			truncated: false,
		};
		mocks.execute.mockResolvedValue({ preview });
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/rules/rule/preview?userId=foreign",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(preview);
		expect(mocks.find).toHaveBeenCalledWith({ where: { id: "rule", userId: "user-1" } });
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				dryRun: true,
				rule: expect.objectContaining({ userId: "user-1", parameters: { instanceId: "plex" } }),
			}),
		);
		expect(mocks.update).not.toHaveBeenCalled();
	});
	it("hides a missing or unowned rule before evaluating it", async () => {
		mocks.find.mockResolvedValue(null);
		expect((await createInjectAuthenticated(app)("GET", "/rules/foreign/preview")).statusCode).toBe(
			404,
		);
		expect(mocks.execute).not.toHaveBeenCalled();
	});
});
