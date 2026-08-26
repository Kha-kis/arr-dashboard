import type { RadarrClient, SonarrClient } from "arr-sdk";
import { z } from "zod";
import { createUpstreamResourceStateToken } from "./deployment-target.js";

type ArrClient = SonarrClient | RadarrClient;
const intendedWritableStateTokenPrefix = "arr-dashboard-custom-format-writable-v1";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectWritableCustomFormatState(value: unknown): unknown {
	if (!isRecord(value)) return value;
	return {
		name: value.name,
		includeCustomFormatWhenRenaming: value.includeCustomFormatWhenRenaming,
		specifications: Array.isArray(value.specifications)
			? value.specifications.map((specification) => {
					if (!isRecord(specification)) return specification;
					return {
						name: specification.name,
						implementation: specification.implementation,
						negate: specification.negate,
						required: specification.required,
						fields: Array.isArray(specification.fields)
							? specification.fields.map((field) =>
									isRecord(field) ? { name: field.name, value: field.value } : field,
								)
							: specification.fields,
					};
				})
			: value.specifications,
	};
}

function getDefaultableSonarrLanguageSpecificationIndexes(
	intended: Record<string, unknown>,
): number[] {
	if (!Array.isArray(intended.specifications)) return [];
	return intended.specifications.flatMap((specification, index) => {
		if (
			!isRecord(specification) ||
			specification.implementation !== "LanguageSpecification" ||
			!Array.isArray(specification.fields) ||
			specification.fields.some((field) => isRecord(field) && field.name === "exceptLanguage")
		) {
			return [];
		}
		return [index];
	});
}

function removeMaterializedSonarrDefaults(actual: unknown, defaultableIndexes: number[]): unknown {
	if (!isRecord(actual) || !Array.isArray(actual.specifications)) return actual;
	const defaultableIndexSet = new Set(defaultableIndexes);
	return {
		...actual,
		specifications: actual.specifications.map((specification, index) => {
			if (
				!defaultableIndexSet.has(index) ||
				!isRecord(specification) ||
				specification.implementation !== "LanguageSpecification" ||
				!Array.isArray(specification.fields)
			) {
				return specification;
			}
			const exceptLanguageFields = specification.fields.flatMap((field, fieldIndex) =>
				isRecord(field) && field.name === "exceptLanguage" ? [{ field, fieldIndex }] : [],
			);
			if (exceptLanguageFields.length !== 1 || exceptLanguageFields[0]?.field.value !== false) {
				return specification;
			}
			return {
				...specification,
				fields: specification.fields.filter(
					(_, fieldIndex) => fieldIndex !== exceptLanguageFields[0]?.fieldIndex,
				),
			};
		}),
	};
}

function createWritableCustomFormatStateToken(value: unknown): string {
	return createUpstreamResourceStateToken(projectWritableCustomFormatState(value));
}

/**
 * Persist a versioned token in the same writable-state domain used by post-write verification.
 * The token records exactly which Sonarr LanguageSpecifications omitted exceptLanguage, so
 * recovery cannot apply Sonarr's false-default exception to Radarr or to an explicit value.
 */
export function createIntendedCustomFormatPostStateToken(
	intended: Record<string, unknown>,
	service: string,
): string {
	if (service !== "SONARR" && service !== "RADARR") {
		throw new Error(`Unsupported Custom Format mutation service: ${service}`);
	}
	const defaultableIndexes =
		service === "SONARR" ? getDefaultableSonarrLanguageSpecificationIndexes(intended) : [];
	return [
		intendedWritableStateTokenPrefix,
		service,
		defaultableIndexes.length > 0 ? defaultableIndexes.join(",") : "-",
		createWritableCustomFormatStateToken(intended),
	].join(":");
}

/** Reconcile a pending mutation without accepting any state the original verifier rejected. */
export function matchesIntendedCustomFormatPostStateToken(
	actual: unknown,
	intendedToken: string,
): boolean {
	const [prefix, service, rawIndexes, expectedHash, ...extra] = intendedToken.split(":");
	if (
		prefix !== intendedWritableStateTokenPrefix ||
		(service !== "SONARR" && service !== "RADARR") ||
		extra.length > 0 ||
		!/^[a-f0-9]{64}$/.test(expectedHash ?? "")
	) {
		return false;
	}
	const defaultableIndexes =
		rawIndexes === "-"
			? []
			: /^\d+(?:,\d+)*$/.test(rawIndexes ?? "")
				? rawIndexes!.split(",").map(Number)
				: null;
	if (
		defaultableIndexes === null ||
		defaultableIndexes.some(
			(index, position) =>
				!Number.isSafeInteger(index) ||
				index < 0 ||
				index <= (defaultableIndexes[position - 1] ?? -1),
		)
	) {
		return false;
	}
	if (createWritableCustomFormatStateToken(actual) === expectedHash) return true;
	return (
		service === "SONARR" &&
		defaultableIndexes.length > 0 &&
		createWritableCustomFormatStateToken(
			removeMaterializedSonarrDefaults(actual, defaultableIndexes),
		) === expectedHash
	);
}

