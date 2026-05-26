/**
 * Unit tests for the qui webhook-secret module (Phase 5.1).
 *
 * The module is small but security-sensitive: it generates the secret
 * that authenticates inbound qui pushes. We assert:
 *   - The secret is long enough (256-bit entropy) and base64url-shaped.
 *   - The hash is deterministic and matches what `resolveUserFromQuiSecret`
 *     would look up.
 *   - Resolver short-circuits on missing/too-short secrets without
 *     hitting the DB (defense in depth — a malformed query never even
 *     gets to Prisma).
 */

import { describe, expect, it, vi } from "vitest";
import {
	generateQuiWebhookSecret,
	hashSecret,
	resolveUserFromQuiSecret,
} from "../webhook-secret.js";

describe("generateQuiWebhookSecret", () => {
	it("returns a base64url-shaped secret + matching hash", () => {
		const { plaintextSecret, hashedSecret } = generateQuiWebhookSecret();
		// 32 random bytes → 43 base64url chars (no padding).
		expect(plaintextSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		// SHA-256 hex digest is exactly 64 chars.
		expect(hashedSecret).toMatch(/^[a-f0-9]{64}$/);
		expect(hashedSecret).toBe(hashSecret(plaintextSecret));
	});

	it("returns different secrets on each call (entropy sanity)", () => {
		const a = generateQuiWebhookSecret();
		const b = generateQuiWebhookSecret();
		expect(a.plaintextSecret).not.toBe(b.plaintextSecret);
		expect(a.hashedSecret).not.toBe(b.hashedSecret);
	});
});

describe("hashSecret", () => {
	it("is deterministic — same input always yields same digest", () => {
		const input = "hello-world";
		expect(hashSecret(input)).toBe(hashSecret(input));
	});

	it("changes drastically with a single-byte input change (avalanche)", () => {
		const a = hashSecret("hello-world");
		const b = hashSecret("hello-worlD");
		// Hamming distance check — SHA-256 should differ by ~half the bits
		// for any input change. We don't compute exact distance, just assert
		// the digests don't share long common prefixes (a regression where
		// someone accidentally swaps in a Caesar cipher would fail this).
		expect(a.slice(0, 8)).not.toBe(b.slice(0, 8));
	});
});

describe("resolveUserFromQuiSecret", () => {
	it("returns null without touching Prisma when the secret is undefined", async () => {
		const prisma = {
			user: { findUnique: vi.fn() },
		} as never;
		const result = await resolveUserFromQuiSecret(prisma, undefined);
		expect(result).toBeNull();
		expect(
			(prisma as { user: { findUnique: ReturnType<typeof vi.fn> } }).user.findUnique,
		).not.toHaveBeenCalled();
	});

	it("returns null without touching Prisma when the secret is too short", async () => {
		const prisma = {
			user: { findUnique: vi.fn() },
		} as never;
		const result = await resolveUserFromQuiSecret(prisma, "short");
		expect(result).toBeNull();
		// Defense in depth — short secrets can't be real generated values
		// (those are 43 chars). Short-circuiting before the DB call avoids
		// burning a query on noise from random URL probes.
		expect(
			(prisma as { user: { findUnique: ReturnType<typeof vi.fn> } }).user.findUnique,
		).not.toHaveBeenCalled();
	});

	it("queries Prisma with the hash (not the plaintext)", async () => {
		const findUnique = vi.fn().mockResolvedValue({ id: "user-1" });
		const prisma = { user: { findUnique } } as never;
		const { plaintextSecret, hashedSecret } = generateQuiWebhookSecret();
		const result = await resolveUserFromQuiSecret(prisma, plaintextSecret);
		expect(result).toEqual({ id: "user-1" });
		expect(findUnique).toHaveBeenCalledWith({
			where: { hashedQuiWebhookSecret: hashedSecret },
		});
		// Critical: the WHERE clause MUST use the hash, never the plaintext.
		// A regression where plaintext leaks into a Prisma query would log
		// the secret to query logs and effectively defeat hashing-at-rest.
		const calledWith = findUnique.mock.calls[0]?.[0];
		expect(JSON.stringify(calledWith)).not.toContain(plaintextSecret);
	});
});
