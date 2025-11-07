# TRaSH Guides Template Versioning - Best Practices

## Executive Summary

**Recommendation**: Implement **Git-Style Versioning with Dirty Flag Tracking**

This approach provides:
- ✅ Full traceability to TRaSH Guides source
- ✅ Smart auto-sync for unmodified templates
- ✅ User control for customized templates
- ✅ Audit trail for troubleshooting
- ✅ Rollback capabilities
- ✅ Minimal storage overhead

---

## Why Version Tracking Matters

### The Problem
Without versioning, you face these challenges:

1. **Sync Ambiguity**: When TRaSH Guides updates, you can't determine:
   - Which version the template came from
   - What changed between then and now
   - Whether user customizations will be overwritten

2. **Troubleshooting Difficulty**: When issues arise:
   - Can't reproduce the exact TRaSH Guides configuration
   - No audit trail of changes
   - Unclear if issue is from TRaSH Guides or user customization

3. **User Confusion**: Users don't know:
   - If their template is up-to-date
   - Whether updates are safe to apply
   - What they customized vs what came from TRaSH Guides

---

## Recommended Approach: Git-Style Versioning

### Core Concept
Track templates similarly to how Git tracks file changes:
- **Commit Hash**: Exact TRaSH Guides version (GitHub commit SHA)
- **Dirty Flag**: Whether user has modified from source
- **Change Log**: What was modified and when

### Data Structure

```typescript
interface TemplateMetadata {
  // Source tracking - WHERE did this come from?
  trashGuidesSource: {
    commitHash: string;           // e.g., "a7f3c2b..."
    commitDate: string;           // e.g., "2024-01-15T10:30:00Z"
    sourceUrl: string;            // e.g., "https://github.com/TRaSH-Guides/Guides/..."
    qualityProfileName: string;   // e.g., "HD Bluray + WEB"
    serviceType: "RADARR" | "SONARR";
  };

  // Import tracking - WHEN was it created?
  lifecycle: {
    importedAt: string;           // ISO timestamp of creation
    lastEditedAt?: string;        // ISO timestamp of last user edit
    lastSyncedAt?: string;        // ISO timestamp of last TRaSH sync
    lastDeployedAt?: string;      // ISO timestamp of last deployment
  };

  // Customization tracking - WHAT changed?
  customization: {
    hasUserModifications: boolean;
    modifiedFields: Array<
      | "cf_selections"           // User added/removed CFs
      | "cf_scores"               // User overrode scores
      | "cf_conditions"           // User toggled conditions
      | "cf_groups"               // User changed group selections
      | "template_metadata"       // User changed name/description
    >;
    modificationSummary?: {
      cfsAdded: number;           // Count of CFs user added beyond default
      cfsRemoved: number;         // Count of CFs user removed from default
      scoresOverridden: number;   // Count of scores user customized
    };
  };

  // Sync strategy - HOW should updates work?
  syncSettings: {
    strategy: "auto" | "notify" | "manual";
    autoSyncEnabled: boolean;     // Derived from hasUserModifications
    notificationsEnabled: boolean;
  };

  // Audit trail - HISTORY of changes (optional, can be limited)
  changeLog?: Array<{
    timestamp: string;
    type: "import" | "edit" | "sync" | "deploy" | "rollback";
    actor: string;                // userId or "system"
    changes?: {
      before?: any;               // Snapshot before change
      after?: any;                // Snapshot after change
      diff?: string;              // Human-readable diff
    };
  }>;
}
```

---

## Sync Strategy Decision Tree

### On Template Creation
```
User imports Quality Profile
  ↓
Fetch current TRaSH Guides commit hash from GitHub API
  ↓
Store metadata:
  - commitHash: "a7f3c2b..."
  - commitDate: "2024-01-15T10:30:00Z"
  - importedAt: NOW
  - hasUserModifications: false (initially)
  - syncStrategy: "auto" (default for unmodified)
```

