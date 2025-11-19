/**
 * TRaSH Guides Deployment Executor Service
 *
 * Executes deployment of Custom Formats from template to Radarr/Sonarr instances.
 * Handles both single and bulk deployments.
 */

import { PrismaClient } from "@prisma/client";
import { ArrApiClient, createArrApiClient } from "./arr-api-client.js";
import type { CustomFormat } from "./arr-api-client.js";

// ============================================================================
// Types
// ============================================================================

export interface DeploymentResult {
	instanceId: string;
	instanceLabel: string;
	success: boolean;
	customFormatsCreated: number;
	customFormatsUpdated: number;
	customFormatsSkipped: number;
	errors: string[];
	details?: {
		created: string[]; // CF names
		updated: string[]; // CF names
		failed: string[]; // CF names
	};
}

export interface BulkDeploymentResult {
	templateId: string;
	templateName: string;
	totalInstances: number;
	successfulInstances: number;
	failedInstances: number;
	results: DeploymentResult[];
}

// ============================================================================
// Deployment Executor Service Class
// ============================================================================

export class DeploymentExecutorService {
	private prisma: PrismaClient;
	private encryptor: { decrypt: (payload: { value: string; iv: string }) => string };

	constructor(
		prisma: PrismaClient,
		encryptor: { decrypt: (payload: { value: string; iv: string }) => string },
	) {
		this.prisma = prisma;
		this.encryptor = encryptor;
	}

