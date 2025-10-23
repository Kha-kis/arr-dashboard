/**
 * Profile Diff Service - Stub Implementation
 * Computes differences between quality profile configurations
 */

import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

export interface ProfileDiffResult<T = any> {
	added: T[];
	removed: T[];
	modified: Array<{ before: T; after: T; changes: string[] }>;
	unchanged: T[];
}

export class ProfileDiffService {
	constructor(
		private prisma: PrismaClient,
		private log: FastifyBaseLogger,
	) {}

	/**
	 * Compute diff between two sets of profiles
	 */
	async computeDiff<T extends { id?: number | string; name?: string }>(
		before: T[],
		after: T[],
	): Promise<ProfileDiffResult<T>> {
		this.log.debug({ beforeCount: before.length, afterCount: after.length }, "ProfileDiffService stub: computeDiff");

		const keyOf = (x: T) => String(x.id ?? x.name ?? JSON.stringify(x));
		const beforeMap = new Map(before.map((x) => [keyOf(x), x]));
		const afterMap = new Map(after.map((x) => [keyOf(x), x]));

		const added: T[] = [];
		const removed: T[] = [];
		const modified: Array<{ before: T; after: T; changes: string[] }> = [];
		const unchanged: T[] = [];

		// Check after items
		for (const [k, v] of afterMap) {
			if (!beforeMap.has(k)) {
				added.push(v);
			} else {
				const beforeItem = beforeMap.get(k) as T;
				if (JSON.stringify(beforeItem) !== JSON.stringify(v)) {
					modified.push({
						before: beforeItem,
						after: v,
						changes: ["Content changed"], // Stub: simplified change detection
					});
				} else {
					unchanged.push(v);
				}
			}
		}

		// Check for removed items
		for (const [k, v] of beforeMap) {
			if (!afterMap.has(k)) {
				removed.push(v);
			}
		}

		return { added, removed, modified, unchanged };
	}
}