### On User Edit
```
User modifies template (score override, CF toggle, etc.)
  ↓
Update metadata:
  - hasUserModifications: true
  - modifiedFields: ["cf_scores"]
  - lastEditedAt: NOW
  - syncStrategy: "notify" (auto-switch from "auto")
  - modificationSummary: {scoresOverridden: 5}
  ↓
Add to change log:
  - type: "edit"
  - actor: userId
  - changes: {before: {scores: {...}}, after: {scores: {...}}}
```

### On Sync Check (Daily Background Job)
```
For each template:
  ↓
Fetch latest TRaSH Guides commit hash
  ↓
Compare with template.trashGuidesSource.commitHash
  ↓
  ┌─ Same commit hash? ────────────────┐
  │  → No updates available            │
  │  → Skip template                   │
  └────────────────────────────────────┘
  ↓
  ┌─ Different commit hash? ───────────┐
  │  → Updates available               │
  │  → Check hasUserModifications      │
  └────────────────────────────────────┘
  ↓
  ┌─ hasUserModifications = false? ────┐
  │  → Auto-sync (no user changes)     │
  │  → Update template silently        │
  │  → Update lastSyncedAt             │
  │  → Notify user: "Synced to latest" │
  └────────────────────────────────────┘
  ↓
  ┌─ hasUserModifications = true? ─────┐
  │  → Notify user of available update │
  │  → Show diff (what changed)        │
  │  → User chooses action:            │
  │    • Keep custom (no sync)         │
  │    • Sync (lose customizations)    │
  │    • Merge (smart combine)         │
  └────────────────────────────────────┘
```

---

## Sync Notification UI

### For Unmodified Templates (Auto-Synced)
```
┌─ Notification ──────────────────────────────────────────────┐
│                                                              │
│  ✅  Template "HD Bluray + WEB" updated automatically       │
│                                                              │
│  Synced to latest TRaSH Guides (commit a7f3c2b)             │
│  • 3 new custom formats added                               │
│  • 5 score adjustments applied                              │
│                                                              │
│  [View Changes] [Undo Sync]                                 │
└──────────────────────────────────────────────────────────────┘
```

### For Modified Templates (Requires User Action)
```
┌─ Update Available ──────────────────────────────────────────┐
│                                                              │
│  📢  TRaSH Guides update available for "HD Bluray + WEB"    │
│                                                              │
│  Your template has customizations and was NOT auto-updated. │
│                                                              │
│  TRaSH Guides Changes (commit a7f3c2b → e9d1f4a):           │
│  • HDR Formats group: +2 new formats                        │
│  • Unwanted group: Score changed for "LQ" (-10000 → -9999) │
│  • Streaming Services: Netflix CF updated                   │
│                                                              │
│  Your Customizations:                                        │
│  • 5 score overrides                                        │
│  • 3 CFs added beyond defaults                              │
│  • 2 CFs removed from defaults                              │
│                                                              │
│  ⚠️  Syncing will replace your customizations!              │
│                                                              │
│  [Keep My Custom] [View Full Diff] [Sync Anyway] [Merge]   │
└──────────────────────────────────────────────────────────────┘
```

---

## Diff View Implementation

