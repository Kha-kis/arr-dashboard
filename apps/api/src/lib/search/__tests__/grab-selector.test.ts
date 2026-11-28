import { describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../auth/encryption.js";

const key = "1".repeat(64);
const now = 1_790_000_000_000;
const target = {
	userId: "synthetic-owner",
	serviceInstanceId: "synthetic-prowlarr",
	connectionFingerprint: "a".repeat(64),
	guid: "opaque:release/one?part=2",
	indexerId: 7,
};
const binding = {
	userId: "synthetic-owner",
	serviceInstanceId: "synthetic-prowlarr",
	connectionFingerprint: "a".repeat(64),
};
const claims = {
	purpose: "arr-dashboard:search-grab-selector",
	version: 1,
	...target,
	issuedAt: now,
	expiresAt: now + 1_800_000,
};

// Independent authenticated fixtures exercise validation after real decryption.
function seal(encryptor: Encryptor, value: unknown): string {
	const encrypted = encryptor.encrypt(JSON.stringify(value));
	return `sg1.${Buffer.from(encrypted.iv, "base64").toString("base64url")}.${Buffer.from(encrypted.value, "base64").toString("base64url")}`;
}

async function implementation() {
	return import("../grab-selector.js");
}

describe("authenticated manual Grab result selector", () => {
	it("observes an expired exact recorded target without authorizing new admission", async () => {
		const { assertSearchGrabSelectorMatchesRecordedTarget, readSearchGrabSelector } =
			await implementation();
		const encryptor = new Encryptor(key);
		const selector = seal(encryptor, claims);
		expect(() =>
			assertSearchGrabSelectorMatchesRecordedTarget(encryptor, selector, target, now + 1_800_000),
		).not.toThrow();
		expect(
			assertSearchGrabSelectorMatchesRecordedTarget(encryptor, selector, target, now + 86_400_000),
		).toBeUndefined();
		expect(() => readSearchGrabSelector(encryptor, selector, binding, now + 1_800_000)).toThrow();
	});
	it.each([
		{ ...target, userId: "other-owner" },
		{ ...target, serviceInstanceId: "other-instance" },
		{ ...target, connectionFingerprint: "b".repeat(64) },
		{ ...target, guid: "other-release" },
		{ ...target, indexerId: 8 },
	])("refuses observation of a different recorded target %j", async (recorded) => {
		const { assertSearchGrabSelectorMatchesRecordedTarget, SearchGrabSelectorError } =
			await implementation();
		const encryptor = new Encryptor(key);
		expect(() =>
			assertSearchGrabSelectorMatchesRecordedTarget(
				encryptor,
				seal(encryptor, claims),
				recorded,
				now + 86_400_000,
			),
		).toThrow(SearchGrabSelectorError);
	});
	it.each([
		{ ...claims, purpose: "different-domain" },
		{ ...claims, version: 2 },
		{ ...claims, issuedAt: now + 1, expiresAt: now + 1_800_001 },
		{ ...claims, expiresAt: now + 1_800_001 },
		{ ...claims, guid: "bad\u0000guid" },
		{ ...claims, extra: true },
	])("retains strict authenticated validation during observation %j", async (invalid) => {
		const { assertSearchGrabSelectorMatchesRecordedTarget, SearchGrabSelectorError } =
			await implementation();
		const encryptor = new Encryptor(key);
		expect(() =>
			assertSearchGrabSelectorMatchesRecordedTarget(
				encryptor,
				seal(encryptor, invalid),
				target,
				now,
			),
		).toThrow(SearchGrabSelectorError);
	});
	it("rejects unauthenticated and oversized observation evidence", async () => {
		const { assertSearchGrabSelectorMatchesRecordedTarget, SearchGrabSelectorError } =
			await implementation();
		const encryptor = new Encryptor(key);
		const selector = seal(encryptor, claims);
		expect(() =>
			assertSearchGrabSelectorMatchesRecordedTarget(
				new Encryptor("2".repeat(64)),
				selector,
				target,
				now,
			),
		).toThrow(SearchGrabSelectorError);
		expect(() =>
			assertSearchGrabSelectorMatchesRecordedTarget(encryptor, "x".repeat(16_385), target, now),
		).toThrow(SearchGrabSelectorError);
	});
	it("recovers only the exact accepted target through real authenticated encryption", async () => {
		const { issueSearchGrabSelector, readSearchGrabSelector } = await implementation();
		const encryptor = new Encryptor(key);
		const selector = issueSearchGrabSelector(encryptor, target, now);
		expect(selector).not.toContain(target.guid);
		expect(selector).not.toContain(target.userId);
		expect(readSearchGrabSelector(encryptor, selector, binding, now + 1)).toEqual(target);
	});

	it("issues independent ciphertext for the same target without changing its identity", async () => {
		const { issueSearchGrabSelector, readSearchGrabSelector } = await implementation();
		const encryptor = new Encryptor(key);
		const first = issueSearchGrabSelector(encryptor, target, now);
		const second = issueSearchGrabSelector(encryptor, target, now);
		expect(first).not.toBe(second);
		expect(first.split(".")[1]).not.toBe(second.split(".")[1]);
		expect(readSearchGrabSelector(encryptor, second, binding, now)).toEqual(target);
	});

	it("preserves Unicode and delimiter-bearing provider identities without normalization", async () => {
		const { issueSearchGrabSelector, readSearchGrabSelector } = await implementation();
		const encryptor = new Encryptor(key);
		const unicode = { ...target, guid: "opaque:é/雪?x=1&x=2|part:3" };
		expect(
			readSearchGrabSelector(
				encryptor,
				issueSearchGrabSelector(encryptor, unicode, now),
				binding,
				now,
			),
		).toEqual(unicode);
	});

	it.each([
		["owner", { ...binding, userId: "other-owner" }],
		["instance", { ...binding, serviceInstanceId: "other-instance" }],
		["replaced connection", { ...binding, connectionFingerprint: "b".repeat(64) }],
	])("refuses a selector bound to a different %s", async (_label, expected) => {
		const { readSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		expect(() =>
			readSearchGrabSelector(new Encryptor(key), seal(new Encryptor(key), claims), expected, now),
		).toThrow(SearchGrabSelectorError);
	});

	it("rejects a destination-key mismatch without exposing the encrypted target", async () => {
		const { readSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		const selector = seal(new Encryptor(key), claims);
		expect(() =>
			readSearchGrabSelector(new Encryptor("2".repeat(64)), selector, binding, now),
		).toThrow(SearchGrabSelectorError);
	});

	it.each(["iv", "ciphertext"])("rejects tampered %s", async (part) => {
		const { readSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		const encryptor = new Encryptor(key);
		const segments = seal(encryptor, claims).split(".");
		const index = part === "iv" ? 1 : 2;
		const current = segments[index]!;
		segments[index] = (current[0] === "A" ? "B" : "A") + current.slice(1);
		expect(() => readSearchGrabSelector(encryptor, segments.join("."), binding, now)).toThrow(
			SearchGrabSelectorError,
		);
	});

	it.each([
		undefined,
		null,
		{},
		"",
		`sg1.AAAAAAAAAAAAAAAA.${"A".repeat(16384)}`,
		"sg2.a.b",
		"sg1.a.b.c",
		"sg1.!.!",
		"sg1.AAAAAAAAAAAAAAAA=.AAAA",
		"sg1.AAAAAAAAAAAAAAAB.AAAA",
		"sg1.AAAAAAAAAAAAAAAA.AA",
	])("rejects malformed or oversized envelope %j before decryption", async (selector) => {
		const { readSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		const encryptor = new Encryptor(key);
		const decrypt = vi.spyOn(encryptor, "decrypt");
		expect(() => readSearchGrabSelector(encryptor, selector, binding, now)).toThrow(
			SearchGrabSelectorError,
		);
		expect(decrypt).not.toHaveBeenCalled();
	});

	it("rejects noncanonical base64url aliases before decryption", async () => {
		const { readSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		const encryptor = new Encryptor(key);
		const original = seal(encryptor, claims);
		const decrypt = vi.spyOn(encryptor, "decrypt");
		expect(() => readSearchGrabSelector(encryptor, `${original}=`, binding, now)).toThrow(
			SearchGrabSelectorError,
		);
		expect(decrypt).not.toHaveBeenCalled();
	});

	it("rejects unused-base64-bit aliases rather than attempting authentication", async () => {
		const { readSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		const encryptor = new Encryptor(key);
		const decrypt = vi.spyOn(encryptor, "decrypt");
		// Seventeen zero bytes canonically encode as23 As. B changes only unused bits.
		const alias = `sg1.AAAAAAAAAAAAAAAA.${"A".repeat(22)}B`;
		expect(() => readSearchGrabSelector(encryptor, alias, binding, now)).toThrow(
			SearchGrabSelectorError,
		);
		expect(decrypt).not.toHaveBeenCalled();
	});

	it.each([
		["other purpose", { ...claims, purpose: "arr-dashboard:other-purpose" }],
		["other version", { ...claims, version: 2 }],
		["missing target", { purpose: claims.purpose, version: 1 }],
		["unknown field", { ...claims, unexpected: "not accepted" }],
		["array", [claims]],
		["null", null],
		["empty guid", { ...claims, guid: "" }],
		["surrounding whitespace", { ...claims, guid: " release " }],
		["control character", { ...claims, guid: "release\u0000tail" }],
		["Unicode byte limit", { ...claims, guid: "é".repeat(2049) }],
		["zero indexer", { ...claims, indexerId: 0 }],
		["fractional indexer", { ...claims, indexerId: 1.5 }],
		["unsafe indexer", { ...claims, indexerId: 9_007_199_254_740_992 }],
		["empty owner", { ...claims, userId: "" }],
		["oversized instance", { ...claims, serviceInstanceId: "x".repeat(129) }],
		["uppercase fingerprint", { ...claims, connectionFingerprint: "A".repeat(64) }],
		["string timestamp", { ...claims, issuedAt: String(now) }],
		["fractional timestamp", { ...claims, issuedAt: now + 0.5 }],
		["negative timestamp", { ...claims, issuedAt: -1 }],
		["extended lifetime", { ...claims, expiresAt: now + 1_800_001 }],
		["shortened lifetime", { ...claims, expiresAt: now + 1_799_999 }],
	])("refuses authenticated but invalid claims: %s", async (_label, invalidClaims) => {
		const { readSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		const encryptor = new Encryptor(key);
		expect(() =>
			readSearchGrabSelector(encryptor, seal(encryptor, invalidClaims), binding, now),
		).toThrow(SearchGrabSelectorError);
	});

	it("accepts the last valid instant but refuses expiry and future issuance", async () => {
		const { readSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		const encryptor = new Encryptor(key);
		const selector = seal(encryptor, claims);
		expect(readSearchGrabSelector(encryptor, selector, binding, now + 1_799_999)).toEqual(target);
		expect(() => readSearchGrabSelector(encryptor, selector, binding, now + 1_800_000)).toThrow(
			SearchGrabSelectorError,
		);
		expect(() => readSearchGrabSelector(encryptor, selector, binding, now - 1)).toThrow(
			SearchGrabSelectorError,
		);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, now + 0.5, Number.MAX_SAFE_INTEGER])(
		"refuses an invalid admission clock %s",
		async (clock) => {
			const { issueSearchGrabSelector, readSearchGrabSelector, SearchGrabSelectorError } =
				await implementation();
			const encryptor = new Encryptor(key);
			expect(() => issueSearchGrabSelector(encryptor, target, clock)).toThrow(
				SearchGrabSelectorError,
			);
			expect(() =>
				readSearchGrabSelector(encryptor, seal(encryptor, claims), binding, clock),
			).toThrow(SearchGrabSelectorError);
		},
	);

	it.each([
		{ ...target, guid: " " },
		{ ...target, guid: "x".repeat(4097) },
		{ ...target, userId: "x".repeat(129) },
		{ ...target, serviceInstanceId: "bad\ninstance" },
		{ ...target, connectionFingerprint: "not-a-fingerprint" },
		{ ...target, indexerId: -1 },
	])("refuses to issue provenance for an invalid result binding %j", async (invalidTarget) => {
		const { issueSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		expect(() => issueSearchGrabSelector(new Encryptor(key), invalidTarget, now)).toThrow(
			SearchGrabSelectorError,
		);
	});

	it("accepts the bounded UTF-8 target limit and returns only dispatch fields", async () => {
		const { issueSearchGrabSelector, readSearchGrabSelector } = await implementation();
		const encryptor = new Encryptor(key);
		const bounded = { ...target, guid: "é".repeat(2048) };
		const selector = issueSearchGrabSelector(encryptor, bounded, now);
		expect(selector.length).toBeLessThanOrEqual(16384);
		expect(readSearchGrabSelector(encryptor, selector, binding, now)).toEqual(bounded);
	});

	it("accepts JSON-escaped opaque GUIDs at the semantic byte limit", async () => {
		const { issueSearchGrabSelector, readSearchGrabSelector } = await implementation();
		const encryptor = new Encryptor(key);
		const escaped = { ...target, guid: '"\\'.repeat(2048) };
		const selector = issueSearchGrabSelector(encryptor, escaped, now);
		expect(selector.length).toBeLessThanOrEqual(16384);
		expect(readSearchGrabSelector(encryptor, selector, binding, now)).toEqual(escaped);
	});

	it("returns the same generic error for bad identity, key, format and expiry", async () => {
		const { readSearchGrabSelector, SearchGrabSelectorError } = await implementation();
		const encryptor = new Encryptor(key);
		const selector = seal(encryptor, claims);
		const failures = [
			() => readSearchGrabSelector(encryptor, selector, { ...binding, userId: "other" }, now),
			() => readSearchGrabSelector(new Encryptor("2".repeat(64)), selector, binding, now),
			() => readSearchGrabSelector(encryptor, "bad", binding, now),
			() => readSearchGrabSelector(encryptor, selector, binding, now + 1_800_000),
		];
		const messages = failures.map((run) => {
			try {
				run();
				throw new Error("Selector incorrectly admitted");
			} catch (error) {
				expect(error).toBeInstanceOf(SearchGrabSelectorError);
				return (error as Error).message;
			}
		});
		expect(new Set(messages).size).toBe(1);
		expect(messages.join(" ")).not.toContain(target.guid);
		expect(messages.join(" ")).not.toContain(target.userId);
	});
});
