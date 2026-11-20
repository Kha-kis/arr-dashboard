import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../restore-runtime-bootstrap.js";

describe("native running-phase scheduler initialization", () => {
	let fixture: Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
	let app: FastifyInstance;
	let release: (() => void) | undefined;
	let work: Promise<unknown> | undefined;
	beforeEach(async () => {
		fixture = await createNotificationOutboxNativeFixture();
		await fixture.restart(false);
		app = Fastify({ logger: false });
		app.decorate("restoreRuntime", fixture.runtime);
		app.decorate("prisma", fixture.prisma);
		app.register(fp(async () => {}, { name: "prisma" }));
		app.register(fp(async () => {}, { name: "security" }));
		release = undefined;
		work = undefined;
	});
	afterEach(async () => {
		release?.();
		await work;
		await app.close();
		await fixture.close();
	});

	it("initializes selected jobs only after native activation while registration stays starting", async () => {
		const observed: string[] = [];
		registerRestoreBootstrapPlugin(
			app,
			fp(async (scope) => {
				observed.push(
					(
						await scope.prisma.restoreRuntimeControl.findUniqueOrThrow({
							where: { id: 1 },
						})
					).phase,
				);
				scope.addHook("onReady", async () => {
					observed.push(
						(
							await scope.prisma.restoreRuntimeControl.findUniqueOrThrow({
								where: { id: 1 },
							})
						).phase,
					);
					await scope.prisma.user.update({
						where: { id: fixture.userId },
						data: { mustChangePassword: false },
					});
				});
			}),
			{ readyPhase: "running" },
		);
		registerRestoreRuntimeActivation(app);
		await app.ready();
		expect(observed).toEqual(["starting", "running"]);
		expect(
			await fixture.run(() =>
				fixture.prisma.user.findUniqueOrThrow({
					where: { id: fixture.userId },
					select: { mustChangePassword: true },
				}),
			),
		).toEqual({ mustChangePassword: false });
	});

	it("does not hold readiness behind a detached native startup job", async () => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		registerRestoreBootstrapPlugin(
			app,
			fp(async (scope) => {
				scope.addHook("onReady", async () => {
					work = scope.restoreRuntime.runIndependentOperation(async () => {
						await scope.prisma.user.findUniqueOrThrow({ where: { id: fixture.userId } });
						entered();
						await held;
						await scope.prisma.user.update({
							where: { id: fixture.userId },
							data: { mustChangePassword: false },
						});
					});
				});
			}),
			{ readyPhase: "running" },
		);
		registerRestoreRuntimeActivation(app);
		const ready = app.ready();
		await started;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let readyWhileHeld: boolean;
		try {
			readyWhileHeld = await Promise.race([
				ready.then(() => true),
				new Promise<false>((resolve) => {
					deadline = setTimeout(() => resolve(false), 1_000);
				}),
			]);
		} finally {
			clearTimeout(deadline);
			release?.();
			await ready;
			await work;
		}
		expect(readyWhileHeld).toBe(true);
		expect(
			await fixture.run(() =>
				fixture.prisma.user.findUniqueOrThrow({
					where: { id: fixture.userId },
					select: { mustChangePassword: true },
				}),
			),
		).toEqual({ mustChangePassword: false });
	});

	it("retains callback hook context and commits selected initialization under running permission", async () => {
		const observed: string[] = [];
		registerRestoreBootstrapPlugin(
			app,
			fp(async (scope) => {
				scope.addHook("onReady", function (done) {
					void this.prisma.restoreRuntimeControl
						.findUniqueOrThrow({ where: { id: 1 } })
						.then(async (control) => {
							observed.push(control.phase);
							await this.prisma.user.update({
								where: { id: fixture.userId },
								data: { mustChangePassword: false },
							});
						})
						.then(() => done(), done);
				});
			}),
			{ readyPhase: "running" },
		);
		registerRestoreRuntimeActivation(app);
		await app.ready();
		expect(observed).toEqual(["running"]);
		expect(
			await fixture.run(() =>
				fixture.prisma.user.findUniqueOrThrow({
					where: { id: fixture.userId },
					select: { mustChangePassword: true },
				}),
			),
		).toEqual({ mustChangePassword: false });
	});
});
