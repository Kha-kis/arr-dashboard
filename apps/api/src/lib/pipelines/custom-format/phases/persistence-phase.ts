// Logger will be accessed from the context or injected
import { IPipelinePhase, PipelineFlow } from '../../types';
import { CustomFormatPipelineContext } from '../context';
import { RadarrApiService } from '../../../radarr-api';

/**
 * Persistence phase for custom formats - applies changes to Radarr API
 * Similar to recyclarr's CustomFormatApiPersistencePhase
 */
export class CustomFormatPersistencePhase implements IPipelinePhase<CustomFormatPipelineContext> {
  constructor(private readonly apiService: RadarrApiService) {}

  async execute(context: CustomFormatPipelineContext): Promise<PipelineFlow> {
    logger.debug('Applying custom format changes to Radarr API');

    if (!context.transactionOutput) {
      logger.error('Transaction phase output not found');
      return PipelineFlow.Terminate;
    }

    const { customFormatsToCreate, customFormatsToUpdate } = context.transactionOutput;
    const created = [];
    const updated = [];
    const errors = [];

    // Check if this is preview mode
    if (context.settings.preview) {
      logger.info('Preview mode: Would create/update custom formats');
      this.logPreviewChanges(customFormatsToCreate, customFormatsToUpdate);
      return PipelineFlow.Continue;
    }

    // Create new custom formats
    for (const customFormat of customFormatsToCreate) {
      try {
        logger.info(`Creating custom format: ${customFormat.name}`);
        const result = await this.apiService.createCustomFormat(customFormat);
        created.push(result);
        
        // Update the cache with the created custom format
        const configCf = context.configOutput?.customFormats.find(cf => 
          cf.trash_id === customFormat.trash_id
        );
        if (configCf) {
          context.processedCustomFormats.set(configCf.trash_id, result);
        }
      } catch (error) {
        logger.error(`Failed to create custom format ${customFormat.name}:`, error);
        errors.push({ action: 'create', name: customFormat.name, error });
      }
    }

    // Update existing custom formats
    for (const { existing, updated } of customFormatsToUpdate) {
      try {
        logger.info(`Updating custom format: ${updated.name}`);
        const result = await this.apiService.updateCustomFormat(existing.id, updated);
        updated.push(result);
      } catch (error) {
        logger.error(`Failed to update custom format ${updated.name}:`, error);
        errors.push({ action: 'update', name: updated.name, error });
      }
    }

    context.persistenceOutput = {
      created,
      updated,
      deleted: [] // We don't delete CFs automatically
    };

    if (errors.length > 0) {
      logger.warn(`${errors.length} custom format operations failed`);
    }

    logger.info(`Custom format sync completed. Created: ${created.length}, Updated: ${updated.length}`);

    return PipelineFlow.Continue;
  }

  private logPreviewChanges(toCreate: any[], toUpdate: { existing: any; updated: any }[]): void {
    if (toCreate.length > 0) {
      logger.info('Custom formats that would be created:');
      for (const cf of toCreate) {
        logger.info(`  - ${cf.name} (${cf.trash_id})`);
      }
    }

    if (toUpdate.length > 0) {
      logger.info('Custom formats that would be updated:');
      for (const { updated } of toUpdate) {
        logger.info(`  - ${updated.name} (${updated.trash_id})`);
      }
    }
  }
}