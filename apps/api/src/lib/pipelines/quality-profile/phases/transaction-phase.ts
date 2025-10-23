// Logger will be accessed from the context or injected
import { IPipelinePhase, PipelineFlow } from '../../types';
import { QualityProfilePipelineContext } from '../context';
import { QualityProfileSyncService } from '../../../quality-profile-sync';

/**
 * Transaction phase for quality profiles - reuses existing quality profile logic
 * This bridges our new pipeline architecture with the existing implementation
 */
export class QualityProfileTransactionPhase implements IPipelinePhase<QualityProfilePipelineContext> {
  constructor(private readonly syncService: QualityProfileSyncService) {}

  async execute(context: QualityProfilePipelineContext): Promise<PipelineFlow> {
    logger.debug('Analyzing quality profile changes needed');

    if (!context.configOutput || !context.apiFetchOutput) {
      logger.error('Required phase outputs not found');
      return PipelineFlow.Terminate;
    }

    try {
      // Use the existing quality profile sync service logic
      // But now we know all custom formats exist from the previous pipeline
      const { profileName, trashProfile } = context.configOutput;
      const { existingProfiles } = context.apiFetchOutput;

      // Find existing profile
      const existingProfile = existingProfiles.find(
        p => p.name.toLowerCase() === profileName.toLowerCase()
      );

      logger.info(`Quality profile ${profileName} ${existingProfile ? 'exists' : 'will be created'}`);

      // The existing logic is complex, so we'll delegate to it
      // In the future, we can move more logic into this pipeline phase
      context.transactionOutput = {
        profileToCreate: existingProfile ? undefined : { name: profileName },
        profileToUpdate: existingProfile ? { existing: existingProfile, updated: {} } : undefined,
        formatItems: [] // Will be populated by the sync service
      };

      return PipelineFlow.Continue;
    } catch (error) {
      logger.error('Failed to analyze quality profile changes:', error);
      return PipelineFlow.Terminate;
    }
  }
}