	/**
	 * Execute deployment to a single instance
	 */
	async deploySingleInstance(
		templateId: string,
		instanceId: string,
		userId: string,
	): Promise<DeploymentResult> {
		const errors: string[] = [];
		const details = {
			created: [] as string[],
			updated: [] as string[],
			failed: [] as string[],
		};

		const startTime = new Date();
		let historyId: string | null = null;
		let deploymentHistoryId: string | null = null;

		try {
			// Get template
			const template = await this.prisma.trashTemplate.findUnique({
				where: { id: templateId },
			});

			if (!template) {
				throw new Error("Template not found");
			}

			// Get instance
			const instance = await this.prisma.serviceInstance.findUnique({
				where: { id: instanceId },
			});

			if (!instance) {
				throw new Error("Instance not found");
			}

			// Validate service type match
			if (template.serviceType !== instance.service) {
				throw new Error(
					`Service type mismatch: template is ${template.serviceType}, instance is ${instance.service}`,
				);
			}

			// Create backup snapshot before deployment
			const preDeploymentCFs = await this.getExistingCustomFormats(instance);
			const backup = await this.prisma.trashBackup.create({
				data: {
					instanceId,
					userId,
					backupData: JSON.stringify(preDeploymentCFs),
				},
			});

			// Create deployment history record (TrashSyncHistory for legacy compatibility)
			const history = await this.prisma.trashSyncHistory.create({
				data: {
					instanceId,
					templateId,
					userId,
					syncType: "MANUAL",
					status: "IN_PROGRESS",
					backupId: backup.id,
					appliedConfigs: "[]",
					configsApplied: 0,
					configsFailed: 0,
					configsSkipped: 0,
				},
			});
			historyId = history.id;

			// Create API client
			const apiClient = createArrApiClient(instance, this.encryptor);

			// Test connection
			try {
				await apiClient.getSystemStatus();
			} catch (error) {
				throw new Error(`Instance unreachable: ${error instanceof Error ? error.message : "Unknown error"}`);
			}

			// Get existing Custom Formats from instance
			const existingCFs = await apiClient.getCustomFormats();
			console.log(`[DEPLOYMENT] Found ${existingCFs.length} existing CFs in Radarr`);

			const existingCFMap = new Map<string, CustomFormat>();
			const existingCFByName = new Map<string, CustomFormat>();
			for (const cf of existingCFs) {
				const trashId = this.extractTrashId(cf);
				console.log(`[DEPLOYMENT] Existing CF: "${cf.name}" (ID: ${cf.id}, trashId: ${trashId})`);
				if (trashId) {
					existingCFMap.set(trashId, cf);
				}
				// Also map by name for fallback matching
				existingCFByName.set(cf.name, cf);
			}

			console.log(`[DEPLOYMENT] Built maps: ${existingCFMap.size} by trashId, ${existingCFByName.size} by name`);

			// Parse template config and apply instance overrides
			const templateConfig = JSON.parse(template.configData);
			let templateCFs = (templateConfig.customFormats || []) as Array<{
				trashId: string;
				name: string;
				scoreOverride: number;
				originalConfig: any;
			}>;

			// Apply instance-specific overrides
			const instanceOverrides = template.instanceOverrides
				? JSON.parse(template.instanceOverrides)
				: {};
			const overridesForInstance = instanceOverrides[instanceId] || {};

			if (overridesForInstance.scoreOverrides || overridesForInstance.cfOverrides) {
				templateCFs = templateCFs
					.map((cf) => {
						const cfOverride = overridesForInstance.cfOverrides?.[cf.trashId];
						const scoreOverride = overridesForInstance.scoreOverrides?.[cf.trashId];

						// Skip if CF is disabled for this instance
						if (cfOverride?.enabled === false) {
							return null;
						}

						// Apply score override if exists
						const finalScore =
							scoreOverride !== undefined ? scoreOverride : cf.scoreOverride;

						return {
							...cf,
							scoreOverride: finalScore,
						};
					})
					.filter((cf): cf is NonNullable<typeof cf> => cf !== null);
			}

			// Create TemplateDeploymentHistory record now that we have templateCFs
			const deploymentHistory = await this.prisma.templateDeploymentHistory.create({
				data: {
					templateId,
					instanceId,
					userId,
					deployedBy: userId,
					status: "IN_PROGRESS",
					totalCFs: templateCFs.length,
					appliedCFs: 0,
					failedCFs: 0,
					conflictsCount: 0,
					backupId: backup.id,
					canRollback: true,
					templateSnapshot: template.configData,
				},
			});
			deploymentHistoryId = deploymentHistory.id;

			// Deploy each Custom Format
			let created = 0;
			let updated = 0;
			let skipped = 0;

			// Write deployment start info to file
			const fs = await import("fs");
			fs.writeFileSync("/tmp/deployment-start.log", `Starting deployment at ${new Date().toISOString()}\nTemplate CFs: ${templateCFs.length}\nExisting CFs: ${existingCFs.length}\n`);

			for (const templateCF of templateCFs) {
				try {
					console.log(`[DEPLOYMENT] ===== Processing CF: ${templateCF.name} =====`);
					console.log(`[DEPLOYMENT] Template CF trashId: ${templateCF.trashId}`);
					console.log(`[DEPLOYMENT] Looking for name: "${templateCF.name}"`);
					console.log(`[DEPLOYMENT] Available names in map:`, Array.from(existingCFByName.keys()).slice(0, 5)); // Just first 5 to reduce log spam

					// Try to match by trashId first, then fall back to name
					let existingCF = existingCFMap.get(templateCF.trashId);
					if (!existingCF) {
						console.log(`[DEPLOYMENT] No match by trashId, trying name match...`);
						existingCF = existingCFByName.get(templateCF.name);
						if (!existingCF) {
							console.log(`[DEPLOYMENT] Name match also failed`);
						}
					}

					if (existingCF) {
						console.log(`[DEPLOYMENT] FOUND MATCH: "${existingCF.name}" (ID: ${existingCF.id})`);
					} else {
						console.log(`[DEPLOYMENT] NO MATCH FOUND - will create new CF`);
					}

					if (existingCF && existingCF.id) {
						// Update existing CF
						// Transform specifications: convert fields from object to array format
						console.log(`[DEPLOYMENT] PRE-TRANSFORM UPDATE - Original spec for "${templateCF.name}":`, JSON.stringify(templateCF.originalConfig?.specifications || []));
						const specifications = (templateCF.originalConfig?.specifications || []).map((spec: any) => {
							console.log(`[DEPLOYMENT] Processing spec "${spec.name}" with fields:`, JSON.stringify(spec.fields));
							const transformedFields = this.transformFieldsToArray(spec.fields);
							console.log(`[DEPLOYMENT] Transformed fields result:`, JSON.stringify(transformedFields));
							return {
								...spec,
								fields: transformedFields,
							};
						});

						const updatedCF = {
							...existingCF,
							name: templateCF.name,
							specifications,
						};

						console.log(`[DEPLOYMENT] Updating CF "${templateCF.name}" (id: ${existingCF.id})`);
						console.log(`[DEPLOYMENT] Update CF Data:`, JSON.stringify(updatedCF, null, 2));
						await apiClient.updateCustomFormat(existingCF.id, updatedCF);
						updated++;
						details.updated.push(templateCF.name);
					} else {
						// Create new CF
						// Transform specifications: convert fields from object to array format
						console.log(`[DEPLOYMENT] PRE-TRANSFORM - Original spec for "${templateCF.name}":`, JSON.stringify(templateCF.originalConfig?.specifications || []));
						const specifications = (templateCF.originalConfig?.specifications || []).map((spec: any) => {
							console.log(`[DEPLOYMENT] Processing spec "${spec.name}" with fields:`, JSON.stringify(spec.fields));
							const transformedFields = this.transformFieldsToArray(spec.fields);
							console.log(`[DEPLOYMENT] Transformed fields result:`, JSON.stringify(transformedFields));
							return {
								...spec,
								fields: transformedFields,
							};
						});

						const newCF = {
							name: templateCF.name,
							includeCustomFormatWhenRenaming: false,
							specifications,
						};

						console.log(`[DEPLOYMENT] Creating CF "${templateCF.name}"`);
						console.log(`[DEPLOYMENT] CF Data:`, JSON.stringify(newCF, null, 2));
						await apiClient.createCustomFormat(newCF);
						created++;
						details.created.push(templateCF.name);
					}
				} catch (error) {
					console.error(`[DEPLOYMENT] Failed to deploy "${templateCF.name}":`, error);
					console.error(`[DEPLOYMENT] Error details:`, {
						message: error instanceof Error ? error.message : "Unknown error",
						stack: error instanceof Error ? error.stack : undefined,
						error: error,
					});
					errors.push(
						`Failed to deploy "${templateCF.name}": ${error instanceof Error ? error.message : "Unknown error"}`,
					);
					details.failed.push(templateCF.name);
					skipped++;
				}
			}

			// Update Quality Profile with Custom Format scores
			console.log("[DEPLOYMENT] ===== Updating Quality Profile =====");
			try {
				const profileName = template.name || "TRaSH Guides HD/UHD";
				console.log(`[DEPLOYMENT] Looking for quality profile: "${profileName}"`);

				let qualityProfiles = await apiClient.getQualityProfiles();
				console.log(`[DEPLOYMENT] Quality profiles response:`, JSON.stringify(qualityProfiles));
				console.log(`[DEPLOYMENT] Quality profiles count: ${qualityProfiles.length}`);

				// Find existing profile by name
				let targetProfile = qualityProfiles.find(p => p.name === profileName);

				if (targetProfile) {
					console.log(`[DEPLOYMENT] Found existing profile "${profileName}" (ID: ${targetProfile.id})`);
				}

				// Create quality profile if it doesn't exist
				if (!targetProfile) {
					console.log(`[DEPLOYMENT] Profile "${profileName}" not found, creating new profile...`);

					try {
						// Get the quality profile schema to get proper structure
						console.log("[DEPLOYMENT] Fetching quality profile schema...");
						const schema = await apiClient.getQualityProfileSchema();
						console.log("[DEPLOYMENT] Schema fetched successfully");

						// Write to file for debugging
						const fs = await import("fs");
						fs.writeFileSync("/tmp/radarr-schema.json", JSON.stringify(schema, null, 2));
						console.log("[DEPLOYMENT] Schema written to /tmp/radarr-schema.json");

						// Get quality definitions from the TRaSH template config
						const fs2 = await import("fs");
						fs2.writeFileSync("/tmp/template-debug.json", JSON.stringify(templateConfig, null, 2));
						console.log("[DEPLOYMENT] ===== TEMPLATE CONFIG DEBUG =====");
						console.log("[DEPLOYMENT] template.name:", template.name);
						console.log("[DEPLOYMENT] templateConfig.qualityProfile exists:", !!templateConfig.qualityProfile);
						if (templateConfig.qualityProfile) {
							console.log("[DEPLOYMENT] qualityProfile.items count:", templateConfig.qualityProfile.items?.length || 0);
						}
						console.log("[DEPLOYMENT] ===== END TEMPLATE CONFIG DEBUG =====");

						// Normalize quality names for consistent matching (remove spaces/hyphens)
						const normalizeQualityName = (name: string) => name.replace(/[\s-]/g, '').toLowerCase();

						// Build a flat map of all individual qualities available in Radarr schema
						const allAvailableQualities = new Map<string, any>();
						const extractQualities = (items: any[]) => {
							for (const item of items) {
								if (item.quality) {
									// This is an individual quality
									allAvailableQualities.set(
										normalizeQualityName(item.quality.name),
										item
									);
								}
								// Recursively extract from nested items
								if (item.items && Array.isArray(item.items)) {
									extractQualities(item.items);
								}
							}
						};
						extractQualities(schema.items);
						console.log(`[DEPLOYMENT] Found ${allAvailableQualities.size} individual qualities in Radarr`);

						// Build quality items according to TRaSH Guides structure
						const qualityItems: any[] = [];
						let customGroupId = 1000; // Start custom group IDs at 1000

						for (const templateItem of templateConfig.qualityProfile?.items || []) {
							if (templateItem.items && Array.isArray(templateItem.items) && templateItem.items.length > 0) {
								// This is a quality GROUP from TRaSH (e.g., "WEB 720p" with nested qualities)
								console.log(`[DEPLOYMENT] Building custom group "${templateItem.name}" with ${templateItem.items.length} qualities`);

								const groupQualities: any[] = [];
								for (const qualityName of templateItem.items) {
									const quality = allAvailableQualities.get(normalizeQualityName(qualityName));
									if (quality) {
										groupQualities.push({
											...quality,
											allowed: false // Individual items in groups have allowed=false, group controls it
										});
										console.log(`[DEPLOYMENT]   - Added "${qualityName}" to group`);
									} else {
										console.log(`[DEPLOYMENT]   - WARNING: Quality "${qualityName}" not found in Radarr`);
									}
								}

								if (groupQualities.length > 0) {
									qualityItems.push({
										name: templateItem.name,
										items: groupQualities,
										allowed: templateItem.allowed,
										id: customGroupId++
									});
									console.log(`[DEPLOYMENT] Created group "${templateItem.name}": ${templateItem.allowed ? 'ENABLED' : 'DISABLED'}`);
								}
							} else {
								// This is an INDIVIDUAL quality from TRaSH (no nested items)
								const quality = allAvailableQualities.get(normalizeQualityName(templateItem.name));
								if (quality) {
									qualityItems.push({
										...quality,
										allowed: templateItem.allowed
									});
									console.log(`[DEPLOYMENT] Individual quality "${templateItem.name}": ${templateItem.allowed ? 'ENABLED' : 'DISABLED'}`);
								} else {
									console.log(`[DEPLOYMENT] WARNING: Quality "${templateItem.name}" not found in Radarr`);
								}
							}
						}

						console.log(`[DEPLOYMENT] Built ${qualityItems.length} quality items for profile`);

						// Get fresh CFs list with IDs for score application
						const allCFs = await apiClient.getCustomFormats();
						const cfMap = new Map(allCFs.map(cf => [cf.name, cf]));

						// Apply CF scores from template to the schema's formatItems
					const formatItemsWithScores = schema.formatItems.map((item: any) => {
						// Find corresponding template CF by matching format ID with CF name
						const cf = allCFs.find(cf => cf.id === item.format);
						if (cf) {
							const templateCF = templateCFs.find(tcf => tcf.name === cf.name);
							if (templateCF) {
							// Determine score: user override > trash_scores[score_set] > trash_scores.default > 0
							let score = 0;
							const scoreSet = templateConfig.qualityProfile?.trash_score_set;

							// Priority 1: User's score override from wizard
							if (templateCF.scoreOverride !== undefined && templateCF.scoreOverride !== null) {
								score = templateCF.scoreOverride;
								console.log(`[DEPLOYMENT] Applying user override score ${score} to CF "${cf.name}" (ID: ${cf.id})`);
							}
							// Priority 2: TRaSH Guides score from profile's score set
							else if (scoreSet && templateCF.originalConfig?.trash_scores?.[scoreSet] !== undefined) {
								score = templateCF.originalConfig.trash_scores[scoreSet];
								console.log(`[DEPLOYMENT] Applying TRaSH score ${score} (set: ${scoreSet}) to CF "${cf.name}" (ID: ${cf.id})`);
							}
							// Priority 3: TRaSH Guides default score
							else if (templateCF.originalConfig?.trash_scores?.default !== undefined) {
								score = templateCF.originalConfig.trash_scores.default;
								console.log(`[DEPLOYMENT] Applying TRaSH default score ${score} to CF "${cf.name}" (ID: ${cf.id})`);
							}
							// Priority 4: Explicit zero (CF has no scores)
							else {
								console.log(`[DEPLOYMENT] CF "${cf.name}" (ID: ${cf.id}) has no scores defined, using 0`);
							}
	
								return {
									...item,
									score
								};
							}
						}
						return item; // Keep default score 0 for CFs not in template
					});

						// Find the cutoff quality ID from the template's cutoff name
						let cutoffId = 31; // Default to Remux-2160p
						if (templateConfig.qualityProfile?.cutoff) {
							const cutoffName = templateConfig.qualityProfile.cutoff;
							console.log(`[DEPLOYMENT] Template specifies cutoff: "${cutoffName}"`);

							// Search in the quality items we built (not schema) - if cutoff is in a group, return group ID
							// Normalize names by removing spaces and hyphens for comparison
							const normalizeName = (name: string) => name.replace(/[\s-]/g, '').toLowerCase();

							const findQualityId = (items: any[], name: string): number | null => {
								const normalizedSearchName = normalizeName(name);

								for (const item of items) {
									// Check top-level quality
									const itemName = item.quality?.name || item.name;
									if (itemName && normalizeName(itemName) === normalizedSearchName) {
										return item.quality?.id || item.id;
									}
									// Check nested qualities (like WEB 2160p contains WEBDL-2160p, WEBRip-2160p)
									if (item.items && Array.isArray(item.items)) {
										for (const subItem of item.items) {
											const subItemName = subItem.quality?.name || subItem.name;
											if (subItemName && normalizeName(subItemName) === normalizedSearchName) {
												return item.id; // Return GROUP ID when cutoff is nested
											}
										}
									}
								}
								return null;
							};

							const foundCutoffId = findQualityId(qualityItems, cutoffName);
							if (foundCutoffId) {
								cutoffId = foundCutoffId;
								console.log(`[DEPLOYMENT] Found cutoff quality ID: ${cutoffId} for "${cutoffName}"`);
							} else {
								console.log(`[DEPLOYMENT] Could not find cutoff "${cutoffName}", using default: ${cutoffId}`);
							}
						}

						// Check if any CF scores are actually defined
						// If all scores are 0 or undefined, override minFormatScore to 0
						const hasDefinedScores = formatItemsWithScores.some((item: any) => item.score && item.score !== 0);
						const templateMinScore = templateConfig.qualityProfile?.minFormatScore ?? 0;
						const effectiveMinScore = (!hasDefinedScores && templateMinScore > 0) ? 0 : templateMinScore;
						if (!hasDefinedScores && templateMinScore > 0) {
							console.log(`[DEPLOYMENT] ⚠️  Template specifies minFormatScore=${templateMinScore} but no CF scores defined - overriding to 0`);
						}

						// Use schema as base and customize with template settings
						const profileToCreate = {
							...schema,
							name: profileName,
							upgradeAllowed: templateConfig.qualityProfile?.upgradeAllowed ?? true,
							cutoff: cutoffId,
							items: qualityItems,
							minFormatScore: effectiveMinScore,
							cutoffFormatScore: templateConfig.qualityProfile?.cutoffFormatScore ?? 10000,
							minUpgradeFormatScore: templateConfig.qualityProfile?.minUpgradeFormatScore ?? 1,
							formatItems: formatItemsWithScores, // Apply template CF scores
						// Set language from template, defaulting to Original if not specified
						...(templateConfig.qualityProfile?.language ? {
							language: {
								id: templateConfig.qualityProfile.language === "Original" ? -2 :
									templateConfig.qualityProfile.language === "Any" ? -1 :
									1, // Default to English
								name: templateConfig.qualityProfile.language
							}
						} : {
							language: { id: -2, name: "Original" } // Default to Original
						}),
						};

						// Remove the id field if it exists (schema might include it)
						delete (profileToCreate as { id?: number }).id;

						fs.writeFileSync("/tmp/radarr-profile-create.json", JSON.stringify(profileToCreate, null, 2));
						console.log("[DEPLOYMENT] Profile to create written to /tmp/radarr-profile-create.json");
						console.log("[DEPLOYMENT] Creating quality profile with schema-based structure and CF scores");
						targetProfile = await apiClient.createQualityProfile(profileToCreate);
						console.log(`[DEPLOYMENT] Created quality profile: ${targetProfile.name} (ID: ${targetProfile.id})`);
					} catch (createError) {
						console.error("[DEPLOYMENT] Failed to create quality profile:", createError);
						console.error("[DEPLOYMENT] Error details:", JSON.stringify(createError, null, 2));
						throw new Error(`Failed to create quality profile: ${createError instanceof Error ? createError.message : "Unknown error"}`);
					}
				}

				if (targetProfile) {
					console.log(`[DEPLOYMENT] Updating quality profile: ${targetProfile.name} (ID: ${targetProfile.id})`);

					// Get fresh CFs list with IDs
					const allCFs = await apiClient.getCustomFormats();
					const cfMap = new Map(allCFs.map(cf => [cf.name, cf]));

				// Fetch instance-level quality profile score overrides
				const instanceOverrides = await this.prisma.instanceQualityProfileOverride.findMany({
					where: {
						instanceId,
						qualityProfileId: targetProfile.id,
					},
				});
				const overrideMap = new Map(
					instanceOverrides.map(override => [override.customFormatId, override.score])
				);
				console.log(`[DEPLOYMENT] Found ${instanceOverrides.length} instance-level score overrides for profile ${targetProfile.id}`);

				// Build format items from template CFs
				const formatItems: Array<{ format: number; score: number }> = [];
				const scoreSet = templateConfig.qualityProfile?.trash_score_set;

				for (const templateCF of templateCFs) {
					const cf = cfMap.get(templateCF.name);
					if (cf && cf.id) {
						// Determine score using priority order
						let score = 0;
						let scoreSource = "default";

						// Priority 1: Instance-level override (manual changes)
						if (overrideMap.has(cf.id)) {
							score = overrideMap.get(cf.id)!;
							scoreSource = "instance override";
						}
						// Priority 2: User's score override from wizard
						else if (templateCF.scoreOverride !== undefined && templateCF.scoreOverride !== null) {
							score = templateCF.scoreOverride;
							scoreSource = "template override";
						}
						// Priority 3: TRaSH Guides score from profile's score set
						else if (scoreSet && templateCF.originalConfig?.trash_scores?.[scoreSet] !== undefined) {
							score = templateCF.originalConfig.trash_scores[scoreSet];
							scoreSource = `TRaSH score set (${scoreSet})`;
						}
						// Priority 4: TRaSH Guides default score
						else if (templateCF.originalConfig?.trash_scores?.default !== undefined) {
							score = templateCF.originalConfig.trash_scores.default;
							scoreSource = "TRaSH default";
						}

						formatItems.push({
							format: cf.id,
							score,
						});
						console.log(`[DEPLOYMENT] CF "${templateCF.name}" (ID: ${cf.id}) score: ${score} (source: ${scoreSource})`);
					}
				}

					// Merge with existing formatItems to preserve CFs not in this template
					const existingFormatMap = new Map(
						(targetProfile.formatItems || []).map(item => [item.format, item])
					);

					for (const newItem of formatItems) {
						existingFormatMap.set(newItem.format, newItem);
					}

					const updatedProfile = {
						...targetProfile,
						formatItems: Array.from(existingFormatMap.values()),
					};

					await apiClient.updateQualityProfile(targetProfile.id, updatedProfile);
					console.log(`[DEPLOYMENT] Quality profile updated successfully with ${formatItems.length} CF scores`);

					// Create/update mapping to track that this profile is managed by this template
					await this.prisma.templateQualityProfileMapping.upsert({
						where: {
							instanceId_qualityProfileId: {
								instanceId,
								qualityProfileId: targetProfile.id,
							},
						},
						create: {
							templateId,
							instanceId,
							qualityProfileId: targetProfile.id,
							qualityProfileName: targetProfile.name,
							lastSyncedAt: new Date(),
						},
						update: {
							templateId,
							qualityProfileName: targetProfile.name,
							lastSyncedAt: new Date(),
							updatedAt: new Date(),
						},
					});
					console.log(`[DEPLOYMENT] Created/updated template mapping for profile ${targetProfile.id}`);
				}
			} catch (error) {
				console.error("[DEPLOYMENT] Failed to update quality profile:", error);
				errors.push(`Failed to update quality profile: ${error instanceof Error ? error.message : "Unknown error"}`);
			}

			// Update deployment history with success
			if (historyId) {
				const endTime = new Date();
				const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

				await this.prisma.trashSyncHistory.update({
					where: { id: historyId },
					data: {
						status: errors.length === 0 ? "SUCCESS" : "PARTIAL_SUCCESS",
						completedAt: endTime,
						duration,
						configsApplied: created + updated,
						configsFailed: skipped,
						configsSkipped: 0,
						appliedConfigs: JSON.stringify([...details.created, ...details.updated]),
						failedConfigs: details.failed.length > 0 ? JSON.stringify(details.failed) : null,
						errorLog: errors.length > 0 ? errors.join("\n") : null,
					},
				});
			}

			// Update TemplateDeploymentHistory with success
			if (deploymentHistoryId) {
				const endTime = new Date();
				const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

				await this.prisma.templateDeploymentHistory.update({
					where: { id: deploymentHistoryId },
					data: {
						status: errors.length === 0 ? "SUCCESS" : (skipped > 0 ? "PARTIAL_SUCCESS" : "SUCCESS"),
						duration,
						appliedCFs: created + updated,
						failedCFs: skipped,
						appliedConfigs: JSON.stringify(details.created.map((name) => ({ name, action: "created" })).concat(details.updated.map((name) => ({ name, action: "updated" })))),
						failedConfigs: details.failed.length > 0 ? JSON.stringify(details.failed.map((name) => ({ name, error: "Deployment failed" }))) : null,
						errors: errors.length > 0 ? JSON.stringify(errors) : null,
					},
				});
			}

			return {
				instanceId,
				instanceLabel: instance.label,
				success: errors.length === 0,
				customFormatsCreated: created,
				customFormatsUpdated: updated,
				customFormatsSkipped: skipped,
				errors,
				details,
			};
		} catch (error) {
			// Update deployment history with failure
			if (historyId) {
				const endTime = new Date();
				const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

				await this.prisma.trashSyncHistory.update({
					where: { id: historyId },
					data: {
						status: "FAILED",
						completedAt: endTime,
						duration,
						errorLog: error instanceof Error ? error.message : "Unknown error",
					},
				});
			}

			// Update TemplateDeploymentHistory with failure
			if (deploymentHistoryId) {
				const endTime = new Date();
				const duration = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

				await this.prisma.templateDeploymentHistory.update({
					where: { id: deploymentHistoryId },
					data: {
						status: "FAILED",
						duration,
						errors: JSON.stringify([error instanceof Error ? error.message : "Unknown error"]),
					},
				});
			}

			return {
				instanceId,
				instanceLabel: "Unknown",
				success: false,
				customFormatsCreated: 0,
				customFormatsUpdated: 0,
				customFormatsSkipped: 0,
				errors: [error instanceof Error ? error.message : "Unknown error"],
			};
		}
	}

