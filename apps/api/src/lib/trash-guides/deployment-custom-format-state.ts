import type { RadarrClient, SonarrClient } from "arr-sdk";
import { z } from "zod";
import { createUpstreamResourceStateToken } from "./deployment-target.js";

type ArrClient = SonarrClient | RadarrClient;
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
	intendedPostState?: Record<string, unknown> | null;
}

export interface RecoveredCustomFormatIdentity {
	resourceId: number;
	postStateToken: string;
}

function projectActualToIntendedShape(actualValue: unknown, intendedValue: unknown): unknown {
	if (Array.isArray(intendedValue)) {
		if (!Array.isArray(actualValue)) return actualValue;
		return actualValue.map((item, index) =>
			projectActualToIntendedShape(item, intendedValue[index]),
		);
	}
	if (intendedValue && typeof intendedValue === "object") {
		if (!actualValue || typeof actualValue !== "object" || Array.isArray(actualValue)) {
			return actualValue;
		}
		const actualRecord = actualValue as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(intendedValue as Record<string, unknown>).map(([key, value]) => [
				key,
				projectActualToIntendedShape(actualRecord[key], value),
			]),
		);
	}
	return actualValue;
}

export function matchesIntendedWritableState(
	actual: unknown,
	intended: Record<string, unknown>,
): boolean {
	if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
	return (
		createUpstreamResourceStateToken(projectActualToIntendedShape(actual, intended)) ===
		createUpstreamResourceStateToken(intended)
	);
}

/**
 * Roll back only an exact Custom Format mutation made by this deployment.
 * Unknown writes fail closed; an already-restored state is an idempotent success.
 */
export async function rollbackCustomFormatDeployment(
	client: ArrClient,
	state: CustomFormatRollbackState,
	onRecoveredIdentity?: (identity: RecoveredCustomFormatIdentity) => void | Promise<void>,
): Promise<"noop" | "restored" | "deleted"> {
	let resourceId = state.resourceId;
	let recoveredPostStateToken: string | null = null;
	const listed = await client.customFormat.getAll();
	if (resourceId === null) {
		if (state.action !== "created" || !state.intendedPostState) {
			throw new Error(
				`Custom Format "${state.name}" may have been created, but its ID is unknown.`,
			);
		}
		const namedCandidates = listed.filter(
			(format) =>
				Number.isSafeInteger(format.id) && (format.id ?? 0) > 0 && format.name === state.name,
		);
		const exactCandidates: Array<{ id: number; format: Record<string, unknown> }> = [];
		for (const candidate of namedCandidates) {
			const fullFormat = await client.customFormat.getById(candidate.id!);
			if (matchesIntendedWritableState(fullFormat, state.intendedPostState)) {
				exactCandidates.push({
					id: candidate.id!,
					format: fullFormat as Record<string, unknown>,
				});
			}
		}
		if (exactCandidates.length !== 1) {
			throw new Error(
				`Custom Format "${state.name}" may have been created, but its ID could not be recovered exactly.`,
			);
		}
		resourceId = exactCandidates[0]!.id;
		recoveredPostStateToken = createUpstreamResourceStateToken(exactCandidates[0]!.format);
		await onRecoveredIdentity?.({ resourceId, postStateToken: recoveredPostStateToken });
	}
	let beforeFormat: Record<string, unknown> | null = null;
	if (state.action === "updated") {
		const parsed = restorableCustomFormatSchema.safeParse(state.beforeFormat);
		if (!parsed.success || parsed.data.id !== resourceId) {
			throw new Error(
				`Custom Format "${state.name}" has an incomplete or mismatched pre-deployment state and was not restored.`,
			);
		}
		beforeFormat = parsed.data;
	}

	const listedCurrent = listed.find((format) => format.id === resourceId);
	if (!listedCurrent) {
		if (state.action === "created") return "noop";
		throw new Error(`Custom Format "${state.name}" no longer exists.`);
	}
	const current = await client.customFormat.getById(resourceId);
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
		if (state.postStateToken && currentToken === state.postStateToken) {
			verifiedPostStateToken = state.postStateToken;
		} else if (state.intendedPostStateToken && currentToken === state.intendedPostStateToken) {
			verifiedPostStateToken = state.intendedPostStateToken;
		} else if (
			state.action === "created" &&
			recoveredPostStateToken &&
			currentToken === recoveredPostStateToken &&
			state.intendedPostState &&
			matchesIntendedWritableState(current, state.intendedPostState)
		) {
			verifiedPostStateToken = recoveredPostStateToken;
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
			if (formatItems.some((item) => item.format === resourceId)) {
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
		const rechecked = await client.customFormat.getById(resourceId);
		if (createUpstreamResourceStateToken(rechecked) !== verifiedPostStateToken) {
			throw new Error(
				`Custom Format "${state.name}" changed after deployment and was not deleted.`,
			);
		}
		throw new Error(
			`Custom Format "${state.name}" (ARR ID: ${resourceId}) cannot be deleted safely because the upstream API has no conditional delete. Verify that exact ID is unused, then remove it manually.`,
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
		`Custom Format "${state.name}" (ARR ID: ${resourceId}) cannot be restored safely because the upstream API has no conditional update. Its current state still matches this deployment; restore the recorded pre-deployment configuration for that exact ID manually.`,
	);
}
