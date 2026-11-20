import { describe, expect, it } from "vitest";
import type { ServiceInstance } from "../../prisma.js";
import { normalizeSearchResult } from "../normalizers.js";

const instance = {
	id: "p-1",
	label: "Synthetic",
	baseUrl: "https://synthetic.invalid",
} as ServiceInstance;
const raw = { id: 7, guid: "guid", title: "Synthetic", indexerId: 7, protocol: "torrent" };

describe("Search row-local metadata admission", () => {
	it("keeps explicit SDK category ids without inferring nested taxonomy assignments", () => {
		const result = normalizeSearchResult(
			{
				...raw,
				categories: [
					{ id: 5000, name: "Synthetic TV", subCategories: [{ id: 5030, name: "Synthetic SD" }] },
					{ id: 5040, name: "Synthetic HD", description: null, subCategories: [] },
				],
			},
			instance,
		);
		expect(result).toMatchObject({ id: "7", guid: "guid", indexerId: 7, categories: [5000, 5040] });
		expect(result).not.toHaveProperty("metadataIncomplete");
	});
	it.each([
		["missing", { name: "Synthetic", subCategories: [{ id: 5030 }] }],
		["null", { id: null }],
		["blank", { id: " " }],
		["fractional", { id: 5000.5 }],
		["nested", { id: { value: 5000 } }],
	])("keeps valid categories but flags a %s object id as incomplete", (_label, invalid) => {
		const result = normalizeSearchResult(
			{ ...raw, categories: [{ id: 5000 }, 2000, "5040", invalid] },
			instance,
		);
		expect(result).toMatchObject({
			id: "7",
			indexerId: 7,
			categories: [5000, 2000, 5040],
			metadataIncomplete: true,
		});
	});
	it.each([[2000, 5040], ["2000", "5040"], "2000|5040"])(
		"retains legacy numeric category representations %#",
		(categories) => {
			const result = normalizeSearchResult({ ...raw, categories }, instance);
			expect(result?.categories).toEqual([2000, 5040]);
			expect(result).not.toHaveProperty("metadataIncomplete");
		},
	);
	it.each([
		"size",
		"seeders",
		"leechers",
		"peers",
		"grabs",
		"age",
		"ageHours",
		"ageDays",
		"downloadVolumeFactor",
		"uploadVolumeFactor",
		"minimumRatio",
		"minimumSeedTime",
	])("omits invalid %s without dropping usable identity", (field) => {
		for (const value of [-1, " ", "invalid", Number.POSITIVE_INFINITY, {}]) {
			const result = normalizeSearchResult(
				{
					...raw,
					[field]: value,
					downloadVolumeFactor: field === "downloadVolumeFactor" ? value : 0,
				},
				instance,
			);
			expect(result).toMatchObject({
				id: "7",
				guid: "guid",
				indexerId: 7,
				instanceId: "p-1",
				metadataIncomplete: true,
			});
			expect(result).not.toHaveProperty(field);
		}
	});
	it("keeps real zeros and valid numeric strings, absent/null stays unknown", () => {
		const result = normalizeSearchResult(
			{ ...raw, size: 0, seeders: "0", leechers: null, downloadVolumeFactor: "0.5" },
			instance,
		);
		expect(result).toMatchObject({ size: 0, seeders: 0, downloadVolumeFactor: 0.5 });
		expect(result?.peers).toBeUndefined();
		expect(result?.leechers).toBeUndefined();
		expect(result?.metadataIncomplete).toBeUndefined();
	});
	it("omits invalid optional arrays and dates while keeping other valid metadata", () => {
		const result = normalizeSearchResult(
			{
				...raw,
				size: 1024,
				categories: [1.5],
				languages: [{ id: 1.5, name: "Synthetic" }],
				rejectionReasons: {},
				publishDate: "invalid",
			},
			instance,
		);
		expect(result).toMatchObject({ id: "7", size: 1024, metadataIncomplete: true });
		expect(result?.categories).toBeUndefined();
		expect(result?.languages).toBeUndefined();
		expect(result?.publishDate).toBeUndefined();
		expect(result?.rejectionReasons).toBeUndefined();
	});
	it.each([undefined, -1, 1.5, Number.POSITIVE_INFINITY, " ", {}])(
		"rejects invalid indexer identity %#",
		(indexerId) => {
			expect(normalizeSearchResult({ ...raw, indexerId }, instance)).toBeNull();
		},
	);
	it.each(["id", "guid", "downloadUrl", "magnetUrl", "infoUrl", "link"])(
		"rejects present malformed %s rather than concealing invalid action metadata",
		(field) => {
			for (const value of [{}, [], true, Number.POSITIVE_INFINITY]) {
				expect(normalizeSearchResult({ ...raw, [field]: value }, instance)).toBeNull();
			}
		},
	);
	it("rejects blank selected identities but retains absent and null identity fallback", () => {
		expect(normalizeSearchResult({ ...raw, id: " " }, instance)).toBeNull();
		expect(normalizeSearchResult({ ...raw, guid: " " }, instance)).toBeNull();
		expect(normalizeSearchResult({ ...raw, id: null }, instance)).toMatchObject({
			id: "guid",
			guid: "guid",
		});
		expect(normalizeSearchResult({ ...raw, guid: null }, instance)).toMatchObject({ id: "7" });
	});
	it("omits a malformed peers total instead of replacing it with a derived value", () => {
		const result = normalizeSearchResult({ ...raw, seeders: 4, leechers: 1, peers: -1 }, instance);
		expect(result).toMatchObject({ seeders: 4, leechers: 1, metadataIncomplete: true });
		expect(result?.peers).toBeUndefined();
	});
	it("marks partially malformed optional arrays incomplete without inventing taxonomy", () => {
		const result = normalizeSearchResult(
			{
				...raw,
				categories: [2000, {}],
				rejectionReasons: ["Synthetic reason", {}],
				languages: [{ id: 1, name: "Synthetic" }, {}],
			},
			instance,
		);
		expect(result).toMatchObject({ id: "7", metadataIncomplete: true });
	});
	it("does not erase identity when a derived peers sum overflows", () => {
		const result = normalizeSearchResult(
			{ ...raw, seeders: Number.MAX_VALUE, leechers: Number.MAX_VALUE },
			instance,
		);
		expect(result).toMatchObject({ id: "7", metadataIncomplete: true });
		expect(result?.peers).toBeUndefined();
	});
});
