/**
 * Simple pipeline service that demonstrates the recyclarr workflow
 * Fetches actual TRaSH custom format definitions and applies them properly
 */
export class SimplePipelineService {
  constructor(
    private readonly fetcher: (path: string, init?: RequestInit) => Promise<Response>,
    private readonly logger: any,
    private readonly trashData: any, // TRaSH guides data with custom format definitions
    private readonly prisma?: any, // Prisma client for tracking (optional)
    private readonly instanceId?: string, // Instance ID for tracking (optional)
    private readonly serviceType?: string, // Service type for tracking (optional)
    private readonly gitRef?: string, // Git ref for tracking (optional, deprecated)
    private readonly commitSha?: string // Actual commit SHA for version pinning (NEW)
  ) {}

  /**
   * Apply a TRaSH quality profile using the pipeline workflow
   * Step 1: Create custom formats first (with actual TRaSH definitions)
   * Step 2: Then apply quality profile
   */
  async applyProfile(
    profileName: string,
    trashProfile: any,
    profileFileName?: string, // NEW: Profile filename for tracking
    customizations?: Record<string, { excluded?: boolean; scoreOverride?: number }> // User customizations
  ): Promise<{ success: boolean; message?: string; details?: any }> {
    this.logger.info(`Starting pipeline workflow for profile: ${profileName}`);

    try {
      // Pipeline Step 1: Custom Format Phase
      await this.executeCustomFormatPhase(trashProfile, profileFileName, customizations);

      // Pipeline Step 2: Quality Profile Phase
      await this.executeQualityProfilePhase(profileName, trashProfile, customizations);

      return {
        success: true,
        message: `Successfully applied profile '${profileName}' using pipeline workflow`
      };
    } catch (error) {
      this.logger.error(`Pipeline failed for profile '${profileName}':`, error);
      return {
        success: false,
        message: `Pipeline failed: ${error.message}`,
        details: { error: error.message }
      };
    }
  }

