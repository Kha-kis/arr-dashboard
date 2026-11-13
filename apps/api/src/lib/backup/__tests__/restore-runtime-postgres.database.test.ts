import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquirePostgresRestoreRuntimeOwnership,
	type PostgresRestoreRuntimeOwnership,
	RESTORE_POSTGRES_LOCK_NAMESPACE,
	RESTORE_POSTGRES_OPERATION_LOCK,
	RestoreRuntimeOwnershipError,
} from "../restore-runtime-postgres.js";

const connectionString = process.env.TEST_DATABASE_URL;
const owners: Readonly<PostgresRestoreRuntimeOwnership>[] = [];
const clients: Client[] = [];
const actors: ChildProcess[] = [];
let sequence = 0;

async function own(onUnavailable?: () => void) {
	const owner = await acquirePostgresRestoreRuntimeOwnership(connectionString ?? "", onUnavailable);
	owners.push(owner);
	return owner;
}

async function client() {
	const result = new Client({ connectionString, connectionTimeoutMillis: 5000 });
	result.on("error", () => {});
	clients.push(result);
	try {
		await result.connect();
	} catch {
		throw new Error("Synthetic PostgreSQL fixture connection unavailable");
	}
	return result;
}

async function share(connection: Client) {
	return (
		await connection.query("SELECT pg_try_advisory_lock_shared($1, $2) AS acquired", [
			RESTORE_POSTGRES_LOCK_NAMESPACE,
			RESTORE_POSTGRES_OPERATION_LOCK,
		])
	).rows[0].acquired as boolean;
}

async function unshare(connection: Client) {
	return (
		await connection.query("SELECT pg_advisory_unlock_shared($1, $2) AS released", [
			RESTORE_POSTGRES_LOCK_NAMESPACE,
			RESTORE_POSTGRES_OPERATION_LOCK,
		])
	).rows[0].released as boolean;
}

async function terminate(connection: Client, pid: number) {
	expect(
		(await connection.query("SELECT pg_terminate_backend($1) AS terminated", [pid])).rows[0],
	).toEqual({ terminated: true });
}

async function command(actor: ChildProcess, commandName: string) {
	const id = ++sequence;
	return await new Promise<{ category: string; pid?: number }>((resolve, reject) => {
		const timer = setTimeout(() => {
			actor.off("message", listen);
			reject(new Error("Synthetic actor command did not settle"));
		}, 5000);
		function listen(value: unknown) {
			const message = value as { id?: number; category: string; pid?: number };
			if (message.id !== id) return;
			clearTimeout(timer);
			actor.off("message", listen);
			resolve(message);
		}
		actor.on("message", listen);
		actor.send({ id, command: commandName }, (error) => {
			if (!error) return;
			clearTimeout(timer);
			actor.off("message", listen);
			reject(new Error("Synthetic actor IPC unavailable"));
		});
	});
}

async function actor() {
	const env = Object.fromEntries(
		["PATH", "LANG", "LC_ALL", "TZ"]
			.filter((key) => process.env[key] !== undefined)
			.map((key) => [key, process.env[key]]),
	);
	const child = fork(
		fileURLToPath(new URL("./fixtures/restore-runtime-postgres-owner.ts", import.meta.url)),
		[],
		{
			env: { ...env, TEST_DATABASE_URL: connectionString },
			execArgv: ["--import", import.meta.resolve("tsx/esm")],
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		},
	);
	actors.push(child);
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
	try {
		const [ready] = await once(child, "message");
		expect(ready).toEqual({ category: "ready" });
	} finally {
		clearTimeout(timer);
	}
	return child;
}

afterEach(async () => {
	for (const child of actors.splice(0)) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		child.kill("SIGCONT");
		const ended = once(child, "exit");
		child.kill("SIGKILL");
		await ended;
	}
	await Promise.all(owners.splice(0).map((owner) => owner.close()));
	await Promise.all(clients.splice(0).map((connection) => connection.end()));
});

