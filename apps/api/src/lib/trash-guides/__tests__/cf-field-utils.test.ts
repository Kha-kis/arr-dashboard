import { describe, expect, it } from "vitest";
import { buildCustomFormatIdentityIndex, extractTrashId } from "../cf-field-utils.js";

describe("extractTrashId", () => {
	it("uses the trailing TRaSH UUID identity when ARR does not persist metadata fields", () => {
		expect(
			extractTrashId({
				id: 42,
				name: "Streaming Services [A1B2C3D4-E5F6-47A8-9B0C-1D2E3F4A5B6C]",
				specifications: [],
			} as never),
		).toBe("a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c");
	});

	it("accepts the canonical UUID shape without imposing UUID version bits", () => {
		expect(
			extractTrashId({
				name: "TRaSH format [a1b2c3d4-e5f6-f7a8-7b0c-1d2e3f4a5b6c]",
				specifications: [],
			} as never),
		).toBe("a1b2c3d4-e5f6-f7a8-7b0c-1d2e3f4a5b6c");
	});

	it("prefers an explicit specification identity over the display-name suffix", () => {
		expect(
			extractTrashId({
				name: "Streaming Services [a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c]",
				specifications: [
					{
						fields: [{ name: "trash_id", value: "11111111-2222-4333-8444-555555555555" }],
					},
				],
			} as never),
		).toBe("11111111-2222-4333-8444-555555555555");
	});
});

describe("buildCustomFormatIdentityIndex", () => {
	it("reports duplicate extracted identities and fallback names instead of choosing a row", () => {
		const duplicateIdentity = "a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c";
		const result = buildCustomFormatIdentityIndex([
			{ id: 1, name: `First [${duplicateIdentity}]`, specifications: [] },
			{ id: 2, name: `Second [${duplicateIdentity}]`, specifications: [] },
			{ id: 3, name: "Same name", specifications: [] },
			{ id: 4, name: "Same name", specifications: [] },
		] as never);

		expect(result.collisions).toEqual([`TRaSH identity ${duplicateIdentity}`, 'name "Same name"']);
		expect(result.byTrashId.has(duplicateIdentity)).toBe(false);
		expect(result.byName.has("Same name")).toBe(false);
	});
});
