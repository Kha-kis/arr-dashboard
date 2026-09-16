import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadAdditionalTargetWatchFacts,
	positiveTargetWatchRuleTypes,
	revalidateMatchedTargetWatchFacts,
} from "../additional-target-watch-policy.js";
import type { CacheItemForEval, CleanupExecutorDeps, EvalContext } from "../types.js";

const adapters = vi.hoisted(() => ({
	jellyfinRead: vi.fn(),
	jellyfinVerify: vi.fn(),
	tautulliRead: vi.fn(),
	tautulliVerify: vi.fn(),
}));
vi.mock("../../jellyfin/jellyfin-target-watch-evidence.js", () => ({
	readJellyfinTargetWatchEvidence: adapters.jellyfinRead,
	revalidateJellyfinTargetWatchEvidence: adapters.jellyfinVerify,
}));
vi.mock("../../tautulli/tautulli-target-watch-evidence.js", () => ({
	readTautulliTargetWatchEvidence: adapters.tautulliRead,
	revalidateTautulliTargetWatchEvidence: adapters.tautulliVerify,
}));

const item = {
	itemType: "movie",
	instanceId: "radarr",
	arrItemId: 9,
	data: JSON.stringify({ remoteIds: { tmdbId: 42 } }),
} as CacheItemForEval;
const proof = {
	userId: "owner",
	instanceId: "provider",
	mediaType: "movie",
	tmdbId: 42,
	generationId: "generation",
	coordinate: "proof-binding",
	observedValue: 3,
	providerStatus: {
		availability: "current",
		evidence: "positive-only",
		reasonCodes: [],
		domains: [
			{
				domain: "watch-count",
				availability: "current",
				evidence: "positive-only",
				valueSemantics: "lower-bound",
				reasonCodes: [],
			},
		],
	},
};
const deps = {
	prisma: {
		serviceInstance: {
			findMany: vi.fn(async () => [
				{ id: "provider", userId: "owner", service: "JELLYFIN", enabled: true },
			]),
		},
	},
	encryptor: {},
} as unknown as CleanupExecutorDeps;

beforeEach(() => {
	vi.clearAllMocks();
	adapters.jellyfinRead.mockResolvedValue([proof]);
	adapters.tautulliRead.mockResolvedValue([proof]);
	adapters.jellyfinVerify.mockResolvedValue(true);
	adapters.tautulliVerify.mockResolvedValue(true);
});

describe.each(["jellyfin", "tautulli"] as const)("%s target watch policy", (provider) => {
	it("loads only the requested family and requires live reproof of its exact threshold", async () => {
		const facts = await loadAdditionalTargetWatchFacts(
			deps,
			"owner",
			[item],
			new Set([`${provider}_watch_count`]),
		);
		expect(facts.get("movie:42")).toMatchObject([
			{
				provider: provider.toUpperCase(),
				cacheType: provider,
				targetScoped: true,
				observedValue: 3,
			},
		]);
		expect(
			provider === "jellyfin" ? adapters.tautulliRead : adapters.jellyfinRead,
		).not.toHaveBeenCalled();
		const ctx = { now: new Date(), providerWatchCountFacts: facts } as EvalContext;
		const conditions = [
			{ ruleType: `${provider}_watch_count`, parameters: { operator: "greater_than", count: 2 } },
		];
		expect(await revalidateMatchedTargetWatchFacts(deps, "owner", item, conditions, ctx)).toBe(
			true,
		);
		const verifier = provider === "jellyfin" ? adapters.jellyfinVerify : adapters.tautulliVerify;
		expect(verifier).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "owner",
				instanceId: "provider",
				mediaType: "movie",
				tmdbId: 42,
				generationId: "generation",
				coordinate: "proof-binding",
				threshold: 2,
			}),
		);
		verifier.mockResolvedValue(false);
		expect(await revalidateMatchedTargetWatchFacts(deps, "owner", item, conditions, ctx)).toBe(
			false,
		);
		verifier.mockRejectedValue(new Error("private provider failure"));
		expect(await revalidateMatchedTargetWatchFacts(deps, "owner", item, conditions, ctx)).toBe(
			false,
		);
	});
	it("does not authorize unknown predicates or a different owner/target", async () => {
		const facts = await loadAdditionalTargetWatchFacts(
			deps,
			"owner",
			[item],
			new Set([`${provider}_watch_count`]),
		);
		const ctx = { now: new Date(), providerWatchCountFacts: facts } as EvalContext;
		expect(
			await revalidateMatchedTargetWatchFacts(
				deps,
				"owner",
				item,
				[{ ruleType: `${provider}_watch_count`, parameters: { operator: "less_than", count: 4 } }],
				ctx,
			),
		).toBe(false);
		expect(
			await revalidateMatchedTargetWatchFacts(
				deps,
				"other-owner",
				item,
				[
					{
						ruleType: `${provider}_watch_count`,
						parameters: { operator: "greater_than", count: 2 },
					},
				],
				ctx,
			),
		).toBe(false);
		expect(adapters.jellyfinVerify).not.toHaveBeenCalled();
		expect(adapters.tautulliVerify).not.toHaveBeenCalled();
	});
});