### High-Level Diff Summary
```
┌─ TRaSH Guides Changes: HD Bluray + WEB ─────────────────────┐
│                                                              │
│ From: commit a7f3c2b (2024-01-15)                           │
│ To:   commit e9d1f4a (2024-02-20)                           │
│                                                              │
│ ━━ CUSTOM FORMATS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                              │
│ ➕ Added (3):                                                │
│    • DV HLG (Score: 500)                                    │
│    • HDR10+ BOOST (Score: 250)                              │
│    • BR-REMUX (Score: 2000)                                 │
│                                                              │
│ 📝 Modified (5):                                             │
│    • LQ (Score: -10000 → -9999)                             │
│    • DV HDR10+ (Score: 1100 → 1200)                         │
│    • Netflix (Conditions updated)                           │
│    • x265 (HD) (Description updated)                        │
│    • TrueHD ATMOS (Score: 500 → 750)                        │
│                                                              │
│ ➖ Removed (1):                                              │
│    • HDR (undefined) (Score: 500) - Deprecated              │
│                                                              │
│ ━━ CF GROUPS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                              │
│ ➕ Added (1):                                                │
│    • Audio Advanced (12 formats)                            │
│                                                              │
│ 📝 Modified (2):                                             │
│    • HDR Formats (+2 new CFs)                               │
│    • Unwanted (1 score change)                              │
│                                                              │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                              │
│ Impact on Your Template:                                    │
│ • 3 new CFs will be added                                   │
│ • 5 CFs scores will be updated                              │
│ • 1 deprecated CF will be removed                           │
│ • Your 5 custom score overrides will be LOST if you sync   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Detailed Side-by-Side Diff
```
┌─ Custom Format: DV HDR10+ ──────────────────────────────────┐
│                                                              │
│ ┌─ Your Template ──────────┐  ┌─ Latest TRaSH Guides ─────┐│
│ │ Name: DV HDR10+          │  │ Name: DV HDR10+           ││
│ │ Score: 1500 ⭐ custom    │  │ Score: 1200 (default)     ││
│ │                          │  │                           ││
│ │ Conditions: 3 enabled    │  │ Conditions: 3 enabled     ││
│ │ • Dolby Vision HDR10+    │  │ • Dolby Vision HDR10+     ││
│ │ • HDR10+ DV              │  │ • HDR10+ DV               ││
│ │ • DOVI HDR10PLUS         │  │ • DOVI HDR10PLUS          ││
│ └──────────────────────────┘  └───────────────────────────┘│
│                                                              │
│ Changes if you sync:                                        │
│ ❌ Your custom score (1500) will be lost                    │
│ ✅ Score will revert to TRaSH default (1200)                │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Merge Strategy (Advanced)

For power users who want to keep customizations while getting updates:

### Smart Merge Algorithm
```
For each CF in TRaSH Guides update:
  ↓
  ┌─ CF exists in user template? ──────────┐
  │  NO → Add new CF with default settings │
  └─────────────────────────────────────────┘
  ↓
  ┌─ CF exists in user template? ──────────┐
  │  YES → Compare fields:                 │
  │    • Score:                            │
  │      - User overrode? → Keep user      │
  │      - No override? → Use TRaSH new    │
  │    • Conditions:                       │
  │      - User modified? → Keep user      │
  │      - No changes? → Use TRaSH new     │
  │    • Description/Name:                 │
  │      - Always use TRaSH new            │
  └─────────────────────────────────────────┘
  ↓
Result: Template with user customizations preserved
        where possible, TRaSH updates applied elsewhere
```

### Merge Result Preview
```
┌─ Merge Preview: HD Bluray + WEB ────────────────────────────┐
│                                                              │
│ After merge, your template will have:                       │
│                                                              │
│ ✅ 3 new CFs from TRaSH Guides added                        │
│ ✅ 5 score overrides PRESERVED (your custom scores)         │
│ ✅ TRaSH score updates applied to non-overridden CFs        │
│ ✅ 1 deprecated CF removed                                  │
│ ✅ New CF group "Audio Advanced" added                      │
│                                                              │
│ Conflicts requiring your choice:                            │
│ ⚠️  DV HDR10+: You have score 1500, TRaSH updated to 1200   │
│    → Keep your 1500? [Keep Mine] [Use TRaSH 1200]           │
│                                                              │
│ ⚠️  LQ: TRaSH changed score -10000 → -9999                  │
│    → You have no override, apply new score? [Yes] [No]      │
│                                                              │
│ [Cancel] [Apply Merge]                                      │
└──────────────────────────────────────────────────────────────┘
```

---

## Rollback Capabilities

### Rollback to Previous State
```typescript
interface TemplateSnapshot {
  snapshotId: string;
  templateId: string;
  timestamp: string;
  reason: "pre_sync" | "pre_edit" | "pre_deploy" | "manual";

  // Full template state at this point
  snapshot: {
    config: TemplateConfig;
    metadata: TemplateMetadata;
  };
}

// Automatically create snapshots before:
// - Syncing with TRaSH Guides
// - Major user edits (bulk changes)
// - Deployments (optional)
```

