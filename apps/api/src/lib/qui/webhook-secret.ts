/**
 * Per-user qui-webhook secret manager (Phase 5.1).
 *
 * Mirrors the bearer-token pattern in `auto-tag/webhook-handler.ts` but uses
 * a query-param scheme instead of an Authorization header — qui's
 * notification system delivers webhooks via `POST <url>?secret=...` (the
 * `ApiKeyQuery` security scheme in qui's openapi), and inverting that to
 * fit our existing Bearer-header receiver would require a custom shim
 * inside qui (which arr-dashboard doesn't own).
 *
 * Plaintext secret is returned ONLY at generation/rotation time — never
 * stored, only hashed. Operators paste it into qui's notification target
 * URL once. Re-displaying after that would require fresh rotation.
 */

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "../prisma.js";

const SECRET_BYTES = 32; // 256-bit, base64url-encoded → 43 chars

/**
 * Domain prefix mixed into the hash input. Two features in the codebase
 * use SHA-256 of a per-user secret to authenticate webhooks (auto-tag
 * Connect bearer; qui notification target). Without domain separation,
 * a user happening to reuse the same plaintext for both would get the
 * same hash in two columns — a leak of one column then unlocks the
 * other. Prefixing with a domain string + version makes the two hash
 * spaces disjoint by construction.
 *
 * The version segment (`v1`) lets us rotate the prefix in the future
 * without breaking existing secrets — we'd accept both old + new hashes
 * during a transition window.
 *
 * Auto-tag has already shipped, so it can't add domain separation
 * without breaking deployed secrets. qui is unshipped (this branch),
 * so applying the prefix from day one carries no migration cost.
 */
const QUI_HASH_DOMAIN = "qui-webhook-v1:";

/**
 * Generated qui secrets are base64url of 32 random bytes (43 chars, no
 * padding). The receiver pre-checks this shape before hashing so a
 * malformed inbound secret produces a sharper 401 (and skips a DB lookup
 * on noise from random URL probes). 22 = base64url(16 bytes) lower
 * bound; 86 = base64url(64 bytes) upper bound — a generous range in
 * case we ever issue longer tokens.
 */
const SECRET_SHAPE_RE = /^[A-Za-z0-9_-]{22,86}$/;

export interface SecretGenerationResult {
	plaintextSecret: string;
	hashedSecret: string;
}

/**
 * Generate a fresh secret + its hash. Returns both so the caller can stash
 * the hash and surface the plaintext to the user.
 */
export function generateQuiWebhookSecret(): SecretGenerationResult {
	const buf = randomBytes(SECRET_BYTES);
	const plaintextSecret = buf.toString("base64url");
	const hashedSecret = hashSecret(plaintextSecret);
	return { plaintextSecret, hashedSecret };
}

/**
 * Hash a webhook secret. Pure function — same input always yields the same
 * hex digest. Domain-separated from auto-tag's hash space via
 * `QUI_HASH_DOMAIN` (see comment on the constant for rationale).
 */
export function hashSecret(secret: string): string {
	return createHash("sha256").update(`${QUI_HASH_DOMAIN}${secret}`).digest("hex");
}

/**
 * Resolve a query-param secret to a user. Returns null if the secret is
 * missing, shape-malformed, or unknown. The shape pre-check + hashing
 * mean a malformed inbound secret never reaches a DB query — short-
 * circuiting before Prisma avoids burning a lookup on random URL probes
 * and keeps the receiver fast even under attack noise.
 *
 * Constant-time concerns: Prisma's `findUnique` on an indexed hash
 * column is O(log n) on uniformly-distributed digest bytes; with SHA-256
 * of a 256-bit secret, B-tree traversal timing can't fingerprint the
 * original secret bits.
 */
export async function resolveUserFromQuiSecret(prisma: PrismaClient, secret: string | undefined) {
	if (!secret || !SECRET_SHAPE_RE.test(secret)) return null;
	const hashedSecret = hashSecret(secret);
	return prisma.user.findUnique({ where: { hashedQuiWebhookSecret: hashedSecret } });
}
