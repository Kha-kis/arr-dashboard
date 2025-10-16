/**
 * TRaSH Guides Automatic Sync Scheduler
 * Automatically syncs TRaSH-managed custom formats, CF groups, and quality profiles on a configurable schedule
 */

import type { PrismaClient, ServiceType } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { FastifyInstance } from "fastify";
import { fetchTrashGuides, fetchCFGroups, fetchQualityProfiles } from "./trash-fetcher.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

interface SyncResult {
	instanceId: string;
	instanceLabel: string;
	synced: number;
	failed: number;
	skipped: number;
	cfGroupsSynced: number;
	qualityProfilesSynced: number;
}

export class TrashSyncScheduler {
	private intervalId: NodeJS.Timeout | null = null;
	private isRunning = false;

	constructor(
		private prisma: PrismaClient,
		private logger: FastifyBaseLogger,
		private app: FastifyInstance,
	) {}

	/**
	 * Start the TRaSH sync scheduler
	 */
	start() {
		if (this.intervalId) {
			this.logger.warn("TRaSH sync scheduler already running");
			return;
		}

		this.logger.info("Starting TRaSH sync scheduler");

		// Run immediately on startup
		this.checkAndRunSync().catch((error) => {
			this.logger.error({ err: error }, "Failed to run initial TRaSH sync check");
		});

		// Then check every minute
		this.intervalId = setInterval(() => {
			this.checkAndRunSync().catch((error) => {
				this.logger.error({ err: error }, "Failed to run scheduled TRaSH sync check");
			});
		}, CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the TRaSH sync scheduler
	 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			this.logger.info("TRaSH sync scheduler stopped");
		}
	}

	/**
	 * Check if a sync should run and execute it
	 * Checks all instances and syncs those that are due
	 */
	private async checkAndRunSync() {
		// In-flight guard: prevent overlapping sync runs
		if (this.isRunning) {
			this.logger.debug("TRaSH sync already running, skipping this check");
			return;
		}

		try {
			// Get all instance sync settings
			const allSettings = await this.prisma.trashInstanceSyncSettings.findMany();

			if (allSettings.length === 0) {
				return;
			}

			const now = new Date();
			const instancesToSync = allSettings.filter((settings) => {
				// Skip if disabled or no interval
				if (!settings.enabled || settings.intervalType === "DISABLED") {
					return false;
				}

				// Check if it's time to run
				return !settings.nextRunAt || settings.nextRunAt <= now;
			});

			if (instancesToSync.length === 0) {
				return;
			}

			// Set running flag before executing sync
			this.isRunning = true;

			this.logger.info(
				{
					instanceCount: instancesToSync.length,
				},
				"Running scheduled TRaSH sync for instances",
			);

			try {
				const results: SyncResult[] = [];

				// Sync each instance independently
				for (const settings of instancesToSync) {
					try {
						const instance = await this.prisma.serviceInstance.findUnique({
							where: { id: settings.serviceInstanceId },
						});

						if (!instance) {
							this.logger.warn(
								{ instanceId: settings.serviceInstanceId },
								"Instance not found for sync settings",
							);
							continue;
						}

						// Sync this instance
						const result = await this.syncInstance(
							instance.id,
							instance.label,
							instance.service,
						settings,
						);
						results.push(result);

						// Calculate next run time for this instance
						const nextRunAt = this.calculateNextRunTime(
							settings.intervalType as "HOURLY" | "DAILY" | "WEEKLY",
							settings.intervalValue,
						);

						// Update this instance's settings
						await this.prisma.trashInstanceSyncSettings.update({
					where: { id: settings.id },
						data: {
							lastRunAt: now,
							lastRunStatus: result.failed > 0 ? "PARTIAL" : "SUCCESS",
							lastErrorMessage: null,
							formatsSynced: result.synced,
							formatsFailed: result.failed,
							cfGroupsSynced: result.cfGroupsSynced,
							qualityProfilesSynced: result.qualityProfilesSynced,
							nextRunAt,
						},
						});

						this.logger.info(
							{
								instanceId: instance.id,
								instanceLabel: instance.label,
								synced: result.synced,
								failed: result.failed,
								nextRunAt: nextRunAt.toISOString(),
							},
							"Instance sync completed",
						);
					} catch (error) {
				const nextRunAt = this.calculateNextRunTime(
						settings.intervalType as "HOURLY" | "DAILY" | "WEEKLY",
						settings.intervalValue,
					);

					// Update settings with failure status
					await this.prisma.trashInstanceSyncSettings.update({
						where: { id: settings.id },
						data: {
							lastRunAt: now,
							lastRunStatus: "FAILED",
							lastErrorMessage: error instanceof Error ? error.message : String(error),
							nextRunAt,
						},
					});

						this.logger.error(
							{ err: error, instanceId: settings.serviceInstanceId },
							"Failed to sync instance",
						);
					}
				}

				this.logger.info(
					{
						totalFormatsSynced: results.reduce((sum, r) => sum + r.synced, 0),
						totalFormatsFailed: results.reduce((sum, r) => sum + r.failed, 0),
						totalCFGroupsSynced: results.reduce((sum, r) => sum + r.cfGroupsSynced, 0),
						totalQualityProfilesSynced: results.reduce((sum, r) => sum + r.qualityProfilesSynced, 0),
						instancesProcessed: results.length,
					},
					"Scheduled TRaSH sync completed",
				);
			} finally {
				// Always reset the running flag, even if sync fails
				this.isRunning = false;
			}
		} catch (error) {
			this.logger.error({ err: error }, "Error checking/running scheduled TRaSH sync");
		}
	}

