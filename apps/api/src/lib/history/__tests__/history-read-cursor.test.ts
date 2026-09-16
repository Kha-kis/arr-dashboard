import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import {
	advanceHistoryCursor,
	decodeHistoryCursor,
	encodeHistoryCursor,
	type HistoryCursorPlaintext,
} from "../history-read-cursor.js";

const NOW = "2026-09-03T12:00:00.000Z";
const OWNER = "owner-a";
const FILTER_DIGEST = createHash("sha256").update("filter").digest("hex");
const SOURCE_DIGEST = createHash("sha256").update("sources").digest("hex");
const OTHER_SOURCE_DIGEST = createHash("sha256").update("other-sources").digest("hex");
const KEY = "a".repeat(64);

function plaintext(overrides: Partial<HistoryCursorPlaintext> = {}): HistoryCursorPlaintext {
	return {
		version: 1,
		ownerId: OWNER,
		issuedAt: NOW,
		expiresAt: "2026-09-03T12:30:00.000Z",
		snapshotAt: "2026-09-03T11:59:00.000Z",
		filterDigest: FILTER_DIGEST,
		limit: 2,
		anchor: null,
		sourceStateDigest: SOURCE_DIGEST,
		...overrides,
	};
}

function context(overrides: Record<string, unknown> = {}) {
	return {
		now: NOW,
		expectedOwnerId: OWNER,
		expectedFilterDigest: FILTER_DIGEST,
		expectedLimit: 2,
		expectedSourceStateDigest: SOURCE_DIGEST,
		...overrides,
	};
}

