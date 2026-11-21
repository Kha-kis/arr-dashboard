import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../../lib/__tests__/scoped-write-intent-fixture.js";
import { withIsolatedRuntimePrismaReadClient } from "../../../lib/backup/restore-runtime-client.js";
import { createPlexClient } from "../../../lib/plex/plex-client.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { registerImageProxyRoutes } from "../image-proxy-routes.js";

const provider = vi.hoisted(() => ({ fetchImage: vi.fn() }));
vi.mock("../../../lib/plex/plex-client.js", async (original) => ({
	...(await original<typeof import("../../../lib/plex/plex-client.js")>()),
	createPlexClient: vi.fn(() => provider),
}));

const image = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const imageResponse = () => new Response(image, { headers: { "content-type": "image/jpeg" } });

beforeEach(() => {
	vi.clearAllMocks();
	provider.fetchImage.mockImplementation(async () => imageResponse());
	vi.stubGlobal("fetch", () => {
		throw new Error("Unexpected provider network request");
	});
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await closeScopedWriteFixtures();
});

async function setup() {
	const f = await createScopedWriteFixture({ writeIntent: true });
	await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
	const instanceData = {
		userId: "synthetic-user",
		service: "PLEX" as const,
		label: "Committed",
		baseUrl: "http://synthetic.invalid",
		encryptedApiKey: "synthetic-cipher",
		encryptionIv: "synthetic-iv",
	};
	await f.plain.serviceInstance.update({
		where: { id: "synthetic-plex" },
		data: { label: "Committed" },
	});
	await f.plain.serviceInstance.createMany({
		data: [
			{ ...instanceData, id: "foreign-instance", userId: "foreign-user" },
			{ ...instanceData, id: "disabled-instance", enabled: false },
		],
	});
	const app = Fastify({ logger: false });
	app.decorate("prisma", f.client.prisma);
	app.decorate("encryptor", {} as never);
	setupAuthInjection(app, { id: "synthetic-user", username: "synthetic-user" });
	registerTestErrorHandler(app);
	await app.register(registerImageProxyRoutes, { prefix: "/api/plex/thumb" });
	await app.ready();
	const inject = createInjectAuthenticated(app);
	const get = (id = "synthetic-plex") =>
		f.runtime.runOperation(() =>
			inject("GET", `/api/plex/thumb/${id}?path=/library/metadata/1/thumb/1`),
		);
	return { f, app, get };
}

async function holdOrdinaryTransaction(f: ScopedWriteFixture) {
	let entered!: () => void;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const rollback = new Error("synthetic-image-selection-rollback");
	const completion = f.runtime
		.runOperation(() =>
			f.client.prisma.$transaction(
				async (tx) => {
					await tx.serviceInstance.update({
						where: { id: "synthetic-plex" },
						data: { enabled: false, userId: "foreign-user", label: "Uncommitted" },
					});
					await tx.serviceInstance.update({
						where: { id: "foreign-instance" },
						data: { userId: "synthetic-user" },
					});
					await tx.serviceInstance.update({
						where: { id: "disabled-instance" },
						data: { enabled: true },
					});
					await tx.serviceInstance.update({
						where: { id: "synthetic-jellyfin" },
						data: { service: "PLEX" },
					});
					await tx.serviceInstance.create({
						data: {
							id: "uncommitted-instance",
							userId: "synthetic-user",
							service: "PLEX",
							label: "Uncommitted new",
							baseUrl: "http://synthetic.invalid",
							encryptedApiKey: "synthetic-cipher",
							encryptionIv: "synthetic-iv",
						},
					});
					entered();
					await held;
					throw rollback;
				},
				{ timeout: 15_000 },
			),
		)
		.then(
			() => null,
			(error: unknown) => error,
		);
	try {
		await Promise.race([
			ready,
			completion.then(() => {
				throw new Error("Ordinary transaction did not enter");
			}),
		]);
	} catch (error) {
		release();
		await completion;
		throw error;
	}
	return async () => {
		release();
		expect(await completion).toBe(rollback);
	};
}

describe("Plex thumbnail read acquisition", { timeout: 20_000 }, () => {
	it("returns a committed image before the ordinary writer is released", async () => {
		const { f, app, get } = await setup();
		const release = await holdOrdinaryTransaction(f);
		try {
			const response = await get();
			expect(response.statusCode).toBe(200);
			expect(response.rawPayload).toEqual(Buffer.from(image));
			expect(response.headers["content-type"]).toBe("image/jpeg");
			expect(response.headers["cache-control"]).toBe("public, max-age=86400, immutable");
			expect(createPlexClient).toHaveBeenCalledExactlyOnceWith(
				app.encryptor,
				expect.objectContaining({
					id: "synthetic-plex",
					userId: "synthetic-user",
					enabled: true,
					label: "Committed",
				}),
				app.log,
			);
			expect(provider.fetchImage).toHaveBeenCalledExactlyOnceWith("/library/metadata/1/thumb/1");
		} finally {
			try {
				await release();
			} finally {
				await app.close();
			}
		}
		expect(f.losses).toEqual([]);
	});

	it.each([
		["foreign-instance", 404, "InstanceNotFoundError"],
		["disabled-instance", 404, "InstanceNotFoundError"],
		["missing-instance", 404, "InstanceNotFoundError"],
		["synthetic-jellyfin", 400, "AppValidationError"],
		["uncommitted-instance", 404, "InstanceNotFoundError"],
	] as const)("denies %s from committed authority without transport", async (id, status, error) => {
		const { f, app, get } = await setup();
		const release = await holdOrdinaryTransaction(f);
		try {
			const response = await get(id);
			expect(response.statusCode).toBe(status);
			expect(response.json()).toMatchObject({ error });
			expect(createPlexClient).not.toHaveBeenCalled();
			expect(provider.fetchImage).not.toHaveBeenCalled();
		} finally {
			try {
				await release();
			} finally {
				await app.close();
			}
		}
		expect(f.losses).toEqual([]);
	});

	it("releases read lanes before four pending image callbacks and a fifth SELECT", async () => {
		const { f, app, get } = await setup();
		const release = await holdOrdinaryTransaction(f);
		let releaseImages!: () => void;
		const heldImages = new Promise<void>((resolve) => {
			releaseImages = resolve;
		});
		let entered!: () => void;
		const allImagesEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let callbacks = 0;
		provider.fetchImage.mockImplementation(async () => {
			if (++callbacks === 4) entered();
			await heldImages;
			return imageResponse();
		});
		const operations = Array.from({ length: 4 }, () => get());
		const images = Promise.all(operations);
		try {
			await Promise.race([
				allImagesEntered,
				images.then(() => {
					throw new Error("Image callbacks did not remain pending");
				}),
			]);
			expect(
				await f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
						reader.serviceInstance.findFirst({
							where: { id: "synthetic-plex", userId: "synthetic-user", enabled: true },
							select: { id: true, label: true },
						}),
					),
				),
			).toEqual({ id: "synthetic-plex", label: "Committed" });
			releaseImages();
			for (const response of await images) {
				expect(response.statusCode).toBe(200);
				expect(response.rawPayload).toEqual(Buffer.from(image));
			}
		} finally {
			releaseImages();
			await Promise.allSettled(operations);
			try {
				await release();
			} finally {
				await app.close();
			}
		}
		expect(f.losses).toEqual([]);
	});
});
