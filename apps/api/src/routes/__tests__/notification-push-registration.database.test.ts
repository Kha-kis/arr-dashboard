import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../lib/__tests__/test-prisma.js";
import { Encryptor } from "../../lib/auth/encryption.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { registerNotificationRoutes } from "../notifications.js";
import { setupAuthInjection } from "./test-helpers.js";

const encryptor = new Encryptor(Buffer.alloc(32, 61).toString("base64"));
const proofTime = new Date("2026-01-01T00:00:00Z");
const privateMarker = "synthetic-private-push-credential";
const initialConfig = {
	endpoint: `https://synthetic.invalid/${privateMarker}`,
	p256dh: `${privateMarker}-original-p256dh`,
	auth: `${privateMarker}-original-auth`,
};
const incoming = {
	endpoint: initialConfig.endpoint,
	keys: { p256dh: `${privateMarker}-new-p256dh`, auth: `${privateMarker}-new-auth` },
};
const equivalent = {
	endpoint: initialConfig.endpoint,
	keys: { p256dh: initialConfig.p256dh, auth: initialConfig.auth },
};
let directory: string;
let database: string;
let prisma: PrismaClient;
let app: FastifyInstance;
let logs: string[];
const children: ChildProcess[] = [];

beforeAll(async () => {
	directory = mkdtempSync(join(process.env.PUSH_FIXTURE_ROOT ?? tmpdir(), "push-registration-"));
	database = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		env: { ...process.env, DATABASE_URL: `file:${database}` },
		stdio: "pipe",
	});
	prisma = createTestPrismaClient(database);
	await prisma.user.createMany({
		data: [
			{ id: "owner", username: "synthetic-owner" },
			{ id: "other-owner", username: "synthetic-other-owner" },
		],
	});
}, 30_000);

beforeEach(async () => {
	for (const trigger of ["reject_push_update", "reject_push_insert", "reject_push_lock"])
		await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`);
	await prisma.notificationLog.deleteMany({});
	await prisma.notificationChannel.deleteMany({});
	logs = [];
});

afterEach(async () => {
	for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
	await app?.close();
});

afterAll(async () => {
	await prisma?.$disconnect();
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function mount(client = prisma, owner = "owner", credentialDecoder = encryptor) {
	const logger: FastifyBaseLogger = pino(
		{ level: "debug", base: null, timestamp: false },
		{ write: (line: string) => logs.push(line) },
	);
	app = Fastify({ loggerInstance: logger });
	app.decorate("prisma", client);
	app.decorate("encryptor", credentialDecoder);
	setupAuthInjection(app, { id: owner, username: "synthetic-owner" });
	// Keep SQL/Prisma failures observable without logging their private exception text.
	app.setErrorHandler((error, _request, reply) =>
		reply
			.status(error instanceof Error && error.name === "ZodValidationError" ? 400 : 500)
			.send({ error: "Fixture error" }),
	);
	await app.register(registerNotificationRoutes);
	await app.ready();
}

function register(payload: unknown = incoming) {
	return app.inject({
		method: "POST",
		url: "/push-subscription",
		headers: { "x-test-auth": "1" },
		payload: payload as Record<string, unknown>,
	});
}

async function seed(id = "owned", config = initialConfig, owner = "owner") {
	const encrypted = encryptor.encrypt(JSON.stringify(config));
	return prisma.notificationChannel.create({
		data: {
			id,
			userId: owner,
			name: "Synthetic saved name",
			enabled: false,
			type: "BROWSER_PUSH",
			encryptedConfig: encrypted.value,
			configIv: encrypted.iv,
			lastTestedAt: proofTime,
			lastTestResult: "success",
			lastSentAt: proofTime,
			lastSendResult: "success",
		},
	});
}

const read = (id = "owned") => prisma.notificationChannel.findUniqueOrThrow({ where: { id } });
function decode(row: { encryptedConfig: string; configIv: string }) {
	return JSON.parse(encryptor.decrypt({ value: row.encryptedConfig, iv: row.configIv }));
}

async function seedHistory() {
	await prisma.notificationSubscription.create({
		data: { channelId: "owned", eventType: "HUNT_COMPLETED" },
	});
	await prisma.notificationLog.create({
		data: {
			channelId: "owned",
			channelType: "BROWSER_PUSH",
			eventType: "HUNT_COMPLETED",
			title: "Synthetic event",
			body: "Synthetic body",
			status: "sent",
		},
	});
}

// Instrument both the top-level delegate and the actual transaction delegate.
// Mutation is injected after the real selection, even when selection moves into a transaction.
function interceptSelection(action: (client: PrismaClient) => Promise<void>) {
	let injected = 0;
	function wrap(client: PrismaClient): PrismaClient {
		const channels = new Proxy(client.notificationChannel, {
			get(target, property) {
				if (property === "findMany")
					return async (args: any) => {
						const rows = await target.findMany(args);
						if (
							args?.where?.userId === "owner" &&
							args?.where?.type === "BROWSER_PUSH" &&
							!injected
						) {
							injected++;
							await action(client);
						}
						return rows;
					};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return new Proxy(client, {
			get(target, property) {
				if (property === "notificationChannel") return channels;
				if (property === "$transaction")
					return (callback: any, options: any) =>
						target.$transaction((tx: any) => callback(wrap(tx)), options);
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
	return { client: wrap(prisma), injections: () => injected };
}

async function seedDevices(count: number) {
	for (let i = 0; i < count; i++)
		await seed(`device-${i}`, {
			...initialConfig,
			endpoint: `https://synthetic.invalid/device-${i}`,
		});
}

