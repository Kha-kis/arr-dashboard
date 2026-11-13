import { createHash } from "node:crypto";
import type { BackupData } from "@arr/shared";
import { z } from "zod";
import { createArrServiceFingerprint } from "../arr/service-fingerprint.js";
import type { Encryptor } from "../auth/encryption.js";
import type { ServiceInstance } from "../prisma.js";
import { searchGrabTargetSchema } from "../search/grab-selector.js";

export const GRAB_SAFETY_PAYLOAD_FIELDS = ["searchGrabAttempts", "searchGrabClaims"] as const;
type Row = Record<string, unknown>;
const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z
	.union([z.date(), z.string()])
	.refine((value) => Number.isFinite(new Date(value).getTime()));
const attemptSchema = z
	.object({
		id: z.string().uuid(),
		userId: id,
		intentId: z.string().uuid(),
		serviceInstanceId: id,
		connectionFingerprint: hash,
		targetHash: hash,
		encryptedTarget: z.string().min(1),
		targetIv: z.string().min(1),
		state: z.enum(["prepared", "submitting", "acknowledged", "rejected", "uncertain"]),
		outcomeCategory: z
			.enum([
				"transport-unconfirmed",
				"provider-rejected",
				"interrupted-before-dispatch",
				"interrupted-after-marker",
				"predecessor-acknowledged",
			])
			.nullable(),
		workerEpoch: id.nullable(),
		predecessorId: z.string().uuid().nullable(),
		requestedAt: date,
		updatedAt: date,
		dispatchedAt: date.nullable(),
		completedAt: date.nullable(),
	})
	.strict();
const claimSchema = z
	.object({
		userId: id,
		serviceInstanceId: id,
		targetHash: hash,
		attemptId: z.string().uuid(),
		createdAt: date,
	})
	.strict();
const minimalSchema = searchGrabTargetSchema
	.pick({ guid: true, indexerId: true })
	.extend({ purpose: z.literal("arr-dashboard:search-grab-target"), version: z.literal(1) })
	.strict();
function invalid(): never {
	throw new Error("Invalid portable Grab safety backup state");
}
function check(condition: unknown): asserts condition {
	if (!condition) invalid();
}
function rows(value: unknown): Row[] {
	check(Array.isArray(value));
	return value.map((row) => {
		check(row && typeof row === "object" && !Array.isArray(row));
		return row;
	});
}
function unique<T>(values: T[], key: (value: T) => string): Map<string, T> {
	const result = new Map<string, T>();
	for (const value of values) {
		const k = key(value);
		check(!result.has(k));
		result.set(k, value);
	}
	return result;
}
export function portableGrabTargetHash(
	row: Pick<
		z.infer<typeof attemptSchema>,
		"userId" | "serviceInstanceId" | "connectionFingerprint"
	>,
	target: z.infer<typeof minimalSchema>,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"arr-dashboard:search-grab-target",
				1,
				row.userId,
				row.serviceInstanceId,
				row.connectionFingerprint,
				target.guid,
				target.indexerId,
			]),
		)
		.digest("hex");
}

