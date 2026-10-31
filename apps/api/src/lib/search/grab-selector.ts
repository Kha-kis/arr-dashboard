import { z } from "zod";
import type { Encryptor } from "../auth/encryption.js";

const PURPOSE = "arr-dashboard:search-grab-selector";
const LIFETIME_MS = 30 * 60 * 1000;
const MAX_SELECTOR_LENGTH = 16_384;
const MAX_CLOCK = Number.MAX_SAFE_INTEGER - LIFETIME_MS;

function exactBoundedString(maxBytes: number) {
	return z
		.string()
		.min(1)
		.max(maxBytes)
		.refine(
			(value) =>
				value.trim() === value &&
				Array.from(value).every((character) => {
					const code = character.charCodeAt(0);
					return code >= 32 && code !== 127;
				}) &&
				Buffer.byteLength(value, "utf8") <= maxBytes,
		);
}

const bindingSchema = z
	.object({
		userId: exactBoundedString(128),
		serviceInstanceId: exactBoundedString(128),
		connectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const targetSchema = bindingSchema
	.extend({
		guid: exactBoundedString(4096),
		indexerId: z.number().int().positive(),
	})
	.strict();
const clockSchema = z.number().int().nonnegative().max(MAX_CLOCK);
const claimsSchema = targetSchema
	.extend({
		purpose: z.literal(PURPOSE),
		version: z.literal(1),
		issuedAt: clockSchema,
		expiresAt: z.number().int().nonnegative(),
	})
	.strict()
	.refine((claims) => claims.expiresAt === claims.issuedAt + LIFETIME_MS);

export type SearchGrabBinding = z.infer<typeof bindingSchema>;
export type SearchGrabTarget = z.infer<typeof targetSchema>;
export { targetSchema as searchGrabTargetSchema };

/** Never include token, provider identity or cryptographic diagnostics in this error. */
export class SearchGrabSelectorError extends Error {
	constructor() {
		super("Search result cannot authorize a new submission; run a new search.");
		this.name = "SearchGrabSelectorError";
	}
}

export function issueSearchGrabSelector(
	encryptor: Encryptor,
	target: SearchGrabTarget,
	now = Date.now(),
): string {
	try {
		const verified = targetSchema.parse(target);
		const issuedAt = clockSchema.parse(now);
		const encrypted = encryptor.encrypt(
			JSON.stringify({
				purpose: PURPOSE,
				version: 1,
				...verified,
				issuedAt,
				expiresAt: issuedAt + LIFETIME_MS,
			}),
		);
		const selector = `sg1.${Buffer.from(encrypted.iv, "base64").toString("base64url")}.${Buffer.from(encrypted.value, "base64").toString("base64url")}`;
		if (selector.length > MAX_SELECTOR_LENGTH) throw new SearchGrabSelectorError();
		return selector;
	} catch {
		throw new SearchGrabSelectorError();
	}
}

function decodeEnvelope(selector: unknown): { iv: string; value: string } {
	if (typeof selector !== "string" || selector.length > MAX_SELECTOR_LENGTH) {
		throw new SearchGrabSelectorError();
	}
	const segments = selector.split(".");
	if (segments.length !== 3 || segments[0] !== "sg1") throw new SearchGrabSelectorError();
	const ivPart = segments[1]!;
	const valuePart = segments[2]!;
	if (!/^[A-Za-z0-9_-]{16}$/.test(ivPart) || !/^[A-Za-z0-9_-]+$/.test(valuePart)) {
		throw new SearchGrabSelectorError();
	}
	const iv = Buffer.from(ivPart, "base64url");
	const value = Buffer.from(valuePart, "base64url");
	if (
		iv.length !== 12 ||
		value.length < 17 ||
		iv.toString("base64url") !== ivPart ||
		value.toString("base64url") !== valuePart
	)
		throw new SearchGrabSelectorError();
	return { iv: iv.toString("base64"), value: value.toString("base64") };
}

/** For NEW admission only. Existing attempt status must not depend on selector validity. */
export function readSearchGrabSelector(
	encryptor: Encryptor,
	selector: unknown,
	expected: SearchGrabBinding,
	now = Date.now(),
): SearchGrabTarget {
	try {
		const binding = bindingSchema.parse(expected);
		const currentTime = clockSchema.parse(now);
		const claims = claimsSchema.parse(JSON.parse(encryptor.decrypt(decodeEnvelope(selector))));
		if (
			claims.userId !== binding.userId ||
			claims.serviceInstanceId !== binding.serviceInstanceId ||
			claims.connectionFingerprint !== binding.connectionFingerprint ||
			claims.issuedAt > currentTime ||
			claims.expiresAt <= currentTime
		)
			throw new SearchGrabSelectorError();
		return Object.freeze({
			userId: claims.userId,
			serviceInstanceId: claims.serviceInstanceId,
			connectionFingerprint: claims.connectionFingerprint,
			guid: claims.guid,
			indexerId: claims.indexerId,
		});
	} catch {
		throw new SearchGrabSelectorError();
	}
}

/** Observation only: never returns a target usable for new admission or dispatch. */
export function assertSearchGrabSelectorMatchesRecordedTarget(
	encryptor: Encryptor,
	selector: unknown,
	recorded: SearchGrabTarget,
	now = Date.now(),
): void {
	try {
		const expected = targetSchema.parse(recorded);
		const currentTime = clockSchema.parse(now);
		const claims = claimsSchema.parse(JSON.parse(encryptor.decrypt(decodeEnvelope(selector))));
		if (
			claims.userId !== expected.userId ||
			claims.serviceInstanceId !== expected.serviceInstanceId ||
			claims.connectionFingerprint !== expected.connectionFingerprint ||
			claims.guid !== expected.guid ||
			claims.indexerId !== expected.indexerId ||
			claims.issuedAt > currentTime
		)
			throw new SearchGrabSelectorError();
	} catch {
		throw new SearchGrabSelectorError();
	}
}
