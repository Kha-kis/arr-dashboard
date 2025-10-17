/**
 * Flow control for pipeline phases
 */
export enum PipelineFlow {
  Continue = 'continue',
  Terminate = 'terminate'
}

/**
 * Base context for all pipelines
 */
export abstract class PipelineContext {
  public settings: any = {};
  public abstract readonly pipelineDescription: string;
  public logger?: any; // Logger will be injected by the pipeline runner
}

/**
 * Interface for individual pipeline phases
 */
export interface IPipelinePhase<TContext extends PipelineContext> {
  execute(context: TContext): Promise<PipelineFlow>;
}

/**
 * Interface for complete pipelines
 */
export interface ISyncPipeline {
  execute(settings: any): Promise<void>;
}

/**
 * Configuration for Radarr instance
 */
export interface RadarrConfig {
  url: string;
  apiKey: string;
  name: string;
}