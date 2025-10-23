// Logger will be accessed from the context or injected
import { IPipelinePhase, PipelineFlow } from '../../types';
import { CustomFormatPipelineContext } from '../context';
import { TrashCustomFormatService } from '../../../trash-custom-format-service';

/**
 * Transaction phase for custom formats - determines what changes need to be made
 * Similar to recyclarr's CustomFormatTransactionPhase
 */
export class CustomFormatTransactionPhase implements IPipelinePhase<CustomFormatPipelineContext> {
  constructor(private readonly trashService: TrashCustomFormatService) {}

  async execute(context: CustomFormatPipelineContext): Promise<PipelineFlow> {
    logger.debug('Analyzing custom format changes needed');

    if (!context.configOutput || !context.apiFetchOutput) {
      logger.error('Required phase outputs not found');
      return PipelineFlow.Terminate;
    }

    const { customFormats } = context.configOutput;
    const { existingCustomFormats } = context.apiFetchOutput;

    const customFormatsToCreate: any[] = [];
    const customFormatsToUpdate: { existing: any; updated: any }[] = [];
    
    // Create a map of existing custom formats by name for quick lookup
    const existingByName = new Map(
      existingCustomFormats.map(cf => [cf.name.toLowerCase(), cf])
    );

    for (const configCf of customFormats) {
      try {
        // Get the full TRaSH custom format definition
        const trashCustomFormat = await this.trashService.getCustomFormat(configCf.trash_id);
        
        if (!trashCustomFormat) {
          logger.warn(`Custom format not found in TRaSH guide: ${configCf.trash_id}`);
          continue;
        }

        const existing = existingByName.get(trashCustomFormat.name.toLowerCase());
        
        if (!existing) {
          // Custom format doesn't exist, need to create it
          logger.debug(`Will create custom format: ${trashCustomFormat.name}`);
          customFormatsToCreate.push(trashCustomFormat);
        } else {
          // Custom format exists, check if it needs updating
          const needsUpdate = this.customFormatNeedsUpdate(existing, trashCustomFormat);
          
          if (needsUpdate) {
            logger.debug(`Will update custom format: ${trashCustomFormat.name}`);
            customFormatsToUpdate.push({
              existing,
              updated: { ...trashCustomFormat, id: existing.id }
            });
          } else {
            logger.debug(`Custom format up to date: ${trashCustomFormat.name}`);
          }
          
          // Cache the processed custom format for the quality profile pipeline
          context.processedCustomFormats.set(configCf.trash_id, existing);
        }
      } catch (error) {
        logger.error(`Failed to process custom format ${configCf.trash_id}:`, error);
      }
    }

    context.transactionOutput = {
      customFormatsToCreate,
      customFormatsToUpdate,
      customFormatsToDelete: [] // We don't delete CFs automatically
    };

    logger.info(`Custom formats to create: ${customFormatsToCreate.length}, update: ${customFormatsToUpdate.length}`);

    if (customFormatsToCreate.length === 0 && customFormatsToUpdate.length === 0) {
      logger.info('No custom format changes needed');
    }

    return PipelineFlow.Continue;
  }

  private customFormatNeedsUpdate(existing: any, updated: any): boolean {
    // Simple comparison - in reality you might want more sophisticated comparison
    return JSON.stringify(existing.specifications) !== JSON.stringify(updated.specifications);
  }
}