it("loads target proof when only a generic fact already exists", async () => {
	const existing = new Map([
		[
			"movie:42",
			[
				{
					userId: "owner",
					provider: "JELLYFIN",
					cacheType: "jellyfin",
					instanceId: "provider",
					generationId: "generation",
					targetKey: "movie:42",
					coordinate: "generic-coordinate",
					observedValue: 3,
					status: proof.providerStatus,
				},
			],
		],
	]) as unknown as EvalContext["providerWatchCountFacts"];
	const facts = await loadAdditionalTargetWatchFacts(
		deps,
		"owner",
		[item],
		new Set(["jellyfin_watch_count"]),
		existing,
	);
	expect(facts.get("movie:42")).toMatchObject([{ targetScoped: true, observedValue: 3 }]);
	expect(adapters.jellyfinRead).toHaveBeenCalledOnce();
});

it("skips a target that already has target-scoped proof", async () => {
	const existing = new Map([
		["movie:42", [{ ...proof, provider: "JELLYFIN", cacheType: "jellyfin", targetScoped: true }]],
	]) as unknown as EvalContext["providerWatchCountFacts"];
	const facts = await loadAdditionalTargetWatchFacts(
		deps,
		"owner",
		[item],
		new Set(["jellyfin_watch_count"]),
		existing,
	);
	expect(facts.size).toBe(0);
	expect(adapters.jellyfinRead).not.toHaveBeenCalled();
});

it.each(["jellyfin", "tautulli"] as const)(
	"reproves the displayed %s count for explanation parity",
	async (family) => {
		const verifier = family === "jellyfin" ? adapters.jellyfinVerify : adapters.tautulliVerify;
		const facts = await loadAdditionalTargetWatchFacts(
			deps,
			"owner",
			[item],
			new Set([`${family}_watch_count`]),
			undefined,
			{ verifyPositiveCounts: true },
		);
		expect(facts.size).toBe(1);
		expect(verifier).toHaveBeenCalledWith(expect.objectContaining({ threshold: 2 }));
		verifier.mockResolvedValue(false);
		expect(
			(
				await loadAdditionalTargetWatchFacts(
					deps,
					"owner",
					[item],
					new Set([`${family}_watch_count`]),
					undefined,
					{ verifyPositiveCounts: true },
				)
			).size,
		).toBe(0);
	},
);

it.each(["jellyfin", "tautulli"] as const)(
	"chunks ARR batches to the bounded %s reader",
	async (family) => {
		const reader = family === "jellyfin" ? adapters.jellyfinRead : adapters.tautulliRead;
		reader.mockImplementation(async ({ targets }) =>
			targets.length > 200
				? []
				: targets.map((target: { tmdbId: number; mediaType: string }) => ({ ...proof, ...target })),
		);
		const items = Array.from({ length: 500 }, (_, i) => ({
			...item,
			data: JSON.stringify({ remoteIds: { tmdbId: i + 1 } }),
		}));
		const facts = await loadAdditionalTargetWatchFacts(
			deps,
			"owner",
			items,
			new Set([`${family}_watch_count`]),
		);
		expect(facts.size).toBe(500);
		expect(reader).toHaveBeenCalledTimes(3);
		expect(reader.mock.calls.every(([input]) => input.targets.length <= 200)).toBe(true);
	},
);

it("requires a decryptor for live provider proof without blocking ARR-only rules", async () => {
	const noEncryptor = { ...deps, encryptor: undefined };
	expect(
		(
			await loadAdditionalTargetWatchFacts(
				noEncryptor,
				"owner",
				[item],
				new Set(["jellyfin_watch_count"]),
			)
		).size,
	).toBe(0);
	const facts = await loadAdditionalTargetWatchFacts(
		deps,
		"owner",
		[item],
		new Set(["jellyfin_watch_count"]),
	);
	const ctx = { now: new Date(), providerWatchCountFacts: facts } as EvalContext;
	expect(
		await revalidateMatchedTargetWatchFacts(
			noEncryptor,
			"owner",
			item,
			[{ ruleType: "jellyfin_watch_count", parameters: { operator: "greater_than", count: 2 } }],
			ctx,
		),
	).toBe(false);
	expect(
		await revalidateMatchedTargetWatchFacts(
			noEncryptor,
			"owner",
			item,
			[{ ruleType: "age", parameters: { days: 30 } }],
			ctx,
		),
	).toBe(true);
});

it("requests target readers only for supported positive watch predicates", () => {
	const rules = [
		{
			enabled: true,
			ruleType: "jellyfin_watch_count",
			parameters: JSON.stringify({ operator: "equals", count: 0 }),
			conditions: null,
		},
		{
			enabled: true,
			ruleType: "composite",
			parameters: "{}",
			operator: "AND",
			conditions: JSON.stringify([
				{ ruleType: "age", parameters: { operator: "older_than", days: 30 } },
				{ ruleType: "tautulli_watch_count", parameters: { operator: "greater_than", count: 2 } },
			]),
		},
		{
			enabled: false,
			ruleType: "jellyfin_watch_count",
			parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
			conditions: null,
		},
	];
	expect(positiveTargetWatchRuleTypes(rules)).toEqual(new Set(["tautulli_watch_count"]));
});
