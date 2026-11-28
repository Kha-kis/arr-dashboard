import { describe, expect, it } from "vitest";
import type { PrismaClientInstance } from "../../prisma.js";
import { withRuntimeReadPhases } from "../restore-runtime-read-phases.js";

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("read phase scope lifecycle", () => {
	for (const fail of [false, true]) {
		it(`joins started admission on callback ${fail ? "failure" : "success"} and closes before joining`, async () => {
			const admitted = signal(),
				release = signal(),
				leaving = signal();
			const sentinel = new Error("synthetic-original-callback-failure");
			let escaped!: PrismaClientInstance;
			let settled = false,
				admissions = 0;
			// Exercise lifetime only: admission is held, no fake/native SQL result.
			const result = withRuntimeReadPhases(
				async () => {
					admissions++;
					admitted.resolve();
					await release.promise;
					throw new Error("synthetic-admission-failure");
				},
				async (reader) => {
					escaped = reader;
					void reader.serviceInstance.count().catch(() => undefined);
					await admitted.promise;
					leaving.resolve();
					if (fail) throw sentinel;
					return "callback-value";
				},
			).then(
				(value) => {
					settled = true;
					return value;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			try {
				await leaving.promise;
				// Let the outer callback settle and close its scope.
				await Promise.resolve();
				await Promise.resolve();
				expect(settled).toBe(false);
				expect(() => escaped.serviceInstance.count()).toThrow();
			} finally {
				release.resolve();
			}
			expect(await result).toBe(fail ? sentinel : "callback-value");
			expect(admissions).toBe(1);
		});
	}

	it("does not admit unawaited descriptors and refuses them after scope closure", async () => {
		let admissions = 0;
		let lazy!: ReturnType<PrismaClientInstance["serviceInstance"]["count"]>;
		await withRuntimeReadPhases(
			async () => {
				admissions++;
				throw new Error("must-not-admit");
			},
			async (reader) => {
				lazy = reader.serviceInstance.count();
			},
		);
		expect(admissions).toBe(0);
		await expect(Promise.resolve(lazy)).rejects.toMatchObject({ statusCode: 503 });
		expect(admissions).toBe(0);
	});

	it("passes transaction options and the actual transaction client through one admission", async () => {
		const options = { maxWait: 123, timeout: 456, isolationLevel: "Serializable" as const };
		const actualTransaction = Object.freeze({ native: true });
		let admissions = 0;
		// No query engine is substituted: this checks the scoped forwarding boundary only.
		const native = {
			$transaction: async (callback: (tx: unknown) => Promise<unknown>, supplied: unknown) => {
				expect(supplied).toBe(options);
				return callback(actualTransaction);
			},
		} as unknown as PrismaClientInstance;
		const result = await withRuntimeReadPhases(
			async (read) => {
				admissions++;
				return read(native);
			},
			async (reader) => reader.$transaction(async (tx) => tx, options),
		);
		expect(result).toBe(actualTransaction);
		expect(admissions).toBe(1);
	});
});