const restorableCustomFormatFieldSchema = z.looseObject({
	name: z.string().min(1),
	type: z.string().min(1),
});
const restorableCustomFormatSpecificationSchema: z.ZodType = z.lazy(() =>
	z.looseObject({
		id: z.number().int().positive().safe().optional(),
		name: z.string().min(1),
		implementation: z.string().min(1),
		implementationName: z.string().min(1).nullable().optional(),
		infoLink: z.string().nullable().optional(),
		negate: z.boolean(),
		required: z.boolean(),
		fields: z.array(restorableCustomFormatFieldSchema),
		presets: z.array(restorableCustomFormatSpecificationSchema).nullable().optional(),
	}),
);
export const restorableCustomFormatSchema = z.looseObject({
	id: z.number().int().positive().safe(),
	name: z.string().min(1),
	specifications: z.array(restorableCustomFormatSpecificationSchema),
	includeCustomFormatWhenRenaming: z.boolean().nullable().optional(),
});

export interface CustomFormatRollbackState {
	beforeFormat: Record<string, unknown> | null;
	action: "created" | "updated";
	resourceId: number | null;
	name: string;
	status: "pending" | "applied";
	postStateToken: string | null;
	intendedPostStateToken?: string | null;
}

/**
 * Roll back only an exact Custom Format mutation made by this deployment.
 * Unknown writes fail closed; an already-restored state is an idempotent success.
 */
export async function rollbackCustomFormatDeployment(
	client: ArrClient,
	state: CustomFormatRollbackState,
): Promise<"noop" | "restored" | "deleted"> {
	if (state.resourceId === null) {
		throw new Error(`Custom Format "${state.name}" may have been created, but its ID is unknown.`);
	}
	let beforeFormat: Record<string, unknown> | null = null;
	if (state.action === "updated") {
		const parsed = restorableCustomFormatSchema.safeParse(state.beforeFormat);
		if (!parsed.success || parsed.data.id !== state.resourceId) {
			throw new Error(
				`Custom Format "${state.name}" has an incomplete or mismatched pre-deployment state and was not restored.`,
			);
		}
		beforeFormat = parsed.data;
	}

	const listed = await client.customFormat.getAll();
	const listedCurrent = listed.find((format) => format.id === state.resourceId);
	if (!listedCurrent) {
		if (state.action === "created") return "noop";
		throw new Error(`Custom Format "${state.name}" no longer exists.`);
	}
	const current = await client.customFormat.getById(state.resourceId);
	const currentToken = createUpstreamResourceStateToken(current);

	let verifiedPostStateToken = state.postStateToken;
	if (state.status === "pending") {
		if (
			state.action === "updated" &&
			beforeFormat &&
			currentToken === createUpstreamResourceStateToken(beforeFormat)
		) {
			return "noop";
		}
		if (state.postStateToken) {
			if (currentToken !== state.postStateToken) {
				throw new Error(
					`Custom Format "${state.name}" has an unverified deployment state and was not changed.`,
				);
			}
			verifiedPostStateToken = state.postStateToken;
		} else if (
			state.intendedPostStateToken &&
			(currentToken === state.intendedPostStateToken ||
				matchesIntendedCustomFormatPostStateToken(current, state.intendedPostStateToken))
		) {
			verifiedPostStateToken = currentToken;
		} else {
			throw new Error(
				`Custom Format "${state.name}" has an unverified deployment state and was not changed.`,
			);
		}
	}

	if (!verifiedPostStateToken) {
		throw new Error(`Custom Format "${state.name}" is missing its verified post-write state.`);
	}
	if (state.action === "created") {
		if (currentToken !== verifiedPostStateToken) {
			throw new Error(
				`Custom Format "${state.name}" changed after deployment and was not deleted.`,
			);
		}
		const profiles = await client.qualityProfile.getAll();
		const referencingProfiles: Array<{ id?: number; name?: string | null }> = [];
		for (const profile of profiles) {
			let formatItems = profile.formatItems;
			if (!Array.isArray(formatItems)) {
				if (!Number.isSafeInteger(profile.id) || (profile.id ?? 0) <= 0) {
					throw new Error(
						`Custom Format "${state.name}" profile references could not be established because a quality profile has no valid ID.`,
					);
				}
				const fullProfile = await client.qualityProfile.getById(profile.id!);
				formatItems = fullProfile.formatItems;
				if (!Array.isArray(formatItems)) {
					throw new Error(
						`Custom Format "${state.name}" profile reference list could not be established for "${profile.name ?? profile.id}".`,
					);
				}
			}
			if (formatItems.some((item) => item.format === state.resourceId)) {
				referencingProfiles.push(profile);
			}
		}
		if (referencingProfiles.length > 0) {
			throw new Error(
				`Custom Format "${state.name}" is referenced by quality profile(s) ${referencingProfiles
					.map((profile) => `"${profile.name ?? profile.id ?? "Unknown"}"`)
					.join(", ")} and was not deleted.`,
			);
		}
		const rechecked = await client.customFormat.getById(state.resourceId);
		if (createUpstreamResourceStateToken(rechecked) !== verifiedPostStateToken) {
			throw new Error(
				`Custom Format "${state.name}" changed after deployment and was not deleted.`,
			);
		}
		throw new Error(
			`Custom Format "${state.name}" cannot be deleted safely because the upstream API has no conditional delete. Verify that it is unused, then remove it manually.`,
		);
	}

	if (!beforeFormat) {
		throw new Error(`Custom Format "${state.name}" is missing its pre-deployment state.`);
	}
	if (currentToken === createUpstreamResourceStateToken(beforeFormat)) return "noop";
	if (currentToken !== verifiedPostStateToken) {
		throw new Error(
			`Custom Format "${state.name}" changed after deployment and was not overwritten.`,
		);
	}
	throw new Error(
		`Custom Format "${state.name}" cannot be restored safely because the upstream API has no conditional update. Its current state still matches this deployment; restore the recorded pre-deployment configuration manually.`,
	);
}
