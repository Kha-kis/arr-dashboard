import {
	HISTORY_CURSOR_MAX_LENGTH,
	HISTORY_IDENTIFIER_TEXT_MAX_LENGTH,
	HISTORY_PAGE_MAX_ITEMS,
} from "@arr/shared";
import type { Encryptor } from "../auth/encryption.js";

export type HistoryCursorAnchor = { eventAt: string; id: string };
export type HistoryCursorPlaintext = {
	version: 1;
	ownerId: string;
	issuedAt: string;
	expiresAt: string;
	snapshotAt: string;
	filterDigest: string;
	limit: number;
	anchor: HistoryCursorAnchor | null;
	sourceStateDigest: string;
};
export type HistoryCursorDecodeContext = {
	now: Date | string;
	expectedOwnerId: string;
	expectedFilterDigest: string;
	expectedLimit: number;
	expectedSourceStateDigest: string;
};
export type HistoryCursorDecodeResult =
	| { kind: "valid"; cursor: HistoryCursorPlaintext }
	| { kind: "invalid" }
	| { kind: "stale" };

const TTL_MS = 1_800_000;
const CANONICAL_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST = /^[a-f0-9]{64}$/;
const URL_LIKE = /(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b(?:data|mailto|magnet):)/iu;
const MAX_PLAINTEXT_BYTES = HISTORY_CURSOR_MAX_LENGTH;
const ENVELOPE_KEYS = ["version", "value", "iv"] as const;
const PLAINTEXT_KEYS = [
	"version",
	"ownerId",
	"issuedAt",
	"expiresAt",
	"snapshotAt",
	"filterDigest",
	"limit",
	"anchor",
	"sourceStateDigest",
] as const;
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: RecordValue, keys: readonly string[]): boolean {
	const expected = [...keys].sort();
	const actual = Object.keys(value).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= HISTORY_IDENTIFIER_TEXT_MAX_LENGTH &&
		value === value.trim() &&
		![...value].some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) &&
		!URL_LIKE.test(value)
	);
}

function canonicalDate(value: unknown): value is string {
	if (typeof value !== "string" || !CANONICAL_DATE.test(value)) return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function canonicalDigest(value: unknown): value is string {
	return typeof value === "string" && DIGEST.test(value);
}

function canonicalBase64(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
		return false;
	try {
		return Buffer.from(value, "base64").toString("base64") === value;
	} catch {
		return false;
	}
}

function canonicalBase64Url(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > HISTORY_CURSOR_MAX_LENGTH ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	)
		return false;
	try {
		return Buffer.from(value, "base64url").toString("base64url") === value;
	} catch {
		return false;
	}
}

function bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function canonicalPlaintext(value: HistoryCursorPlaintext): string {
	return JSON.stringify({
		version: value.version,
		ownerId: value.ownerId,
		issuedAt: value.issuedAt,
		expiresAt: value.expiresAt,
		snapshotAt: value.snapshotAt,
		filterDigest: value.filterDigest,
		limit: value.limit,
		anchor: value.anchor === null ? null : { eventAt: value.anchor.eventAt, id: value.anchor.id },
		sourceStateDigest: value.sourceStateDigest,
	});
}

function parseTrustedDate(value: Date | string): Date | null {
	if (value instanceof Date)
		return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
	if (!canonicalDate(value)) return null;
	return new Date(value);
}

function validPlaintext(value: unknown): value is HistoryCursorPlaintext {
	if (
		!isRecord(value) ||
		!exactKeys(value, PLAINTEXT_KEYS) ||
		value.version !== 1 ||
		!safeText(value.ownerId)
	)
		return false;
	if (
		!canonicalDate(value.issuedAt) ||
		!canonicalDate(value.expiresAt) ||
		!canonicalDate(value.snapshotAt)
	)
		return false;
	if (!canonicalDigest(value.filterDigest) || !canonicalDigest(value.sourceStateDigest))
		return false;
	if (
		typeof value.limit !== "number" ||
		!Number.isSafeInteger(value.limit) ||
		value.limit < 1 ||
		value.limit > HISTORY_PAGE_MAX_ITEMS
	)
		return false;
	const issued = Date.parse(value.issuedAt);
	const expires = Date.parse(value.expiresAt);
	const snapshot = Date.parse(value.snapshotAt);
	if (expires !== issued + TTL_MS || snapshot > issued) return false;
	if (value.anchor !== null) {
		if (
			!isRecord(value.anchor) ||
			!exactKeys(value.anchor, ["eventAt", "id"]) ||
			!canonicalDate(value.anchor.eventAt) ||
			!safeText(value.anchor.id)
		)
			return false;
	}
	return true;
}

