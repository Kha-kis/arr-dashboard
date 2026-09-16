import type { PrismaClient } from "../prisma.js";
import { readCompleteNativeLibrary } from "./inventory-connection-repository.js";
import {
	arrConnectionIds,
	createArrConnectionIndex,
	normalizeConnectionIds,
	resolveArrConnection,
	type ArrConnectionItem,
} from "./inventory-connections.js";
import { readNativeInventoryPage, type NativeInventoryRow } from "./native-inventory.js";

export interface NativePresenceEvidence {
	userId: string;
	instanceId: string;
	generationId: string;
	index: Map<string, NativeInventoryRow[]>;
}
export type NativePresenceContext = Map<string, NativePresenceEvidence>;
export type NativePresenceResult =
	| "present"
	| "provider-unavailable"
	| "missing-identifiers"
	| "no-verified-match"
	| "ambiguous-match";

export function createNativePresenceEvidence(
	userId: string,
	instanceId: string,
	generationId: string,
	rows: readonly NativeInventoryRow[],
): NativePresenceEvidence {
	const index = new Map<string, NativeInventoryRow[]>();
	for (const row of rows) {
		const ids = normalizeConnectionIds(row.externalIds);
		for (const family of ["tmdb", "tvdb"] as const) {
			for (const id of ids[family] ?? []) {
				const key = `${row.mediaType}:${family}:${id}`;
				const matches = index.get(key) ?? [];
				matches.push(row);
				index.set(key, matches);
			}
		}
	}
	return { userId, instanceId, generationId, index };
}

export function resolveNativePresence(
	item: ArrConnectionItem,
	evidence: NativePresenceEvidence | undefined,
): NativePresenceResult {
	if (!evidence) return "provider-unavailable";
	const ids = arrConnectionIds(item.data);
	if (!ids.tmdb?.length && !ids.tvdb?.length) return "missing-identifiers";
	const candidates = new Map<string, NativeInventoryRow>();
	for (const family of ["tmdb", "tvdb"] as const) {
		for (const id of ids[family] ?? []) {
			for (const row of evidence.index.get(`${item.itemType}:${family}:${id}`) ?? [])
				candidates.set(row.nativeId, row);
		}
	}
	if (candidates.size === 0) return "no-verified-match";
	if (candidates.size !== 1) return "ambiguous-match";
	const index = createArrConnectionIndex([item]);
	const row = candidates.values().next().value;
	return row && resolveArrConnection(row, index, item.instanceId).status === "matched"
		? "present"
		: "ambiguous-match";
}

/** Only auto-tagging requests this evidence; ordinary ARR rules perform no provider reads. */
export async function loadNativePresenceContext(
	prisma: PrismaClient,
	userId: string,
	instanceIds: readonly string[],
	previous?: NativePresenceContext,
): Promise<NativePresenceContext> {
	const context: NativePresenceContext = new Map();
	for (const instanceId of new Set(instanceIds)) {
		try {
			const instance = await prisma.serviceInstance.findFirst({
				where: { id: instanceId, userId, enabled: true, service: { in: ["PLEX", "JELLYFIN"] } },
				select: { id: true },
			});
			if (!instance) continue;
			const prior = previous?.get(instanceId);
			if (prior?.userId === userId) {
				const current = await readNativeInventoryPage(prisma, {
					userId,
					instanceId,
					domain: "library",
					limit: 1,
					expectedGenerationId: prior.generationId,
				});
				if (current.status === "available" && current.complete && current.freshness === "current") {
					context.set(instanceId, prior);
					continue;
				}
			}
			const publication = await readCompleteNativeLibrary(prisma, { userId, instanceId });
			if (publication?.complete && publication.freshness === "current") {
				context.set(
					instanceId,
					createNativePresenceEvidence(
						userId,
						instanceId,
						publication.generationId,
						publication.rows,
					),
				);
			}
		} catch {
			/* An unavailable dependency remains UNKNOWN and never authorizes a tag. */
		}
	}
	return context;
}

export function collectNativePresenceInstances(
	rules: readonly {
		ruleType: string;
		parameters: Record<string, unknown>;
		conditions?: readonly { ruleType: string; parameters: Record<string, unknown> }[] | null;
	}[],
): string[] {
	const ids = new Set<string>();
	for (const rule of rules) {
		for (const condition of rule.ruleType === "composite" ? (rule.conditions ?? []) : [rule]) {
			if (
				condition.ruleType === "media_server_presence" &&
				typeof condition.parameters.instanceId === "string" &&
				condition.parameters.instanceId.trim()
			)
				ids.add(condition.parameters.instanceId);
		}
	}
	return [...ids];
}
