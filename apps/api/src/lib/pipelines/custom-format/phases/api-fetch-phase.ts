// Logger will be accessed from the context or injected
import { IPipelinePhase, PipelineFlow } from '../../types';
import { CustomFormatPipelineContext } from '../context';
import { RadarrApiService } from '../../../radarr-api';

/**
 * API fetch phase for custom formats - fetches existing custom formats from Radarr
 * Similar to recyclarr's CustomFormatApiFetchPhase
 */
export class CustomFormatApiFetchPhase implements IPipelinePhase<CustomFormatPipelineContext> {
  constructor(private readonly apiService: RadarrApiService) {}

  async execute(context: CustomFormatPipelineContext): Promise<PipelineFlow> {
    if (context.logger) context.logger.debug('Fetching existing custom formats from Radarr API');

    if (!context.configOutput) {
      if (context.logger) context.logger.error('Config phase output not found');
      return PipelineFlow.Terminate;
    }

    try {
      const existingCustomFormats = await this.apiService.getCustomFormats();
      
      if (context.logger) context.logger.info(`Found ${existingCustomFormats.length} existing custom formats in Radarr`);

      context.apiFetchOutput = {
        existingCustomFormats
      };

      return PipelineFlow.Continue;
    } catch (error) {
      if (context.logger) context.logger.error('Failed to fetch custom formats from Radarr API:', error);
      return PipelineFlow.Terminate;
    }
  }
}