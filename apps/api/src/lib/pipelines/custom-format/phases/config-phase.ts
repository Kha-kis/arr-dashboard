// Logger will be accessed from the context or injected
import { IPipelinePhase, PipelineFlow } from '../../types';
import { CustomFormatPipelineContext } from '../context';

/**
 * Config phase for custom formats - processes which custom formats should be synced
 * Similar to recyclarr's CustomFormatConfigPhase
 */
export class CustomFormatConfigPhase implements IPipelinePhase<CustomFormatPipelineContext> {
  async execute(context: CustomFormatPipelineContext): Promise<PipelineFlow> {
    if (context.logger) context.logger.debug('Processing custom format configuration');

    // For now, we'll extract custom formats from the quality profile config
    // In the future, this could be expanded to support standalone CF configs
    const { profileConfig } = context.settings;
    
    if (!profileConfig?.customFormats) {
      if (context.logger) context.logger.debug('No custom formats specified in configuration');
      context.configOutput = { customFormats: [] };
      return PipelineFlow.Terminate;
    }

    // Extract unique custom formats referenced in the profile
    const customFormatIds = new Set<string>();
    
    if (profileConfig.customFormats) {
      for (const cf of profileConfig.customFormats) {
        if (cf.trash_id) {
          customFormatIds.add(cf.trash_id);
        }
      }
    }

    if (context.logger) context.logger.info(`Found ${customFormatIds.size} custom formats to process`);

    context.configOutput = {
      customFormats: Array.from(customFormatIds).map(id => ({ trash_id: id }))
    };

    if (context.configOutput.customFormats.length === 0) {
      return PipelineFlow.Terminate;
    }

    return PipelineFlow.Continue;
  }
}