### Rollback UI
```
┌─ Template History: HD Bluray + WEB ─────────────────────────┐
│                                                              │
│ Current State (modified)                                     │
│ └─ 2024-02-20 15:30 - Edited by user (5 score overrides)   │
│                                                              │
│ Snapshots:                                                   │
│ ├─ 2024-02-20 10:00 - Before sync to TRaSH commit e9d1f4a  │
│ │  [View] [Restore]                                         │
│ │                                                            │
│ ├─ 2024-01-25 14:20 - Before bulk edit (10 CFs modified)   │
│ │  [View] [Restore]                                         │
│ │                                                            │
│ └─ 2024-01-15 09:00 - Original import (TRaSH commit a7f3c2b)│
│    [View] [Restore to Original]                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Storage & Performance Considerations

### Storage Optimization
```typescript
// Efficient storage strategy
interface StorageStrategy {
  // Full snapshots - store complete state
  fullSnapshots: {
    frequency: "on_import" | "before_major_change";
    retention: "keep_last_5";
    compressionEnabled: true;
  };

  // Delta snapshots - store only changes
  deltaSnapshots: {
    frequency: "on_every_edit";
    retention: "keep_last_20";
    referenceSnapshot: "latest_full_snapshot";
  };

  // Change log entries
  changeLog: {
    detailLevel: "summary" | "full_diff";
    retention: "keep_all" | "keep_last_50";
    maxSizePerEntry: "10KB";
  };
}

// Example storage sizes
// - Full snapshot: ~50-100 KB per template
// - Delta snapshot: ~5-10 KB per edit
// - Change log entry: ~1-5 KB per entry
//
// For 100 templates with 5 snapshots each:
// Total: ~25-50 MB (very reasonable)
```

### Performance Optimization
```typescript
// Background job for sync checks
// Runs daily at low-traffic time (e.g., 3 AM server time)

async function checkTemplatesForUpdates() {
  const templates = await db.template.findMany({
    where: { syncSettings: { autoSyncEnabled: true } }
  });

  const latestCommitHash = await fetchLatestTRaSHCommit();

  const updates = [];
  for (const template of templates) {
    if (template.metadata.trashGuidesSource.commitHash !== latestCommitHash) {
      if (template.metadata.customization.hasUserModifications) {
        // Queue notification
        updates.push({ templateId: template.id, action: "notify" });
      } else {
        // Queue auto-sync
        updates.push({ templateId: template.id, action: "auto_sync" });
      }
    }
  }

  // Process in batches to avoid overwhelming system
  await processSyncUpdatesInBatches(updates, batchSize: 10);
}
```

---

## API Endpoints for Versioning

### Get Template Version Info
```typescript
GET /api/templates/:templateId/version

Response: {
  current: {
    commitHash: "a7f3c2b...",
    commitDate: "2024-01-15T10:30:00Z",
    importedAt: "2024-01-15T11:00:00Z",
    lastSyncedAt: null,
    hasUserModifications: true
  },
  latest: {
    commitHash: "e9d1f4a...",
    commitDate: "2024-02-20T08:00:00Z",
    updateAvailable: true
  },
  customizations: {
    scoresOverridden: 5,
    cfsAdded: 3,
    cfsRemoved: 2
  }
}
```

### Get Sync Diff
```typescript
GET /api/templates/:templateId/sync-diff

Response: {
  from: { commitHash: "a7f3c2b...", date: "2024-01-15" },
  to: { commitHash: "e9d1f4a...", date: "2024-02-20" },
  changes: {
    customFormats: {
      added: [{ name: "DV HLG", score: 500, ... }],
      modified: [{ name: "LQ", oldScore: -10000, newScore: -9999, ... }],
      removed: [{ name: "HDR (undefined)", ... }]
    },
    cfGroups: {
      added: [{ name: "Audio Advanced", cfCount: 12, ... }],
      modified: [{ name: "HDR Formats", changes: "+2 CFs", ... }]
    }
  },
  conflicts: [
    {
      cfName: "DV HDR10+",
      yourValue: { score: 1500 },
      trashValue: { score: 1200 },
      recommendation: "keep_custom"
    }
  ]
}
```

### Sync Template
```typescript
POST /api/templates/:templateId/sync

