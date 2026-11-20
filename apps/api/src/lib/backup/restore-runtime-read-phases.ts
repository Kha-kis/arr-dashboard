import { Prisma, type PrismaClientInstance } from "../prisma.js";
import { RestoreRuntimeAdmissionError } from "./restore-runtime-admission.js";

type Admit = <T>(operation: (client: PrismaClientInstance) => Promise<T>) => Promise<T>;
type Read = (client: PrismaClientInstance) => Promise<unknown>;
const readMethods = new Set([
	"findUnique",
	"findUniqueOrThrow",
	"findFirst",
	"findFirstOrThrow",
	"findMany",
	"count",
	"aggregate",
	"groupBy",
]);
const models = new Set(
	Object.values(Prisma.ModelName).map((name) => name[0]!.toLowerCase() + name.slice(1)),
);

/** Internal, opt-in lazy read subset. Native Prisma owns all query/transaction semantics. */
export async function withRuntimeReadPhases<T>(
	admit: Admit,
	operation: (client: PrismaClientInstance) => Promise<T>,
): Promise<T> {
	let open = true;
	const pending = new Set<Promise<unknown>>();
	const descriptors = new WeakMap<object, { read: Read; consumed: boolean }>();
	const checkOpen = () => {
		if (!open) throw new RestoreRuntimeAdmissionError();
	};
	const start = <R>(read: (client: PrismaClientInstance) => Promise<R>): Promise<R> => {
		checkOpen();
		const promise = admit(read);
		pending.add(promise);
		// Started but unawaited work must be joined without an unhandled rejection.
		void promise.then(
			() => pending.delete(promise),
			() => pending.delete(promise),
		);
		return promise;
	};
	const lazy = (read: Read) => {
		checkOpen();
		const descriptor = { read, consumed: false };
		let result: Promise<unknown> | undefined;
		const execute = () => {
			checkOpen();
			if (!result) {
				if (descriptor.consumed) throw new RestoreRuntimeAdmissionError();
				descriptor.consumed = true;
				result = start(read);
			}
			return result;
		};
		const query = {
			// biome-ignore lint/suspicious/noThenProperty: Await starts this intentionally lazy read descriptor.
			then: (...args: Parameters<Promise<unknown>["then"]>) => execute().then(...args),
			catch: (...args: Parameters<Promise<unknown>["catch"]>) => execute().catch(...args),
			finally: (...args: Parameters<Promise<unknown>["finally"]>) => execute().finally(...args),
			[Symbol.toStringTag]: "PrismaPromise",
		};
		descriptors.set(query, descriptor);
		return query;
	};
	const facade = new Proxy(Object.create(null) as PrismaClientInstance, {
		get: (_target, key) => {
			checkOpen();
			if (key === "$transaction")
				return async (input: unknown, options?: unknown) => {
					checkOpen();
					if (typeof input === "function") {
						return start((client) => Reflect.apply(client.$transaction, client, [input, options]));
					}
					if (!Array.isArray(input)) throw new RestoreRuntimeAdmissionError();
					const batch = input.map((query: unknown) =>
						typeof query === "object" && query !== null ? descriptors.get(query) : undefined,
					);
					if (batch.some((item) => !item || item.consumed) || new Set(batch).size !== batch.length)
						throw new RestoreRuntimeAdmissionError();
					for (const item of batch) item!.consumed = true;
					return start((client) =>
						Reflect.apply(client.$transaction, client, [
							batch.map((item) => item!.read(client)),
							options,
						]),
					);
				};
			if (key === "$queryRaw" || key === "$queryRawUnsafe")
				return (...args: unknown[]) => lazy((client) => Reflect.apply(client[key], client, args));
			if (typeof key !== "string" || !models.has(key)) throw new RestoreRuntimeAdmissionError();
			return new Proxy(Object.create(null), {
				get: (_model, method) => {
					checkOpen();
					if (typeof method !== "string" || !readMethods.has(method))
						throw new RestoreRuntimeAdmissionError();
					return (...args: unknown[]) =>
						lazy((client) => {
							const delegate = Reflect.get(client, key);
							return Reflect.apply(Reflect.get(delegate, method), delegate, args);
						});
				},
			});
		},
	});
	let value!: T;
	let failure: unknown;
	let failed = false;
	try {
		value = await operation(facade);
	} catch (error) {
		failure = error;
		failed = true;
	} finally {
		open = false;
	}
	await Promise.allSettled(pending);
	if (failed) throw failure;
	return value;
}