	/**
	 * Sync a single instance's TRaSH-tracked formats, CF groups, and quality profiles
	 */
	private async syncInstance(
		instanceId: string,
		instanceLabel: string,
		service: string,
		syncSettings: any,
	): Promise<SyncResult> {
		const result: SyncResult = {
			instanceId,
			instanceLabel,
			synced: 0,
			failed: 0,
			skipped: 0,
			cfGroupsSynced: 0,
			qualityProfilesSynced: 0,
		};

		try {
			// Get instance for API calls
			const instance = await this.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				this.logger.error({ instanceId }, "Instance not found");
				return result;
			}

			const { createInstanceFetcher } = await import("../../arr/arr-fetcher.js");
			const fetcher = createInstanceFetcher(this.app, instance);

			// ========================================
			// 1. Sync Individual Custom Formats
			// ========================================
			if (syncSettings.syncFormats) {
				await this.syncCustomFormats(instanceId, instanceLabel, instance, fetcher, service, result);
			} else {
				this.logger.debug({ instanceId, instanceLabel }, "Skipping custom formats sync (disabled in settings)");
			}

			// ========================================
			// 2. Sync CF Groups
			// ========================================
			if (syncSettings.syncCFGroups) {
				await this.syncCFGroups(instanceId, instanceLabel, instance, fetcher, service, result);
			} else {
				this.logger.debug({ instanceId, instanceLabel }, "Skipping CF groups sync (disabled in settings)");
			}

			// ========================================
			// 3. Sync Quality Profiles
			// ========================================
			if (syncSettings.syncQualityProfiles) {
				await this.syncQualityProfiles(instanceId, instanceLabel, instance, fetcher, service, result);
			} else {
				this.logger.debug({ instanceId, instanceLabel }, "Skipping quality profiles sync (disabled in settings)");
			}

			this.logger.info(
				{
					instanceLabel,
					formatsSynced: result.synced,
					formatsFailed: result.failed,
					cfGroupsSynced: result.cfGroupsSynced,
					qualityProfilesSynced: result.qualityProfilesSynced,
				},
				"Instance sync completed",
			);
		} catch (error) {
			this.logger.error({ err: error, instanceId, instanceLabel }, "Failed to sync instance");
			throw error;
		}

