import { PipelineContext } from '../types';
import type { RadarrCustomFormat } from '../../radarr-api';

/**
 * Data from the config phase
 */
export interface CustomFormatConfigData {
  customFormats: any[]; // TRaSH custom formats to sync
}

/**
 * Data from the API fetch phase
 */
export interface CustomFormatServiceData {
  existingCustomFormats: RadarrCustomFormat[];
}

/**
 * Transaction data - what changes need to be made
 */
export interface CustomFormatTransactionData {
  customFormatsToCreate: any[];
  customFormatsToUpdate: { existing: RadarrCustomFormat; updated: any }[];
  customFormatsToDelete: RadarrCustomFormat[];
}

/**
 * Results after persistence
 */
export interface CustomFormatPersistenceResults {
  created: RadarrCustomFormat[];
  updated: RadarrCustomFormat[];
  deleted: RadarrCustomFormat[];
}

/**
 * Context for the custom format pipeline
 */
export class CustomFormatPipelineContext extends PipelineContext {
  public readonly pipelineDescription = 'Custom Format Sync Pipeline';

  // Phase outputs
  public configOutput?: CustomFormatConfigData;
  public apiFetchOutput?: CustomFormatServiceData;
  public transactionOutput?: CustomFormatTransactionData;
  public persistenceOutput?: CustomFormatPersistenceResults;

  // Cache of processed custom formats for other pipelines to use
  public processedCustomFormats: Map<string, RadarrCustomFormat> = new Map();
}