import { PipelineContext } from '../types';
import type { RadarrQualityProfile } from '../../radarr-api';

/**
 * Data from the config phase
 */
export interface QualityProfileConfigData {
  profileName: string;
  trashProfile: any; // TRaSH quality profile config
  customFormatScores: Map<string, number>; // trash_id -> score
}

/**
 * Data from the API fetch phase  
 */
export interface QualityProfileServiceData {
  existingProfiles: RadarrQualityProfile[];
  schema: any;
  customFormats: any[];
  qualityDefinitions: any[];
}

/**
 * Transaction data - what changes need to be made
 */
export interface QualityProfileTransactionData {
  profileToCreate?: any;
  profileToUpdate?: { existing: RadarrQualityProfile; updated: any };
  formatItems: any[];
}

/**
 * Results after persistence
 */
export interface QualityProfilePersistenceResults {
  created?: RadarrQualityProfile;
  updated?: RadarrQualityProfile;
}

/**
 * Context for the quality profile pipeline
 */
export class QualityProfilePipelineContext extends PipelineContext {
  public readonly pipelineDescription = 'Quality Profile Sync Pipeline';

  // Phase outputs
  public configOutput?: QualityProfileConfigData;
  public apiFetchOutput?: QualityProfileServiceData;
  public transactionOutput?: QualityProfileTransactionData;
  public persistenceOutput?: QualityProfilePersistenceResults;

  // Access to custom formats from the previous pipeline
  public customFormatCache?: Map<string, any>;
}