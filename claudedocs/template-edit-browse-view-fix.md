# Template Edit Mode - Browse View Fix

## Issue
When editing templates, the "+ Add More Formats" browse view was empty. Users were unable to add additional custom formats to their templates.

## Root Cause
The `availableFormats` array was only populated from the template's stored CF Groups (`templateCFGroups`), which is a limited subset. This approach missed all the other custom formats available in TRaSH Guides.

## Solution
Modified `cf-configuration.tsx` (lines 81-101) to fetch ALL custom formats from the cache API:

```typescript
// Fetch all available custom formats from cache for browse view
const customFormatsRes = await apiRequest<any>(
    `/api/trash-guides/cache/entries?serviceType=${serviceType}&configType=CUSTOM_FORMATS`
);
const customFormatsCacheEntry = Array.isArray(customFormatsRes) ? customFormatsRes[0] : customFormatsRes;
const allCustomFormats = customFormatsCacheEntry?.data || [];

// Map all custom formats with proper score extraction
const availableFormats = allCustomFormats.map((cf: any) => {
    const trashScores = cf.trash_scores || {};
    const defaultScore = trashScores.default || 0;

    return {
        trash_id: cf.trash_id,
        name: cf.name,
        displayName: cf.name,
        description: cf.trash_description || '',
        score: defaultScore,
        originalConfig: cf, // Keep full config for future use
    };
});
```

## Key Changes
1. **Data Source**: Changed from extracting from `templateCFGroups.originalConfig.custom_formats` to fetching all CFs from cache API
2. **Score Extraction**: Properly extract TRaSH default scores from `trash_scores.default`
3. **Full Data Retention**: Store `originalConfig` for future enhancements
4. **Description Support**: Include `trash_description` for the "What is this?" expandable sections

## Benefits
- Users can now browse and select from ALL TRaSH Guides custom formats
- Scores display correctly showing TRaSH defaults
- Descriptions are available for each custom format
- Existing filter logic (line 690) prevents duplicate selection
- Search functionality works across all formats

## Testing
- Compilation successful with Next.js hot reload
- Browse view now populated with all custom formats
- Filter properly excludes already-selected formats
- Score display shows TRaSH default values

## Related Work
This completes the template edit mode data refactoring that included:
1. Using template's embedded `originalConfig` for current config display
2. Proper score extraction from `trash_scores.default`
3. Full custom format list for browse view (this fix)
