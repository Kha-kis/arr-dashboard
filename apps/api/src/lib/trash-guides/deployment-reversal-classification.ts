import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { ArrClientFactory } from "../arr/client-factory.js";
import type { DeploymentBackupState } from "./deployment-backup-state.js";
import {
	createQualityProfileStateToken,
	createUpstreamResourceStateToken,
} from "./deployment-target.js";

type ArrClient = SonarrClient | RadarrClient;

export type ReversalClassification = "already_reversed" | "needs_write" | "unknown";

/**
 * Classify whether a single target mutation has already been reversed against
 * live ARR state, without performing any write. This mirrors the "noop" branch
 * of the rollback helpers so that a deployment whose every mutation is already
 * reversed can be finalized without requiring competing-ownership authority.
 *
 * Any read failure (network, auth, unexpected shape) yields "unknown", never
 * "already_reversed": absence of evidence is not evidence of absence.
 */
export async function classifyTargetReversal(
	client: ArrClient,
	clientFactory: ArrClientFactory,
	instance: Parameters<ArrClientFactory["rawRequest"]>[0],
	state: DeploymentBackupState,
): Promise<ReversalClassification> {
	const classifications: ReversalClassification[] = [];

	for (const mutation of state.customFormatDeployments) {
		if (mutation.resourceId === null) {
			classifications.push("unknown");
			continue;
		}
		if (mutation.action === "created") {
			try {
				const listed = await client.customFormat.getAll();
				const present = listed.some((format) => format.id === mutation.resourceId);
				classifications.push(present ? "needs_write" : "already_reversed");
			} catch {
				classifications.push("unknown");
			}
			continue;
		}
		if (!mutation.beforeFormat) {
			classifications.push("unknown");
			continue;
		}
		try {
			const current = await client.customFormat.getById(mutation.resourceId);
			classifications.push(
				createUpstreamResourceStateToken(current) ===
					createUpstreamResourceStateToken(mutation.beforeFormat)
					? "already_reversed"
					: "needs_write",
			);
		} catch {
			classifications.push("unknown");
		}
	}

	const profile = state.qualityProfileDeployment;
	if (profile.status !== "not_started") {
		if (profile.profileId === null) {
			classifications.push("unknown");
		} else if (profile.action === "created") {
			try {
				const profiles = await client.qualityProfile.getAll();
				const present = profiles.some((item) => item.id === profile.profileId);
				classifications.push(present ? "needs_write" : "already_reversed");
			} catch {
				classifications.push("unknown");
			}
		} else {
			if (!profile.beforeProfile) {
				classifications.push("unknown");
			} else {
				try {
					const current = await client.qualityProfile.getById(profile.profileId);
					classifications.push(
						createQualityProfileStateToken(current) ===
							createQualityProfileStateToken(profile.beforeProfile)
							? "already_reversed"
							: "needs_write",
					);
				} catch {
					classifications.push("unknown");
				}
			}
		}
	}

	const naming = state.namingDeployment;
	if (naming && naming.status !== "not_started") {
		try {
			const currentResponse = await clientFactory.rawRequest(instance, "/api/v3/config/naming");
			if (!currentResponse.ok) {
				classifications.push("unknown");
			} else {
				const currentConfig = (await currentResponse.json()) as Record<string, unknown>;
				classifications.push(
					createUpstreamResourceStateToken(currentConfig) ===
						createUpstreamResourceStateToken(naming.beforeConfig)
						? "already_reversed"
						: "needs_write",
				);
			}
		} catch {
			classifications.push("unknown");
		}
	}

	if (classifications.length === 0) {
		// A valid schema-v2 deployment with no recorded mutation has nothing to
		// reverse, so it is already reversed by definition.
		return "already_reversed";
	}
	if (classifications.some((item) => item === "unknown")) {
		return "unknown";
	}
	if (classifications.some((item) => item === "needs_write")) {
		return "needs_write";
	}
	return "already_reversed";
}
