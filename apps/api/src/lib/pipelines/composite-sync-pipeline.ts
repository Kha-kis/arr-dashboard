// Logger will be accessed from the pipeline context
import { ISyncPipeline } from './types';
import { GenericSyncPipeline } from './generic-pipeline';
import { CustomFormatPipelineContext } from './custom-format/context';
import { QualityProfilePipelineContext } from './quality-profile/context';

/**
 * Composite pipeline that executes pipelines in the correct order
 * Mirrors recyclarr's CompositeSyncPipeline
 */
export class CompositeSyncPipeline implements ISyncPipeline {
  constructor(
    private readonly customFormatPipeline: GenericSyncPipeline<CustomFormatPipelineContext>,
    private readonly qualityProfilePipeline: GenericSyncPipeline<QualityProfilePipelineContext>,
    private readonly logger?: any
  ) {}

  async execute(settings: any): Promise<void> {
    const { radarrConfig, profileName } = settings;
    
    if (this.logger) {
      this.logger.info(`Starting sync for Radarr instance: ${radarrConfig?.name || 'Unknown'}`);
      this.logger.info(`Processing quality profile: ${profileName}`);
    }

    try {
      // Step 1: Execute Custom Format Pipeline (must run first)
      if (this.logger) this.logger.debug('Starting Custom Format Pipeline');
      await this.customFormatPipeline.execute(settings);

      // Step 2: Execute Quality Profile Pipeline (runs after custom formats are ready)
      if (this.logger) this.logger.debug('Starting Quality Profile Pipeline');
      await this.qualityProfilePipeline.execute(settings);

      if (this.logger) this.logger.info(`Sync completed successfully for: ${radarrConfig?.name || 'Unknown'}`);
    } catch (error) {
      if (this.logger) this.logger.error(`Sync failed for ${radarrConfig?.name || 'Unknown'}:`, error);
      throw error;
    }
  }

  /**
   * Factory method to create a configured composite pipeline
   */
  static create(
    customFormatPhases: any[],
    qualityProfilePhases: any[],
    logger?: any
  ): CompositeSyncPipeline {
    const customFormatPipeline = new GenericSyncPipeline(
      () => new CustomFormatPipelineContext(),
      customFormatPhases,
      logger
    );

    const qualityProfilePipeline = new GenericSyncPipeline(
      () => new QualityProfilePipelineContext(), 
      qualityProfilePhases,
      logger
    );

    return new CompositeSyncPipeline(customFormatPipeline, qualityProfilePipeline, logger);
  }
}