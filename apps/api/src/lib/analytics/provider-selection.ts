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

export class AnalyticsProviderSelectionInvalidStateError extends Error {
	constructor() {
		super("Historical analytics provider selection is invalid");
		this.name = "AnalyticsProviderSelectionInvalidStateError";
	}
}

export type AnalyticsProviderSelectionWriteResult = {
	selection: AnalyticsProviderSelection;
	previousProvider?: AnalyticsProvider;
};

function resolveStatus(family: AnalyticsProviderFamilyState): AnalyticsProviderSelection["status"] {
	if (family.configuredCount === 0) return "unconfigured";
	if (family.enabledCount === 0) return "disabled";
	return "configured";
}

function inferProvider(
	tracearr: AnalyticsProviderFamilyState,
	tautulli: AnalyticsProviderFamilyState,
) {
	return tracearr.configuredCount === 0 && tautulli.configuredCount > 0 ? "tautulli" : "tracearr";
}

export async function resolveAnalyticsProviderSelection(
	prisma: AnalyticsProviderPrisma,
	userId: string,
): Promise<AnalyticsProviderSelection> {
	return await prisma.$transaction(async (tx) => {
		const [
			settings,
			tracearrConfiguredCount,
			tracearrEnabledCount,
			tautulliConfiguredCount,
			tautulliEnabledCount,
		] = await Promise.all([
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
			return {
				selected: selected.data,
				source: source.data,
				families,
				status: resolveStatus(families[selected.data]),
			};
		}

		if (
			settings &&
			(settings.analyticsProvider !== null || settings.analyticsProviderSource !== null)
		) {
			throw new AnalyticsProviderSelectionInvalidStateError();
		}

		const inferred = inferProvider(families.tracearr, families.tautulli);
		if (!settings) {
			const winner = await tx.systemSettings.upsert({
				where: { id: 1 },
				create: {
					id: 1,
					analyticsProvider: inferred,
					analyticsProviderSource: "migration-default",
				},
				update: {},
			});
			const winnerProvider = analyticsProviderSchema.safeParse(winner.analyticsProvider);
			const winnerSource = analyticsProviderSourceSchema.safeParse(winner.analyticsProviderSource);
			if (!winnerProvider.success || !winnerSource.success) {
				throw new AnalyticsProviderSelectionInvalidStateError();
			}
			return {
				selected: winnerProvider.data,
				source: winnerSource.data,
				families,
				status: resolveStatus(families[winnerProvider.data]),
			};
		}

		const materialized = await tx.systemSettings.updateMany({
			where: { id: 1, analyticsProvider: null, analyticsProviderSource: null },
			data: { analyticsProvider: inferred, analyticsProviderSource: "migration-default" },
		});
		if (materialized.count === 0) {
			const winner = await tx.systemSettings.findUnique({ where: { id: 1 } });
			const winnerProvider = analyticsProviderSchema.safeParse(winner?.analyticsProvider);
			const winnerSource = analyticsProviderSourceSchema.safeParse(winner?.analyticsProviderSource);
			if (!winnerProvider.success || !winnerSource.success) {
				throw new AnalyticsProviderSelectionInvalidStateError();
			}
			return {
				selected: winnerProvider.data,
				source: winnerSource.data,
				families,
				status: resolveStatus(families[winnerProvider.data]),
			};
		}

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
	userId: string,
	provider: AnalyticsProvider,
): Promise<AnalyticsProviderSelectionWriteResult> {
	const selected = analyticsProviderSchema.parse(provider);
	return await prisma.$transaction(async (tx) => {
		const [
			settings,
			tracearrConfiguredCount,
			tracearrEnabledCount,
			tautulliConfiguredCount,
			tautulliEnabledCount,
		] = await Promise.all([
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
		await tx.systemSettings.upsert({
			where: { id: 1 },
			create: { id: 1, analyticsProvider: selected, analyticsProviderSource: "explicit" },
			update: { analyticsProvider: selected, analyticsProviderSource: "explicit" },
		});
		const previousProvider = analyticsProviderSchema.safeParse(settings?.analyticsProvider);
		const previousSource = analyticsProviderSourceSchema.safeParse(
			settings?.analyticsProviderSource,
		);
		const families = {
			tracearr: { configuredCount: tracearrConfiguredCount, enabledCount: tracearrEnabledCount },
			tautulli: { configuredCount: tautulliConfiguredCount, enabledCount: tautulliEnabledCount },
		};
		return {
			selection: {
				selected,
				source: "explicit",
				families,
				status: resolveStatus(families[selected]),
			},
			...(previousProvider.success && previousSource.success
				? { previousProvider: previousProvider.data }
				: {}),
		};
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
