/**
 * Quality Profile Sync Implementation
 * Based on recyclarr's approach for proper ARR API interaction
 */

interface ArrQualityItem {
  id?: number;
  quality?: {
    id: number;
    name: string;
    source?: string;
    resolution?: number;
  };
  items?: ArrQualityItem[];
  allowed: boolean;
  name?: string;
}

interface ArrQualityProfile {
  id?: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items: ArrQualityItem[];
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore: number;
  formatItems: Array<{
    id?: number;
    format: number;
    name: string;
    score: number;
  }>;
  language: {
    id: number;
    name: string;
  };
}

interface TrashQualityDefinition {
  name: string;
  enabled?: boolean;
  qualities?: TrashQualityDefinition[];
}

interface TrashQualityProfile {
  name: string;
  upgrade?: {
    allowed: boolean;
    until_quality?: string;
    until_score?: number;
  };
  min_format_score?: number;
  qualities?: TrashQualityDefinition[];
  quality_sort?: 'top' | 'bottom';
  reset_unmatched_scores?: {
    enabled: boolean;
    except?: string[];
  };
  // TRaSH-specific fields
  upgradeAllowed?: boolean;
  cutoff?: string;
  minFormatScore?: number;
  cutoffFormatScore?: number;
  items?: Array<{
    name: string;
    allowed: boolean;
    items?: string[];
  }>;
  formatItems?: Record<string, string>;
}

export class QualityProfileSync {
  constructor(
    private fetcher: (path: string, init?: RequestInit) => Promise<Response>,
    private logger: any
  ) {}

  /**
   * Get quality profile schema from ARR instance
   */
  async getQualityProfileSchema(): Promise<ArrQualityProfile> {
    const response = await this.fetcher('/api/v3/qualityprofile/schema');
    if (!response.ok) {
      throw new Error(`Failed to get quality profile schema: ${response.status}`);
    }
    return response.json();
  }

  /**
   * Get existing quality profiles from ARR instance
   */
  async getExistingProfiles(): Promise<ArrQualityProfile[]> {
    const response = await this.fetcher('/api/v3/qualityprofile');
    if (!response.ok) {
      throw new Error(`Failed to get existing quality profiles: ${response.status}`);
    }
    return response.json();
  }

  /**
   * Get complete quality definitions from ARR instance
   * This might show us what qualities Radarr actually expects
   */
  async getQualityDefinitions(): Promise<any[]> {
    try {
      const response = await this.fetcher('/api/v3/qualitydefinition');
      if (!response.ok) {
        this.logger.warn(`Failed to get quality definitions: ${response.status}`);
        return [];
      }
      return response.json();
    } catch (error) {
      this.logger.warn('Error fetching quality definitions:', error);
      return [];
    }
  }

  /**
   * Get all custom formats from ARR instance
   */
  async getCustomFormats(): Promise<Array<{ id: number; name: string }>> {
    try {
      const response = await this.fetcher('/api/v3/customformat');
      if (!response.ok) {
        this.logger.warn(`Failed to get custom formats: ${response.status}, using empty array`);
        return [];
      }
      return response.json();
    } catch (error) {
      this.logger.warn('Error fetching custom formats, using empty array', error);
      return [];
    }
  }

  /**
   * Create custom formats from TRaSH data if they don't exist
   * This is the primary workflow - users expect everything to be set up automatically
   */
  async createCustomFormatsFromTrash(
    trashCustomFormats: any[],
    existingFormats: Array<{ id: number; name: string }>
  ): Promise<Array<{ id: number; name: string; score?: number }>> {
    const results: Array<{ id: number; name: string; score?: number }> = [];
    
    this.logger.info(`Setting up ${trashCustomFormats.length} TRaSH custom formats`);

    for (const trashCF of trashCustomFormats) {
      // Check if format already exists
      const existing = existingFormats.find(f => 
        f.name.toLowerCase() === trashCF.name.toLowerCase()
      );
      
      if (existing) {
        this.logger.debug(`Custom format '${trashCF.name}' already exists with ID: ${existing.id}`);
        results.push({ ...existing, score: trashCF.score });
        continue;
      }

      this.logger.info(`Creating TRaSH custom format: ${trashCF.name}`);
      
      // Create custom format with TRaSH specifications
      const newFormat = {
        name: trashCF.name,
        includeCustomFormatWhenRenaming: trashCF.includeCustomFormatWhenRenaming ?? false,
        specifications: trashCF.specifications || [{
          name: "TRaSH Auto-Created",
          implementation: "ReleaseTitleSpecification",
          negate: false,
          required: false,
          fields: {
            value: trashCF.name
          }
        }]
      };

      try {
        const response = await this.fetcher('/api/v3/customformat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newFormat),
        });

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`Failed to create custom format '${trashCF.name}': ${response.status} ${errorText}`);
          continue;
        }