	/**
	 * Execute bulk deployment to multiple instances
	 */
	async deployBulkInstances(
		templateId: string,
		instanceIds: string[],
		userId: string,
	): Promise<BulkDeploymentResult> {
		// Get template info
		const template = await this.prisma.trashTemplate.findUnique({
			where: { id: templateId },
		});

		if (!template) {
			throw new Error("Template not found");
		}

		// Deploy to all instances in parallel
		const deploymentPromises = instanceIds.map((instanceId) =>
			this.deploySingleInstance(templateId, instanceId, userId),
		);

		const results = await Promise.all(deploymentPromises);

		const successfulInstances = results.filter((r) => r.success).length;
		const failedInstances = results.filter((r) => !r.success).length;

		return {
			templateId,
			templateName: template.name,
			totalInstances: instanceIds.length,
			successfulInstances,
			failedInstances,
			results,
		};
	}

	/**
	 * Transform fields from TRaSH Guides object format to Radarr API array format
	 * TRaSH format: { value: 5 }
	 * Radarr format: [{ name: "value", value: 5 }]
	 */
	private transformFieldsToArray(fields: any): Array<{ name: string; value: unknown }> {
		// If fields is already an array, return it as-is
		if (Array.isArray(fields)) {
			console.log("[DEPLOYMENT] transformFieldsToArray - INPUT is already an array:", JSON.stringify(fields));
			return fields;
		}

		// If fields is undefined or null, return empty array
		if (!fields) {
			console.log("[DEPLOYMENT] transformFieldsToArray - INPUT is null/undefined");
			return [];
		}

		// Convert object format to array format
		console.log("[DEPLOYMENT] transformFieldsToArray - INPUT (object):", JSON.stringify(fields));
		const result = Object.entries(fields).map(([name, value]) => ({
			name,
			value,
		}));
		console.log("[DEPLOYMENT] transformFieldsToArray - OUTPUT (array):", JSON.stringify(result));
		return result;
	}

	/**
	 * Extract trash_id from Custom Format
	 * Checks specifications for a field named "trash_id"
	 */
	private extractTrashId(cf: CustomFormat): string | null {
		// Try to find trash_id in specifications
		for (const spec of cf.specifications || []) {
			if (spec.fields) {
				// Handle both array and object format
				if (Array.isArray(spec.fields)) {
					const trashIdField = spec.fields.find(f => f.name === 'trash_id');
					if (trashIdField) {
						return String(trashIdField.value);
					}
				} else if (typeof spec.fields === 'object') {
					if ('trash_id' in spec.fields) {
						return String((spec.fields as any).trash_id);
					}
				}
			}
		}

		// Fallback to name if trash_id not found
		return cf.name;
	}

	/**
	 * Get existing custom formats from instance
	 */
	private async getExistingCustomFormats(instance: any): Promise<CustomFormat[]> {
		const apiClient = createArrApiClient(instance, this.encryptor);
		return await apiClient.getCustomFormats();
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createDeploymentExecutorService(
	prisma: PrismaClient,
	encryptor: { decrypt: (payload: { value: string; iv: string }) => string },
): DeploymentExecutorService {
	return new DeploymentExecutorService(prisma, encryptor);
}
