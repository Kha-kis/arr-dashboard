import { z } from "zod";

const positiveResourceId = z.number().int().positive().safe();
const stateToken = z.string().min(1);
const recordState = z.record(z.string(), z.unknown());
const legacyCustomFormatSchema = z.looseObject({
	id: positiveResourceId.optional(),
	name: z.string().min(1),
	specifications: z.array(z.unknown()).optional(),
	includeCustomFormatWhenRenaming: z.boolean().optional(),
});
const legacyBackupSchema = z.looseObject({
	customFormats: z.array(legacyCustomFormatSchema),
	qualityProfile: recordState.nullable(),
});

const customFormatStateSchema = z
	.object({
		beforeFormat: recordState.nullable(),
		action: z.enum(["created", "updated"]),
		resourceId: positiveResourceId.nullable(),
		name: z.string().min(1),
		status: z.enum(["pending", "applied"]),
		postStateToken: stateToken.nullable(),
		intendedPostStateToken: stateToken.nullable().optional().default(null),
	})
	.superRefine((state, ctx) => {
		if (state.action === "updated" && !state.beforeFormat) {
			ctx.addIssue({ code: "custom", message: "Updated CF state requires beforeFormat" });
		}
		if (state.status === "applied" && !state.postStateToken) {
			ctx.addIssue({ code: "custom", message: "Applied CF state requires a post token" });
		}
		if (state.status === "applied" && state.resourceId === null) {
			ctx.addIssue({ code: "custom", message: "Applied CF state requires a resource ID" });
		}
	});

const qualityProfileStateSchema = z
	.object({
		beforeProfile: recordState.nullable(),
		status: z.enum(["not_started", "pending", "applied"]),
		action: z.enum(["created", "updated"]),
		profileId: positiveResourceId.nullable(),
		profileName: z.string().min(1).nullable().optional().default(null),
		postStateToken: stateToken.nullable(),
		intendedPostStateToken: stateToken.nullable().optional().default(null),
	})
	.superRefine((state, ctx) => {
		if (state.status !== "not_started" && state.action === "updated" && !state.beforeProfile) {
			ctx.addIssue({ code: "custom", message: "Updated profile state requires beforeProfile" });
		}
		if (state.status === "applied" && !state.postStateToken) {
			ctx.addIssue({ code: "custom", message: "Applied profile state requires a post token" });
		}
		if (state.status === "applied" && state.profileId === null) {
			ctx.addIssue({ code: "custom", message: "Applied profile state requires a profile ID" });
		}
	});

const namingStateSchema = z
	.object({
		beforeConfig: recordState,
		status: z.enum(["not_started", "pending", "applied"]),
		postStateToken: stateToken.nullable(),
		intendedPostStateToken: stateToken.nullable().optional().default(null),
	})
	.superRefine((state, ctx) => {
		if (state.status === "applied" && !state.postStateToken) {
			ctx.addIssue({ code: "custom", message: "Applied naming state requires a post token" });
		}
	});

const managedFormatSchema = z.object({
	trashId: z.string().min(1),
	name: z.string().min(1),
	resourceId: positiveResourceId,
	stateToken,
	profileId: positiveResourceId,
	appliedScore: z.number().int().safe(),
});

export const deploymentBackupStateSchema = z.object({
	schemaVersion: z.literal(2),
	endpointKey: z.string().min(1),
	connectionStateToken: stateToken,
	customFormats: z.array(recordState),
	customFormatDeployments: z.array(customFormatStateSchema),
	managedCustomFormats: z.array(managedFormatSchema),
	managedCustomFormatsCaptured: z.boolean(),
	qualityProfileDeployment: qualityProfileStateSchema,
	namingDeployment: namingStateSchema.nullable(),
});

export type DeploymentBackupState = z.infer<typeof deploymentBackupStateSchema>;

export function parseDeploymentBackupState(value: string): DeploymentBackupState {
	return deploymentBackupStateSchema.parse(JSON.parse(value));
}

export function hasPendingDeploymentMutation(state: DeploymentBackupState): boolean {
	return (
		state.customFormatDeployments.some((item) => item.status === "pending") ||
		state.qualityProfileDeployment.status === "pending" ||
		state.namingDeployment?.status === "pending"
	);
}

/** Fail closed when cleanup cannot prove a current deployment ledger is terminal. */
export function shouldRetainDeploymentBackup(value: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return true;
	}
	if (Array.isArray(parsed)) {
		return !z.array(legacyCustomFormatSchema).safeParse(parsed).success;
	}
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		!("schemaVersion" in parsed) &&
		legacyBackupSchema.safeParse(parsed).success
	) {
		return false;
	}
	return true;
}
