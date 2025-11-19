# Phase 1 Critical Gaps Implementation Plan

**Date**: 2025-11-18
**Status**: 🔄 IN PROGRESS

## Overview

Phase 1 critical gaps involve properly handling and displaying mandatory vs optional custom formats, implementing CF group required logic, and improving the score override UX.

## Current State Analysis

### Data Flow
1. **Backend API** (`quality-profile-routes.ts:116-240`):
   - Returns `mandatoryCFs` array (from profile.formatItems)
   - Returns `cfGroups` array (optional CF groups)
   - Each CF group has:
     - `defaultEnabled: boolean` (from `default: "true"`)
     - `custom_formats` array with:
       - `required: boolean` - CF must be enabled with group
       - `defaultChecked: boolean` - CF pre-checked when group enabled
       - `score: number` - TRaSH Guides score (can be 0)
       - `source: "group"` - Marks as optional

2. **Frontend Component** (`cf-configuration.tsx:145-184`):
   - Initializes selections from `mandatoryCFs` (always selected)
   - Processes `cfGroups` with logic:
     - `isGroupDefault = group.defaultEnabled === true`
     - Auto-selects CFs if `isGroupDefault && (isCFRequired || isCFDefault)`

### Issues Identified

1. **❌ No CF Group Required Logic**
   - Groups don't have `required: true` flag handling
   - Example: "Unwanted" group should be required (cannot be disabled)
   - Currently all groups are optional

2. **❌ Mandatory CF Display Confusion**
   - Mandatory CFs mixed with optional CFs visually
   - No clear distinction that mandatory CFs cannot be toggled
   - Users might think they can disable mandatory CFs

3. **❌ Required CFs in Groups Not Enforced**
   - Individual CFs with `required: true` can still be toggled
   - Should be locked when group is enabled
   - Current code skips them in `selectAllInGroup`/`deselectAllInGroup` but doesn't lock UI

4. **❌ Zero-Score CF Handling**
   - CFs with score 0 look like missing data
   - Should clearly show "0" or "Neutral" instead of blank
   - Important for transparency

5. **❌ Score Override UX Issues**
   - No visual indication when score is overridden
   - Hard to distinguish default score from custom score
   - No reset to default option

## Implementation Tasks

### Task 1: Add CF Group Required Flag Support ✅

**Files**:
- `packages/shared/src/types/trash-guides.ts`
- `apps/api/src/routes/trash-guides/quality-profile-routes.ts`

**Changes**:
1. Add `required?: boolean` to `TrashCustomFormatGroup` interface
2. Backend: Pass through `required` flag from TRaSH data
3. Backend: Set `required: true` for groups that should be mandatory

**Implementation**:
```typescript
// types/trash-guides.ts
export interface TrashCustomFormatGroup {
    trash_id: string;
    name: string;
    trash_description?: string;
    default?: string | boolean;
    required?: boolean; // NEW: If true, group cannot be disabled
    custom_formats: Array<GroupCustomFormat | string>;
    quality_profiles?: {
        exclude?: Record<string, string>;
        score?: number;
    };
}

// quality-profile-routes.ts
return {
    ...group,
    custom_formats: enrichedCFs,
    defaultEnabled: group.default === "true",
    required: group.required === true, // NEW: Pass through required flag
};
```

---

### Task 2: Improve Mandatory CF Visual Distinction ✅

**Files**:
- `apps/web/src/features/trash-guides/components/wizard-steps/cf-configuration.tsx`

**Changes**:
1. Add "Mandatory" badge/indicator to mandatory CFs
2. Disable toggle for mandatory CFs (visual + functional)
3. Add tooltip explaining why CF is mandatory
4. Separate section header styling

**Implementation**:
```tsx
{/* Mandatory CFs Section */}
<div className="space-y-3">
    <div className="flex items-center gap-3 border-b border-border pb-2">
        <h3 className="text-sm font-semibold text-fg">
            Mandatory Custom Formats
        </h3>
        <span className="rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
            {mandatoryCFs.length} required
        </span>
    </div>

    <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
            These custom formats are required by the quality profile and cannot be disabled.
        </AlertDescription>
    </Alert>

    {mandatoryCFs.map((cf) => (
        <Card key={cf.trash_id} className="opacity-90">
            {/* Disabled checkbox with locked icon */}
            <input
                type="checkbox"
                checked={true}
                disabled
                className="cursor-not-allowed opacity-60"
            />
            <Lock className="h-3 w-3 text-fg-muted" />
            <span className="text-xs font-medium text-primary">MANDATORY</span>
        </Card>
    ))}
</div>
```

---

### Task 3: Implement Required CF Group Logic ✅

**Files**:
- `apps/web/src/features/trash-guides/components/wizard-steps/cf-configuration.tsx`

**Changes**:
1. Detect CF groups with `required: true`
2. Disable group toggle for required groups
3. Show lock icon and tooltip
4. Keep required groups always expanded
5. Enforce individual CF `required: true` within groups

**Implementation**:
```tsx
const isGroupRequired = group.required === true;

{/* CF Group Card */}
<Card className={isGroupRequired ? "border-primary/30" : ""}>
    <CardHeader>
        <div className="flex items-center gap-3">
            <input
                type="checkbox"
                checked={isGroupSelected}
                disabled={isGroupRequired}
                onChange={() => isGroupRequired ? null : toggleGroup(group.trash_id)}
                className={isGroupRequired ? "cursor-not-allowed opacity-60" : ""}
            />

            {isGroupRequired && (
                <>
                    <Lock className="h-4 w-4 text-primary" />
                    <span className="rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
                        REQUIRED
                    </span>
                </>
            )}

            <h3>{group.name}</h3>
        </div>
    </CardHeader>

    {/* Individual CFs */}
    {group.custom_formats.map((cf) => {
        const isCFRequired = cf.required === true;
        const isCFLocked = isCFRequired && isGroupSelected;

        return (
            <div key={cf.trash_id}>
                <input
                    type="checkbox"
                    checked={selections[cf.trash_id]?.selected || false}
                    disabled={isCFLocked}
                    onChange={() => !isCFLocked && toggleCF(cf.trash_id)}
                />
                {isCFRequired && <Lock className="h-3 w-3" />}
            </div>
        );
    })}
</Card>
```

