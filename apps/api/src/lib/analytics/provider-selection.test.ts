import { describe, expect, it, vi } from "vitest";
import {
	AnalyticsProviderSelectionMismatchError,
	requireSelectedAnalyticsProvider,
	resolveAnalyticsProviderSelection,
	selectAnalyticsProvider,
} from "./provider-selection.js";

type Provider = "tracearr" | "tautulli";
type Scenario = {
	stored: Provider | null;
	tracearr: number;
	tautulli: number;
	tracearrEnabled?: number;
	tautulliEnabled?: number;
	selected: Provider;
	source: "explicit" | "migration-default";
};

function createPrisma({ stored, tracearr, tautulli, tracearrEnabled, tautulliEnabled, source }: Scenario) {
	let settings: { analyticsProvider: Provider | null; analyticsProviderSource: string | null } = {
		analyticsProvider: stored,
		analyticsProviderSource: source,
	};
	const transaction = {
		systemSettings: {
			findUnique: vi.fn(async () => settings),
			upsert: vi.fn(async ({ create, update }) => {
				settings = {
					analyticsProvider: (update.analyticsProvider ?? create.analyticsProvider) as Provider,
					analyticsProviderSource: update.analyticsProviderSource ?? create.analyticsProviderSource,
				};
				return settings;
			}),
		},
		serviceInstance: {
			count: vi.fn(async ({ where }: { where: { service: "TRACEARR" | "TAUTULLI"; enabled?: boolean } }) => {
				const configured = where.service === "TRACEARR" ? tracearr : tautulli;
				const enabled = where.service === "TRACEARR" ? tracearrEnabled : tautulliEnabled;
				return where.enabled === true ? (enabled ?? configured) : configured;
			}),
		},
	};
	return {
		$transaction: vi.fn(async (callback) => callback(transaction)),
		transaction,
		settings: () => settings,
	};
}

describe("resolveAnalyticsProviderSelection", () => {
	it.each([
		{ stored: null, tracearr: 0, tautulli: 0, selected: "tracearr", source: "migration-default" },
		{ stored: null, tracearr: 0, tautulli: 1, selected: "tautulli", source: "migration-default" },
		{ stored: null, tracearr: 1, tautulli: 1, selected: "tracearr", source: "migration-default" },
		{ stored: "tautulli", tracearr: 1, tautulli: 0, selected: "tautulli", source: "explicit" },
	] satisfies Scenario[])("resolves $selected without failover", async (scenario) => {
		const prisma = createPrisma(scenario);
		const resolution = await resolveAnalyticsProviderSelection(prisma, "user-1");

		expect(resolution.selected).toBe(scenario.selected);
		expect(resolution.source).toBe(scenario.source);
		expect(prisma.settings()).toMatchObject({
			analyticsProvider: scenario.selected,
			analyticsProviderSource: scenario.source,
		});
	});

	it("keeps an explicit selected family when it is disabled", async () => {
		const prisma = createPrisma({
			stored: "tautulli",
			source: "explicit",
			tracearr: 1,
			tautulli: 1,
			tautulliEnabled: 0,
			selected: "tautulli",
		});

		await expect(resolveAnalyticsProviderSelection(prisma, "user-1")).resolves.toMatchObject({
			selected: "tautulli",
			status: "disabled",
		});
	});

	it("keeps an explicit selected family when it is deleted", async () => {
		const prisma = createPrisma({
			stored: "tautulli",
			source: "explicit",
			tracearr: 1,
			tautulli: 0,
			selected: "tautulli",
		});

		await expect(resolveAnalyticsProviderSelection(prisma, "user-1")).resolves.toMatchObject({
			selected: "tautulli",
			status: "unconfigured",
		});
	});

	it("does not require reachability to retain an explicit selection", async () => {
		const prisma = createPrisma({
			stored: "tautulli",
			source: "explicit",
			tracearr: 1,
			tautulli: 1,
			selected: "tautulli",
		});

		await expect(resolveAnalyticsProviderSelection(prisma, "user-1")).resolves.toMatchObject({
			selected: "tautulli",
			status: "configured",
		});
	});

	it("stores an explicit choice even when that family is unconfigured", async () => {
		const prisma = createPrisma({
			stored: null,
			source: "migration-default",
			tracearr: 1,
			tautulli: 0,
			selected: "tracearr",
		});

		await selectAnalyticsProvider(prisma, "user-1", "tautulli");

		expect(prisma.settings()).toEqual({
			analyticsProvider: "tautulli",
			analyticsProviderSource: "explicit",
		});
	});

	it("rejects a mismatched provider without querying a provider client", async () => {
		const prisma = createPrisma({
			stored: "tracearr",
			source: "explicit",
			tracearr: 1,
			tautulli: 1,
			selected: "tracearr",
		});

		await expect(requireSelectedAnalyticsProvider(prisma, "user-1", "tautulli")).rejects.toEqual(
			expect.objectContaining<Partial<AnalyticsProviderSelectionMismatchError>>({
				expected: "tautulli",
				actual: "tracearr",
			}),
		);
	});
});