describe("History encrypted cursor", () => {
	it("round-trips through the installation Encryptor with exact valid result keys", () => {
		const encryptor = new Encryptor(KEY);
		const token = encodeHistoryCursor(encryptor, plaintext());
		expect(typeof token).toBe("string");
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		const outer = JSON.parse(Buffer.from(token!, "base64url").toString("utf8"));
		expect(Object.keys(outer).sort()).toEqual(["iv", "value", "version"]);
		expect(Buffer.from(token!, "base64url").toString("utf8")).not.toContain(OWNER);
		expect(Buffer.from(token!, "base64url").toString("utf8")).not.toContain(FILTER_DIGEST);
		const decoded = decodeHistoryCursor(encryptor, token!, context());
		expect(decoded).toEqual({ kind: "valid", cursor: plaintext() });
		expect(Object.keys(decoded)).toEqual(["kind", "cursor"]);
	});

	it("preserves chain lifetime and changes only the anchor", () => {
		const advanced = advanceHistoryCursor(plaintext(), {
			eventAt: "2026-09-03T11:30:00.000Z",
			id: "observation-1",
		});
		expect(advanced).not.toBeNull();
		if (!advanced) return;
		expect(advanced).toEqual({
			...plaintext(),
			anchor: { eventAt: "2026-09-03T11:30:00.000Z", id: "observation-1" },
		});
		expect(advanceHistoryCursor(advanced, null)).toEqual({ ...advanced, anchor: null });
	});

	it("encodes a canonical fixed-key plaintext projection regardless of input insertion order", () => {
		let captured: string | null = null;
		const seam = {
			encrypt: (value: string) => {
				captured = value;
				return {
					value: Buffer.alloc(16).toString("base64"),
					iv: Buffer.alloc(12).toString("base64"),
				};
			},
			decrypt: () => "",
		};
		const anchor = { id: "observation-1", eventAt: "2026-09-03T11:30:00.000Z" };
		const reordered = {
			sourceStateDigest: SOURCE_DIGEST,
			anchor,
			limit: 2,
			filterDigest: FILTER_DIGEST,
			snapshotAt: "2026-09-03T11:59:00.000Z",
			expiresAt: "2026-09-03T12:30:00.000Z",
			issuedAt: NOW,
			ownerId: OWNER,
			version: 1,
		} satisfies HistoryCursorPlaintext;
		expect(encodeHistoryCursor(seam, reordered)).toEqual(expect.any(String));
		expect(captured).toBe(
			JSON.stringify({ ...plaintext(), anchor: { eventAt: anchor.eventAt, id: anchor.id } }),
		);
	});

	it("rejects owner/filter/limit mismatch and source mismatch with distinct precedence", () => {
		const encryptor = new Encryptor(KEY);
		const token = encodeHistoryCursor(encryptor, plaintext())!;
		expect(decodeHistoryCursor(encryptor, token, context({ expectedOwnerId: "owner-b" }))).toEqual({
			kind: "invalid",
		});
		expect(
			decodeHistoryCursor(encryptor, token, context({ expectedFilterDigest: "b".repeat(64) })),
		).toEqual({
			kind: "invalid",
		});
		expect(decodeHistoryCursor(encryptor, token, context({ expectedLimit: 3 }))).toEqual({
			kind: "invalid",
		});
		expect(
			decodeHistoryCursor(
				encryptor,
				token,
				context({ expectedSourceStateDigest: OTHER_SOURCE_DIGEST }),
			),
		).toEqual({ kind: "stale" });
	});

	it.each([
		"",
		"not-base64!",
		"eyJ2ZXJzaW9uIjoxfQ", // valid base64url but missing envelope keys
		"A".repeat(4097),
	])("returns generic invalid for malformed token %s", (token) => {
		const encryptor = new Encryptor(KEY);
		expect(decodeHistoryCursor(encryptor, token, context())).toEqual({ kind: "invalid" });
	});

	it("rejects tamper, truncation, noncanonical base64, envelope extras, and decrypt errors", () => {
		const encryptor = new Encryptor(KEY);
		const token = encodeHistoryCursor(encryptor, plaintext())!;
		const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
		expect(decodeHistoryCursor(encryptor, tampered, context())).toEqual({ kind: "invalid" });
		expect(decodeHistoryCursor(encryptor, token.slice(1), context())).toEqual({ kind: "invalid" });
		const outer = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		const validOuter = { ...outer };
		outer.extra = true;
		const extra = Buffer.from(JSON.stringify(outer)).toString("base64url");
		expect(decodeHistoryCursor(encryptor, extra, context())).toEqual({ kind: "invalid" });
		for (const field of ["value", "iv"] as const) {
			const invalidBase64 = { ...validOuter, [field]: "not canonical!!!" };
			const invalidToken = Buffer.from(JSON.stringify(invalidBase64)).toString("base64url");
			expect(decodeHistoryCursor(encryptor, invalidToken, context())).toEqual({ kind: "invalid" });
		}
		const reorderedEnvelope = Buffer.from(
			JSON.stringify({ iv: validOuter.iv, value: validOuter.value, version: 1 }),
		).toString("base64url");
		const validPlaintextDecryptor = {
			decrypt: () => JSON.stringify(plaintext()),
			encrypt: encryptor.encrypt.bind(encryptor),
		};
		expect(decodeHistoryCursor(validPlaintextDecryptor, reorderedEnvelope, context())).toEqual({
			kind: "invalid",
		});
		const alternateValue = Buffer.from(
			JSON.stringify({ ...validOuter, value: validOuter.value.replace(/=+$/u, "") }),
		).toString("base64url");
		expect(decodeHistoryCursor(validPlaintextDecryptor, alternateValue, context())).toEqual({
			kind: "invalid",
		});
		const reorderedPlaintext = {
			sourceStateDigest: SOURCE_DIGEST,
			anchor: null,
			limit: 2,
			filterDigest: FILTER_DIGEST,
			snapshotAt: "2026-09-03T11:59:00.000Z",
			expiresAt: "2026-09-03T12:30:00.000Z",
			issuedAt: NOW,
			ownerId: OWNER,
			version: 1,
		};
		const reorderedPlaintextDecryptor = {
			decrypt: () => JSON.stringify(reorderedPlaintext),
			encrypt: encryptor.encrypt.bind(encryptor),
		};
		expect(decodeHistoryCursor(reorderedPlaintextDecryptor, token, context())).toEqual({
			kind: "invalid",
		});
		const mocked = {
			decrypt: () => {
				throw new Error("secret detail");
			},
			encrypt: encryptor.encrypt.bind(encryptor),
		};
		expect(decodeHistoryCursor(mocked, token, context())).toEqual({ kind: "invalid" });
		const oversizedDecrypted = {
			decrypt: () => "x".repeat(4097),
			encrypt: encryptor.encrypt.bind(encryptor),
		};
		expect(decodeHistoryCursor(oversizedDecrypted, token, context())).toEqual({ kind: "invalid" });
		const missingPlaintextKey = {
			decrypt: () => JSON.stringify({ ...plaintext(), limit: undefined }),
			encrypt: encryptor.encrypt.bind(encryptor),
		};
		expect(decodeHistoryCursor(missingPlaintextKey, token, context())).toEqual({ kind: "invalid" });
	});

	it("rejects an extra plaintext key after a valid outer envelope is decrypted", () => {
		const encryptor = new Encryptor(KEY);
		const token = encodeHistoryCursor(encryptor, plaintext())!;
		let decryptCalls = 0;
		const seam = {
			decrypt: () => {
				decryptCalls += 1;
				return JSON.stringify({ ...plaintext(), extra: "not allowed" });
			},
			encrypt: encryptor.encrypt.bind(encryptor),
		};
		expect(decodeHistoryCursor(seam, token, context())).toEqual({ kind: "invalid" });
		expect(decryptCalls).toBe(1);
	});

	it("rejects reordered nested anchor keys after a valid outer envelope is decrypted", () => {
		const encryptor = new Encryptor(KEY);
		const token = encodeHistoryCursor(encryptor, plaintext())!;
		let decryptCalls = 0;
		const seam = {
			decrypt: () => {
				decryptCalls += 1;
				return JSON.stringify({
					...plaintext(),
					anchor: { id: "observation-1", eventAt: "2026-09-03T11:30:00.000Z" },
				});
			},
			encrypt: encryptor.encrypt.bind(encryptor),
		};
		expect(decodeHistoryCursor(seam, token, context())).toEqual({ kind: "invalid" });
		expect(decryptCalls).toBe(1);
	});

	it.each([
		{ expiresAt: "2026-09-03T12:29:59.999Z" },
		{ expiresAt: "2026-09-03T12:30:00.001Z" },
		{ issuedAt: "2026-09-03T12:00:00Z" },
		{ snapshotAt: "2026-09-03T12:00:00.001Z" },
		{ filterDigest: "A".repeat(64) },
		{ ownerId: "https://owner" },
		{ limit: 0 },
		{ limit: 101 },
		{ anchor: { eventAt: NOW, id: "bad\n" } },
	])("rejects invalid plaintext shape %j", (changes) => {
		const encryptor = new Encryptor(KEY);
		const token = encodeHistoryCursor(encryptor, plaintext(changes));
		expect(token).toBeNull();
	});

	it("returns invalid at exact expiry and for future-issued cursors", () => {
		const encryptor = new Encryptor(KEY);
		const expired = encodeHistoryCursor(encryptor, plaintext())!;
		expect(
			decodeHistoryCursor(encryptor, expired, context({ now: "2026-09-03T12:30:00.000Z" })),
		).toEqual({
			kind: "invalid",
		});
		const future = encodeHistoryCursor(
			encryptor,
			plaintext({ issuedAt: "2026-09-03T12:01:00.000Z", expiresAt: "2026-09-03T12:31:00.000Z" }),
		)!;
		expect(decodeHistoryCursor(encryptor, future, context())).toEqual({ kind: "invalid" });
	});
});
