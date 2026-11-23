import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteSchemaFixture } from "../../__tests__/sqlite-schema-fixture.js";
import { getRestoreRuntimeClientContext } from "../../backup/restore-runtime-admission.js";
import { createNotificationOutboxNativeFixture } from "./notification-outbox-native-fixture.js";

type NativeFixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
const natives: NativeFixture[] = [];
const templates: SqliteSchemaFixture[] = [];

// Record only completed real copies; schema initialization and native startup stay real.
class ObservedSqliteSchemaFixture extends SqliteSchemaFixture {
	readonly destinations: string[] = [];
	override copyTo(path: string): void {
		super.copyTo(path);
		this.destinations.push(path);
	}
}

async function create(options?: Readonly<{ sqliteSchema?: SqliteSchemaFixture }>) {
	const native = await createNotificationOutboxNativeFixture(options);
	natives.push(native);
	return native;
}

function template() {
	const schema = new ObservedSqliteSchemaFixture();
	templates.push(schema);
	return schema;
}

function inspect(native: NativeFixture) {
	const context = getRestoreRuntimeClientContext(native.runtime);
	const path = context.databaseUrl.slice("file:".length);
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		return {
			path,
			identity: statSync(path, { bigint: true }),
			journal: db.prepare("SELECT * FROM RestoreRuntimeControl").get(),
			binding: db.prepare("SELECT * FROM SqliteRestoreStorageBinding").get(),
		};
	} finally {
		db.close();
	}
}

beforeEach(() => {
	vi.stubEnv("NOTIFICATION_OUTBOX_TEST_ENGINE", "sqlite");
});

afterEach(async () => {
	// Never dispose the template before every actual native client/owner has closed.
	for (const native of natives.splice(0)) await native.close();
	for (const schema of templates.splice(0)) schema.dispose();
	vi.unstubAllEnvs();
});

describe("notification outbox native fixture schema opt-in", () => {
	it("copies the real empty Prisma schema and freshly enrolls independent native destinations", async () => {
		const schema = template();
		schema.initialize();
		const first = await create({ sqliteSchema: schema });
		const firstState = inspect(first);
		expect(schema.destinations).toEqual([firstState.path]);
		await first.run(async () => {
			await first.prisma.user.create({
				data: { id: "first-case-only", username: "first-case-only" },
			});
			await first.prisma.$executeRawUnsafe("CREATE TABLE FirstCaseOnly (value TEXT)");
		});

		const second = await create({ sqliteSchema: schema });
		const secondState = inspect(second);
		expect(schema.destinations).toEqual([firstState.path, secondState.path]);
		expect(firstState.path).not.toBe(secondState.path);
		expect(firstState.identity.ino).not.toBe(secondState.identity.ino);
		expect(firstState.identity.nlink).toBe(1n);
		expect(secondState.identity.nlink).toBe(1n);
		expect(first.userId).not.toBe(second.userId);
		expect(first.channelId).not.toBe(second.channelId);
		const firstContext = getRestoreRuntimeClientContext(first.runtime);
		const secondContext = getRestoreRuntimeClientContext(second.runtime);
		expect(firstContext.runtimeEpoch).not.toBe(secondContext.runtimeEpoch);
		for (const [native, state, context] of [
			[first, firstState, firstContext],
			[second, secondState, secondContext],
		] as const) {
			await context.assertOwned();
			expect(state.journal).toMatchObject({
				phase: "running",
				runtimeEpoch: context.runtimeEpoch,
				destinationInstallationId: "synthetic-notification-outbox-destination",
			});
			expect(state.binding).toMatchObject({
				databaseDevice: state.identity.dev.toString(),
				databaseInode: state.identity.ino.toString(),
			});
			await native.run(async () => {
				expect(
					await native.prisma.user.findUnique({ where: { id: native.userId } }),
				).not.toBeNull();
				expect(await native.prisma.notificationChannel.count()).toBe(1);
			});
		}
		await second.run(async () => {
			expect(await second.prisma.user.count()).toBe(1);
			expect(await second.prisma.user.findUnique({ where: { id: first.userId } })).toBeNull();
			expect(await second.prisma.user.findUnique({ where: { id: "first-case-only" } })).toBeNull();
			expect(
				await second.prisma.$queryRawUnsafe(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'FirstCaseOnly'",
				),
			).toEqual([]);
		});
		await first.run(async () => {
			expect(await first.prisma.user.count()).toBe(2);
			expect(await first.prisma.user.findUnique({ where: { id: second.userId } })).toBeNull();
		});
	}, 60_000);

	it("retains real cold native startup when no schema option is supplied", async () => {
		const native = await create();
		const state = inspect(native);
		expect(state.journal).toMatchObject({
			phase: "running",
			destinationInstallationId: "synthetic-notification-outbox-destination",
		});
		expect(state.binding).toMatchObject({ databaseInode: state.identity.ino.toString() });
		await getRestoreRuntimeClientContext(native.runtime).assertOwned();
		await native.run(async () => {
			expect(await native.prisma.user.count()).toBe(1);
			expect(await native.prisma.notificationChannel.count()).toBe(1);
		});
	}, 60_000);

	it.each(["uninitialized", "disposed"])(
		"refuses an %s optional template",
		async (state) => {
			const schema = template();
			if (state === "disposed") schema.dispose();
			await expect(create({ sqliteSchema: schema })).rejects.toThrow(
				"SQLite schema fixture is not ready",
			);
			expect(schema.destinations).toEqual([]);
		},
		60_000,
	);

	it.each(["postgresql", "unsupported"])(
		"rejects invalid %s ownership without consulting the SQLite template",
		async (engine) => {
			vi.stubEnv("NOTIFICATION_OUTBOX_TEST_ENGINE", engine);
			vi.stubEnv(
				"RESTORE_RUNTIME_TEST_PG_URL",
				"postgresql://invalid:synthetic@127.0.0.1:1/invalid",
			);
			let consultations = 0;
			const options = {
				get sqliteSchema(): SqliteSchemaFixture {
					consultations++;
					throw new Error("SQLite template must not be consulted");
				},
			};
			await expect(create(options)).rejects.toThrow(
				engine === "postgresql"
					? "Owned notification PostgreSQL fixture required."
					: "Owned notification database required.",
			);
			expect(consultations).toBe(0);
		},
	);
});
