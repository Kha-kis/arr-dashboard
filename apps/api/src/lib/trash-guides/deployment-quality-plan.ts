import {
	type CustomQualityConfig,
	type DeploymentPreview,
	type DeploymentQualityOrderEntry,
	importedQualityItemsInProviderOrder,
	type TemplateConfig,
} from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import { AppValidationError, ConflictError } from "../errors.js";
import { createUpstreamResourceStateToken } from "./deployment-target.js";
import { extractQualitiesFromSchema, normalizeQualityName } from "./quality-profile-helpers.js";

interface QualityItem {
	id?: number;
	name?: string | null;
	quality?: { id?: number; name?: string | null };
	allowed?: boolean;
	items?: QualityItem[] | null;
}

interface QualityEntry {
	id: string;
	name: string;
	allowed: boolean;
	members: readonly string[];
}

export interface DeploymentQualityPlan {
	items: QualityItem[];
	cutoff?: number;
}

function compileQualityItems(schemaItems: QualityItem[], entries: QualityEntry[], strict: boolean) {
	const { byId, byName } = extractQualitiesFromSchema(schemaItems);
	const ambiguousNames = new Set<string>();
	const seenNames = new Set<string>();
	if (strict) {
		for (const { quality } of byId.values()) {
			const name = normalizeQualityName(quality.name);
			if (seenNames.has(name)) ambiguousNames.add(name);
			seenNames.add(name);
		}
	}
	const items: QualityItem[] = [];
	const ids = new Map<string, number>();
	const mappedQualityIds = new Set<number>();
	let groupId = 1000;

	const resolveQuality = (name: string): QualityItem | undefined => {
		const key = normalizeQualityName(name);
		const quality: QualityItem | undefined = byName.get(key);
		if (!strict) return quality;
		const id = quality?.quality?.id;
		if (id === undefined || ambiguousNames.has(key) || mappedQualityIds.has(id)) {
			throw new AppValidationError(
				"A custom quality is missing or duplicated in the destination schema.",
			);
		}
		mappedQualityIds.add(id);
		return quality;
	};

	for (const entry of entries) {
		if (entry.members.length > 0) {
			const members = entry.members.flatMap((name) => {
				const item = resolveQuality(name);
				return item ? [{ ...item, allowed: false }] : [];
			});
			if (members.length > 0) {
				const id = groupId++;
				ids.set(entry.id, id);
				items.push({ id, name: entry.name, items: members, allowed: entry.allowed });
			}
		} else {
			const item = resolveQuality(entry.name);
			if (!item) continue;
			if (item.quality?.id !== undefined) ids.set(entry.id, item.quality.id);
			items.push({ ...item, allowed: entry.allowed });
		}
	}
	return { items, ids };
}

function itemId(item: QualityItem | undefined): number | undefined {
	return item?.id ?? item?.quality?.id;
}

export function buildImportedQualityPlan(
	schemaItems: QualityItem[],
	profile?: TemplateConfig["qualityProfile"],
): DeploymentQualityPlan {
	const entries = importedQualityItemsInProviderOrder(profile?.items ?? []).map((item) => ({
		...item,
		id: item.name,
		members: item.items ?? [],
	}));
	const { items } = compileQualityItems(schemaItems, entries, false);
	const cutoffName = profile?.cutoff && normalizeQualityName(profile.cutoff);
	const matches = (item: QualityItem) =>
		normalizeQualityName(item.quality?.name ?? item.name ?? "") === cutoffName;
	const cutoffItem = cutoffName
		? items.find((item) => matches(item) || item.items?.some(matches))
		: undefined;
	return { items, cutoff: itemId(cutoffItem) ?? itemId(items.at(-1)) ?? 1 };
}

