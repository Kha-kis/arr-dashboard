// Logger will be passed as parameter or accessed from context
import type { IPipelinePhase, ISyncPipeline, PipelineContext, PipelineFlow } from './types';

/**
 * Generic pipeline that executes phases in order, similar to recyclarr's GenericSyncPipeline
 */
export class GenericSyncPipeline<TContext extends PipelineContext> implements ISyncPipeline {
  constructor(
    private readonly contextFactory: () => TContext,
    private readonly phases: IPipelinePhase<TContext>[],
    private readonly logger?: any
  ) {}

  async execute(settings: any): Promise<void> {
    const context = this.contextFactory();
    context.settings = settings;
    context.logger = this.logger; // Inject logger into context

    if (this.logger) {
      this.logger.debug(`Executing Pipeline: ${context.pipelineDescription}`);
    }

    for (const phase of this.phases) {
      const flow = await phase.execute(context);
      if (flow === PipelineFlow.Terminate) {
        if (this.logger) {
          this.logger.debug(`Pipeline terminated at phase: ${phase.constructor.name}`);
        }
        break;
      }
    }

    if (this.logger) {
      this.logger.debug(`Completed Pipeline: ${context.pipelineDescription}`);
    }
  }
}