export function encodeHistoryCursor(
	encryptor: Pick<Encryptor, "encrypt" | "decrypt">,
	cursor: HistoryCursorPlaintext,
): string | null {
	if (!validPlaintext(cursor)) return null;
	const plaintext = canonicalPlaintext(cursor);
	if (bytes(plaintext) > MAX_PLAINTEXT_BYTES) return null;
	try {
		const encrypted = encryptor.encrypt(plaintext);
		if (!isRecord(encrypted) || !exactKeys(encrypted, ["value", "iv"])) return null;
		if (!canonicalBase64(encrypted.value) || !canonicalBase64(encrypted.iv)) return null;
		const valueBytes = Buffer.from(encrypted.value, "base64");
		const ivBytes = Buffer.from(encrypted.iv, "base64");
		if (valueBytes.byteLength < 16 || ivBytes.byteLength !== 12) return null;
		const envelope = JSON.stringify({ version: 1, value: encrypted.value, iv: encrypted.iv });
		const token = Buffer.from(envelope, "utf8").toString("base64url");
		return token.length <= HISTORY_CURSOR_MAX_LENGTH ? token : null;
	} catch {
		return null;
	}
}

export function decodeHistoryCursor(
	encryptor: Pick<Encryptor, "encrypt" | "decrypt">,
	token: unknown,
	context: HistoryCursorDecodeContext,
): HistoryCursorDecodeResult {
	if (!canonicalBase64Url(token)) return { kind: "invalid" };
	let envelopeBytes: Buffer;
	try {
		envelopeBytes = Buffer.from(token, "base64url");
		if (envelopeBytes.byteLength > MAX_PLAINTEXT_BYTES) return { kind: "invalid" };
		const envelopeText = envelopeBytes.toString("utf8");
		const envelope = JSON.parse(envelopeText) as unknown;
		if (
			!isRecord(envelope) ||
			!exactKeys(envelope, ENVELOPE_KEYS) ||
			envelope.version !== 1 ||
			!canonicalBase64(envelope.value) ||
			!canonicalBase64(envelope.iv)
		)
			return { kind: "invalid" };
		if (
			Buffer.from(envelope.value, "base64").byteLength < 16 ||
			Buffer.from(envelope.iv, "base64").byteLength !== 12
		)
			return { kind: "invalid" };
		if (JSON.stringify({ version: 1, value: envelope.value, iv: envelope.iv }) !== envelopeText)
			return { kind: "invalid" };
		const decrypted = encryptor.decrypt({ value: envelope.value, iv: envelope.iv });
		if (typeof decrypted !== "string" || bytes(decrypted) > MAX_PLAINTEXT_BYTES)
			return { kind: "invalid" };
		const plaintext = JSON.parse(decrypted) as unknown;
		if (!validPlaintext(plaintext) || canonicalPlaintext(plaintext) !== decrypted)
			return { kind: "invalid" };
		const now = parseTrustedDate(context.now);
		if (
			!now ||
			!safeText(context.expectedOwnerId) ||
			!canonicalDigest(context.expectedFilterDigest) ||
			!canonicalDigest(context.expectedSourceStateDigest) ||
			!Number.isSafeInteger(context.expectedLimit) ||
			context.expectedLimit < 1 ||
			context.expectedLimit > HISTORY_PAGE_MAX_ITEMS
		)
			return { kind: "invalid" };
		if (
			Date.parse(plaintext.issuedAt) > now.getTime() ||
			now.getTime() >= Date.parse(plaintext.expiresAt)
		)
			return { kind: "invalid" };
		if (
			plaintext.ownerId !== context.expectedOwnerId ||
			plaintext.filterDigest !== context.expectedFilterDigest ||
			plaintext.limit !== context.expectedLimit
		)
			return { kind: "invalid" };
		if (plaintext.sourceStateDigest !== context.expectedSourceStateDigest) return { kind: "stale" };
		return { kind: "valid", cursor: plaintext };
	} catch {
		return { kind: "invalid" };
	}
}

export function advanceHistoryCursor(
	cursor: HistoryCursorPlaintext,
	anchor: HistoryCursorAnchor | null,
): HistoryCursorPlaintext | null {
	if (
		!validPlaintext(cursor) ||
		(anchor !== null &&
			(!isRecord(anchor) ||
				!exactKeys(anchor, ["eventAt", "id"]) ||
				!canonicalDate(anchor.eventAt) ||
				!safeText(anchor.id)))
	)
		return null;
	return { ...cursor, anchor: anchor === null ? null : { eventAt: anchor.eventAt, id: anchor.id } };
}

export const encodeHistoryReadCursor = encodeHistoryCursor;
export const decodeHistoryReadCursor = decodeHistoryCursor;
export const advanceHistoryReadCursor = advanceHistoryCursor;
