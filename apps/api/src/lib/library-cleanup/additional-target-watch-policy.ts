import {
	readJellyfinTargetWatchEvidence,
	revalidateJellyfinTargetWatchEvidence,
} from "../jellyfin/jellyfin-target-watch-evidence.js";
import {
	TargetWatchReadBudget,
	type TargetWatchReadPhase,
} from "../tautulli/target-watch-read-budget.js";
import {
	readTautulliTargetWatchEvidence,
	revalidateTautulliTargetWatchEvidence,
} from "../tautulli/tautulli-target-watch-evidence.js";
import { safeJsonParse } from "../utils/json.js";
import {
	decideProviderWatchCountFact,
	normalizeStoredCleanupRuleExpression,
} from "./rule-evaluators.js";
import type {
	CacheItemForEval,
	CleanupExecutorDeps,
	EvalContext,
	ProviderWatchCountFact,
} from "./types.js";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const READ_LIMIT_WARNING =
	"Tautulli watch checks reached the operation's provider read limit. Unchecked items remain unknown; this result is partial.";

export function withTargetWatchReadBudget(deps: CleanupExecutorDeps): CleanupExecutorDeps {
	return {
		...deps,
		targetWatchReadBudget: deps.targetWatchReadBudget ?? new TargetWatchReadBudget(),
	};
}

export function applyTargetWatchReadWarning(
	deps: CleanupExecutorDeps,
	result: { status?: string; warnings?: string[] },
): void {
	if (!deps.targetWatchReadBudget?.exhausted) return;
	if (result.status === "completed") result.status = "partial";
	result.warnings = [...new Set([...(result.warnings ?? []), READ_LIMIT_WARNING])];
}

/** Avoid live reads for predicates that positive-only evidence cannot establish. */
export function positiveTargetWatchRuleTypes(
	rules: readonly {
		enabled: boolean;
		ruleType: string;
		parameters?: string;
		operator?: string | null;
		conditions: string | null;
		targetScope?: string;
	}[],
): Set<string> {
	const types = new Set<string>();
	for (const rule of rules) {
		if (!rule.enabled || rule.targetScope === "episode") continue;
		const expression = normalizeStoredCleanupRuleExpression({
			...rule,
			parameters: rule.parameters ?? "{}",
			operator: rule.operator ?? null,
		});
		if (!expression) continue;
		const stack = [expression.root];
		while (stack.length) {
			const node = stack.pop()!;
			if (node.type === "group") stack.push(...node.children);
			else if (node.type === "not") stack.push(node.child);
			else if (
				(node.ruleType === "jellyfin_watch_count" || node.ruleType === "tautulli_watch_count") &&
				node.parameters.operator === "greater_than" &&
				typeof node.parameters.count === "number" &&
				Number.isSafeInteger(node.parameters.count) &&
				node.parameters.count >= 0
			)
				types.add(node.ruleType);
		}
	}
	return types;
}

type Target = { mediaType: "movie" | "series"; tmdbId: number };
type Condition = { ruleType: string; parameters: Record<string, unknown> };

function targetOf(item: CacheItemForEval): Target | undefined {
	if (item.itemType !== "movie" && item.itemType !== "series") return undefined;
	const value = safeJsonParse(item.data) as { remoteIds?: { tmdbId?: unknown } } | null;
	const id = value?.remoteIds?.tmdbId;
	return typeof id === "number" && Number.isSafeInteger(id) && id > 0
		? { mediaType: item.itemType, tmdbId: id }
		: undefined;
}

