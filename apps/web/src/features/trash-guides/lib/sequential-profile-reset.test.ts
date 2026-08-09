import { describe, expect, it, vi } from "vitest";
import { runProfileOverrideResetsSequentially } from "./sequential-profile-reset";

describe("runProfileOverrideResetsSequentially", () => {
	it("does not start the next profile reset until the previous one finishes", async () => {
		let finishFirst!: (value: number) => void;
		const firstResult = new Promise<number>((resolve) => {
			finishFirst = resolve;
		});
		const execute = vi
			.fn()
			.mockImplementationOnce(() => firstResult)
			.mockResolvedValueOnce(2);

		const pending = runProfileOverrideResetsSequentially(
			[
				{ profileId: 4, customFormatIds: [7] },
				{ profileId: 5, customFormatIds: [8] },
			],
			execute,
		);
		await Promise.resolve();

		expect(execute).toHaveBeenCalledTimes(1);
		finishFirst(1);
		await expect(pending).resolves.toEqual([1, 2]);
		expect(execute).toHaveBeenNthCalledWith(1, {
			profileId: 4,
			customFormatIds: [7],
		});
		expect(execute).toHaveBeenNthCalledWith(2, {
			profileId: 5,
			customFormatIds: [8],
		});
	});
});
