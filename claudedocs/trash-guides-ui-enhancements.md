# TRaSH Guides UI Enhancements - Implementation Summary

## What We Implemented

### ✅ 1. CF Group Descriptions (Already Present)
**Location**: `cf-configuration.tsx` lines 825-837
- Shows TRaSH's guidance text for each CF group
- Displays in blue alert box with icon
- HTML content properly rendered

### ✅ 2. Language & Score Set Display - Template Creation Review
**Location**: `template-creation.tsx` lines 167-181
**What we added:**
- 🌐 Language badge (blue) - Shows the language that will be set (e.g., "Original")
- 📊 Score Set badge (purple) - Shows which score preset is active (e.g., "default", "sqp-1-1080p")
- 🎬 Cutoff badge (green) - Shows the quality cutoff setting

**Why it matters:** Users can see at a glance what language and scoring strategy their profile will use before deployment.

### ✅ 3. CF Specification Count & Naming Badge
**Location**: `cf-configuration.tsx` lines 874-883
**What we added:**
- 📝 "Affects Naming" badge (amber) - Shows when a CF will change file names via `includeCustomFormatWhenRenaming`
- Condition count badge (gray) - Shows how many conditions each CF has (e.g., "3 conditions")

**Why it matters:** 
- Users know which CFs will modify their file names
- Condition count gives insight into CF complexity

### ✅ 4. Language & Score Set - Template List View  
**Location**: `template-list.tsx` lines 308-326
**What we added:**
- Same badge system as template creation review
- Shows language, score set, and cutoff for each template in the list
- Compact badges that don't clutter the UI

**Why it matters:** Users can quickly identify which templates use which language and scoring strategies without opening them.

---

## What Was Already Implemented

### ✅ CF Group Descriptions
- TRaSH's guidance already displayed in blue alert boxes
- Properly rendered HTML content

### ✅ CF Scores  
- Already showing default scores next to each CF
- Score override functionality working

### ✅ "Recommended" Badge
- Already showing for recommended CF groups
- Lines 795-799 in cf-configuration.tsx

---

## Data Sources

All enhancements use data from `originalConfig` and the TRaSH Guides JSON:

1. **Language**: `qualityProfile.language` from TRaSH profile
2. **Score Set**: `qualityProfile.trash_score_set` from TRaSH profile  
3. **Cutoff**: `qualityProfile.cutoff` from TRaSH profile
4. **includeCustomFormatWhenRenaming**: `originalConfig.includeCustomFormatWhenRenaming`
5. **Specifications**: `originalConfig.specifications` array
6. **CF Group Descriptions**: `originalConfig.trash_description`

---

## Visual Design

### Badge Color Scheme
- 🌐 **Language** - Blue (`bg-blue-500/20 text-blue-300`)
- 📊 **Score Set** - Purple (`bg-purple-500/20 text-purple-300`)
- 🎬 **Cutoff** - Green (`bg-green-500/20 text-green-300`)
- 📝 **Affects Naming** - Amber (`bg-amber-500/20 text-amber-300`)
- 🔒 **Required** - Red (`bg-red-500/20 text-red-300`)
- ⚙️ **Optional** - Blue (`bg-blue-500/20 text-blue-300`)
- ✅ **Default** - Green (`bg-green-500/20 text-green-300`)
- 📘 **Recommended** - Amber (`bg-amber-500/20 text-amber-300`)

### Layout
- Badges use consistent spacing and sizing
- Flex-wrap ensures responsive layout
- Inline-flex for proper text alignment
- Small text sizes (text-xs) to avoid clutter

---

## User Benefits

### Before
- Users couldn't see what language would be set
- No indication of which score set was active
- Didn't know which CFs affect file naming
- No sense of CF complexity

### After
- Clear visibility of language settings (especially important for anime profiles)
- Score set clearly shown (critical for profiles with multiple presets)
- Warning about CFs that modify file names
- Quick assessment of CF complexity via condition count
- Better template comparison in list view

---

## Technical Notes

### No API Changes Required
All data was already available through:
- `QualityProfileSummary` type (already had language and scoreSet fields)
- `originalConfig` in template CFs and CF groups

### Type Safety
Using optional chaining (`?.`) throughout to handle:
- Templates without quality profiles
- Profiles without language/score set specified
- CFs without specifications

### Performance
- No additional API calls
- All data loaded with existing queries
- Minimal render impact (just conditional badges)

---

## Future Enhancement Opportunities

### Medium Priority
1. **Score Set Selector** - Allow users to choose score set during wizard (if profile has multiple)
2. **CF Group Score Recommendations** - Show `quality_profiles.score` recommendations
3. **Total Score Calculation** - Show potential max score in template stats

### Low Priority  
4. **Detailed Specification Types** - Show implementation types (e.g., "SourceSpecification")
5. **All Score Sets in Editor** - Show all available score presets with "Use This" buttons
6. **Profile Description in Wizard** - Display TRaSH's profile guidance at start

---

## Files Modified

1. **apps/web/src/features/trash-guides/components/wizard-steps/template-creation.tsx**
   - Lines 167-181: Added language, score set, and cutoff badges

2. **apps/web/src/features/trash-guides/components/wizard-steps/cf-configuration.tsx**
   - Lines 874-883: Added naming and specification count badges

3. **apps/web/src/features/trash-guides/components/template-list.tsx**
   - Lines 302-327: Added badge display in template list

---

## Testing Checklist

- [ ] Verify language badge shows "Original" for anime profiles
- [ ] Verify score set badge shows correct preset (e.g., "sqp-1-1080p")  
- [ ] Verify "Affects Naming" badge only shows when includeCustomFormatWhenRenaming is true
- [ ] Verify condition count shows correct number
- [ ] Verify badges display properly on mobile (flex-wrap working)
- [ ] Verify badges don't appear when data is missing (optional chaining working)
- [ ] Verify template list shows all badges compactly