// Each worker has its own process and Prisma connection. GREEN synchronizes admission
// before beginning transactions; RED synchronizes after both original real selections.
// No barrier waits while holding the GREEN database lock.
async function concurrentRegistrations(second = incoming) {
	const require = createRequire(import.meta.url);
	const worker = `
import Fastify from 'fastify';
import { createTestPrismaClient } from ${JSON.stringify(new URL("../../lib/__tests__/test-prisma.ts", import.meta.url).pathname)};
import { Encryptor } from ${JSON.stringify(new URL("../../lib/auth/encryption.ts", import.meta.url).pathname)};
import { registerNotificationRoutes } from ${JSON.stringify(new URL("../notifications.ts", import.meta.url).pathname)};
const prisma = createTestPrismaClient(process.env.PUSH_DATABASE);
const encryptor = new Encryptor(Buffer.alloc(32,61).toString('base64'));
let release;
const barrier = new Promise(resolve => {release=resolve;});
process.on('message', message => {if(message==='release') release();});
let reached=0;
async function gate(){reached++;process.send({stage:'admitted'});await barrier;}
const channels = new Proxy(prisma.notificationChannel,{get(target,key){
if(key==='findMany') return async args => {const rows=await target.findMany(args);if(process.env.PUSH_NEGATIVE_CONTROL==='1') await gate();return rows;};
const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}});
const client = new Proxy(prisma,{get(target,key){
if(key==='notificationChannel')return channels;
if(key==='$transaction') return async (callback,options)=>{await gate();return target.$transaction(callback,options);};
const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}});
const app=Fastify();app.decorate('prisma',client);app.decorate('encryptor',encryptor);
app.decorateRequest('currentUser',null);app.addHook('preHandler',async request=>{request.currentUser={id:'owner',username:'synthetic-owner'};});
app.setErrorHandler((_error,_request,reply)=>reply.status(500).send({error:'Fixture error'}));
await app.register(registerNotificationRoutes);await app.ready();
const response=await app.inject({method:'POST',url:'/push-subscription',payload:JSON.parse(process.env.PUSH_PAYLOAD)});
process.send({stage:'result',status:response.statusCode,body:response.json(),reached});
await app.close();await prisma.$disconnect();process.disconnect();
`;
	let arrivals = 0;
	const pending = [incoming, second].map(
		(payload) =>
			new Promise<{ status: number; body: any; reached: number }>((resolve, reject) => {
				const child = spawn(
					process.execPath,
					["--import", require.resolve("tsx"), "--input-type=module", "--eval", worker],
					{
						cwd: process.cwd(),
						env: { ...process.env, PUSH_DATABASE: database, PUSH_PAYLOAD: JSON.stringify(payload) },
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				);
				children.push(child);
				let stderr = "";
				let settled = false;
				child.stderr?.on("data", (chunk) => {
					stderr += chunk;
				});
				child.on("error", reject);
				child.on("exit", (code) => {
					if (!settled) reject(new Error(`Worker exited ${code}: ${stderr}`));
				});
				child.on("message", (message: any) => {
					if (message.stage === "admitted") {
						arrivals++;
						if (arrivals === 2) for (const sibling of children) sibling.send("release");
					}
					if (message.stage === "result") {
						settled = true;
						resolve(message);
					}
				});
			}),
	);
	const responses = await Promise.all(pending);
	expect(arrivals).toBe(2);
	expect(responses.map((response) => response.reached)).toEqual([1, 1]);
	return responses;
}

describe("real Browser Push registration database boundary", () => {
	it("creates an encrypted owned channel without claiming a Test", async () => {
		await mount();
		const response = await register();
		expect(response.statusCode).toBe(201);
		expect(response.json()).toEqual({ id: expect.any(String), updated: false });
		const rows = await prisma.notificationChannel.findMany({ where: { userId: "owner" } });
		expect(rows).toHaveLength(1);
		expect(decode(rows[0]!)).toEqual({ endpoint: incoming.endpoint, ...incoming.keys });
		expect(rows[0]!.encryptedConfig).not.toContain(privateMarker);
		expect(rows[0]!.lastTestedAt).toBeNull();
		expect(rows[0]!.lastTestResult).toBeNull();
	});

	it("preserves ciphertext, IV, proof and User metadata for identical keys", async () => {
		const initial = await seed();
		const owner = await prisma.user.findUniqueOrThrow({ where: { id: "owner" } });
		await mount();
		const response = await register(equivalent);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ id: "owned", updated: true });
		const row = await read();
		expect(row.encryptedConfig).toBe(initial.encryptedConfig);
		expect(row.configIv).toBe(initial.configIv);
		expect(row.lastTestedAt).toEqual(proofTime);
		expect(row.lastTestResult).toBe("success");
		expect(await prisma.user.findUniqueOrThrow({ where: { id: "owner" } })).toEqual(owner);
	});

	it("invalidates old Test proof on rotation while preserving saved settings and history", async () => {
		const initial = await seed();
		await seedHistory();
		await mount();
		expect((await register()).statusCode).toBe(200);
		const row = await read();
		expect(decode(row)).toEqual({ endpoint: incoming.endpoint, ...incoming.keys });
		expect(row.lastTestedAt).toBeNull();
		expect(row.lastTestResult).toBeNull();
		expect(row.name).toBe(initial.name);
		expect(row.enabled).toBe(false);
		expect(row.lastSentAt).toEqual(proofTime);
		expect(row.lastSendResult).toBe("success");
		expect(await prisma.notificationSubscription.count({ where: { channelId: "owned" } })).toBe(1);
		expect(await prisma.notificationLog.count({ where: { channelId: "owned" } })).toBe(1);
	});

	it("does not update a foreign matching endpoint", async () => {
		const initial = await seed("foreign", initialConfig, "other-owner");
		await mount();
		expect((await register()).statusCode).toBe(201);
		expect(await read("foreign")).toEqual(initial);
		expect(await prisma.notificationChannel.count({ where: { userId: "owner" } })).toBe(1);
	});

	it("rolls back a real failed update, never creates a fallback row, and allows explicit retry", async () => {
		const initial = await seed();
		await prisma.$executeRawUnsafe(
			`CREATE TRIGGER reject_push_update BEFORE UPDATE ON notification_channels BEGIN SELECT RAISE(ABORT, '${privateMarker}'); END`,
		);
		await mount();
		expect((await register()).statusCode).toBe(500);
		expect(await read()).toEqual(initial);
		expect(await prisma.notificationChannel.count({ where: { userId: "owner" } })).toBe(1);
		expect(logs.join("\n")).not.toContain(privateMarker);
		await prisma.$executeRawUnsafe("DROP TRIGGER reject_push_update");
		expect((await register()).statusCode).toBe(200);
		expect(decode(await read())).toEqual({ endpoint: incoming.endpoint, ...incoming.keys });
	});

	it("rolls back a real failed insert and allows explicit retry", async () => {
		await prisma.$executeRawUnsafe(
			`CREATE TRIGGER reject_push_insert BEFORE INSERT ON notification_channels BEGIN SELECT RAISE(ABORT, '${privateMarker}'); END`,
		);
		await mount();
		const response = await register();
		expect(response.statusCode).toBe(500);
		expect(JSON.stringify(response.json()) + logs.join("\n")).not.toContain(privateMarker);
		expect(await prisma.notificationChannel.count({ where: { userId: "owner" } })).toBe(0);
		await prisma.$executeRawUnsafe("DROP TRIGGER reject_push_insert");
		expect((await register()).statusCode).toBe(201);
	});

	for (const change of ["owner", "endpoint", "type"] as const) {
		it(`rejects a stale selected ${change} without overwriting the winner`, async () => {
			await seed();
			let winner: Awaited<ReturnType<typeof read>>;
			const boundary = interceptSelection(async (client) => {
				const encrypted = encryptor.encrypt(
					JSON.stringify({ ...initialConfig, endpoint: "https://synthetic.invalid/winner" }),
				);
				winner = await client.notificationChannel.update({
					where: { id: "owned" },
					data:
						change === "owner"
							? { userId: "other-owner" }
							: change === "type"
								? { type: "WEBHOOK" }
								: { encryptedConfig: encrypted.value, configIv: encrypted.iv },
				});
			});
			await mount(boundary.client);
			const response = await register();
			expect(boundary.injections()).toBe(1);
			expect([404, 409]).toContain(response.statusCode);
			expect(await read()).toEqual(winner!);
			expect(await prisma.notificationChannel.count()).toBe(1);
		});
	}

	it("fences the identical-key no-op against a selected generation change", async () => {
		await seed();
		let winner: Awaited<ReturnType<typeof read>>;
		const boundary = interceptSelection(async (client) => {
			const encrypted = encryptor.encrypt(
				JSON.stringify({ ...initialConfig, auth: "synthetic-winner-auth" }),
			);
			winner = await client.notificationChannel.update({
				where: { id: "owned" },
				data: { encryptedConfig: encrypted.value, configIv: encrypted.iv },
			});
		});
		await mount(boundary.client);
		expect((await register(equivalent)).statusCode).toBe(409);
		expect(boundary.injections()).toBe(1);
		expect(await read()).toEqual(winner!);
	});

	it("serializes duplicate admission across independent processes", async () => {
		const responses = await concurrentRegistrations();
		expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
		expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
		expect(
			await prisma.notificationChannel.count({ where: { userId: "owner", type: "BROWSER_PUSH" } }),
		).toBe(1);
	}, 30_000);

	it("serializes the final cap slot across independent processes", async () => {
		await seedDevices(9);
		const responses = await concurrentRegistrations({
			...incoming,
			endpoint: "https://synthetic.invalid/other-device",
		});
		expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);
		expect(
			await prisma.notificationChannel.count({ where: { userId: "owner", type: "BROWSER_PUSH" } }),
		).toBe(10);
	}, 30_000);

	it("rejects an eleventh device but permits an existing device at the cap", async () => {
		await seedDevices(10);
		await mount();
		expect((await register()).statusCode).toBe(400);
		expect(
			(await register({ ...incoming, endpoint: "https://synthetic.invalid/device-0" })).statusCode,
		).toBe(200);
		expect(await prisma.notificationChannel.count({ where: { userId: "owner" } })).toBe(10);
	});

	for (const corrupted of ["cipher", "json", "shape"] as const) {
		it(`skips unreadable ${corrupted} without matching, repairing, or exposing its credentials`, async () => {
			const initial = await seed();
			const encrypted = encryptor.encrypt(
				corrupted === "json"
					? privateMarker
					: JSON.stringify({ endpoint: incoming.endpoint, p256dh: "", auth: privateMarker }),
			);
			const unreadable = await prisma.notificationChannel.update({
				where: { id: "owned" },
				data:
					corrupted === "cipher"
						? { encryptedConfig: privateMarker }
						: { encryptedConfig: encrypted.value, configIv: encrypted.iv },
			});
			await mount();
			expect((await register()).statusCode).toBe(201);
			expect(await read()).toEqual(unreadable);
			expect(await prisma.notificationChannel.count()).toBe(2);
			expect(logs.join("\n")).not.toContain(privateMarker);
			expect(logs.join("\n")).not.toContain(initial.configIv);
			expect(logs.some((line) => line.includes('"failureCategory":"configuration"'))).toBe(true);
		});
	}

	it("does not leak a decoder exception that contains synthetic credentials", async () => {
		await seed();
		const decoder = new Proxy(encryptor, {
			get(target, key) {
				if (key === "decrypt")
					return () => {
						throw new Error(privateMarker);
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await mount(prisma, "owner", decoder);
		expect((await register()).statusCode).toBe(201);
		expect(logs.join("\n")).not.toContain(privateMarker);
	});

	it("rejects invalid request keys before persistence", async () => {
		await mount();
		expect((await register({ ...incoming, keys: { p256dh: "", auth: "" } })).statusCode).toBe(400);
		expect(await prisma.notificationChannel.count()).toBe(0);
	});

	it("fails closed if the owned User lock row does not exist", async () => {
		await mount(prisma, "missing-owner");
		expect((await register()).statusCode).toBe(409);
		expect(await prisma.notificationChannel.count()).toBe(0);
	});

	it("does not continue registration when acquiring the real database lock fails", async () => {
		await prisma.$executeRawUnsafe(
			`CREATE TRIGGER reject_push_lock BEFORE UPDATE ON "User" BEGIN SELECT RAISE(ABORT, '${privateMarker}'); END`,
		);
		await mount();
		expect((await register()).statusCode).toBe(500);
		expect(await prisma.notificationChannel.count()).toBe(0);
		expect(logs.join("\n")).not.toContain(privateMarker);
	});
});
