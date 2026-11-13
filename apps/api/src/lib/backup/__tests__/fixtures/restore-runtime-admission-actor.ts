import Database from "better-sqlite3";
import { enrollSqliteRestoreRuntimeStorage } from "../../restore-runtime-sqlite-enrollment.js";

if (process.argv[4] === "interrupt-after-journal") {
	// Instrument the real native statement only to choose the crash boundary.
	// No SQL, transaction, resource, or result is replaced by a mock.
	const prepare = Database.prototype.prepare;
	Object.defineProperty(Database.prototype, "prepare", {
		value: function (this: Database.Database, source: string) {
			const statement = Reflect.apply(prepare, this, [source]) as Database.Statement;
			if (/^INSERT INTO RestoreRuntimeControl\b/.test(source)) {
				statement.run = new Proxy(statement.run, {
					apply(target, self, args) {
						const result = Reflect.apply(target, self, args);
						process.kill(process.pid, "SIGKILL");
						return result;
					},
				});
			}
			return statement;
		},
	});
}

if (process.argv[4] === "api-entrypoint") {
	const { Server } = await import("node:net");
	Server.prototype.listen = new Proxy(Server.prototype.listen, {
		apply(target, receiver: InstanceType<typeof Server>, args) {
			receiver.once("listening", () => {
				const address = receiver.address();
				if (address && typeof address !== "string")
					process.send?.({ kind: "entrypoint-listening", port: address.port });
			});
			return Reflect.apply(target, receiver, args);
		},
	});
	// Observe only the real listener. Runtime, settings, Fastify, schedulers,
	// process signals and native client closure remain the actual entrypoint.
	await import("../../../../index.js");
} else if (process.argv[4]?.startsWith("postgres-close-")) {
	const { Client } = await import("pg");
	const { openRestoreRuntime } = await import("../../restore-runtime-admission.js");
	const { createRuntimePostgresAdapter } = await import("../../restore-runtime-postgres-client.js");
	let losses = 0;
	const runtime = await openRestoreRuntime({
		databaseUrl: process.argv[2]!,
		onUnavailable: () => {
			losses++;
		},
	});
	const originalEnd = Client.prototype.end;
	Client.prototype.end = function (
		this: InstanceType<typeof Client>,
		callback?: (error?: Error) => void,
	) {
		// Fault only the owned pool's native subclass, never the separate control actor.
		if (this.constructor === Client)
			return Reflect.apply(originalEnd, this, callback ? [callback] : []);
		const error = new Error("Synthetic native physical end failure");
		if (process.argv[4] === "postgres-close-throw") throw error;
		if (callback) {
			callback(error);
			return;
		}
		return Promise.reject(error);
	} as InstanceType<typeof Client>["end"];
	const adapter = createRuntimePostgresAdapter(runtime);
	const driver = await runtime.runStarting(() => adapter.connect());
	const pool = driver.underlyingDriver();
	await runtime.bindDestination("fixture-destination");
	await runtime.activate();
	const connection = await runtime.runOperation(() => pool.connect());
	connection.release();
	const nativeEnd = Reflect.get(connection, "end");
	if (typeof nativeEnd !== "function") throw new Error("Actual native physical end required");
	const promiseRejected =
		process.argv[4] === "postgres-close-promise"
			? await Promise.resolve(Reflect.apply(nativeEnd, connection, [])).then(
					() => false,
					() => true,
				)
			: false;
	let callbackCount = 0;
	let callbackFailed = false;
	let unhandled = 0;
	process.on("unhandledRejection", () => {
		unhandled++;
	});
	Reflect.apply(pool.end, pool, [
		(error?: Error) => {
			callbackCount++;
			callbackFailed = error instanceof Error;
		},
	]);
	async function rejectedWithin(pending: Promise<void>) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				pending.then(
					() => false,
					() => true,
				),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), 1000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	const closeRejected = await rejectedWithin(adapter.close());
	const runtimeCloseRejected = await rejectedWithin(runtime.close());
	await new Promise<void>((resolve) => setImmediate(resolve));
	const result = await Reflect.apply(Client.prototype.query, connection, ["SELECT 1 AS value"]);
	process.send?.({
		kind: "postgres-disposal-failure",
		closeRejected,
		runtimeCloseRejected,
		physicalStillOpen: result.rows.length === 1,
		losses,
		callbackCount,
		callbackFailed,
		unhandled,
		promiseRejected,
	});
	process.once("message", async () => {
		Client.prototype.end = originalEnd;
		await Reflect.apply(originalEnd, connection, []);
		process.exit(0);
	});
} else if (process.argv[4] === "client-close-failure") {
	const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
	const { openRestoreRuntime } = await import("../../restore-runtime-admission.js");
	const { createRuntimePrismaClient } = await import("../../restore-runtime-client.js");
	const connect = PrismaBetterSqlite3.prototype.connect;
	let actual!: Awaited<ReturnType<InstanceType<typeof PrismaBetterSqlite3>["connect"]>>;
	let dispose!: () => Promise<void>;
	PrismaBetterSqlite3.prototype.connect = async function () {
		actual = await connect.call(this);
		dispose = actual.dispose.bind(actual);
		actual.dispose = async () => {
			throw new Error("Synthetic physical close failure");
		};
		return actual;
	};
	let losses = 0;
	const runtime = await openRestoreRuntime({
		databaseUrl: process.argv[2]!,
		onUnavailable: () => {
			losses++;
		},
	});
	const native = createRuntimePrismaClient(runtime);
	await runtime.runStarting(() => native.prisma.$connect());
	await runtime.bindDestination("fixture-destination");
	await runtime.activate();
	await runtime.runOperation(() => native.prisma.user.count());
	const closeRejected = await native.close().then(
		() => false,
		() => true,
	);
	const runtimeCloseRejected = await runtime.close().then(
		() => false,
		() => true,
	);
	const result = await actual.queryRaw({ sql: "SELECT 1", args: [], argTypes: [] });
	process.send?.({
		kind: "disposal-failure",
		closeRejected,
		runtimeCloseRejected,
		physicalStillOpen: result.rows.length === 1,
		losses,
	});
	process.once("message", async () => {
		await dispose();
		process.exit(0);
	});
} else {
	const pending = enrollSqliteRestoreRuntimeStorage(process.argv[2]!, {
		runtimeEpoch: process.argv[3]!,
	});
	if (process.argv[4] === "interrupt") process.kill(process.pid, "SIGKILL");
	try {
		const result = await pending;
		process.send?.({ kind: "owned" });
		process.on("message", async () => {
			await result.ownership.close();
			process.send?.({ kind: "closed" });
			process.disconnect?.();
		});
	} catch {
		process.send?.({ kind: "unavailable" });
		process.disconnect?.();
	}
}