/** Pure graph validation; a historical predecessor is evidence, never a new claim. */
export function validatePortableGrabSafety(data: BackupData["data"]): void {
	if (data.searchGrabAttempts === undefined && data.searchGrabClaims === undefined) return;
	const parsedAttempts = z.array(attemptSchema).safeParse(data.searchGrabAttempts),
		parsedClaims = z.array(claimSchema).safeParse(data.searchGrabClaims);
	check(parsedAttempts.success && parsedClaims.success);
	const attempts = parsedAttempts.data,
		claims = parsedClaims.data;
	const byId = unique(attempts, (row) => row.id),
		users = unique(rows(data.users), (row) => String(row.id)),
		instances = unique(rows(data.serviceInstances), (row) => String(row.id));
	unique(attempts, (row) => JSON.stringify([row.userId, row.intentId]));
	const remainingChildren = new Map<string, number>();
	for (const row of attempts)
		if (row.predecessorId !== null)
			remainingChildren.set(row.predecessorId, (remainingChildren.get(row.predecessorId) ?? 0) + 1);
	const byClaim = unique(claims, (row) => row.attemptId);
	unique(claims, (row) => JSON.stringify([row.userId, row.serviceInstanceId, row.targetHash]));
	for (const attempt of attempts) {
		check(users.has(attempt.userId));
		const requested = new Date(attempt.requestedAt).getTime(),
			updated = new Date(attempt.updatedAt).getTime();
		check(requested <= updated);
		if (attempt.dispatchedAt !== null)
			check(
				requested <= new Date(attempt.dispatchedAt).getTime() &&
					new Date(attempt.dispatchedAt).getTime() <= updated,
			);
		if (attempt.completedAt !== null)
			check(
				new Date(attempt.completedAt).getTime() >=
					(attempt.dispatchedAt === null ? requested : new Date(attempt.dispatchedAt).getTime()) &&
					new Date(attempt.completedAt).getTime() <= updated,
			);
		if (attempt.state === "prepared")
			check(
				attempt.dispatchedAt === null &&
					attempt.completedAt === null &&
					attempt.outcomeCategory === null,
			);
		if (["submitting", "uncertain", "acknowledged"].includes(attempt.state))
			check(attempt.dispatchedAt !== null);
		if (["acknowledged", "rejected"].includes(attempt.state)) check(attempt.completedAt !== null);
		if (attempt.state === "prepared" || attempt.state === "submitting")
			check(attempt.completedAt === null);
		if (attempt.predecessorId !== null) {
			const previous = byId.get(attempt.predecessorId);
			check(
				previous &&
					previous.id !== attempt.id &&
					previous.userId === attempt.userId &&
					previous.serviceInstanceId === attempt.serviceInstanceId &&
					previous.connectionFingerprint === attempt.connectionFingerprint &&
					previous.targetHash === attempt.targetHash &&
					previous.dispatchedAt !== null &&
					["uncertain", "acknowledged", "rejected"].includes(previous.state),
			);
		}
	}
	// Iterative path marking avoids recursion/stack exhaustion for long histories.
	const visited = new Set<string>();
	for (const attempt of attempts) {
		let cursor: typeof attempt | undefined = attempt;
		const path = new Set<string>();
		while (cursor && !visited.has(cursor.id)) {
			check(!path.has(cursor.id));
			path.add(cursor.id);
			cursor = cursor.predecessorId === null ? undefined : byId.get(cursor.predecessorId);
		}
		for (const key of path) visited.add(key);
	}
	// Rejected retries remain history. A rejected intermediate node can still
	// lead to a live successor, so count effective branches bottom-up, not just
	// immediate non-rejected children. Never admit two surviving confirmations.
	const effectiveChildren = new Map<string, number>();
	const leaves = attempts.filter((row) => !remainingChildren.has(row.id));
	while (leaves.length) {
		const attempt = leaves.pop()!;
		const effective = effectiveChildren.get(attempt.id) ?? 0;
		check(effective <= 1);
		if (
			attempt.state === "prepared" ||
			attempt.state === "submitting" ||
			(attempt.state === "uncertain" && effective === 0)
		)
			check(byClaim.has(attempt.id));
		if (attempt.predecessorId !== null) {
			const parent = attempt.predecessorId;
			if (attempt.state !== "rejected" || effective > 0)
				effectiveChildren.set(parent, (effectiveChildren.get(parent) ?? 0) + 1);
			const remaining = remainingChildren.get(parent)! - 1;
			remainingChildren.set(parent, remaining);
			if (remaining === 0) leaves.push(byId.get(parent)!);
		}
	}
	for (const claim of claims) {
		const attempt = byId.get(claim.attemptId),
			instance = instances.get(claim.serviceInstanceId);
		check(
			attempt &&
				instance &&
				users.has(claim.userId) &&
				instance.userId === claim.userId &&
				instance.service === "PROWLARR" &&
				attempt.userId === claim.userId &&
				attempt.serviceInstanceId === claim.serviceInstanceId &&
				attempt.targetHash === claim.targetHash &&
				["prepared", "submitting", "uncertain"].includes(attempt.state) &&
				(effectiveChildren.get(attempt.id) ?? 0) === 0,
		);
	}
}