/** Additional families use their own target readers; generic evidence stays unchanged. */
export async function loadAdditionalTargetWatchFacts(
	deps: CleanupExecutorDeps,
	userId: string,
	items: readonly CacheItemForEval[],
	activeTypes: ReadonlySet<string>,
	existing?: EvalContext["providerWatchCountFacts"],
	options: { verifyPositiveCounts?: boolean; readPhase?: TargetWatchReadPhase } = {},
): Promise<Map<string, ProviderWatchCountFact[]>> {
	const result = new Map<string, ProviderWatchCountFact[]>();
	const encryptor = deps.encryptor;
	if (!encryptor) return result;
	const targets = [
		...new Map(
			items.flatMap((item) => {
				const target = targetOf(item);
				return target ? [[`${target.mediaType}:${target.tmdbId}`, target] as const] : [];
			}),
		).values(),
	];
	if (targets.length === 0) return result;
	for (const family of ["jellyfin", "tautulli"] as const) {
		if (!activeTypes.has(`${family}_watch_count`)) continue;
		if (
			family === "tautulli" &&
			options.readPhase !== "validation" &&
			deps.targetWatchReadBudget?.exhausted
		)
			continue;
		const provider = family === "jellyfin" ? "JELLYFIN" : "TAUTULLI";
		const missing = targets.filter(
			(target) =>
				!existing
					?.get(`${target.mediaType}:${target.tmdbId}`)
					?.some((fact) => fact.provider === provider && fact.targetScoped === true),
		);
		if (missing.length === 0) continue;
		for (let offset = 0; offset < missing.length; offset += 200) {
			const batch = missing.slice(offset, offset + 200);
			try {
				const proofs =
					family === "jellyfin"
						? (
								await Promise.all(
									(
										await deps.prisma.serviceInstance.findMany({
											where: { userId, enabled: true, service: "JELLYFIN" },
											select: { id: true },
										})
									).map((instance) =>
										readJellyfinTargetWatchEvidence({
											prisma: deps.prisma,
											userId,
											instanceId: instance.id,
											targets: batch,
											maxAgeMs: MAX_AGE_MS,
										}),
									),
								)
							).flat()
						: await readTautulliTargetWatchEvidence({
								prisma: deps.prisma,
								encryptor,
								userId,
								targets: batch,
								maxAgeMs: MAX_AGE_MS,
								readBudget: deps.targetWatchReadBudget,
								readPhase: options.readPhase ?? "discovery",
							});
				for (const proof of proofs) {
					const targetKey = `${proof.mediaType}:${proof.tmdbId}`;
					if (
						proof.userId !== userId ||
						!missing.some(
							(target) => target.mediaType === proof.mediaType && target.tmdbId === proof.tmdbId,
						)
					)
						continue;
					if (options.verifyPositiveCounts) {
						if (!Number.isSafeInteger(proof.observedValue) || proof.observedValue <= 0) continue;
						const input = {
							prisma: deps.prisma,
							encryptor,
							userId,
							instanceId: proof.instanceId,
							mediaType: proof.mediaType,
							tmdbId: proof.tmdbId,
							coordinate: proof.coordinate,
							generationId: proof.generationId,
							threshold: proof.observedValue - 1,
							maxAgeMs: MAX_AGE_MS,
							readBudget: deps.targetWatchReadBudget,
							readPhase: options.readPhase ?? "discovery",
						};
						const verified =
							family === "jellyfin"
								? await revalidateJellyfinTargetWatchEvidence(input)
								: await revalidateTautulliTargetWatchEvidence(input);
						if (!verified) continue;
					}
					const fact: ProviderWatchCountFact = {
						userId,
						provider,
						cacheType: family,
						instanceId: proof.instanceId,
						generationId: proof.generationId,
						targetKey,
						coordinate: proof.coordinate,
						observedValue: proof.observedValue,
						status: proof.providerStatus,
						targetScoped: true,
					};
					result.set(targetKey, [...(result.get(targetKey) ?? []), fact]);
				}
			} catch {
				// Unreadable evidence cannot become a rule match.
				// Never pass provider error text (which can contain credentials) onward.
			}
		}
	}
	return result;
}

/** Shared by candidate discovery, preview and every subsequent mutation fence. */
export async function revalidateMatchedTargetWatchFacts(
	deps: CleanupExecutorDeps,
	userId: string,
	item: CacheItemForEval,
	conditions: readonly Condition[],
	ctx: EvalContext,
	readPhase: TargetWatchReadPhase = "validation",
): Promise<boolean> {
	const target = targetOf(item);
	if (!target) return true;
	const targetKey = `${target.mediaType}:${target.tmdbId}`;
	for (const condition of conditions) {
		const provider =
			condition.ruleType === "jellyfin_watch_count"
				? "JELLYFIN"
				: condition.ruleType === "tautulli_watch_count"
					? "TAUTULLI"
					: null;
		if (!provider) continue;
		const facts = ctx.providerWatchCountFacts?.get(targetKey);
		if (!facts?.some((fact) => fact.provider === provider && fact.targetScoped === true)) continue;
		const { operator, count } = condition.parameters;
		if (operator !== "greater_than" || typeof count !== "number") return false;
		const decision = decideProviderWatchCountFact(item, { operator, count }, ctx, provider);
		if (
			decision.kind !== "known" ||
			!decision.matched ||
			!decision.grant ||
			decision.grant.userId !== userId
		)
			return false;
		const encryptor = deps.encryptor;
		if (!encryptor) return false;
		const grant = decision.grant;
		const input = {
			prisma: deps.prisma,
			encryptor,
			userId,
			instanceId: grant.instanceId,
			...target,
			coordinate: grant.coordinate,
			generationId: grant.generationId,
			threshold: count,
			maxAgeMs: MAX_AGE_MS,
			readBudget: deps.targetWatchReadBudget,
			readPhase,
		};
		try {
			const valid =
				provider === "JELLYFIN"
					? await revalidateJellyfinTargetWatchEvidence(input)
					: await revalidateTautulliTargetWatchEvidence(input);
			if (!valid) return false;
		} catch {
			return false;
		}
	}
	return true;
}
