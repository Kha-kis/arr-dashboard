import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBackupMutationGuard } from "../../lib/backup/backup-mutation-gate.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { registerAutoTagRoutes } from "../auto-tag.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

type UserRow = { id: string; hashedWebhookSecret: string | null };
let app: FastifyInstance;
let users: Map<string, UserRow>;
let update: ReturnType<typeof vi.fn>;
let findUnique: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	users = new Map([
		["user-1", { id: "user-1", hashedWebhookSecret: null }],
		["other-user", { id: "other-user", hashedWebhookSecret: "other-hash" }],
	]);
	findUnique = vi.fn(async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null);
	update = vi.fn(
		async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
			const user = users.get(where.id);
			if (!user) throw new Error("Missing synthetic user");
			Object.assign(user, data);
			return user;
		},
	);
	app = Fastify();
	app.decorate("prisma", { user: { findUnique, update } } as never);
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	registerBackupMutationGuard(app);
	await app.register(registerAutoTagRoutes, { prefix: "/api/auto-tag" });
	await app.ready();
});

afterEach(async () => {
	await app.close();
});

const getConfig = () => createInjectAuthenticated(app)("GET", "/api/auto-tag/webhook-config");
const generate = () =>
	createInjectAuthenticated(app)("POST", "/api/auto-tag/webhook-config/regenerate");

describe("registered webhook credential routes", () => {
	it("keeps pure status reads available during maintenance while blocking explicit POST", async () => {
		await withCleanupMaintenanceGuard(async () => {
			const read = await getConfig();
			expect(read.statusCode).toBe(200);
			expect(read.json()).toEqual({ secret: null, configured: false, freshlyGenerated: false });
			expect((await generate()).statusCode).toBe(409);
			expect(update).not.toHaveBeenCalled();
		});
		expect((await generate()).statusCode).toBe(200);
		expect(update).toHaveBeenCalledTimes(1);
	});
	it.each([null, "existing-hash"])(
		"reads status without writing for stored hash %s",
		async (hash) => {
			users.get("user-1")!.hashedWebhookSecret = hash;
			const response = await getConfig();
			expect(response.statusCode).toBe(200);
			const body = response.json();
			// Boolean assertions keep an accidentally generated credential out of failure logs.
			expect(body.secret === null).toBe(true);
			expect(body.configured).toBe(hash !== null);
			expect(body.freshlyGenerated).toBe(false);
			expect(update).not.toHaveBeenCalled();
			expect(users.get("user-1")!.hashedWebhookSecret === hash).toBe(true);
		},
	);

	it("keeps repeated cold and concurrent reads unconfigured without updates", async () => {
		await getConfig();
		await getConfig();
		const responses = await Promise.all(Array.from({ length: 6 }, getConfig));
		for (const response of responses) {
			expect(response.statusCode).toBe(200);
			expect(response.json().secret === null).toBe(true);
			expect(response.json().configured).toBe(false);
			expect(response.json().freshlyGenerated).toBe(false);
		}
		expect(update).not.toHaveBeenCalled();
		expect(users.get("user-1")!.hashedWebhookSecret === null).toBe(true);
	});

	it("returns missing-user status rather than generating a credential", async () => {
		users.delete("user-1");
		const response = await getConfig();
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "User not found" });
		expect(update).not.toHaveBeenCalled();
	});

	it("does not write or report configured status when the user read fails", async () => {
		findUnique.mockRejectedValueOnce(new Error("Synthetic read failure"));
		const response = await getConfig();
		expect(response.statusCode).toBe(500);
		expect(response.json()).toEqual({ error: "Internal Server Error" });
		expect(update).not.toHaveBeenCalled();
	});

	it("ignores a client-supplied owner on reads", async () => {
		const response = await createInjectAuthenticated(app)(
			"GET",
			"/api/auto-tag/webhook-config?userId=other-user",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json().configured).toBe(false);
		expect(findUnique).toHaveBeenCalledWith({ where: { id: "user-1" } });
		expect(update).not.toHaveBeenCalled();
		expect(users.get("other-user")!.hashedWebhookSecret).toBe("other-hash");
	});

	it("explicitly generates once, persists only its hash, and hides it on later reads", async () => {
		const response = await createInjectAuthenticated(app)(
			"POST",
			"/api/auto-tag/webhook-config/regenerate?userId=other-user",
			{ body: { userId: "other-user" } },
		);
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(typeof body.secret === "string" && /^[\w-]{43}$/.test(body.secret)).toBe(true);
		expect(body.configured).toBe(true);
		expect(body.freshlyGenerated).toBe(true);
		const persisted = users.get("user-1")!.hashedWebhookSecret;
		expect(persisted === createHash("sha256").update(body.secret).digest("hex")).toBe(true);
		expect(persisted === body.secret).toBe(false);
		expect(update).toHaveBeenCalledTimes(1);
		expect(update.mock.calls[0]![0].where).toEqual({ id: "user-1" });
		expect(Object.keys(update.mock.calls[0]![0].data)).toEqual(["hashedWebhookSecret"]);
		expect(users.get("other-user")!.hashedWebhookSecret).toBe("other-hash");
		for (const read of await Promise.all([getConfig(), getConfig()])) {
			expect(read.json()).toEqual({ secret: null, configured: true, freshlyGenerated: false });
		}
		expect(update).toHaveBeenCalledTimes(1);
	});

	it("explicit POST replaces a hash created after an unconfigured status read", async () => {
		expect((await getConfig()).json().configured).toBe(false);
		users.get("user-1")!.hashedWebhookSecret = "concurrently-created-hash";
		const response = await generate();
		expect(response.statusCode).toBe(200);
		const secret = response.json().secret;
		expect(users.get("user-1")!.hashedWebhookSecret !== "concurrently-created-hash").toBe(true);
		expect(
			users.get("user-1")!.hashedWebhookSecret ===
				createHash("sha256").update(secret).digest("hex"),
		).toBe(true);
	});

	it("does not acknowledge generation when persistence fails", async () => {
		update.mockRejectedValueOnce(new Error("Synthetic persistence failure"));
		const response = await generate();
		expect(response.statusCode).toBe(500);
		expect(response.json()).toEqual({ error: "Internal Server Error" });
		expect(users.get("user-1")!.hashedWebhookSecret === null).toBe(true);
	});
});
