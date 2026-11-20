import { describe, expect, it } from "vitest";
import { selectSqliteStartupCacheKiB } from "../runtime-sqlite-startup-cache.js";

describe("startup page-cache policy", () => {
	const defaults = {
		cacheSize: -16000,
		pageSize: 4096,
		constrainedBytes: 3221225472,
		availableBytes: 1995345920,
	};
	it.each([
		[defaults, 65536],
		[{ ...defaults, constrainedBytes: 536870912, availableBytes: 268435456 }, 16384],
		[{ ...defaults, constrainedBytes: 1073741824 }, 32768],
		[{ ...defaults, availableBytes: 268435456 }, 32768],
		[{ ...defaults, constrainedBytes: 536903679 }, 16384],
		[{ ...defaults, cacheSize: 4000 }, 65536],
		[{ ...defaults, cacheSize: 0 }, 65536],
		[{ ...defaults, cacheSize: -65536 }, undefined],
		[{ ...defaults, cacheSize: -131072 }, undefined],
		[{ ...defaults, cacheSize: 16384 }, undefined],
		[{ ...defaults, cacheSize: 32768 }, undefined],
		[{ ...defaults, cacheSize: 8192, pageSize: 8192 }, undefined],
		[{ ...defaults, constrainedBytes: 16777216 }, undefined],
		[{ ...defaults, availableBytes: 8388608 }, undefined],
		[{ ...defaults, availableBytes: 1 }, undefined],
	])("selects only a strictly larger bounded budget for %j", (input, expected) => {
		expect(selectSqliteStartupCacheKiB(input)).toBe(expected);
	});
	it.each([undefined, null, "3221225472", 0, -1, NaN, Infinity, 1.5, 9007199254740992])(
		"preserves the existing setting for invalid resource evidence %s",
		(value) => {
			expect(selectSqliteStartupCacheKiB({ ...defaults, constrainedBytes: value })).toBeUndefined();
			expect(selectSqliteStartupCacheKiB({ ...defaults, availableBytes: value })).toBeUndefined();
		},
	);
	it.each([undefined, null, "4096", 0, -1, NaN, Infinity, 1.5, 9007199254740992])(
		"preserves the existing setting for invalid page size %s",
		(pageSize) => {
			expect(selectSqliteStartupCacheKiB({ ...defaults, pageSize })).toBeUndefined();
		},
	);
	it.each([
		undefined,
		null,
		"-16000",
		NaN,
		Infinity,
		1.5,
		9007199254740992,
		-9007199254740992,
		Number.MAX_SAFE_INTEGER,
		-Number.MAX_SAFE_INTEGER,
	])("preserves the existing setting for invalid or overflowing cache size %s", (cacheSize) => {
		expect(selectSqliteStartupCacheKiB({ ...defaults, cacheSize })).toBeUndefined();
	});
});