        const created = await response.json();
        this.logger.info(`Created custom format '${trashCF.name}' with ID: ${created.id}`);
        results.push({ id: created.id, name: created.name, score: trashCF.score });
      } catch (error) {
        this.logger.error(`Error creating custom format '${trashCF.name}':`, error);
      }
    }

    return results;
  }

  /**
   * Find a quality item by name in the schema
   * This includes both individual qualities and custom quality groups
   */
  private findQualityByName(items: ArrQualityItem[], name: string): ArrQualityItem | null {
    let bestMatch: ArrQualityItem | null = null;

    for (const item of items) {
      // Check if this item matches (exact match for quality names or group names)
      if (item.quality?.name === name || item.name === name) {
        // Prioritize items with valid IDs (explicit null check to support ID 0)
        if (item.id != null || item.quality?.id != null) {
          return item;
        } else if (!bestMatch) {
          bestMatch = item;
        }
      }

      // For quality groups, also check if the group itself has a custom name
      // that might match composite names like 'WEB|Remux|Bluray|2160p'
      if (item.items && item.items.length > 0) {
        // First check if this group's name matches
        if (item.name === name) {
          if (item.id != null || item.quality?.id != null) {
            return item;
          } else if (!bestMatch) {
            bestMatch = item;
          }
        }

        // Then recursively search in nested items
        const found = this.findQualityByName(item.items, name);
        if (found) {
          if (found.id != null || found.quality?.id != null) {
            return found;
          } else if (!bestMatch) {
            bestMatch = found;
          }
        }
      }
    }

    return bestMatch;
  }

  /**
   * Build quality items from TRaSH items format (the actual TRaSH-Guides format)
   */
  private buildQualityItemsFromTrashItems(
    trashItems: Array<{ name: string; allowed: boolean; items?: string[] }>,
    schemaItems: ArrQualityItem[]
  ): ArrQualityItem[] {
    const result: ArrQualityItem[] = [];
    const flattenedSchema = this.flattenItems(schemaItems);

    this.logger.info({
      trashItemsCount: trashItems.length,
      schemaItemsCount: schemaItems.length,
      flattenedSchemaCount: flattenedSchema.length,
      trashItemNames: trashItems.map(item => item.name),
      schemaItemNames: flattenedSchema.map(item => item.quality?.name || item.name).slice(0, 10)
    }, 'Building quality items from TRaSH items format');

    for (const trashItem of trashItems) {
      // Find corresponding schema item
      let schemaItem = this.findQualityByName(schemaItems, trashItem.name);
      
      if (schemaItem) {
        // Validate that the schema item has a valid ID (explicit null check to support ID 0)
        const itemId = schemaItem.id ?? schemaItem.quality?.id;
        if (itemId == null) {
          this.logger.warn({
            trashItemName: trashItem.name,
            schemaItem: schemaItem
          }, 'Found schema item but it has no ID, trying partial match');

          // Try to find a better match with a valid ID
          const betterMatch = this.findPartialQualityMatch(schemaItems, trashItem.name);
          if (betterMatch && (betterMatch.id != null || betterMatch.quality?.id != null)) {
            schemaItem = betterMatch;
          } else {
            this.logger.warn(`No valid ID found for quality '${trashItem.name}', skipping`);
            continue;
          }
        }

        // Use existing schema structure but with TRaSH allowed setting
        const qualityItem: ArrQualityItem = {
          ...schemaItem,
          allowed: trashItem.allowed,
        };

        // Handle nested items if they exist in TRaSH data
        if (trashItem.items && trashItem.items.length > 0 && schemaItem.items) {
          qualityItem.items = schemaItem.items.map(schemaSubItem => {
            const isAllowed = trashItem.items!.includes(schemaSubItem.quality?.name || schemaSubItem.name || '');
            return {
              ...schemaSubItem,
              allowed: trashItem.allowed && isAllowed, // Only allowed if parent is allowed AND item is in TRaSH list
            };
          });
        }

        result.push(qualityItem);
        this.logger.debug(`Mapped TRaSH item '${trashItem.name}' to schema item with ID: ${itemId}`);
        
      } else if (trashItem.items && trashItem.items.length > 0) {
        // This is a CUSTOM QUALITY GROUP (like "WEB|Remux|Bluray|2160p")
        // We need to create it from the individual quality items
        this.logger.info(`Creating custom quality group: ${trashItem.name}`);
        
        const customGroupItems: ArrQualityItem[] = [];
        
        // Find each individual quality in the schema
        for (const itemName of trashItem.items) {
          const individualQuality = this.findQualityByName(flattenedSchema, itemName);
          // Explicit null check to support ID 0
          if (individualQuality && (individualQuality.id != null || individualQuality.quality?.id != null)) {
            customGroupItems.push({
              ...individualQuality,
              allowed: trashItem.allowed, // Inherit allowed from parent group
            });
            this.logger.debug(`Found individual quality '${itemName}' for custom group '${trashItem.name}'`);
          } else {
            // Try partial matching
            const partialMatch = this.findPartialQualityMatch(flattenedSchema, itemName);
            if (partialMatch && (partialMatch.id != null || partialMatch.quality?.id != null)) {
              customGroupItems.push({
                ...partialMatch,
                allowed: trashItem.allowed,
              });
              this.logger.info(`Found partial match '${partialMatch.quality?.name || partialMatch.name}' for '${itemName}' in custom group '${trashItem.name}'`);
            } else {
              this.logger.warn(`Individual quality '${itemName}' not found in schema for custom group '${trashItem.name}'`);
            }
          }
        }
        
        if (customGroupItems.length > 0) {
          // Create the custom quality group
          const customGroup: ArrQualityItem = {
            id: this.generateCustomGroupId(trashItem.name),
            name: trashItem.name,
            allowed: trashItem.allowed,
            items: customGroupItems,
          };
          
          result.push(customGroup);
          this.logger.info(`Created custom quality group '${trashItem.name}' with ${customGroupItems.length} items`);
        } else {
          this.logger.warn(`Custom quality group '${trashItem.name}' has no valid items, skipping`);
        }
      } else {
        // Try partial matching for individual qualities
        const partialMatch = this.findPartialQualityMatch(flattenedSchema, trashItem.name);
        // Explicit null check to support ID 0
        if (partialMatch && (partialMatch.id != null || partialMatch.quality?.id != null)) {
          const qualityItem: ArrQualityItem = {
            ...partialMatch,
            allowed: trashItem.allowed,
          };
          result.push(qualityItem);
          this.logger.info(`Found partial match for '${trashItem.name}': ${partialMatch.quality?.name || partialMatch.name}`);
        } else {
          this.logger.warn({
            trashItemName: trashItem.name,
            availableQualities: flattenedSchema.map(item => item.quality?.name || item.name).slice(0, 10)
          }, `TRaSH quality item '${trashItem.name}' not found in schema and has no items to create custom group`);
        }
      }
    }

    this.logger.info({
      resultCount: result.length,
      resultNames: result.map(item => item.name || item.quality?.name),
      resultIds: result.map(item => item.id || item.quality?.id)
    }, 'Completed building quality items from TRaSH items');

    return result;
  }

  /**
   * Build quality items array from TRaSH definitions using schema
   * Creates custom quality groups if they don't exist in schema
   */
  private buildQualityItems(
    trashQualities: TrashQualityDefinition[],
    schemaItems: ArrQualityItem[]
  ): ArrQualityItem[] {
    const result: ArrQualityItem[] = [];

    for (const trashQuality of trashQualities) {
      let schemaItem = this.findQualityByName(schemaItems, trashQuality.name);
      
      if (!schemaItem) {
        // Check if this is a custom quality group that needs to be created
        if (trashQuality.qualities && trashQuality.qualities.length > 0) {
          this.logger.info(`Creating custom quality group: ${trashQuality.name}`);
          
          // Build the nested quality items for the custom group
          const nestedItems = this.buildQualityItems(trashQuality.qualities, this.flattenItems(schemaItems));
          
          if (nestedItems.length === 0) {
            this.logger.warn(`Custom quality group '${trashQuality.name}' has no valid nested qualities, skipping`);
            continue;
          }

          // Create a new custom quality group
          schemaItem = {
            id: this.generateCustomGroupId(trashQuality.name),
            name: trashQuality.name,
            allowed: trashQuality.enabled ?? true,
            items: nestedItems,
          };
        } else {
          // Try partial matching for individual qualities
          const partialMatch = this.findPartialQualityMatch(schemaItems, trashQuality.name);
          if (partialMatch) {
            this.logger.info(`Found partial match for '${trashQuality.name}': ${partialMatch.quality?.name || partialMatch.name}`);
            schemaItem = partialMatch;
          } else {
            this.logger.warn({
              qualityName: trashQuality.name,
              availableSchemaQualities: this.flattenItems(schemaItems).map(item => item.quality?.name || item.name).slice(0, 10)
            }, `Quality '${trashQuality.name}' not found in schema and cannot create custom group`);
            continue;
          }
        }
      }

      // Clone the schema item (or use the custom one we created)
      const qualityItem: ArrQualityItem = {
        ...schemaItem,
        allowed: trashQuality.enabled ?? true,
      };

      // Handle quality groups (items with nested qualities)
      if (trashQuality.qualities && trashQuality.qualities.length > 0 && schemaItem.items) {
        qualityItem.items = this.buildQualityItems(trashQuality.qualities, schemaItem.items);
      }

      result.push(qualityItem);
    }

    return result;
  }

  /**
   * Find cutoff ID by quality name
   * Handles composite quality names like 'WEB|Remux|Bluray|2160p'
   */
  private findCutoffId(items: ArrQualityItem[], qualityName: string): number | null {
    // First try exact match
    const exactMatch = this.findQualityByName(items, qualityName);
    if (exactMatch) {
      return exactMatch.quality?.id || exactMatch.id || null;
    }

    // If qualityName contains pipe separators, try each part
    if (qualityName.includes('|')) {
      const qualityParts = qualityName.split('|').map(part => part.trim());
      
      for (const part of qualityParts) {
        const match = this.findQualityByName(items, part);
        if (match) {
          this.logger.info(`Found cutoff match for '${part}' from composite '${qualityName}'`);
          return match.quality?.id || match.id || null;
        }
      }

      // Try partial matching for quality parts
      for (const part of qualityParts) {
        for (const item of this.flattenItems(items)) {
          const itemName = item.quality?.name || item.name || '';
          if (itemName.toLowerCase().includes(part.toLowerCase()) || 
              part.toLowerCase().includes(itemName.toLowerCase())) {
            this.logger.info(`Found partial cutoff match for '${itemName}' from part '${part}' of composite '${qualityName}'`);
            return item.quality?.id || item.id || null;
          }
        }
      }
    }

    return null;
  }

  /**
   * Helper method to flatten nested quality items
   */
  private flattenItems(items: ArrQualityItem[]): ArrQualityItem[] {
    const result: ArrQualityItem[] = [];
    for (const item of items) {
      result.push(item);
      if (item.items && item.items.length > 0) {
        result.push(...this.flattenItems(item.items));
      }
    }
    return result;
  }

  /**
   * Get the first allowed quality ID as fallback for cutoff
   * Ensures at least one quality is allowed if none are found
   */
  private getFirstAllowedQualityId(items: ArrQualityItem[]): number {
    let firstAllowed = items.find(item => item.allowed);

    // If no allowed qualities found, enable the first valid quality as fallback
    if (!firstAllowed) {
      this.logger.warn('No allowed qualities found, enabling first valid quality as fallback');

      // Find first quality with valid ID (explicit null check to support ID 0)
      const firstValidQuality = items.find(item => item.id != null || item.quality?.id != null);
      if (firstValidQuality) {
        firstValidQuality.allowed = true;
        firstAllowed = firstValidQuality;
        this.logger.info(`Enabled quality '${firstAllowed.name || firstAllowed.quality?.name}' as fallback`);
      } else {
        throw new Error('No valid qualities found with IDs - cannot create quality profile');
      }
    }

    const id = firstAllowed.quality?.id ?? firstAllowed.id;
    if (id == null) {
      throw new Error('First allowed quality has no ID');
    }
    return id;
  }

  /**
   * Generate a custom group ID based on the group name
   * Uses a high number range to avoid conflicts with existing quality IDs
   */
  private generateCustomGroupId(groupName: string): number {
    // Create a simple hash from the group name to ensure consistency
    let hash = 0;
    for (let i = 0; i < groupName.length; i++) {
      const char = groupName.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Use high number range (starting from 10000) to avoid conflicts
    return 10000 + Math.abs(hash) % 10000;
  }

  /**
   * Find partial quality match by checking for substring matches
   */
  private findPartialQualityMatch(items: ArrQualityItem[], name: string): ArrQualityItem | null {
    const lowerName = name.toLowerCase();

    // If items is already flattened, use it directly; otherwise flatten it
    const searchItems = Array.isArray(items) && items.length > 0 && !items.some(item => item.items) ? items : this.flattenItems(items);

    for (const item of searchItems) {
      // Ensure the item has a valid ID before considering it (explicit null check to support ID 0)
      if (item.id == null && item.quality?.id == null) {
        continue;
      }

      const itemName = (item.quality?.name || item.name || '').toLowerCase();

      // Check if names contain each other (partial match)
      if (itemName.includes(lowerName) || lowerName.includes(itemName)) {
        return item;
      }

      // Check for common quality abbreviations and formats
      if (this.isQualityMatch(lowerName, itemName)) {
        return item;
      }
    }

    return null;
  }

  /**
   * Check if two quality names are equivalent (handles common variations)
   */
  private isQualityMatch(name1: string, name2: string): boolean {
    // Handle common quality name variations
    const normalizeQuality = (name: string): string => {
      return name
        .toLowerCase()
        .replace(/[-_\s]/g, '')
        .replace('bluray', 'br')
        .replace('webdl', 'web')
        .replace('webrip', 'web')
        .replace('hdtv', 'tv');
    };
    
    return normalizeQuality(name1) === normalizeQuality(name2);
  }

  /**
   * Apply TRaSH items configuration to complete schema
   * For composite quality names (like "WEB|Remux|Bluray|2160p"), creates new custom quality groups
   * Uses high IDs (5000+) to avoid conflicts with Radarr's predefined groups (which use 1000+)
   */
  private applyTrashItemsToSchema(qualityItems: ArrQualityItem[], trashItems: Array<{ name: string; allowed: boolean; items?: string[] }>): void {
    // Find the highest existing group ID to avoid conflicts
    let maxExistingId = Math.max(
      ...qualityItems.map(item => item.id || 0),
      4999 // Start from at least 5000
    );
    let customGroupIndex = 0; // Counter for custom group IDs

    for (const trashItem of trashItems) {
      const schemaItem = qualityItems.find(item =>
        (item.name === trashItem.name) ||
        (item.quality?.name === trashItem.name)
      );

      if (schemaItem) {
        // Simple match - just mark as allowed/disabled
        schemaItem.allowed = trashItem.allowed;
        this.logger.debug(`Updated ${trashItem.name}: allowed = ${trashItem.allowed}`);
      } else if (trashItem.items && trashItem.items.length > 0) {
        // This is a composite quality reference with explicit items array
        this.logger.info(`Creating custom quality group '${trashItem.name}' with ${trashItem.items.length} referenced qualities`);

        const flattenedSchema = this.flattenItems(qualityItems);
        const customGroupItems: ArrQualityItem[] = [];

        // Build nested items from the referenced quality names
        for (const itemName of trashItem.items) {
          let matchedQuality = this.findQualityByName(flattenedSchema, itemName);

          if (!matchedQuality) {
            matchedQuality = this.findPartialQualityMatch(flattenedSchema, itemName);
          }

          if (matchedQuality && (matchedQuality.id != null || matchedQuality.quality?.id != null)) {
            const nestedItem: ArrQualityItem = {
              quality: matchedQuality.quality ? { ...matchedQuality.quality } : undefined!,
              items: [],
              allowed: trashItem.allowed,
            };

            customGroupItems.push(nestedItem);
            this.logger.debug(`Added '${itemName}' to custom group '${trashItem.name}'`);
          } else {
            this.logger.warn(`Quality '${itemName}' not found in schema for custom group '${trashItem.name}'`);
          }
        }

        if (customGroupItems.length > 0) {
          // Remove these qualities from any existing groups AND standalone items to avoid duplicates
          const qualityIdsToRemove = new Set(customGroupItems.map(item => item.quality?.id).filter(id => id != null));
          let removedCount = 0;

          // First, remove from groups with nested items
          for (const existingItem of qualityItems) {
            if (existingItem.items && existingItem.items.length > 0) {
              const originalCount = existingItem.items.length;
              existingItem.items = existingItem.items.filter(nestedItem =>
                !qualityIdsToRemove.has(nestedItem.quality?.id)
              );

              if (existingItem.items.length < originalCount) {
                removedCount += originalCount - existingItem.items.length;
                this.logger.debug(`Removed ${originalCount - existingItem.items.length} qualities from '${existingItem.name || existingItem.quality?.name}' group to avoid duplicates`);
              }

              // If the group is now empty, mark it as not allowed
              if (existingItem.items.length === 0 && existingItem.name) {
                existingItem.allowed = false;
                this.logger.debug(`Disabled empty group '${existingItem.name}'`);
              }
            }
          }

          // Second, filter out standalone quality items that are in the custom group
          const itemsToKeep = qualityItems.filter(item => {
            // Keep groups
            if (item.items && item.items.length > 0) return true;
            // Keep quality items that aren't in our custom group
            if (item.quality && !qualityIdsToRemove.has(item.quality.id)) return true;
            // Remove standalone quality items that are in our custom group
            if (item.quality && qualityIdsToRemove.has(item.quality.id)) {
              this.logger.debug(`Removed standalone quality '${item.quality.name}' to avoid duplicate with custom group`);
              removedCount++;
              return false;
            }
            return true;
          });

          // Replace the array (we need to modify the original array, not create a new one)
          qualityItems.length = 0;
          qualityItems.push(...itemsToKeep);

          const customGroupId = maxExistingId + 1 + customGroupIndex++;
          const customGroup: ArrQualityItem = {
            id: customGroupId,
            name: trashItem.name,
            items: customGroupItems,
            allowed: trashItem.allowed,
          };

          qualityItems.push(customGroup);

          this.logger.info({
            groupName: trashItem.name,
            groupId: customGroupId,
            itemCount: customGroupItems.length,
            items: customGroupItems.map(item => item.quality?.name || item.name),
            removedDuplicates: removedCount
          }, `Created custom quality group`);
        } else {
          this.logger.warn(`Custom quality group '${trashItem.name}' has no valid items, skipping`);
        }
      } else if (trashItem.name.includes('|')) {
        // Pipe-separated composite reference (like "WEB|Remux|Bluray|2160p")
        // Parse the parts and create a custom group from matching qualities
        this.logger.info(`Parsing pipe-separated quality reference: ${trashItem.name}`);

        const parts = trashItem.name.split('|').map(p => p.trim());
        const flattenedSchema = this.flattenItems(qualityItems);
        const customGroupItems: ArrQualityItem[] = [];

        // Find all qualities that match ALL parts of the composite name
        for (const schemaQuality of flattenedSchema) {
          const qualityName = (schemaQuality.quality?.name || schemaQuality.name || '').toLowerCase();

          // Check if this quality matches all parts
          const matchesAll = parts.every(part => {
            const partLower = part.toLowerCase();
            return qualityName.includes(partLower) ||
                   partLower.includes(qualityName.split('-')[0]) || // Match first part (e.g., "web" in "WEBDL-2160p")
                   (schemaQuality.quality?.resolution && partLower.includes(schemaQuality.quality.resolution.toString()));
          });

          if (matchesAll && schemaQuality.quality && (schemaQuality.id != null || schemaQuality.quality.id != null)) {
            const nestedItem: ArrQualityItem = {
              quality: { ...schemaQuality.quality },
              items: [],
              allowed: trashItem.allowed,
            };

            customGroupItems.push(nestedItem);
            this.logger.debug(`Matched '${schemaQuality.quality.name}' for composite '${trashItem.name}'`);
          }
        }

        if (customGroupItems.length > 0) {
          // Remove these qualities from any existing groups AND standalone items to avoid duplicates
          const qualityIdsToRemove = new Set(customGroupItems.map(item => item.quality?.id).filter(id => id != null));
          let removedCount = 0;

          // First, remove from groups with nested items
          for (const existingItem of qualityItems) {
            if (existingItem.items && existingItem.items.length > 0) {
              const originalCount = existingItem.items.length;
              existingItem.items = existingItem.items.filter(nestedItem =>
                !qualityIdsToRemove.has(nestedItem.quality?.id)
              );

              if (existingItem.items.length < originalCount) {
                removedCount += originalCount - existingItem.items.length;
                this.logger.debug(`Removed ${originalCount - existingItem.items.length} qualities from '${existingItem.name || existingItem.quality?.name}' group to avoid duplicates`);
              }

              // If the group is now empty, mark it as not allowed
              if (existingItem.items.length === 0 && existingItem.name) {
                existingItem.allowed = false;
                this.logger.debug(`Disabled empty group '${existingItem.name}'`);
              }
            }
          }

          // Second, filter out standalone quality items that are in the custom group
          const beforeFilterCount = qualityItems.length;
          const itemsToKeep = qualityItems.filter(item => {
            // Keep groups
            if (item.items && item.items.length > 0) return true;
            // Keep quality items that aren't in our custom group
            if (item.quality && !qualityIdsToRemove.has(item.quality.id)) return true;
            // Remove standalone quality items that are in our custom group
            if (item.quality && qualityIdsToRemove.has(item.quality.id)) {
              this.logger.debug(`Removed standalone quality '${item.quality.name}' to avoid duplicate with custom group`);
              removedCount++;
              return false;
            }
            return true;
          });

          // Replace the array (we need to modify the original array, not create a new one)
          qualityItems.length = 0;
          qualityItems.push(...itemsToKeep);

          const customGroupId = maxExistingId + 1 + customGroupIndex++;
          const customGroup: ArrQualityItem = {
            id: customGroupId,
            name: trashItem.name,
            items: customGroupItems,
            allowed: trashItem.allowed,
          };

          qualityItems.push(customGroup);

          this.logger.info({
            groupName: trashItem.name,
            groupId: customGroupId,
            itemCount: customGroupItems.length,
            items: customGroupItems.map(item => item.quality?.name),
            removedDuplicates: removedCount
          }, `Created custom quality group from pipe-separated reference`);
        } else {
          this.logger.warn(`No matching qualities found for pipe-separated reference '${trashItem.name}'`);
        }
      } else {
        this.logger.warn(`TRaSH item '${trashItem.name}' not found in schema`);
      }
    }
  }

  /**
   * Apply TRaSH qualities configuration to complete schema
   */
  private applyTrashQualitiesToSchema(qualityItems: ArrQualityItem[], trashQualities: TrashQualityDefinition[]): void {
    for (const trashQuality of trashQualities) {
      const schemaItem = qualityItems.find(item => 
        (item.name === trashQuality.name) || 
        (item.quality?.name === trashQuality.name)
      );
      
      if (schemaItem) {
        schemaItem.allowed = trashQuality.enabled ?? true;
        this.logger.debug(`Updated ${trashQuality.name}: allowed = ${trashQuality.enabled ?? true}`);
      } else {
        this.logger.warn(`TRaSH quality '${trashQuality.name}' not found in schema`);
      }
    }
  }

  /**
   * Apply quality profile to ARR instance
   */
  async applyQualityProfile(
    trashProfile: TrashQualityProfile,
    customFormats: any[] = []
  ): Promise<{ success: boolean; profile: ArrQualityProfile; action: 'created' | 'updated' }> {
    // Get schema, existing profiles, custom formats, and quality definitions
    const [schema, existingProfiles, initialCustomFormats, qualityDefinitions] = await Promise.all([
      this.getQualityProfileSchema(),
      this.getExistingProfiles(),
      this.getCustomFormats(),
      this.getQualityDefinitions()
    ]);

    // Log what Radarr expects vs what we have - check for null/duplicate IDs
    const allDefinitionIds = qualityDefinitions.map(qd => qd.quality?.id || qd.id);
    const validDefinitionIds = allDefinitionIds.filter(id => id != null);
    const uniqueDefinitionIds = [...new Set(validDefinitionIds)];
    
    this.logger.info({
      schemaItemsCount: schema.items?.length || 0,
      existingProfilesCount: existingProfiles.length,
      qualityDefinitionsCount: qualityDefinitions.length,
      allDefinitionIds: allDefinitionIds.length,
      validDefinitionIds: validDefinitionIds.length,
      uniqueDefinitionIds: uniqueDefinitionIds.length,
      nullIds: allDefinitionIds.filter(id => id == null).length,
      duplicates: validDefinitionIds.length - uniqueDefinitionIds.length,
      sampleDefinitionIds: uniqueDefinitionIds.slice(0, 15)
    }, 'Radarr API responses received');

    // PRIMARY WORKFLOW: Create all TRaSH custom formats first
    // This is the main use case - users want everything set up from scratch
    let allCustomFormats = [...initialCustomFormats];
    let trashCustomFormatsWithScores: Array<{ id: number; name: string; score?: number }> = [];

    if (customFormats && customFormats.length > 0) {
      this.logger.info('Setting up complete TRaSH custom format and quality profile workflow');
      
      // Create all TRaSH custom formats that don't exist
      const createdFormats = await this.createCustomFormatsFromTrash(customFormats, allCustomFormats);
      trashCustomFormatsWithScores = createdFormats;
      
      // Update the list of all custom formats with newly created ones
      for (const created of createdFormats) {
        if (!allCustomFormats.find(f => f.id === created.id)) {
          allCustomFormats.push({ id: created.id, name: created.name });
        }
      }
      
      this.logger.info(`Total custom formats available: ${allCustomFormats.length}`);
    } else {
      this.logger.info('No TRaSH custom formats provided, using existing custom formats only');
    }

    // Debug: Log the schema structure
    this.logger.info({
      schemaName: schema.name,
      schemaId: schema.id,
      schemaItemsCount: schema.items?.length || 0,
      schemaItemsStructure: schema.items?.slice(0, 5).map(item => ({
        name: item.name,
        id: item.id,
        qualityName: item.quality?.name,
        qualityId: item.quality?.id,
        hasItems: !!item.items?.length,
        itemsCount: item.items?.length || 0
      })) || [],
      existingProfilesCount: existingProfiles.length
    }, 'Schema and existing profiles loaded');

    // Validate schema has items
    if (!schema.items || !Array.isArray(schema.items) || schema.items.length === 0) {
      throw new Error(`Invalid or empty quality profile schema received from ARR instance. Schema items: ${JSON.stringify(schema.items)}`);
    }
    
    // Remove invalid schema items completely - Radarr only accepts predefined quality IDs
    // IMPORTANT: Use explicit null/undefined checks to avoid filtering out ID 0 (Unknown quality)
    const invalidSchemaItems = schema.items.filter((item, index) => item.id == null && item.quality?.id == null);
    if (invalidSchemaItems.length > 0) {
      this.logger.warn({
        invalidItemsCount: invalidSchemaItems.length,
        totalSchemaItems: schema.items.length,
        invalidItems: invalidSchemaItems.map((item, index) => ({
          originalIndex: schema.items.indexOf(item),
          id: item.id,
          name: item.name,
          qualityId: item.quality?.id,
          qualityName: item.quality?.name,
          hasItems: !!item.items?.length,
          itemsContent: item.items?.map(subItem => ({
            id: subItem.id,
            qualityId: subItem.quality?.id,
            qualityName: subItem.quality?.name
          })),
          fullItem: item
        }))
      }, 'Schema contains invalid items - removing them as Radarr only accepts predefined quality IDs');

      // Remove invalid items completely (explicit null check to preserve ID 0)
      schema.items = schema.items.filter(item => item.id != null || item.quality?.id != null);
      
      this.logger.info(`Removed ${invalidSchemaItems.length} invalid items, ${schema.items.length} valid items remaining`);
    }

    // Check if we need to supplement schema with missing quality definitions
    const schemaQualityIds = new Set();
    const extractQualityIds = (items: any[]) => {
      for (const item of items) {
        if (item.quality?.id) schemaQualityIds.add(item.quality.id);
        if (item.items?.length) extractQualityIds(item.items);
      }
    };
    extractQualityIds(schema.items);
    
    // Use the cleaned unique definition IDs we calculated earlier
    const definitionIds = new Set(uniqueDefinitionIds);
    const missingIds = [...definitionIds].filter(id => !schemaQualityIds.has(id));
    
    this.logger.info({
      schemaItemsCount: schema.items.length,
      schemaQualityIds: Array.from(schemaQualityIds),
      definitionIds: Array.from(definitionIds),
      missingIds,
      needsSupplementation: missingIds.length > 0
    }, 'Quality definitions analysis');

    if (missingIds.length > 0 || schemaQualityIds.size < definitionIds.size) {
      this.logger.warn({
        schemaItemsCount: schema.items.length,
        qualityDefinitionsCount: qualityDefinitions.length,
        missingIdsCount: missingIds.length,
        existingProfilesCount: existingProfiles.length
      }, 'Schema missing quality definitions, trying fallback strategies');
      
      // Strategy 1: Use existing profile with most items
      if (existingProfiles.length > 0) {
        const referenceProfile = existingProfiles.reduce((prev, current) => 
          (current.items?.length || 0) > (prev.items?.length || 0) ? current : prev
        );
        
        // Check if reference profile covers all quality definitions
        const referenceQualityIds = new Set();
        const extractFromReference = (items: any[]) => {
          for (const item of items) {
            if (item.quality?.id) referenceQualityIds.add(item.quality.id);
            if (item.items?.length) extractFromReference(item.items);
          }
        };
        if (referenceProfile.items) extractFromReference(referenceProfile.items);
        
        const referenceCoversAll = [...definitionIds].every(id => referenceQualityIds.has(id));
        
        if (referenceProfile.items && referenceCoversAll) {
          this.logger.info({
            referenceProfileName: referenceProfile.name,
            referenceItemsCount: referenceProfile.items.length,
            referenceQualityIds: Array.from(referenceQualityIds),
            coversAllDefinitions: referenceCoversAll
          }, 'Using complete existing profile as quality reference');
          
          schema.items = referenceProfile.items.map(item => ({ ...item }));
          // Re-extract quality IDs after using reference profile
          schemaQualityIds.clear();
          extractQualityIds(schema.items);
          // Recalculate missing IDs
          const updatedMissingIds = [...definitionIds].filter(id => !schemaQualityIds.has(id));
          this.logger.info(`After using reference profile, missing IDs: ${updatedMissingIds.length}`);
        }
      }
      
      // Strategy 2: If still missing qualities, create from quality definitions
      const finalMissingIds = [...definitionIds].filter(id => !schemaQualityIds.has(id));
      if (finalMissingIds.length > 0 && qualityDefinitions.length > 0) {
        this.logger.info({
          currentSchemaItems: schema.items.length,
          qualityDefinitionsCount: qualityDefinitions.length,
          finalMissingIdsCount: finalMissingIds.length,
          finalMissingIds
        }, 'Adding missing qualities from quality definitions');
        
        // Add missing individual quality items
        const missingQualityItems = qualityDefinitions
          .filter(qd => finalMissingIds.includes(qd.quality?.id || qd.id))
          .map(qd => ({
            id: qd.quality?.id || qd.id,
            quality: qd.quality || {
              id: qd.id,
              name: qd.title || `Quality ${qd.id}`,
              source: 'unknown',
              resolution: qd.quality?.resolution || 0,
              modifier: qd.quality?.modifier || 'none'
            },
            items: [],
            allowed: false
          }));
        
        this.logger.info(`Adding ${missingQualityItems.length} missing quality items`);
        schema.items = [...schema.items, ...missingQualityItems];
      }
    }

    // Find existing profile
    const existingProfile = existingProfiles.find(p => p.name === trashProfile.name);
    
    // ALWAYS start with complete schema to satisfy Radarr's "Must contain all qualities" validation
    // Then apply TRaSH modifications on top of the complete schema
    let qualityItems: ArrQualityItem[] = schema.items.map(item => ({
      ...item,
      items: item.items ? item.items.map(nestedItem => ({ ...nestedItem })) : []
    }));
    
    // Debug schema items structure
    const schemaDebug = qualityItems.slice(0, 3).map((item, index) => ({
      index,
      id: item.id,
      name: item.name,
      qualityId: item.quality?.id,
      qualityName: item.quality?.name,
      hasItems: !!item.items?.length,
      allowed: item.allowed
    }));
    
    this.logger.info({
      profileName: trashProfile.name,
      startingWithSchemaItems: qualityItems.length,
      schemaItemsSample: schemaDebug,
      hasTrashItems: !!(trashProfile.items && trashProfile.items.length > 0),
      hasTrashQualities: !!(trashProfile.qualities && trashProfile.qualities.length > 0)
    }, "Starting with complete schema, will apply TRaSH modifications");
    
    // Apply TRaSH modifications to the complete schema
    if (trashProfile.items && trashProfile.items.length > 0) {
      this.logger.info({
        trashItemsCount: trashProfile.items.length,
        trashItemsSample: trashProfile.items.slice(0, 3).map(item => ({
          name: item.name,
          allowed: item.allowed,
          hasItems: !!item.items,
          itemsCount: item.items?.length || 0,
          items: item.items
        }))
      }, "Applying TRaSH items configuration to schema");
      this.applyTrashItemsToSchema(qualityItems, trashProfile.items);
    } else if (trashProfile.qualities && trashProfile.qualities.length > 0) {
      this.logger.info("Applying TRaSH qualities configuration to schema");
      this.applyTrashQualitiesToSchema(qualityItems, trashProfile.qualities);
    }

    if (qualityItems.length === 0) {
      this.logger.error({
        profileName: trashProfile.name,
        hasTrashItems: !!(trashProfile.items && trashProfile.items.length > 0),
        hasTrashQualities: !!(trashProfile.qualities && trashProfile.qualities.length > 0),
        schemaItemsCount: schema.items.length,
        schemaItemsSample: schema.items.slice(0, 3).map(item => ({
          name: item.name || item.quality?.name,
          id: item.id || item.quality?.id,
          hasItems: !!item.items?.length
        }))
      }, 'No valid quality items found - debugging schema and TRaSH data');
      throw new Error(`No valid quality items found for profile '${trashProfile.name}'. Check that the TRaSH profile items match the ARR instance quality schema.`);
    }

    // Handle quality sorting (recyclarr feature)
    if (trashProfile.quality_sort === 'bottom') {
      qualityItems.reverse();
    }

    // Find cutoff ID - use TRaSH cutoff field first, then recyclarr until_quality
    let cutoffId: number;
    const cutoffName = trashProfile.cutoff || trashProfile.upgrade?.until_quality;
    
    this.logger.info({
      profileName: trashProfile.name,
      trashCutoff: trashProfile.cutoff,
      recyclarrUntilQuality: trashProfile.upgrade?.until_quality,
      finalCutoffName: cutoffName,
      qualityItemsForCutoff: qualityItems.map(item => ({
        name: item.name || item.quality?.name,
        id: item.id || item.quality?.id,
        allowed: item.allowed,
        hasItems: !!item.items?.length,
      })),
    }, "Looking for cutoff quality");
    
    if (cutoffName) {
      const foundCutoffId = this.findCutoffId(qualityItems, cutoffName);
      if (foundCutoffId) {
        cutoffId = foundCutoffId;
        this.logger.info(`Successfully found cutoff quality '${cutoffName}' with ID: ${cutoffId}`);
      } else {
        this.logger.warn(`Cutoff quality '${cutoffName}' not found in available qualities, using first allowed quality as fallback`);
        this.logger.info(`Available quality items:`, qualityItems.map(item => ({ 
          name: item.name || item.quality?.name, 
          id: item.id || item.quality?.id,
          allowed: item.allowed,
          type: item.quality ? 'quality' : 'group'
        })));
        cutoffId = this.getFirstAllowedQualityId(qualityItems);
      }
    } else {
      // Default to first allowed quality
      this.logger.info('No cutoff quality specified, using first allowed quality');
      cutoffId = this.getFirstAllowedQualityId(qualityItems);
    }

    // Build format items (custom format scores) with TRaSH scores
    // This is the complete workflow: create format items with proper TRaSH scores
    let formatItems: Array<{ id?: number; format: number; name: string; score: number }>;
    
    if (existingProfile?.formatItems) {
      // Start with existing profile's format items
      formatItems = existingProfile.formatItems.map(item => ({ ...item }));
      this.logger.info(`Starting with existing profile's ${formatItems.length} format items`);
    } else {
      // Use schema's format items or create from all custom formats
      formatItems = schema.formatItems ? 
        schema.formatItems.map(item => ({ ...item })) :
        allCustomFormats.map(format => ({
          id: format.id,
          format: format.id,
          name: format.name,
          score: 0
        }));
      
      this.logger.info(`Starting with schema/all custom formats: ${formatItems.length} format items`);
    }
    
    // Update scores with TRaSH data - this is the key part of the workflow
    if (trashCustomFormatsWithScores.length > 0) {
      this.logger.info(`Applying TRaSH scores to ${trashCustomFormatsWithScores.length} custom formats`);
      
      for (const trashCF of trashCustomFormatsWithScores) {
        const existingFormatItem = formatItems.find(item => 
          item.format === trashCF.id || item.name === trashCF.name
        );
        
        if (existingFormatItem && typeof trashCF.score === 'number') {
          const oldScore = existingFormatItem.score;
          existingFormatItem.score = trashCF.score;
          this.logger.debug(`Updated score for '${trashCF.name}': ${oldScore} → ${trashCF.score}`);
        } else if (!existingFormatItem) {
          // Add new format item with TRaSH score
          formatItems.push({
            id: trashCF.id,
            format: trashCF.id,
            name: trashCF.name,
            score: trashCF.score || 0
          });
          this.logger.debug(`Added new format item '${trashCF.name}' with score: ${trashCF.score}`);
        }
      }
    }
    
    // Ensure we have at least one format item to prevent validation error
    if (formatItems.length === 0) {
      this.logger.warn('No format items found, adding default format item');
      formatItems.push({
        format: 1,
        name: "Default",
        score: 0
      });
    }

    // Final validation: ensure all items have required properties for Radarr API
    const validatedItems = qualityItems.map((item, index) => {
      // Check if the item has any valid ID (explicit null check to support ID 0)
      const hasValidId = item.id != null || item.quality?.id != null;

      if (!hasValidId) {
        this.logger.error({
          itemIndex: index,
          itemName: item.name || item.quality?.name || 'Unknown',
          itemStructure: {
            id: item.id,
            qualityId: item.quality?.id,
            hasItems: !!item.items?.length,
            itemsCount: item.items?.length || 0
          },
          fullItem: item
        }, 'Quality item missing required ID - this should not happen with schema items');
        throw new Error(`Quality item '${item.name || item.quality?.name || 'Unknown'}' at index ${index} is missing required ID`);
      }
      
      // Ensure the item has proper structure for Radarr API
      const validatedItem: ArrQualityItem = {
        ...item,
        allowed: item.allowed ?? false,
      };

      // Ensure quality object structure is correct per Radarr validation rules
      // CRITICAL: Explicitly construct objects without unwanted fields (delete operator isn't reliable)
      if (validatedItem.quality) {
        // Item with quality object (individual quality)
        // IMPORTANT: Individual qualities should NOT have top-level id or name (per Radarr/recyclarr)
        // The quality.id is sufficient - top-level id is only for groups

        // Recursively validate nested items FIRST (before constructing final object)
        let processedItems = validatedItem.items || [];
        if (processedItems.length > 0) {
          processedItems = processedItems.map((nestedItem, nestedIndex) => {
            if (nestedItem.id == null && nestedItem.quality?.id == null) {
              this.logger.warn(`Nested item at ${index}.${nestedIndex} missing ID`);
            }

            // Nested item with quality object - construct WITHOUT top-level id/name
            if (nestedItem.quality) {
              return {
                quality: nestedItem.quality,
                items: nestedItem.items || [],
                allowed: nestedItem.allowed ?? false
              };
            }
            // Nested group - keep as is
            return {
              ...nestedItem,
              allowed: nestedItem.allowed ?? false
            };
          });
        }

        // Return individual quality item WITHOUT top-level id/name
        return {
          quality: validatedItem.quality,
          items: processedItems,
          allowed: validatedItem.allowed
        };
      } else if (validatedItem.items && validatedItem.items.length > 0) {
        // Group item - ensure it has a name and contains multiple qualities
        const groupName = validatedItem.name || `Group ${validatedItem.id}`;

        // Process nested items for groups
        const processedItems = validatedItem.items.map((nestedItem, nestedIndex) => {
          if (nestedItem.id == null && nestedItem.quality?.id == null) {
            this.logger.warn(`Nested item at ${index}.${nestedIndex} missing ID`);
          }

          // Nested item with quality object - construct WITHOUT top-level id/name
          if (nestedItem.quality) {
            return {
              quality: nestedItem.quality,
              items: nestedItem.items || [],
              allowed: nestedItem.allowed ?? false
            };
          }
          // Nested group - keep as is
          return {
            ...nestedItem,
            allowed: nestedItem.allowed ?? false
          };
        });

        // Return group item WITH top-level id/name, WITHOUT quality object
        return {
          id: validatedItem.id,
          name: groupName,
          items: processedItems,
          allowed: validatedItem.allowed
        };
      } else if (validatedItem.id != null && !validatedItem.quality && (!validatedItem.items || validatedItem.items.length === 0)) {
        // This is likely an invalid item - skip it (explicit null check to support ID 0)
        this.logger.warn(`Skipping invalid quality item with ID ${validatedItem.id} - no quality object and no items`);
        return null;
      }

      return validatedItem;
    }).filter(item => item !== null); // Remove null items

    if (validatedItems.length === 0) {
      this.logger.warn(`Profile '${trashProfile.name}' has no valid quality items, falling back to schema defaults`);
      // Use schema items as fallback with at least one allowed
      validatedItems.push(...schema.items.map((item, index) => ({
        ...item,
        allowed: index === 0 // Only allow the first item as minimal fallback
      })));
      
      if (validatedItems.length === 0) {
        throw new Error(`Profile '${trashProfile.name}' has no valid quality items after validation and schema fallback failed`);
      }
    }

    // Ensure at least one quality is allowed for Radarr validation
    const hasAllowedItems = validatedItems.some(item => item.allowed);
    if (!hasAllowedItems) {
      this.logger.warn(`Profile '${trashProfile.name}' has no allowed qualities, enabling first quality as fallback`);
      // Explicit null check to support ID 0
      const firstValidItem = validatedItems.find(item => item.id != null || item.quality?.id != null);
      if (firstValidItem) {
        firstValidItem.allowed = true;
        this.logger.info(`Enabled quality '${firstValidItem.name || firstValidItem.quality?.name}' as fallback for profile '${trashProfile.name}'`);
      }
    }

    this.logger.info({
      profileName: trashProfile.name,
      originalItemsCount: qualityItems.length,
      validatedItemsCount: validatedItems.length,
      cutoffId,
      hasAllowedItems: validatedItems.some(item => item.allowed),
    }, 'Quality items validated successfully');

    // Validate that cutoff quality exists in allowed qualities
    const allowedItems = validatedItems.filter(item => item.allowed);
    const cutoffExistsInAllowed = allowedItems.some(item => (item.id || item.quality?.id) === cutoffId);
    
    if (!cutoffExistsInAllowed) {
      this.logger.warn({
        cutoffId,
        allowedItems: allowedItems.map(item => ({
          id: item.id || item.quality?.id,
          name: item.name || item.quality?.name
        }))
      }, 'Cutoff quality not found in allowed qualities, adjusting');
      
      // Find the cutoff item and mark it as allowed
      const cutoffItem = validatedItems.find(item => (item.id || item.quality?.id) === cutoffId);
      if (cutoffItem) {
        cutoffItem.allowed = true;
        this.logger.info(`Marked cutoff quality '${cutoffItem.name || cutoffItem.quality?.name}' as allowed`);
      }
    }

    // Calculate minimum upgrade format score to avoid "can never be satisfied" error
    const positiveScores = formatItems
      .map(item => item.score)
      .filter(score => score > 0)
      .sort((a, b) => a - b);
    
    // Use the smallest positive score as minimum, but ensure it's at least 1 for Radarr validation
    const calculatedMinUpgradeScore = positiveScores.length > 0 ? positiveScores[0] : 1;
    const minUpgradeFormatScore = Math.max(calculatedMinUpgradeScore, trashProfile.upgrade?.min_format_score ?? 1, 1);
    
    this.logger.info({
      formatItemsCount: formatItems.length,
      positiveScoresCount: positiveScores.length,
      calculatedMinUpgradeScore,
      finalMinUpgradeFormatScore: minUpgradeFormatScore,
      minFormatScore: trashProfile.min_format_score ?? 0,
      cutoffFormatScore: trashProfile.upgrade?.until_score ?? 0
    }, 'Format score calculation');

    // Build the profile payload with all required fields
    const profilePayload: ArrQualityProfile = {
      name: trashProfile.name,
      upgradeAllowed: trashProfile.upgrade?.allowed ?? true,
      cutoff: cutoffId,
      items: validatedItems,
      minFormatScore: trashProfile.min_format_score ?? 0,
      cutoffFormatScore: trashProfile.upgrade?.until_score ?? 0,
      minUpgradeFormatScore,
      formatItems,
      language: schema.language || {
        id: 1, // English - default language ID
        name: "English"
      },
    };

    // Add existing profile ID if updating
    if (existingProfile) {
      profilePayload.id = existingProfile.id;
    }

    // Comprehensive validation logging
    this.logger.info({
      profileName: trashProfile.name,
      action: existingProfile ? 'update' : 'create',
      itemsCount: validatedItems.length,
      allowedItemsCount: validatedItems.filter(item => item.allowed).length,
      cutoffId,
      cutoffValid: validatedItems.some(item => (item.id || item.quality?.id) === cutoffId),
        profilePayload: {
        name: profilePayload.name,
        upgradeAllowed: profilePayload.upgradeAllowed,
        cutoff: profilePayload.cutoff,
        itemsCount: profilePayload.items.length,
        minFormatScore: profilePayload.minFormatScore,
        cutoffFormatScore: profilePayload.cutoffFormatScore,
        minUpgradeFormatScore: profilePayload.minUpgradeFormatScore,
        formatItemsCount: profilePayload.formatItems.length,
        languageId: profilePayload.language.id,
        languageName: profilePayload.language.name,
        sampleItems: profilePayload.items.slice(0, 3).map(item => ({
          id: item.id || item.quality?.id,
          name: item.name || item.quality?.name,
          allowed: item.allowed,
          hasNestedItems: !!item.items?.length
        }))
      }
    }, 'About to send quality profile to Radarr');

    // Log the complete payload for debugging
    this.logger.info({
      profileName: trashProfile.name,
      payloadJson: JSON.stringify(profilePayload, null, 2)
    }, 'Complete payload being sent to Radarr');

    // Make the API call
    const method = existingProfile ? 'PUT' : 'POST';
    const url = existingProfile ? `/api/v3/qualityprofile/${existingProfile.id}` : '/api/v3/qualityprofile';
    
    const response = await this.fetcher(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profilePayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to ${method} quality profile: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    
    return {
      success: true,
      profile: result,
      action: existingProfile ? 'updated' : 'created',
    };
  }
}