export function buildCustomQualityPlan(
	schemaItems: QualityItem[],
	config: CustomQualityConfig,
): DeploymentQualityPlan {
	const entries = config.items.map((entry) =>
		entry.type === "group"
			? { ...entry.group, members: entry.group.qualities.map((quality) => quality.name) }
			: { ...entry.item, members: [] },
	);
	const { items, ids } = compileQualityItems(schemaItems, entries, true);
	const cutoff = config.cutoffId ? ids.get(config.cutoffId) : itemId(items.at(-1));
	if (cutoff === undefined) {
		throw new AppValidationError(
			"The custom quality cutoff cannot be resolved on the destination.",
		);
	}
	return { items, cutoff };
}

export async function resolveDeploymentQualityPlan(
	client: SonarrClient | RadarrClient,
	resources: {
		exists: boolean;
		cloned: boolean;
		imported?: TemplateConfig["qualityProfile"];
		custom?: CustomQualityConfig;
	},
): Promise<DeploymentQualityPlan | undefined> {
	if (resources.custom?.useCustomQualities && resources.custom.items.length > 0) {
		return buildCustomQualityPlan(
			(await client.qualityProfile.getSchema()).items ?? [],
			resources.custom,
		);
	}
	if (!resources.exists && !resources.cloned && resources.imported?.items?.length) {
		return buildImportedQualityPlan(
			(await client.qualityProfile.getSchema()).items ?? [],
			resources.imported,
		);
	}
	return undefined;
}

export function assertReviewedQualityPlan(
	reviewed: DeploymentQualityPlan | undefined,
	actual: DeploymentQualityPlan,
): void {
	if (
		reviewed &&
		createUpstreamResourceStateToken(reviewed) !== createUpstreamResourceStateToken(actual)
	) {
		throw new ConflictError(
			"The destination quality schema changed during deployment. Refresh the preview and review the deployment again.",
		);
	}
}

function qualityName(item: QualityItem): string {
	return item.name ?? item.quality?.name ?? "Unknown quality";
}

function cutoffName(items: QualityItem[], cutoff: number | undefined): string | undefined {
	if (cutoff === undefined) return undefined;
	const topLevel = items.find((entry) => itemId(entry) === cutoff);
	if (topLevel) return qualityName(topLevel);
	for (const group of items) {
		const member = group.items?.find((entry) => itemId(entry) === cutoff);
		if (member) return `${qualityName(group)} / ${qualityName(member)}`;
	}
	return "Unknown quality";
}

function displayQualityOrder(
	items: QualityItem[],
	groupMembers = false,
): DeploymentQualityOrderEntry[] {
	const ordered = groupMembers ? items : [...items].reverse();
	return ordered.map((item) => ({
		name: qualityName(item),
		allowed: item.allowed ?? false,
		children: displayQualityOrder(item.items ?? [], true),
	}));
}

export function describeQualityOrderChange(
	before: QualityItem[] | undefined,
	plan: DeploymentQualityPlan | undefined,
	currentCutoff?: number,
): DeploymentPreview["qualityOrder"] {
	if (!plan) return undefined;
	const previous = displayQualityOrder(before ?? []);
	const proposed = displayQualityOrder(plan.items);
	const cutoffBefore = cutoffName(before ?? [], currentCutoff);
	const cutoffAfter = cutoffName(plan.items, plan.cutoff);
	const cutoffChanged = currentCutoff !== plan.cutoff || cutoffBefore !== cutoffAfter;
	const sameCutoffLabel = cutoffBefore !== undefined && cutoffBefore === cutoffAfter;
	if (!cutoffChanged && JSON.stringify(previous) === JSON.stringify(proposed)) return undefined;
	return {
		before: previous,
		after: proposed,
		...(cutoffChanged
			? {
					cutoffBefore: sameCutoffLabel ? `${cutoffBefore} (ID ${currentCutoff})` : cutoffBefore,
					cutoffAfter: sameCutoffLabel ? `${cutoffAfter} (ID ${plan.cutoff})` : cutoffAfter,
				}
			: {}),
	};
}