Body: {
  strategy: "auto" | "merge",
  conflictResolutions?: Record<string, "keep_custom" | "use_trash">
}

Response: {
  success: true,
  syncedTo: { commitHash: "e9d1f4a...", date: "2024-02-20" },
  changes: {
    cfsAdded: 3,
    cfsModified: 5,
    cfsRemoved: 1,
    scoresUpdated: 10
  },
  snapshotCreated: {
    snapshotId: "snap_abc123",
    reason: "pre_sync"
  }
}
```

### Rollback Template
```typescript
POST /api/templates/:templateId/rollback

Body: {
  snapshotId: "snap_abc123"
}

Response: {
  success: true,
  rolledBackTo: {
    timestamp: "2024-01-25T14:20:00Z",
    reason: "before_bulk_edit"
  },
  snapshotCreated: {
    snapshotId: "snap_def456",
    reason: "pre_rollback"
  }
}
```

---

## Best Practices Summary

### ✅ DO
1. **Always store commit hash** when importing from TRaSH Guides
2. **Track user modifications** with dirty flag and modified fields
3. **Auto-sync unmodified templates** to keep them current
4. **Notify users before syncing** modified templates
5. **Create snapshots before major changes** for rollback capability
6. **Show clear diffs** when updates are available
7. **Provide merge option** for power users
8. **Keep change log** for audit trail (with retention limits)
9. **Compress snapshots** to minimize storage
10. **Run sync checks as background jobs** to avoid blocking users

### ❌ DON'T
1. **Don't overwrite user customizations** without warning
2. **Don't store full history forever** (use retention policies)
3. **Don't sync in real-time** (use scheduled background jobs)
4. **Don't force auto-sync** on modified templates
5. **Don't skip snapshot creation** before destructive operations
6. **Don't show raw JSON diffs** to users (human-readable summaries)
7. **Don't block user actions** while checking for updates
8. **Don't version everything** (focus on meaningful changes)

---

## Migration Path for Existing Templates

If you already have templates without versioning:

```typescript
async function migrateExistingTemplates() {
  const templates = await db.template.findMany({
    where: { metadata: { trashGuidesSource: null } }
  });

  for (const template of templates) {
    // Try to infer TRaSH Guides source
    const inferredSource = await inferTRaSHSource(template);

    // Mark as user-modified (conservative approach)
    await db.template.update({
      where: { id: template.id },
      data: {
        metadata: {
          trashGuidesSource: inferredSource || {
            commitHash: "unknown",
            commitDate: template.createdAt,
            sourceUrl: null,
            qualityProfileName: "Unknown",
            serviceType: template.serviceType
          },
          lifecycle: {
            importedAt: template.createdAt,
            lastEditedAt: template.updatedAt
          },
          customization: {
            hasUserModifications: true,  // Conservative assumption
            modifiedFields: ["unknown"],
            modificationSummary: null
          },
          syncSettings: {
            strategy: "manual",  // Safe default
            autoSyncEnabled: false,
            notificationsEnabled: true
          }
        }
      }
    });
  }
}
```

---

## Conclusion

**Recommended Implementation**: Git-Style Versioning with Dirty Flag

This approach provides the optimal balance of:
- **Traceability**: Know exactly where templates came from
- **User Control**: Respect customizations, provide choices
- **Automation**: Auto-sync safe updates, notify for risky ones
- **Safety**: Snapshots and rollback for peace of mind
- **Efficiency**: Reasonable storage, background processing
- **Transparency**: Clear diffs and change summaries

**Start Simple, Enhance Later**:
1. **Phase 1**: Basic versioning (commit hash, dirty flag, auto-sync)
2. **Phase 2**: Add change log and snapshots
3. **Phase 3**: Implement merge strategy
4. **Phase 4**: Advanced features (detailed diffs, rollback UI)

This gives you a solid foundation while allowing incremental improvements based on user feedback and real-world usage patterns.
