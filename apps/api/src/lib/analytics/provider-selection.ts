import {
	analyticsProviderSchema,
	analyticsProviderSourceSchema,
	type AnalyticsProvider,
	type AnalyticsProviderFamilyState,
	type AnalyticsProviderSelection,
} from "@arr/shared";
import type { PrismaClient } from "../prisma.js";

const PROVIDER_SERVICES = {
	tracearr: "TRACEARR",
	tautulli: "TAUTULLI",
} as const;

type AnalyticsProviderPrisma = Pick<PrismaClient, "$transaction">;

export class AnalyticsProviderSelectionMismatchError extends Error {
	readonly expected: AnalyticsProvider;
	readonly actual: AnalyticsProvider;

	constructor(expected: AnalyticsProvider, actual: AnalyticsProvider) {
		super(`Historical analytics provider ${expected} is not selected`);
		this.name = "AnalyticsProviderSelectionMismatchError";
		this.expected = expected;
		this.actual = actual;
	}
}

function resolveStatus(family: AnalyticsProviderFamilyState): AnalyticsProviderSelection["status"] {
	if (family.configuredCount === 0) return "unconfigured";
	if (family.enabledCount === 0) return "disabled";
	return "configured";
}

function inferProvider(tracearr: AnalyticsProviderFamilyState, tautulli: AnalyticsProviderFamilyState) {
	return tracearr.configuredCount === 0 && tautulli.configuredCount > 0 ? "tautulli" : "tracearr";
}

export async function resolveAnalyticsProviderSelection(
	prisma: AnalyticsProviderPrisma,
	userId: string,
): Promise<AnalyticsProviderSelection> {
	return await prisma.$transaction(async (tx) => {
		const [settings, tracearrConfiguredCount, tracearrEnabledCount, tautulliConfiguredCount, tautulliEnabledCount] =
			await Promise.all([
				tx.systemSettings.findUnique({ where: { id: 1 } }),
				tx.serviceInstance.count({ where: { userId, service: PROVIDER_SERVICES.tracearr } }),
				tx.serviceInstance.count({
					where: { userId, service: PROVIDER_SERVICES.tracearr, enabled: true },
				}),
				tx.serviceInstance.count({ where: { userId, service: PROVIDER_SERVICES.tautulli } }),
				tx.serviceInstance.count({
					where: { userId, service: PROVIDER_SERVICES.tautulli, enabled: true },
				}),
			]);

		const families = {
			tracearr: { configuredCount: tracearrConfiguredCount, enabledCount: tracearrEnabledCount },
			tautulli: { configuredCount: tautulliConfiguredCount, enabledCount: tautulliEnabledCount },
		};
		const selected = analyticsProviderSchema.safeParse(settings?.analyticsProvider);
		const source = analyticsProviderSourceSchema.safeParse(settings?.analyticsProviderSource);

		if (selected.success && source.success) {
			return { selected: selected.data, source: source.data, families, status: resolveStatus(families[selected.data]) };
		}

		const inferred = inferProvider(families.tracearr, families.tautulli);
		await tx.systemSettings.upsert({
			where: { id: 1 },
			create: {
				id: 1,
				analyticsProvider: inferred,
				analyticsProviderSource: "migration-default",
			},
			update: {
				analyticsProvider: inferred,
				analyticsProviderSource: "migration-default",
			},
		});

		return {
			selected: inferred,
			source: "migration-default",
			families,
			status: resolveStatus(families[inferred]),
		};
	});
}

export async function selectAnalyticsProvider(
	prisma: AnalyticsProviderPrisma,
	_userId: string,
	provider: AnalyticsProvider,
): Promise<void> {
	const selected = analyticsProviderSchema.parse(provider);
	await prisma.$transaction(async (tx) => {
		await tx.systemSettings.upsert({
			where: { id: 1 },
			create: { id: 1, analyticsProvider: selected, analyticsProviderSource: "explicit" },
			update: { analyticsProvider: selected, analyticsProviderSource: "explicit" },
		});
	});
}

export async function requireSelectedAnalyticsProvider(
	prisma: AnalyticsProviderPrisma,
	userId: string,
	provider: AnalyticsProvider,
): Promise<AnalyticsProviderSelection> {
	const selection = await resolveAnalyticsProviderSelection(prisma, userId);
	if (selection.selected !== provider) {
		throw new AnalyticsProviderSelectionMismatchError(provider, selection.selected);
	}
	return selection;
}