		return result;
	}

	/**
	 * Sync individual custom formats for an instance
	 */
	private async syncCustomFormats(
		instanceId: string,
		instanceLabel: string,
		instance: any,
		fetcher: any,
		service: string,
		result: SyncResult,
	): Promise<void> {
		const trackedFormats = await this.prisma.trashCustomFormatTracking.findMany({
			where: { serviceInstanceId: instanceId },
		});

		if (trackedFormats.length === 0) {
			this.logger.debug({ instanceId, instanceLabel }, "No TRaSH-tracked formats to sync");
			return;
		}

		// Fetch latest TRaSH data (use master ref for scheduled syncs)
		const trashData = await fetchTrashGuides({
			service: service as ServiceType,
			ref: "master",
		});

		// Sync each tracked format
		for (const tracked of trackedFormats) {
			try {
				// Skip formats excluded from sync
				if (tracked.syncExcluded) {
					this.logger.debug(
						{
							customFormatId: tracked.customFormatId,
							formatName: tracked.customFormatName,
						},
						"Skipping sync for excluded format",
					);
					result.skipped++;
					continue;
				}

				// Find the latest version from TRaSH
				const latestFormat = trashData.customFormats.find(
					(cf) => cf.trash_id === tracked.trashId,
				);

				if (!latestFormat) {
					this.logger.warn(
						{
							trashId: tracked.trashId,
							formatName: tracked.customFormatName,
							instanceLabel,
						},
						"TRaSH format no longer exists in guides",
					);
					result.failed++;
					continue;
				}

				// Update the format in Sonarr/Radarr
				const updateResponse = await fetcher(
					`/api/v3/customformat/${tracked.customFormatId}`,
					{
						method: "PUT",
						body: JSON.stringify({
							id: tracked.customFormatId,
							name: latestFormat.name,
							includeCustomFormatWhenRenaming: latestFormat.includeCustomFormatWhenRenaming,
							specifications: latestFormat.specifications,
						}),
						headers: {
							"Content-Type": "application/json",
						},
					},
				);

				if (!updateResponse.ok) {
					this.logger.error(
						{
							customFormatId: tracked.customFormatId,
							statusCode: updateResponse.status,
							instanceLabel,
						},
						"Failed to update custom format during scheduled sync",
					);
					result.failed++;
					continue;
				}

				// Update tracking record
				await this.prisma.trashCustomFormatTracking.update({
					where: {
						serviceInstanceId_customFormatId: {
							serviceInstanceId: instanceId,
							customFormatId: tracked.customFormatId,
						},
					},
					data: {
						customFormatName: latestFormat.name,
						lastSyncedAt: new Date(),
						gitRef: "master",
					},
				});

				result.synced++;
			} catch (error) {
				this.logger.error(
					{
						err: error,
						customFormatId: tracked.customFormatId,
						instanceLabel,
					},
					"Error syncing custom format",
				);
				result.failed++;
			}
		}
	}

	/**
	 * Sync CF Groups for an instance
	 */
	private async syncCFGroups(
		instanceId: string,
		instanceLabel: string,
		instance: any,
		fetcher: any,
		service: string,
		result: SyncResult,
	): Promise<void> {
		const trackedGroups = await this.prisma.trashCFGroupTracking.findMany({
			where: { serviceInstanceId: instanceId },
		});

		if (trackedGroups.length === 0) {
			this.logger.debug({ instanceId, instanceLabel }, "No tracked CF groups to sync");
			return;
		}

		// Fetch CF groups data
		const cfGroups = await fetchCFGroups({
			service: service as ServiceType,
			ref: "master",
		});

		// Fetch TRaSH custom formats
		const trashData = await fetchTrashGuides({
			service: service as ServiceType,
			ref: "master",
		});

		// Sync each tracked group
		for (const trackedGroup of trackedGroups) {
			try {
				// Find the CF group in TRaSH guides
				const cfGroup = cfGroups.find((group) => group.fileName === trackedGroup.groupFileName);

				if (!cfGroup) {
					this.logger.warn(
						{
							groupFileName: trackedGroup.groupFileName,
							groupName: trackedGroup.groupName,
							instanceLabel,
						},
						"CF group no longer exists in TRaSH guides",
					);
					continue;
				}

				// Get the latest list of custom format IDs in this CF group
				const currentCFGroupFormatIds = new Set(
					(cfGroup.custom_formats || [])
						.map((cfRef: any) => trashData.customFormats.find((cf: any) => cf.trash_id === cfRef.trash_id))
						.filter((cf: any) => cf !== undefined)
						.map((cf: any) => cf.name)
				);

				// Find all custom formats that were imported as part of this CF group
				const groupCustomFormats = await this.prisma.trashCustomFormatTracking.findMany({
					where: {
						serviceInstanceId: instanceId,
						importSource: "CF_GROUP",
						sourceReference: trackedGroup.groupFileName, // Only formats from this specific group
					},
				});

				// Check if each tracked format still exists in the CF group
				for (const trackedFormat of groupCustomFormats) {
					if (!currentCFGroupFormatIds.has(trackedFormat.customFormatName)) {
						// This format was part of the CF group but is no longer in it
						// Delete it from Sonarr/Radarr
						try {
							const deleteResponse = await fetcher(
								`/api/v3/customformat/${trackedFormat.customFormatId}`,
								{
									method: "DELETE",
								},
							);

							if (deleteResponse.ok) {
								// Remove the tracking record
								await this.prisma.trashCustomFormatTracking.delete({
									where: {
										serviceInstanceId_customFormatId: {
											serviceInstanceId: instanceId,
											customFormatId: trackedFormat.customFormatId,
										},
									},
								});
								this.logger.info(
									{
										formatName: trackedFormat.customFormatName,
										formatId: trackedFormat.customFormatId,
										groupFileName: trackedGroup.groupFileName,
										instanceLabel,
									},
									"Custom format removed from CF group and deleted",
								);
							} else {
								this.logger.error(
									{
										formatName: trackedFormat.customFormatName,
										formatId: trackedFormat.customFormatId,
										statusCode: deleteResponse.status,
										instanceLabel,
									},
									"Failed to delete custom format that was removed from CF group",
								);
								result.failed++;
							}
						} catch (deleteError) {
							this.logger.error(
								{
									err: deleteError,
									formatName: trackedFormat.customFormatName,
									formatId: trackedFormat.customFormatId,
									instanceLabel,
								},
								"Error deleting custom format that was removed from CF group",
							);
							result.failed++;
						}
					}
				}

				let importedCount = 0;

				// Re-import each custom format in the group
				for (const cfRef of cfGroup.custom_formats || []) {
					try {
						const trashFormat = trashData.customFormats.find(
							(cf) => cf.trash_id === cfRef.trash_id,
						);

						if (!trashFormat) {
							this.logger.warn(
								{
									trashId: cfRef.trash_id,
									groupName: cfGroup.name,
								},
								"Custom format not found in TRaSH guides",
							);
							continue;
						}

						// Check if this custom format already exists
						const existingResponse = await fetcher("/api/v3/customformat");
						const existingFormats = await existingResponse.json();

						const existingFormat = existingFormats.find(
							(cf: any) => cf.name === trashFormat.name,
						);

						let cfResult;
						if (existingFormat) {
							// Update existing
							const updateResponse = await fetcher(
								`/api/v3/customformat/${existingFormat.id}`,
								{
									method: "PUT",
									body: JSON.stringify({
										...existingFormat,
										name: trashFormat.name,
										includeCustomFormatWhenRenaming:
											trashFormat.includeCustomFormatWhenRenaming,
										specifications: trashFormat.specifications,
									}),
									headers: {
										"Content-Type": "application/json",
									},
								},
							);

							if (!updateResponse.ok) {
								this.logger.error(
									{
										formatName: trashFormat.name,
										statusCode: updateResponse.status,
									},
									"Failed to update custom format from CF group",
								);
								continue;
							}

							cfResult = await updateResponse.json();
						} else {
							// Create new
							const createResponse = await fetcher("/api/v3/customformat", {
								method: "POST",
								body: JSON.stringify({
									name: trashFormat.name,
									includeCustomFormatWhenRenaming:
										trashFormat.includeCustomFormatWhenRenaming,
									specifications: trashFormat.specifications,
								}),
								headers: {
									"Content-Type": "application/json",
								},
							});

							if (!createResponse.ok) {
								this.logger.error(
									{
										formatName: trashFormat.name,
										statusCode: createResponse.status,
									},
									"Failed to create custom format from CF group",
								);
								continue;
							}

							cfResult = await createResponse.json();
						}

						// Track this custom format
						await this.prisma.trashCustomFormatTracking.upsert({
							where: {
								serviceInstanceId_customFormatId: {
									serviceInstanceId: instanceId,
									customFormatId: cfResult.id,
								},
							},
							update: {
								customFormatName: trashFormat.name,
								trashId: cfRef.trash_id,
								lastSyncedAt: new Date(),
								gitRef: "master",
							},
							create: {
								serviceInstanceId: instanceId,
								customFormatId: cfResult.id,
								customFormatName: trashFormat.name,
								trashId: cfRef.trash_id,
								service: instance.service as any,
								gitRef: "master",
								importSource: "CF_GROUP",
								sourceReference: trackedGroup.groupFileName,
							},
						});

						importedCount++;
					} catch (error) {
						this.logger.error(
							{
								err: error,
								trashId: cfRef.trash_id,
								groupName: cfGroup.name,
							},
							"Error syncing custom format from CF group",
						);
					}
				}

				// Update CF group tracking
				await this.prisma.trashCFGroupTracking.update({
					where: {
						serviceInstanceId_groupFileName: {
							serviceInstanceId: instanceId,
							groupFileName: trackedGroup.groupFileName,
						},
					},
					data: {
						groupName: cfGroup.name,
						importedCount,
						lastSyncedAt: new Date(),
						gitRef: "master",
					},
				});

				result.cfGroupsSynced++;
				this.logger.info(
					{
						groupName: cfGroup.name,
						importedCount,
						instanceLabel,
					},
					"CF group synced",
				);
			} catch (error) {
				this.logger.error(
					{
						err: error,
						groupFileName: trackedGroup.groupFileName,
						instanceLabel,
					},
					"Error syncing CF group",
				);
			}
		}
	}

	/**
	 * Sync Quality Profiles for an instance
	 */
	private async syncQualityProfiles(
		instanceId: string,
		instanceLabel: string,
		instance: any,
		fetcher: any,
		service: string,
		result: SyncResult,
	): Promise<void> {
		const trackedProfiles = await this.prisma.trashQualityProfileTracking.findMany({
			where: { serviceInstanceId: instanceId },
		});

		if (trackedProfiles.length === 0) {
			this.logger.debug({ instanceId, instanceLabel }, "No tracked quality profiles to sync");
			return;
		}

		// Fetch quality profiles data
		const qualityProfiles = await fetchQualityProfiles({
			service: service as ServiceType,
			ref: "master",
		});

		// Sync each tracked profile
		for (const trackedProfile of trackedProfiles) {
			try {
				// Find the quality profile in TRaSH guides
				const qualityProfile = qualityProfiles.find(
					(profile) => profile.fileName === trackedProfile.profileFileName,
				);

				if (!qualityProfile) {
					this.logger.warn(
						{
							profileFileName: trackedProfile.profileFileName,
							profileName: trackedProfile.profileName,
							instanceLabel,
						},
						"Quality profile no longer exists in TRaSH guides",
					);
					continue;
				}

				// Get existing quality profiles
				const existingResponse = await fetcher("/api/v3/qualityprofile");
				const existingProfiles = await existingResponse.json();

				// Check if a profile with this ID exists (prefer ID over name)
				const existingProfile = trackedProfile.qualityProfileId
					? existingProfiles.find((profile: any) => profile.id === trackedProfile.qualityProfileId)
					: existingProfiles.find((profile: any) => profile.name === qualityProfile.name);

				if (!existingProfile) {
					this.logger.warn(
						{
							profileName: trackedProfile.profileName,
							instanceLabel,
						},
						"Tracked quality profile no longer exists in instance",
					);
					continue;
				}

				// If this quality profile uses formatItems (custom formats in the profile),
				// we need to handle custom formats that were imported via QUALITY_PROFILE source
				if (qualityProfile.formatItems) {
					// Get the list of custom format IDs currently in the quality profile
					const currentQualityProfileFormatIds = new Set(
						qualityProfile.formatItems.map((item: any) => item.format)
					);

					// Find all custom formats that were imported as part of this quality profile
					const profileCustomFormats = await this.prisma.trashCustomFormatTracking.findMany({
						where: {
							serviceInstanceId: instanceId,
							importSource: "QUALITY_PROFILE",
							sourceReference: trackedProfile.profileFileName, // Only formats from this specific profile
						},
					});

					// Check if each tracked format still exists in the quality profile
					for (const trackedFormat of profileCustomFormats) {
						if (!currentQualityProfileFormatIds.has(trackedFormat.customFormatId)) {
							// This format was part of the quality profile but is no longer in it
							// Delete it from Sonarr/Radarr
							try {
								const deleteResponse = await fetcher(
									`/api/v3/customformat/${trackedFormat.customFormatId}`,
									{
										method: "DELETE",
									},
								);

								if (deleteResponse.ok) {
									// Remove the tracking record
									await this.prisma.trashCustomFormatTracking.delete({
										where: {
											serviceInstanceId_customFormatId: {
												serviceInstanceId: instanceId,
												customFormatId: trackedFormat.customFormatId,
											},
										},
									});
									this.logger.info(
										{
											formatName: trackedFormat.customFormatName,
											formatId: trackedFormat.customFormatId,
											profileFileName: trackedProfile.profileFileName,
											instanceLabel,
										},
										"Custom format removed from quality profile and deleted",
									);
								} else {
									this.logger.error(
										{
											formatName: trackedFormat.customFormatName,
											formatId: trackedFormat.customFormatId,
											statusCode: deleteResponse.status,
											instanceLabel,
										},
										"Failed to delete custom format that was removed from quality profile",
									);
									result.failed++;
								}
							} catch (deleteError) {
								this.logger.error(
									{
										err: deleteError,
										formatName: trackedFormat.customFormatName,
										formatId: trackedFormat.customFormatId,
										instanceLabel,
									},
									"Error deleting custom format that was removed from quality profile",
								);
								result.failed++;
							}
						}
					}
				}

				// Update existing profile
				const updateResponse = await fetcher(
					`/api/v3/qualityprofile/${existingProfile.id}`,
					{
						method: "PUT",
						body: JSON.stringify({
							...existingProfile,
							...qualityProfile,
							id: existingProfile.id,
							name: qualityProfile.name,
						}),
						headers: {
							"Content-Type": "application/json",
						},
					},
				);

				if (!updateResponse.ok) {
					this.logger.error(
						{
							profileName: qualityProfile.name,
							statusCode: updateResponse.status,
							instanceLabel,
						},
						"Failed to update quality profile during scheduled sync",
					);
					continue;
				}

				// Update tracking
				await this.prisma.trashQualityProfileTracking.update({
					where: {
						serviceInstanceId_profileFileName: {
							serviceInstanceId: instanceId,
							profileFileName: trackedProfile.profileFileName,
						},
					},
					data: {
						profileName: qualityProfile.name,
						qualityProfileId: existingProfile.id,
						lastAppliedAt: new Date(),
						gitRef: "master",
					},
				});

				result.qualityProfilesSynced++;
				this.logger.info(
					{
						profileName: qualityProfile.name,
						instanceLabel,
					},
					"Quality profile synced",
				);
			} catch (error) {
				this.logger.error(
					{
						err: error,
						profileFileName: trackedProfile.profileFileName,
						instanceLabel,
					},
					"Error syncing quality profile",
				);
			}
		}
	}

	/**
	 * Calculate the next run time based on interval settings
	 */
	private calculateNextRunTime(
		intervalType: "HOURLY" | "DAILY" | "WEEKLY",
		intervalValue: number,
	): Date {
		const now = new Date();

		switch (intervalType) {
			case "HOURLY":
				return new Date(now.getTime() + intervalValue * 60 * 60 * 1000);
			case "DAILY":
				return new Date(now.getTime() + intervalValue * 24 * 60 * 60 * 1000);
			case "WEEKLY":
				return new Date(now.getTime() + 7 * intervalValue * 24 * 60 * 60 * 1000);
			default:
				return new Date(now.getTime() + 24 * 60 * 60 * 1000); // Default to 24 hours
		}
	}
}
