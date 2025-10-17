import { RadarrApiService } from './radarr-api';
import { TrashCustomFormatService } from './trash-custom-format-service';
import { QualityProfileSyncService } from './quality-profile-sync';
import { CompositeSyncPipeline } from './pipelines/composite-sync-pipeline';
import { CustomFormatConfigPhase } from './pipelines/custom-format/phases/config-phase';
import { CustomFormatApiFetchPhase } from './pipelines/custom-format/phases/api-fetch-phase';
import { CustomFormatTransactionPhase } from './pipelines/custom-format/phases/transaction-phase';
import { CustomFormatPersistencePhase } from './pipelines/custom-format/phases/persistence-phase';

/**
 * Quality Profile service that uses the recyclarr-style pipeline workflow
 * This ensures custom formats are created before quality profiles are applied
 */
export class PipelineQualityProfileService {
  constructor(
    private readonly logger: any,
    private readonly apiService: RadarrApiService,
    private readonly trashService: TrashCustomFormatService,
    private readonly legacySyncService: QualityProfileSyncService
  ) {}

  /**
   * Apply a TRaSH quality profile using the pipeline workflow
   * This ensures custom formats are created first, then quality profiles are applied
   */
  async applyProfile(
    profileName: string,
    trashProfile: any,
    radarrConfig: { url: string; apiKey: string; name: string },
    preview: boolean = false
  ): Promise<{ success: boolean; message?: string; details?: any }> {
    this.logger.info(`Applying TRaSH profile '${profileName}' to ${radarrConfig.name} using pipeline workflow`);

    try {
      // Create the pipeline with all required phases
      const pipeline = this.createPipeline();

      // Execute the pipeline with the configuration
      await pipeline.execute({
        profileName,
        profileConfig: trashProfile,
        radarrConfig,
        preview
      });

      return {
        success: true,
        message: `Successfully applied profile '${profileName}' using pipeline workflow`
      };
    } catch (error) {
      this.logger.error(`Pipeline failed for profile '${profileName}':`, error);
      
      // Fall back to the legacy implementation for now
      this.logger.info('Falling back to legacy quality profile sync...');
      return this.fallbackToLegacySync(profileName, trashProfile, radarrConfig, preview);
    }
  }

  private createPipeline(): CompositeSyncPipeline {
    // Custom Format Pipeline Phases
    const customFormatPhases = [
      new CustomFormatConfigPhase(),
      new CustomFormatApiFetchPhase(this.apiService),
      new CustomFormatTransactionPhase(this.trashService),
      new CustomFormatPersistencePhase(this.apiService)
    ];

    // Quality Profile Pipeline Phases
    // For now, we'll create a simplified phase that delegates to the existing service
    const qualityProfilePhases = [
      // We'll add proper phases later, for now just use a wrapper
      new LegacyQualityProfilePhase(this.legacySyncService)
    ];

    return CompositeSyncPipeline.create(customFormatPhases, qualityProfilePhases, this.logger);
  }

  private async fallbackToLegacySync(
    profileName: string,
    trashProfile: any,
    radarrConfig: any,
    preview: boolean
  ) {
    try {
      const result = await this.legacySyncService.applyQualityProfile(
        profileName,
        trashProfile,
        radarrConfig.url,
        radarrConfig.apiKey
      );

      return {
        success: result.success,
        message: result.success ? 
          `Applied profile '${profileName}' using legacy sync` : 
          `Failed to apply profile: ${result.message}`,
        details: result
      };
    } catch (error) {
      return {
        success: false,
        message: `Both pipeline and legacy sync failed: ${error.message}`,
        details: { error: error.message }
      };
    }
  }
}

/**
 * Temporary wrapper phase that delegates to the existing quality profile sync service
 * TODO: Replace this with proper pipeline phases
 */
class LegacyQualityProfilePhase {
  constructor(private readonly syncService: QualityProfileSyncService) {}

  async execute(context: any) {
    const { profileName, profileConfig, radarrConfig } = context.settings;
    
    if (context.logger) context.logger.debug('Executing legacy quality profile sync within pipeline');
    
    // The custom formats should already exist at this point thanks to the CF pipeline
    await this.syncService.applyQualityProfile(
      profileName,
      profileConfig,
      radarrConfig.url,
      radarrConfig.apiKey
    );

    return 'continue'; // PipelineFlow.Continue
  }
}