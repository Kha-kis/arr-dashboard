import { describe, expect, it } from "vitest";
import {
	withImportConnectionReadGuard,
	withImportConnectionWriteGuard,
} from "../connection-guards.js";

describe("owned import connection reader/writer serialization", () => {
	it("does not enter a connection write while an import reader is active", async () => {
		let changed = false;
		await withImportConnectionReadGuard("owner", "instance", async () => {
			await expect(
				withImportConnectionWriteGuard("owner", "instance", async () => {
					changed = true;
				}),
			).rejects.toMatchObject({ statusCode: 409 });
		});
		expect(changed).toBe(false);
		await withImportConnectionWriteGuard("owner", "instance", async () => {
			changed = true;
		});
		expect(changed).toBe(true);
	});
	it("does not enter an import read or a second write while a connection writer is active", async () => {
		let submitted = false;
		await withImportConnectionWriteGuard("owner", "instance", async () => {
			await expect(
				withImportConnectionReadGuard("owner", "instance", async () => {
					submitted = true;
				}),
			).rejects.toMatchObject({ statusCode: 409 });
			await expect(
				withImportConnectionWriteGuard("owner", "instance", async () => {
					submitted = true;
				}),
			).rejects.toMatchObject({ statusCode: 409 });
		});
		expect(submitted).toBe(false);
	});
	it("keeps detached read protection until actual settlement rather than caller return", async () => {
		let settle!: () => void;
		let announce!: () => void;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const work = withImportConnectionReadGuard("owner", "instance", async () => {
			announce();
			await settled;
		});
		await started;
		try {
			await expect(
				withImportConnectionWriteGuard("owner", "instance", async () => true),
			).rejects.toMatchObject({ statusCode: 409 });
		} finally {
			settle();
			await work;
		}
		await expect(
			withImportConnectionWriteGuard("owner", "instance", async () => true),
		).resolves.toBe(true);
	});
	it("isolates owners and connections without unnecessarily blocking other reads", async () => {
		await withImportConnectionReadGuard("owner", "instance", async () => {
			await expect(withImportConnectionReadGuard("owner", "instance", async () => 1)).resolves.toBe(
				1,
			);
			await expect(
				withImportConnectionWriteGuard("other", "instance", async () => 2),
			).resolves.toBe(2);
			await expect(withImportConnectionWriteGuard("owner", "other", async () => 3)).resolves.toBe(
				3,
			);
		});
	});
	it.each([withImportConnectionReadGuard, withImportConnectionWriteGuard])(
		"releases a failing operation's guard",
		async (guard) => {
			const error = new Error("Synthetic failure");
			await expect(
				guard("owner", "instance", async () => {
					throw error;
				}),
			).rejects.toBe(error);
			await expect(
				withImportConnectionWriteGuard("owner", "instance", async () => true),
			).resolves.toBe(true);
		},
	);
	it.each([
		["", "instance"],
		["owner", ""],
	])("refuses absent authority before entering work", async (owner, instance) => {
		let entered = false;
		await expect(
			withImportConnectionReadGuard(owner, instance, async () => {
				entered = true;
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(entered).toBe(false);
	});
});