describe("explicit PostgreSQL runtime ownership input", () => {
	it.each([
		"",
		" ",
		"file:./synthetic.db",
		"https://example.invalid/not-a-database",
		"postgresql://%",
		"postgresql://user:%@localhost/fixture",
	])("refuses invalid explicit input without credential-bearing cause (%#)", async (input) => {
		await expect(acquirePostgresRestoreRuntimeOwnership(input)).rejects.toMatchObject({
			name: "RestoreRuntimeOwnershipError",
			statusCode: 503,
		});
		try {
			await acquirePostgresRestoreRuntimeOwnership(input);
		} catch (error) {
			expect(error).toBeInstanceOf(RestoreRuntimeOwnershipError);
			expect(Object.hasOwn(error as object, "cause")).toBe(false);
			expect(JSON.stringify(error)).not.toContain(input.trim() || "credential");
		}
	});
});

describe.skipIf(!connectionString?.startsWith("postgres"))(
	"native PostgreSQL runtime ownership",
	() => {
		it("holds one database owner and exposes only a frozen live-session handle", async () => {
			const owner = await own();
			expect(Number.isInteger(owner.ownerBackendPid) && owner.ownerBackendPid > 0).toBe(true);
			expect(Object.isFrozen(owner)).toBe(true);
			await expect(owner.assertOwned()).resolves.toBeUndefined();
			await expect(own()).rejects.toBeInstanceOf(RestoreRuntimeOwnershipError);
			await expect(owner.assertOwned()).resolves.toBeUndefined();
		});

		it("keeps ordinary database writes usable while retaining coordination ownership", async () => {
			await own();
			const db = await client();
			await db.query("CREATE TEMP TABLE ordinary_runtime_test(value integer NOT NULL)");
			await db.query("INSERT INTO ordinary_runtime_test VALUES (7)");
			expect((await db.query("SELECT value FROM ordinary_runtime_test")).rows).toEqual([
				{ value: 7 },
			]);
		});

		it("refuses exclusive admission until every independent shared participant releases", async () => {
			const owner = await own();
			const first = await client(),
				second = await client();
			expect(await share(first)).toBe(true);
			expect(await share(second)).toBe(true);
			expect(await owner.tryAcquireExclusive()).toBe(false);
			expect(await unshare(first)).toBe(true);
			expect(await owner.tryAcquireExclusive()).toBe(false);
			expect(await unshare(second)).toBe(true);
			expect(await owner.tryAcquireExclusive()).toBe(true);
		});

		it("blocks a late shared participant throughout retained exclusive admission", async () => {
			const owner = await own();
			const late = await client();
			expect(await owner.tryAcquireExclusive()).toBe(true);
			expect(await share(late)).toBe(false);
			await owner.releaseExclusive();
			expect(await share(late)).toBe(true);
		});

		it("does not leak recursive lock counts across repeated exclusive admission", async () => {
			const owner = await own();
			expect(await owner.tryAcquireExclusive()).toBe(true);
			expect(await owner.tryAcquireExclusive()).toBe(true);
			await owner.releaseExclusive();
			expect(await share(await client())).toBe(true);
		});

		it("serializes concurrent exclusive requests without accumulating provider lock counts", async () => {
			const owner = await own();
			expect(
				await Promise.all([
					owner.tryAcquireExclusive(),
					owner.tryAcquireExclusive(),
					owner.tryAcquireExclusive(),
				]),
			).toEqual([true, true, true]);
			await owner.releaseExclusive();
			expect(await share(await client())).toBe(true);
		});

		it("allows repeated healthy release and a fresh exclusive cycle", async () => {
			const owner = await own();
			await owner.releaseExclusive();
			expect(await owner.tryAcquireExclusive()).toBe(true);
			await owner.releaseExclusive();
			await owner.releaseExclusive();
			expect(await owner.tryAcquireExclusive()).toBe(true);
		});

		it("closes retained owner and exclusive locks exactly once before a fresh explicit owner", async () => {
			const owner = await own();
			expect(await owner.tryAcquireExclusive()).toBe(true);
			await Promise.all([owner.close(), owner.close(), owner.close()]);
			await expect(owner.assertOwned()).rejects.toBeInstanceOf(RestoreRuntimeOwnershipError);
			await expect(owner.tryAcquireExclusive()).rejects.toBeInstanceOf(
				RestoreRuntimeOwnershipError,
			);
			await expect(owner.releaseExclusive()).rejects.toBeInstanceOf(RestoreRuntimeOwnershipError);
			const fresh = await own();
			expect(await fresh.tryAcquireExclusive()).toBe(true);
			expect(await share(await client())).toBe(false);
		});

		it("latches close before queued work and never treats it as ordinary busy", async () => {
			const owner = await own();
			const queued = owner.tryAcquireExclusive();
			const rejection = expect(queued).rejects.toBeInstanceOf(RestoreRuntimeOwnershipError);
			await owner.close();
			await rejection;
			await expect((await own()).assertOwned()).resolves.toBeUndefined();
		});

		it("session loss permanently rejects the old handle and reports loss only once", async () => {
			let loss = 0;
			const owner = await own(() => {
				loss += 1;
			});
			await terminate(await client(), owner.ownerBackendPid);
			await expect(owner.assertOwned()).rejects.toBeInstanceOf(RestoreRuntimeOwnershipError);
			await expect(owner.tryAcquireExclusive()).rejects.toBeInstanceOf(
				RestoreRuntimeOwnershipError,
			);
			await expect(owner.releaseExclusive()).rejects.toBeInstanceOf(RestoreRuntimeOwnershipError);
			expect(loss).toBe(1);
			await owner.close();
			const fresh = await own();
			expect(fresh.ownerBackendPid).not.toBe(owner.ownerBackendPid);
		});

		it("a throwing loss callback cannot reopen admission or leak its raw exception", async () => {
			let loss = 0;
			const owner = await own(() => {
				loss += 1;
				throw new Error("synthetic-private-callback-detail");
			});
			await terminate(await client(), owner.ownerBackendPid);
			await expect(owner.assertOwned()).rejects.toMatchObject({
				name: "RestoreRuntimeOwnershipError",
			});
			await expect(owner.assertOwned()).rejects.not.toThrow("synthetic-private-callback-detail");
			expect(loss).toBe(1);
			await owner.close();
		});

		it("intentional closure does not report ownership loss", async () => {
			let loss = 0;
			const owner = await own(() => {
				loss += 1;
			});
			await owner.close();
			await owner.close();
			expect(loss).toBe(0);
		});

		it("old participating connections still block a new owner's exclusive lock after coordinator loss", async () => {
			const owner = await own();
			const participant = await client();
			expect(await share(participant)).toBe(true);
			await terminate(await client(), owner.ownerBackendPid);
			await expect(owner.assertOwned()).rejects.toBeInstanceOf(RestoreRuntimeOwnershipError);
			await owner.close();
			const fresh = await own();
			expect(await fresh.tryAcquireExclusive()).toBe(false);
			expect(await unshare(participant)).toBe(true);
			expect(await fresh.tryAcquireExclusive()).toBe(true);
		});

		it.skipIf(process.platform === "win32")(
			"a physically suspended owner is not replaced by a timeout",
			async () => {
				const processOwner = await actor();
				expect((await command(processOwner, "acquire")).category).toBe("acquired");
				processOwner.kill("SIGSTOP");
				try {
					await expect(own()).rejects.toBeInstanceOf(RestoreRuntimeOwnershipError);
				} finally {
					processOwner.kill("SIGCONT");
				}
				expect((await command(processOwner, "close")).category).toBe("closed");
				await expect((await own()).assertOwned()).resolves.toBeUndefined();
			},
		);

		it.skipIf(process.platform === "win32")(
			"physical owner process death releases lifetime ownership for a fresh explicit session",
			async () => {
				const processOwner = await actor();
				expect((await command(processOwner, "acquire")).category).toBe("acquired");
				const ended = once(processOwner, "exit");
				processOwner.kill("SIGKILL");
				await ended;
				await expect((await own()).assertOwned()).resolves.toBeUndefined();
			},
		);
	},
);
