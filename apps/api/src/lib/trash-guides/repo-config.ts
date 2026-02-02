/**
 * TRaSH Guides Repository Configuration Resolver
 *
 * Resolves the active repository configuration for fetching TRaSH Guides data.
 * Users can configure a custom fork that replaces the official upstream entirely.
 * When no custom repo is configured, falls back to the official TRaSH-Guides/Guides repository.
 */

import { DEFAULT_TRASH_REPO } from "@arr/shared";
import type { TrashRepoConfig } from "@arr/shared";
import type { PrismaClient } from "../../lib/prisma.js";

/**
 * Get the repository configuration for a specific user.
 * Used in authenticated route handlers where userId is available.
 *
 * @returns TrashRepoConfig - custom repo if configured, otherwise official default
 */
export async function getRepoConfig(prisma: PrismaClient, userId: string): Promise<TrashRepoConfig> {
	const settings = await prisma.trashSettings.findUnique({
		where: { userId },
		select: {
			customRepoOwner: true,
			customRepoName: true,
			customRepoBranch: true,
		},
	});

	if (settings?.customRepoOwner) {
		return {
			owner: settings.customRepoOwner,
			name: settings.customRepoName ?? DEFAULT_TRASH_REPO.name,
			branch: settings.customRepoBranch ?? DEFAULT_TRASH_REPO.branch,
		};
	}

	return DEFAULT_TRASH_REPO;
}

/**
 * Get the repository configuration without a specific user context.
 * Used by the background scheduler which runs outside of request context.
 *
 * Since this is a single-admin application, we look for the first user
 * with custom repo settings configured.
 *
 * @returns TrashRepoConfig - custom repo if any user configured one, otherwise official default
 */
export async function getGlobalRepoConfig(prisma: PrismaClient): Promise<TrashRepoConfig> {
	const settings = await prisma.trashSettings.findFirst({
		where: {
			customRepoOwner: { not: null },
		},
		select: {
			customRepoOwner: true,
			customRepoName: true,
			customRepoBranch: true,
		},
	});

	if (settings?.customRepoOwner) {
		return {
			owner: settings.customRepoOwner,
			name: settings.customRepoName ?? DEFAULT_TRASH_REPO.name,
			branch: settings.customRepoBranch ?? DEFAULT_TRASH_REPO.branch,
		};
	}

	return DEFAULT_TRASH_REPO;
}
