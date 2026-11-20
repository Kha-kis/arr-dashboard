import { beforeEach, describe, it } from "vitest";

/** Keep native fixture preparation out of the existing lifecycle assertion deadline. */
export function nativeLifecycleTest<T>(
	name: string,
	prepare: () => Promise<T>,
	verify: (fixture: T) => Promise<void>,
	timeout?: number,
) {
	describe(name, () => {
		let fixture: T;
		beforeEach(async () => {
			fixture = await prepare();
		});
		it(
			"preserves the lifecycle contract",
			async () => {
				await verify(fixture);
			},
			timeout,
		);
	});
}