  private async executeCustomFormatPhase(trashProfile: any, profileFileName?: string, customizations?: Record<string, { excluded?: boolean; scoreOverride?: number }>): Promise<void> {
    this.logger.info('Pipeline Phase 1: Processing Custom Formats with actual TRaSH definitions');

    // Get existing custom formats
    const existingFormatsResponse = await this.fetcher('/api/v3/customformat');
    const existingFormats = await existingFormatsResponse.json();

    this.logger.info(`Found ${existingFormats.length} existing custom formats in Radarr`);

    // Extract custom format references from the quality profile
    // NOTE: formatItems is an object mapping custom format names to trash_ids, not scores
    const formatItems = trashProfile.formatItems || [];
    const customFormatsToProcess: Array<{ name: string; trashId?: string }> = [];

    if (Array.isArray(formatItems)) {
      for (const formatItem of formatItems) {
        if (formatItem.name) {
          customFormatsToProcess.push({
            name: formatItem.name,
            trashId: formatItem.trash_id
          });
        }
      }
    } else if (typeof formatItems === 'object') {
      // Handle object format: { "Custom Format Name": "trash_id_hex_string" }
      for (const [formatName, trashId] of Object.entries(formatItems)) {
        customFormatsToProcess.push({
          name: formatName,
          trashId: typeof trashId === 'string' ? trashId : undefined
        });
      }
    }

    this.logger.info(`Found ${customFormatsToProcess.length} custom formats explicitly referenced in quality profile`);

    // ========================================================================
    // Auto-include custom formats from default CF-Groups (like recyclarr)
    // Based on configarr commit: 065de471e4d2feecd198dcc33753933e216b9284
    // ========================================================================

    // Track which CF-Groups were auto-included for later tracking
    const autoIncludedGroups: Array<{ fileName: string; name: string; cfCount: number }> = [];

    try {
      // Fetch CF-Groups from TRaSH guides
      const { fetchCFGroups } = await import('./arr-sync/trash/trash-fetcher.js');
      const cfGroups = await fetchCFGroups({
        service: this.serviceType as any,
        ref: this.gitRef || 'master'
      });

      this.logger.info(`Fetched ${cfGroups.length} CF-Groups from TRaSH guides for auto-inclusion check`);

      const profileName = trashProfile.name;
      let autoIncludedCount = 0;

      // Check each CF-Group for auto-inclusion
      for (const cfGroup of cfGroups) {
        // Only process groups marked as default
        if (cfGroup.default !== true && cfGroup.default !== 'true') {
          continue;
        }

        // Check if this profile is excluded from this CF-Group
        const isExcluded = cfGroup.quality_profiles?.exclude?.[profileName] != null;

        if (isExcluded) {
          this.logger.debug(
            `Excluding default CF-Group '${cfGroup.name}' for profile '${profileName}' due to exclude field`
          );
          continue;
        }

        // Include all CFs from this group where required === true OR default === true
        const cfsToInclude = (cfGroup.custom_formats || []).filter((cf: any) => {
          return cf.required === true || cf.default === true;
        });

        if (cfsToInclude.length === 0) {
          continue;
        }

        this.logger.info(
          `Auto-including ${cfsToInclude.length} custom format(s) from default CF-Group '${cfGroup.name}' for profile '${profileName}'`
        );

        let groupCfCount = 0;

        // Add these CFs to the processing list
        for (const cfRef of cfsToInclude) {
          // Find the actual CF definition by trash_id
          const trashFormat = this.trashData.customFormats.find(
            (cf: any) => cf.trash_id === cfRef.trash_id
          );

          if (trashFormat) {
            // Check if this CF is not already in the list
            const alreadyIncluded = customFormatsToProcess.some(
              (existing) => existing.trashId === cfRef.trash_id || existing.name === trashFormat.name
            );

            if (!alreadyIncluded) {
              customFormatsToProcess.push({
                name: trashFormat.name,
                trashId: cfRef.trash_id,
                autoIncludedFromGroup: cfGroup.fileName // Track source CF-Group
              });
              autoIncludedCount++;
              groupCfCount++;

              this.logger.debug(
                `Auto-included CF '${trashFormat.name}' from group '${cfGroup.name}'`
              );
            }
          } else {
            this.logger.warn(
              `CF with trash_id '${cfRef.trash_id}' from default group '${cfGroup.name}' not found in TRaSH data`
            );
          }
        }

        // Track this CF-Group for later database tracking
        if (groupCfCount > 0) {
          autoIncludedGroups.push({
            fileName: cfGroup.fileName,
            name: cfGroup.name,
            cfCount: groupCfCount
          });
        }
      }

      if (autoIncludedCount > 0) {
        this.logger.info(
          `Auto-included ${autoIncludedCount} custom format(s) from ${autoIncludedGroups.length} default CF-Group(s)`
        );
      }
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }, 'Failed to fetch CF-Groups for auto-inclusion');
      // Don't fail the entire pipeline, just log and continue
      this.logger.warn('Continuing without CF-Group auto-inclusion');
    }

    this.logger.info(`Total ${customFormatsToProcess.length} custom formats to process (including auto-included from CF-Groups)`);

    // Import actual TRaSH custom formats with proper specifications
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (const cfItem of customFormatsToProcess) {
      const cfName = cfItem.name;

      // Check if user excluded this CF via customizations
      if (customizations && customizations[cfName]?.excluded) {
        this.logger.info(`Skipping excluded custom format: ${cfName}`);
        skippedCount++;
        continue;
      }

      // Find the actual TRaSH format definition
      const trashFormat = this.trashData.customFormats.find(
        (cf: any) => cf.name === cfName
      );

      if (!trashFormat) {
        this.logger.warn(`Custom format '${cfName}' not found in TRaSH guides, skipping`);
        skippedCount++;
        continue;
      }

      // Check if format already exists
      const existing = existingFormats.find((cf: any) => cf.name === cfName);

      // Determine import source and reference
      const isAutoIncludedFromGroup = !!(cfItem as any).autoIncludedFromGroup;
      const importSource = isAutoIncludedFromGroup ? "CF_GROUP" : "QUALITY_PROFILE";
      const sourceReference = isAutoIncludedFromGroup ? (cfItem as any).autoIncludedFromGroup : profileFileName;

      if (existing) {
        this.logger.debug(`Custom format '${cfName}' already exists, updating specifications`);

        try {
          // Update existing format with latest TRaSH specifications
          const updateResponse = await this.fetcher(`/api/v3/customformat/${existing.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...existing,
              name: trashFormat.name,
              includeCustomFormatWhenRenaming: trashFormat.includeCustomFormatWhenRenaming ?? false,
              specifications: trashFormat.specifications || []
            }),
          });

          if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            this.logger.error(`Failed to update custom format '${cfName}': ${updateResponse.status} ${errorText}`);
            continue;
          }

          this.logger.info(`Updated custom format '${cfName}' with ID: ${existing.id}`);
          updatedCount++;

          // Track this custom format as TRaSH-managed
          if (this.prisma && this.instanceId && this.serviceType) {
            await this.prisma.trashCustomFormatTracking.upsert({
              where: {
                serviceInstanceId_customFormatId: {
                  serviceInstanceId: this.instanceId,
                  customFormatId: existing.id,
                },
              },
              update: {
                customFormatName: trashFormat.name,
                trashId: trashFormat.trash_id,
                lastSyncedAt: new Date(),
                gitRef: this.gitRef || 'master',
                commitSha: this.commitSha, // NEW: Store actual commit SHA
                importSource: importSource as any,
                sourceReference: sourceReference,
              },
              create: {
                serviceInstanceId: this.instanceId,
                customFormatId: existing.id,
                customFormatName: trashFormat.name,
                trashId: trashFormat.trash_id,
                service: this.serviceType as any,
                gitRef: this.gitRef || 'master',
                commitSha: this.commitSha, // NEW: Store actual commit SHA
                importSource: importSource as any,
                sourceReference: sourceReference,
              },
            });
            this.logger.debug(`Tracked custom format '${cfName}' as TRaSH-managed (source: ${importSource})`);
          }

        } catch (error) {
          this.logger.error(`Error updating custom format '${cfName}':`, error);
        }
      } else {
        this.logger.info(`Creating custom format: ${cfName} with actual TRaSH specifications`);

        try {
          // Create format with actual TRaSH specifications
          const newFormat = {
            name: trashFormat.name,
            includeCustomFormatWhenRenaming: trashFormat.includeCustomFormatWhenRenaming ?? false,
            specifications: trashFormat.specifications || []
          };

          const response = await this.fetcher('/api/v3/customformat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newFormat),
          });

          if (!response.ok) {
            const errorText = await response.text();
            this.logger.error(`Failed to create custom format '${cfName}': ${response.status} ${errorText}`);
            continue;
          }

          const created = await response.json();
          this.logger.info(`Created custom format '${cfName}' with ID: ${created.id}`);
          createdCount++;

          // Track this custom format as TRaSH-managed
          if (this.prisma && this.instanceId && this.serviceType) {
            await this.prisma.trashCustomFormatTracking.create({
              data: {
                serviceInstanceId: this.instanceId,
                customFormatId: created.id,
                customFormatName: trashFormat.name,
                trashId: trashFormat.trash_id,
                service: this.serviceType as any,
                gitRef: this.gitRef || 'master',
                commitSha: this.commitSha, // NEW: Store actual commit SHA
                importSource: importSource as any,
                sourceReference: sourceReference,
              },
            });
            this.logger.debug(`Tracked custom format '${cfName}' as TRaSH-managed (source: ${importSource})`);
          }

        } catch (error) {
          this.logger.error(`Error creating custom format '${cfName}':`, error);
        }
      }
    }

    // Track auto-included CF-Groups in the database
    if (this.prisma && this.instanceId && this.serviceType && autoIncludedGroups.length > 0) {
      this.logger.info(`Tracking ${autoIncludedGroups.length} auto-included CF-Group(s) in database`);

      const profileName = trashProfile.name;

      for (const group of autoIncludedGroups) {
        try {
          await this.prisma.trashCFGroupTracking.upsert({
            where: {
              serviceInstanceId_groupFileName: {
                serviceInstanceId: this.instanceId,
                groupFileName: group.fileName,
              },
            },
            update: {
              groupName: group.name,
              qualityProfileName: profileName,
              importedCount: group.cfCount,
              lastSyncedAt: new Date(),
              gitRef: this.gitRef || 'master',
              commitSha: this.commitSha, // NEW: Store actual commit SHA
            },
            create: {
              serviceInstanceId: this.instanceId,
              groupFileName: group.fileName,
              groupName: group.name,
              qualityProfileName: profileName,
              service: this.serviceType as any,
              importedCount: group.cfCount,
              gitRef: this.gitRef || 'master',
              commitSha: this.commitSha, // NEW: Store actual commit SHA
            },
          });

          this.logger.debug(`Tracked CF-Group '${group.name}' for profile '${profileName}' (${group.cfCount} CFs)`);
        } catch (error) {
          this.logger.error(`Failed to track CF-Group '${group.name}':`, error);
          // Continue even if tracking fails
        }
      }
    }

    this.logger.info(`Custom format phase summary: ${createdCount} created, ${updatedCount} updated, ${skippedCount} skipped`);

    this.logger.info('Pipeline Phase 1: Custom Formats phase completed');
  }

  private async executeQualityProfilePhase(
    profileName: string,
    trashProfile: any,
    customizations?: Record<string, { excluded?: boolean; scoreOverride?: number }>
  ): Promise<void> {
    this.logger.info('Pipeline Phase 2: Processing Quality Profile');

    // At this point, all custom formats should exist from Phase 1
    // Now we can safely apply the quality profile using our fixed logic

    try {
      // Import the fixed quality profile sync logic
      const { QualityProfileSync } = await import('./quality-profile-sync.js');
      const profileSync = new QualityProfileSync(this.fetcher, this.logger);

      // CRITICAL: Re-fetch custom formats AFTER Phase 1 created them
      const existingFormatsResponse = await this.fetcher('/api/v3/customformat');
      const existingFormats = await existingFormatsResponse.json();

      this.logger.info({
        existingFormatsCount: existingFormats.length,
        formatNames: existingFormats.map((f: any) => f.name).slice(0, 10)
      }, 'Custom formats available after Phase 1');

      // Build custom formats array with TRaSH definitions and scores
      const formatItems = trashProfile.formatItems || [];
      const customFormatsForProfile: any[] = [];

      // Extract format items (handle both array and object formats)
      // NOTE: In TRaSH quality profiles, formatItems is an object mapping custom format names to trash_ids
      // The actual scores come from each custom format's trash_scores field, NOT from formatItems
      let formatItemsList: Array<{ name: string; trashId?: string }> = [];
      if (Array.isArray(formatItems)) {
        formatItemsList = formatItems.map((item: any) => ({
          name: item.name,
          trashId: item.trash_id
        }));
      } else if (typeof formatItems === 'object') {
        // formatItems structure: { "Custom Format Name": "trash_id_hex_string" }
        formatItemsList = Object.entries(formatItems).map(([name, trashId]) => ({
          name,
          trashId: typeof trashId === 'string' ? trashId : undefined
        }));
      }

      this.logger.info(`Found ${formatItemsList.length} custom formats explicitly referenced in quality profile formatItems`);

      // ========================================================================
      // Auto-include custom formats from default CF-Groups (for scoring)
      // This mirrors the Phase 1 logic to ensure scores are applied
      // ========================================================================

      try {
        // Fetch CF-Groups from TRaSH guides
        const { fetchCFGroups } = await import('./arr-sync/trash/trash-fetcher.js');
        const cfGroups = await fetchCFGroups({
          service: this.serviceType as any,
          ref: this.gitRef || 'master'
        });

        let autoIncludedCount = 0;

        // Check each CF-Group for auto-inclusion
        for (const cfGroup of cfGroups) {
          // Only process groups marked as default
          if (cfGroup.default !== true && cfGroup.default !== 'true') {
            continue;
          }

          // Check if this profile is excluded from this CF-Group
          const isExcluded = cfGroup.quality_profiles?.exclude?.[profileName] != null;

          if (isExcluded) {
            this.logger.debug(
              `Excluding default CF-Group '${cfGroup.name}' for profile '${profileName}' scoring`
            );
            continue;
          }

          // Include all CFs from this group where required === true OR default === true
          const cfsToInclude = (cfGroup.custom_formats || []).filter((cf: any) => {
            return cf.required === true || cf.default === true;
          });

          if (cfsToInclude.length === 0) {
            continue;
          }

          // Add these CFs to the format items list for scoring
          for (const cfRef of cfsToInclude) {
            // Find the actual CF definition by trash_id
            const trashFormat = this.trashData.customFormats.find(
              (cf: any) => cf.trash_id === cfRef.trash_id
            );

            if (trashFormat) {
              // Check if this CF is not already in the list
              const alreadyIncluded = formatItemsList.some(
                (existing) => existing.trashId === cfRef.trash_id || existing.name === trashFormat.name
              );

              if (!alreadyIncluded) {
                formatItemsList.push({
                  name: trashFormat.name,
                  trashId: cfRef.trash_id
                });
                autoIncludedCount++;

                this.logger.debug(
                  `Auto-included CF '${trashFormat.name}' from group '${cfGroup.name}' for scoring`
                );
              }
            }
          }
        }

        if (autoIncludedCount > 0) {
          this.logger.info(
            `Auto-included ${autoIncludedCount} custom format(s) from default CF-Groups for scoring`
          );
        }
      } catch (error) {
        this.logger.error({
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }, 'Failed to fetch CF-Groups for auto-inclusion (scoring phase)');
        // Don't fail the entire pipeline, just log and continue
        this.logger.warn('Continuing without CF-Group auto-inclusion for scoring');
      }

      // Build TRaSH format objects with scores for applyQualityProfile
      // Use trash_scores mapping from custom format based on quality profile's trash_score_set
      const scoreSetKey = trashProfile.trash_score_set;

      this.logger.debug({
        profileName: profileName,
        scoreSetKey: scoreSetKey,
        formatItemsCount: formatItemsList.length
      }, 'Building custom formats with scores for quality profile (including auto-included from CF-Groups)');

      for (const formatItem of formatItemsList) {
        const cfName = formatItem.name;

        // Check if user excluded this CF via customizations
        if (customizations && customizations[cfName]?.excluded) {
          this.logger.info(`Skipping excluded custom format in quality profile: ${cfName}`);
          continue;
        }

        const trashFormat = this.trashData.customFormats.find((cf: any) => cf.name === cfName);

        if (trashFormat) {
          // Look up score from trash_scores mapping using the profile's trash_score_set
          // Example: CF has trash_scores: { "sqp-1-web-1080p": -175, "sqp-1-web-2160p": -175 }
          // Profile has trash_score_set: "sqp-1-web-1080p"
          let score = 0;

          if (trashFormat.trash_scores && typeof trashFormat.trash_scores === 'object') {
            // Try to find score using this priority:
            // 1. Profile's trash_score_set key (e.g., "sqp-2")
            // 2. "default" key as fallback
            // 3. Zero as last resort

            if (scoreSetKey && scoreSetKey in trashFormat.trash_scores) {
              // Found exact match for profile's score set
              score = trashFormat.trash_scores[scoreSetKey];
              this.logger.debug(`Using score ${score} from trash_score_set '${scoreSetKey}' for custom format '${cfName}'`);
            } else if ('default' in trashFormat.trash_scores) {
              // Fall back to default score
              score = trashFormat.trash_scores['default'];
              this.logger.debug(`Using default score ${score} for custom format '${cfName}'`);
            } else {
              // No matching key or default - use 0
              score = 0;
              this.logger.warn({
                cfName: cfName,
                scoreSetKey: scoreSetKey,
                availableKeys: Object.keys(trashFormat.trash_scores)
              }, 'No matching score in trash_scores, using 0');
            }
          } else {
            // No trash_scores mapping at all - use 0
            score = 0;
            this.logger.warn(`Custom format '${cfName}' has no trash_scores mapping, using score 0`);
          }

          // Apply user's score override if provided
          if (customizations && customizations[cfName]?.scoreOverride !== undefined) {
            const originalScore = score;
            score = customizations[cfName].scoreOverride!;
            this.logger.info(`Applying score override for '${cfName}': ${originalScore} → ${score}`);
          }

          customFormatsForProfile.push({
            ...trashFormat,
            score: score
          });
        } else {
          this.logger.warn({
            formatName: cfName
          }, 'Custom format not found in TRaSH data');
        }
      }

      this.logger.info({
        customFormatsCount: customFormatsForProfile.length,
        sampleFormats: customFormatsForProfile.slice(0, 3).map(f => ({
          name: f.name,
          score: f.score
        }))
      }, 'TRaSH custom formats with scores prepared for quality profile');

      // Convert TRaSH profile to the expected format for QualityProfileSync
      const trashProfileForSync = {
        name: trashProfile.name,
        cutoff: trashProfile.cutoff || trashProfile.upgradeUntilQuality,
        upgradeAllowed: trashProfile.upgradeAllowed ?? true,
        upgrade: {
          allowed: trashProfile.upgradeAllowed ?? true,
          until_quality: trashProfile.upgradeUntilQuality || trashProfile.cutoff,
          until_score: trashProfile.cutoffFormatScore,
        },
        min_format_score: trashProfile.minFormatScore || 0,
        cutoffFormatScore: trashProfile.cutoffFormatScore || 0,
        minFormatScore: trashProfile.minFormatScore || 0,
        items: trashProfile.items,
        qualities: trashProfile.qualities,
        formatItems: trashProfile.formatItems,
      };

      // Apply the quality profile using our enhanced logic
      // Pass TRaSH custom formats with scores for proper formatItems handling
      // Even though Phase 1 created them, createCustomFormatsFromTrash is idempotent
      const syncResult = await profileSync.applyQualityProfile(trashProfileForSync, customFormatsForProfile);

      this.logger.info({
        profileName: syncResult.profile.name,
        profileId: syncResult.profile.id,
        action: syncResult.action
      }, 'Quality profile successfully applied via pipeline');

    } catch (error) {
      this.logger.error('Pipeline Phase 2 failed:', error);
      throw error;
    }

    this.logger.info('Pipeline Phase 2: Quality Profile phase completed successfully');
  }
}