---

### Task 4: Improve Zero-Score CF Display ✅

**Files**:
- `apps/web/src/features/trash-guides/components/wizard-steps/cf-configuration.tsx`

**Changes**:
1. Show "0" explicitly for zero-score CFs
2. Add "Neutral" label or indicator
3. Color code: positive (green), negative (red), zero (gray)
4. Tooltip explaining zero scores

**Implementation**:
```tsx
const formatScore = (score: number | undefined) => {
    if (score === undefined) return "-";
    if (score === 0) return (
        <span className="text-fg-muted">
            0 <span className="text-xs">(neutral)</span>
        </span>
    );

    const color = score > 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
    const sign = score > 0 ? "+" : "";

    return <span className={color}>{sign}{score}</span>;
};

{/* CF Score Display */}
<div className="flex items-center gap-2">
    <span className="text-xs font-medium">Score:</span>
    {formatScore(cf.score)}
</div>
```

---

### Task 5: Enhance Score Override UX ✅

**Files**:
- `apps/web/src/features/trash-guides/components/wizard-steps/cf-configuration.tsx`

**Changes**:
1. Show default score vs override clearly
2. Add "Reset to default" button when overridden
3. Visual indicator (icon/color) when score is custom
4. Validation for score range (-10000 to 10000)

**Implementation**:
```tsx
const hasOverride = selections[cf.trash_id]?.scoreOverride !== undefined;
const displayScore = hasOverride
    ? selections[cf.trash_id].scoreOverride
    : cf.score;

{/* Score Override Input */}
<div className="flex items-center gap-2">
    <label className="text-xs text-fg-muted">
        Score:
        {!hasOverride && <span className="ml-1">(default: {cf.score})</span>}
    </label>

    <input
        type="number"
        value={displayScore}
        onChange={(e) => updateScore(cf.trash_id, e.target.value)}
        min={-10000}
        max={10000}
        className={`w-20 ${hasOverride ? "border-primary ring-1 ring-primary/20" : ""}`}
    />

    {hasOverride && (
        <>
            <Edit className="h-3 w-3 text-primary" title="Custom score" />
            <button
                type="button"
                onClick={() => resetScore(cf.trash_id)}
                className="text-xs text-fg-muted hover:text-primary"
                title="Reset to default"
            >
                <RotateCcw className="h-3 w-3" />
            </button>
        </>
    )}
</div>

// New function
const resetScore = (cfTrashId: string) => {
    setSelections((prev) => ({
        ...prev,
        [cfTrashId]: {
            selected: prev[cfTrashId]?.selected || false,
            scoreOverride: undefined, // Clear override
            conditionsEnabled: prev[cfTrashId]?.conditionsEnabled || {},
        },
    }));
};
```

---

## Testing Checklist

### Manual Testing

- [ ] **Mandatory CFs**:
  - [ ] Mandatory CFs clearly labeled and locked
  - [ ] Cannot toggle mandatory CFs
  - [ ] Tooltip explains why CF is mandatory

- [ ] **Required CF Groups**:
  - [ ] Required groups show lock icon and label
  - [ ] Cannot toggle required groups
  - [ ] Required groups always expanded

- [ ] **Individual Required CFs**:
  - [ ] CFs with `required: true` locked when group enabled
  - [ ] Can toggle non-required CFs in group normally
  - [ ] Lock icon shows for required CFs

- [ ] **Zero-Score CFs**:
  - [ ] Zero scores show "0 (neutral)" clearly
  - [ ] Not confused with missing data
  - [ ] Tooltip explains neutral scoring

- [ ] **Score Override**:
  - [ ] Clear distinction between default and override
  - [ ] Reset button appears when overridden
  - [ ] Reset button restores default score
  - [ ] Validation prevents invalid scores
  - [ ] Visual indicator (color/icon) for overrides

### TypeScript Compilation
- [ ] `pnpm --filter @arr/web typecheck` passes
- [ ] No new type errors introduced

### Functional Testing
- [ ] Can create template with required groups
- [ ] Cannot disable required groups
- [ ] Score overrides save correctly
- [ ] Reset scores work properly
- [ ] Zero-score CFs handled correctly

---

## Implementation Order

1. **✅ Task 1**: Add CF Group Required Flag Support (Backend)
2. **✅ Task 2**: Improve Mandatory CF Visual Distinction (Frontend)
3. **✅ Task 3**: Implement Required CF Group Logic (Frontend)
4. **✅ Task 4**: Improve Zero-Score CF Display (Frontend)
5. **✅ Task 5**: Enhance Score Override UX (Frontend)

---

## Success Criteria

- [ ] All required groups clearly marked and non-toggleable
- [ ] Mandatory CFs visually distinct and locked
- [ ] Individual required CFs enforced within groups
- [ ] Zero-score CFs clearly displayed as "0 (neutral)"
- [ ] Score overrides have clear UX with reset option
- [ ] No TypeScript errors
- [ ] All manual tests pass

---

## Next Steps After Completion

After Phase 1 critical gaps are addressed:
- **Step 4**: Enhance wizard UX and CF selection flow
  - 4-step wizard with progress indicator
  - CF Group selection screen (quick setup)
  - Browse all CFs view
  - Improved mobile responsiveness