/** Authenticate the bounded minimal tuple against its recorded exact proof. */
export function validatePortableGrabTarget(
	row: Row,
	plaintext: string,
): z.infer<typeof minimalSchema> {
	check(Buffer.byteLength(plaintext, "utf8") <= 32768);
	let raw: unknown;
	try {
		raw = JSON.parse(plaintext);
	} catch {
		invalid();
	}
	const parsed = minimalSchema.safeParse(raw);
	check(parsed.success);
	const attempt = attemptSchema.safeParse(row);
	check(attempt.success);
	check(
		searchGrabTargetSchema.safeParse({
			userId: attempt.data.userId,
			serviceInstanceId: attempt.data.serviceInstanceId,
			connectionFingerprint: attempt.data.connectionFingerprint,
			guid: parsed.data.guid,
			indexerId: parsed.data.indexerId,
		}).success,
	);
	check(portableGrabTargetHash(attempt.data, parsed.data) === attempt.data.targetHash);
	return parsed.data;
}

/** Representation migration only. Stale proofs stay stale; no worker survives. */
export function translatePortableGrabSafety(
	original: BackupData["data"],
	translated: BackupData["data"],
	source: Encryptor,
	destination: Encryptor,
): void {
	validatePortableGrabSafety(original);
	if (original.searchGrabAttempts === undefined) return;
	const before = rows(original.searchGrabAttempts),
		after = rows(translated.searchGrabAttempts);
	check(before.length === after.length);
	const incoming = unique(rows(original.serviceInstances), (row) => String(row.id)),
		outgoing = unique(rows(translated.serviceInstances), (row) => String(row.id));
	for (let index = 0; index < before.length; index++) {
		const old = before[index]!,
			next = after[index]!;
		check(
			Object.entries(old).every(
				([key, value]) => key === "encryptedTarget" || key === "targetIv" || next[key] === value,
			),
		);
		const plaintext = source.decrypt({
				value: old.encryptedTarget as string,
				iv: old.targetIv as string,
			}),
			target = validatePortableGrabTarget(old, plaintext);
		check(
			destination.decrypt({
				value: next.encryptedTarget as string,
				iv: next.targetIv as string,
			}) === plaintext,
		);
		const instance = incoming.get(String(old.serviceInstanceId)),
			replacement = outgoing.get(String(old.serviceInstanceId));
		if (
			instance &&
			replacement &&
			instance.userId === old.userId &&
			instance.service === "PROWLARR" &&
			createArrServiceFingerprint(instance as unknown as ServiceInstance) ===
				old.connectionFingerprint
		) {
			next.connectionFingerprint = createArrServiceFingerprint(
				replacement as unknown as ServiceInstance,
			);
			next.targetHash = portableGrabTargetHash(
				next as unknown as z.infer<typeof attemptSchema>,
				target,
			);
		}
		next.workerEpoch = null;
	}
	const byId = unique(after, (row) => String(row.id));
	const originalClaims = rows(original.searchGrabClaims),
		claims = rows(translated.searchGrabClaims);
	check(originalClaims.length === claims.length);
	for (let index = 0; index < claims.length; index++) {
		const claim = claims[index]!,
			old = originalClaims[index]!;
		check(Object.entries(old).every(([key, value]) => claim[key] === value));
		const attempt = byId.get(String(claim.attemptId));
		check(attempt);
		claim.targetHash = attempt.targetHash;
	}
	validatePortableGrabSafety(translated);
}
