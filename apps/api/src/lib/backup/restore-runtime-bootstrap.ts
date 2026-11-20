import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { RestoreRuntime } from "./restore-runtime-admission.js";
import { createRuntimePrismaClient } from "./restore-runtime-client.js";

/** Read only bounded startup fields; close this native client before handoff. */
export async function loadRestoreRuntimeStartupSettings(runtime: RestoreRuntime) {
	const native = createRuntimePrismaClient(runtime);
	try {
		return await runtime.runStarting(() =>
			native.prisma.systemSettings.findUnique({
				where: { id: 1 },
				select: { apiPort: true, webPort: true, trustProxy: true, secureCookies: true },
			}),
		);
	} finally {
		await native.close();
	}
}

type ReadyHook = (this: FastifyInstance, done?: (error?: Error) => void) => void | Promise<void>;
const runningReadyHooks = new WeakMap<FastifyInstance, Array<() => Promise<void>>>();

async function invokeReadyHook(instance: FastifyInstance, hook: ReadyHook): Promise<void> {
	if (hook.length === 0) return await hook.call(instance);
	await new Promise<void>((resolve, reject) => {
		hook.call(instance, (error) => (error ? reject(error) : resolve()));
	});
}

/** Keep startup authority at the registration boundary, not in ordinary hooks. */
export function registerRestoreBootstrapPlugin(
	app: FastifyInstance,
	plugin: FastifyPluginAsync,
	options: { readyPhase?: "starting" | "running" } = {},
): void {
	const admitted: FastifyPluginAsync = async (instance, pluginOptions) => {
		const registration = new Proxy(instance, {
			get(target, property, receiver) {
				if (property === "addHook") {
					return (name: string, hook: ReadyHook) => {
						if (name !== "onReady") {
							Reflect.apply(target.addHook, target, [name, hook]);
						} else if (options.readyPhase === "running") {
							// Selected background jobs must not inherit bootstrap authority.
							// Registration remains starting; initialization runs after activation.
							const hooks = runningReadyHooks.get(app) ?? [];
							hooks.push(() =>
								target.restoreRuntime.runOperation(() => invokeReadyHook(target, hook)),
							);
							runningReadyHooks.set(app, hooks);
						} else {
							target.addHook("onReady", async function () {
								await target.restoreRuntime.runStarting(() => invokeReadyHook(this, hook));
							});
						}
						return registration;
					};
				}
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					const result = Reflect.apply(value, target, args);
					return result === target ? registration : result;
				};
			},
		});
		await instance.restoreRuntime.runStarting(() => plugin(registration, pluginOptions));
	};
	// Preserve Fastify's dependency/decorator/encapsulation contract. Do not copy
	// faux default exports, which would make Avvio load the unwrapped original.
	for (const name of ["skip-override", "fastify.display-name", "plugin-meta"]) {
		const symbol = Symbol.for(name);
		const descriptor = Object.getOwnPropertyDescriptor(plugin, symbol);
		if (descriptor) Object.defineProperty(admitted, symbol, descriptor);
	}
	app.register(admitted);
}

/** Register last so every required startup hook settles before running opens. */
export function registerRestoreRuntimeActivation(app: FastifyInstance): void {
	app.register(
		fp(
			async (instance) => {
				instance.addHook("onReady", async () => {
					await instance.restoreRuntime.activate();
					if (instance.hasDecorator("notificationService"))
						await instance.notificationService.start();
					const hooks = runningReadyHooks.get(app) ?? [];
					runningReadyHooks.delete(app);
					// Join initialization only. Jobs retain and drain their actual work;
					// activation/readiness must not wait for detached provider operations.
					for (const hook of hooks) await hook();
				});
			},
			{ name: "restore-runtime-activation", dependencies: ["prisma", "security"] },
		),
	);
}
