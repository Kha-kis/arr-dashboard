# Hunting Feature Design

Automated discovery of missing content and quality upgrades across Sonarr/Radarr instances.

## Overview

The hunting feature automates the "Search Missing" and "Search Cutoff Unmet" functionality that exists in Sonarr/Radarr but isn't automated by default. It systematically searches for:

1. **Missing Content** - Episodes/movies marked as missing and monitored
2. **Quality Upgrades** - Content below quality cutoff that could be upgraded

## Key Design Decisions

- **Single Admin Feature** - Not per-user, applies globally to all instances
- **Auto-Start** - If hunting is enabled, it automatically starts on server boot
- **Dedicated Sidebar Section** - Own navigation area, not buried in settings
- **Activity Log** - Required, shows what was found and searched
- **Exclusions** - Users can exclude specific series/movies from hunting

## Data Model

### New Prisma Models

```prisma
/// Hunt configuration per service instance (admin-only, not per-user)
model HuntConfig {
  id                    String          @id @default(cuid())
  instanceId            String          @unique
  instance              ServiceInstance @relation(fields: [instanceId], references: [id], onDelete: Cascade)

  // Feature toggles
  huntMissingEnabled    Boolean         @default(false)
  huntUpgradesEnabled   Boolean         @default(false)

  // Missing content settings
  missingBatchSize      Int             @default(5)      // Items per cycle
  missingIntervalMins   Int             @default(60)     // Minutes between cycles

  // Upgrade settings
  upgradeBatchSize      Int             @default(3)      // Items per cycle
  upgradeIntervalMins   Int             @default(120)    // Minutes between cycles

  // Rate limiting
  hourlyApiCap          Int             @default(100)    // Max API calls per hour
  queueThreshold        Int             @default(25)     // Pause if queue exceeds this

  // State
  lastMissingHunt       DateTime?
  lastUpgradeHunt       DateTime?
  apiCallsThisHour      Int             @default(0)
  apiCallsResetAt       DateTime?

  createdAt             DateTime        @default(now())
  updatedAt             DateTime        @updatedAt

  // Relations
  exclusions            HuntExclusion[]
}

/// Exclusions - series/movies to skip during hunting
model HuntExclusion {
  id            String      @id @default(cuid())
  configId      String
  config        HuntConfig  @relation(fields: [configId], references: [id], onDelete: Cascade)

  // What to exclude
  mediaType     String      // "series" | "movie"
  mediaId       Int         // Sonarr series ID or Radarr movie ID
  title         String      // For display purposes

  // Why excluded (optional)
  reason        String?

  createdAt     DateTime    @default(now())

  @@unique([configId, mediaType, mediaId])
  @@index([configId])
}

/// Log of hunt activity
model HuntLog {
  id            String          @id @default(cuid())
  instanceId    String
  instance      ServiceInstance @relation(fields: [instanceId], references: [id], onDelete: Cascade)

  huntType      String          // "missing" | "upgrade"
  itemsSearched Int             @default(0)
  itemsFound    Int             @default(0)

  // Details of what was searched (JSON arrays)
  searchedItems String?         // JSON: [{ id, title, type }]
  foundItems    String?         // JSON: [{ id, title, type, quality? }]

  status        String          // "completed" | "partial" | "skipped" | "error"
  message       String?         // Error message or skip reason

  startedAt     DateTime        @default(now())
  completedAt   DateTime?

  @@index([instanceId, huntType, startedAt])
  @@index([startedAt])  // For global log queries
}
```

### Relation to ServiceInstance

```prisma
model ServiceInstance {
  // ... existing fields ...

  huntConfig    HuntConfig?
  huntLogs      HuntLog[]
}
```

## API Endpoints

### Hunt Configuration

```
GET    /api/hunting/config                    # Get all hunt configs for user
GET    /api/hunting/config/:instanceId        # Get config for specific instance
PUT    /api/hunting/config/:instanceId        # Update hunt config
POST   /api/hunting/config/:instanceId/reset  # Reset API call counter
```

### Hunt Control

```
POST   /api/hunting/trigger/:instanceId       # Manually trigger hunt
POST   /api/hunting/trigger/:instanceId/missing   # Trigger missing hunt only
POST   /api/hunting/trigger/:instanceId/upgrades  # Trigger upgrade hunt only
POST   /api/hunting/pause/:instanceId         # Pause hunting for instance
POST   /api/hunting/resume/:instanceId        # Resume hunting for instance
```

### Hunt Status & History

```
GET    /api/hunting/status                    # Global hunt status (all instances)
GET    /api/hunting/status/:instanceId        # Hunt status for specific instance
GET    /api/hunting/logs                      # Recent hunt logs (paginated)
GET    /api/hunting/logs/:instanceId          # Logs for specific instance
GET    /api/hunting/stats                     # Aggregate statistics
```

## Background Job Architecture

### Option A: In-Process Scheduler (Recommended for MVP)

Use `node-cron` or `node-schedule` within the API process:

```typescript
// apps/api/src/lib/hunting/scheduler.ts

import cron from 'node-cron';

export class HuntScheduler {
  private jobs: Map<string, cron.ScheduledTask> = new Map();

  async initialize(app: FastifyInstance) {
    // Run check every minute
    cron.schedule('* * * * *', () => this.checkAndExecuteHunts(app));

    // Reset hourly API counters
    cron.schedule('0 * * * *', () => this.resetHourlyCounters(app));
  }

  private async checkAndExecuteHunts(app: FastifyInstance) {
    const configs = await app.prisma.huntConfig.findMany({
      where: {
        OR: [
          { huntMissingEnabled: true },
          { huntUpgradesEnabled: true }
        ]
      },
      include: { instance: true }
    });

    for (const config of configs) {
      await this.processInstance(app, config);
    }
  }

  private async processInstance(app: FastifyInstance, config: HuntConfig) {
    // Check queue threshold
    const queueSize = await this.getQueueSize(app, config.instance);
    if (queueSize >= config.queueThreshold) {
      return; // Skip - queue too full
    }

    // Check API cap
    if (config.apiCallsThisHour >= config.hourlyApiCap) {
      return; // Skip - API cap reached
    }

    // Check if it's time for missing hunt
    if (config.huntMissingEnabled && this.isDue(config.lastMissingHunt, config.missingIntervalMins)) {
      await this.executeMissingHunt(app, config);
    }

    // Check if it's time for upgrade hunt
    if (config.huntUpgradesEnabled && this.isDue(config.lastUpgradeHunt, config.upgradeIntervalMins)) {
      await this.executeUpgradeHunt(app, config);
    }
  }
}
```

### Option B: Separate Worker Process (For Scale)

For larger deployments, use BullMQ with Redis:

```typescript
// Separate worker process
import { Worker, Queue } from 'bullmq';

const huntQueue = new Queue('hunting');

// Schedule recurring jobs
await huntQueue.add('check-hunts', {}, {
  repeat: { every: 60000 } // Every minute
});
```

## Hunt Execution Logic

### Missing Content Hunt (Sonarr)

```typescript
async function huntMissingSonarr(client: SonarrClient, batchSize: number) {
  // 1. Get all series with missing episodes
  const series = await client.series.getAll();

  // 2. Filter to monitored series with missing episodes
  const withMissing = series.filter(s =>
    s.monitored &&
    s.statistics?.episodeFileCount < s.statistics?.episodeCount
  );

  // 3. Shuffle and take batch
  const batch = shuffle(withMissing).slice(0, batchSize);

  // 4. Trigger search for each
  const results = [];
  for (const s of batch) {
    await client.command.seriesSearch({ seriesId: s.id });
    results.push(s.id);
  }

  return results;
}
```

### Missing Content Hunt (Radarr)

```typescript
async function huntMissingRadarr(client: RadarrClient, batchSize: number) {
  // 1. Get all movies
  const movies = await client.movie.getAll();

  // 2. Filter to monitored, missing, and released
  const missing = movies.filter(m =>
    m.monitored &&
    !m.hasFile &&
    m.status === 'released'
  );

  // 3. Shuffle and take batch
  const batch = shuffle(missing).slice(0, batchSize);

  // 4. Trigger search for each
  const results = [];
  for (const m of batch) {
    await client.command.moviesSearch({ movieIds: [m.id] });
    results.push(m.id);
  }

  return results;
}
```

### Upgrade Hunt

```typescript
async function huntUpgradesSonarr(client: SonarrClient, batchSize: number) {
  // 1. Get cutoff unmet episodes
  const cutoffUnmet = await client.wanted.getCutoffUnmet({
    pageSize: 100,
    sortKey: 'airDateUtc',
    sortDirection: 'descending'
  });

  // 2. Shuffle and take batch
  const batch = shuffle(cutoffUnmet.records).slice(0, batchSize);

  // 3. Trigger search for each episode
  const results = [];
  for (const episode of batch) {
    await client.command.episodeSearch({ episodeIds: [episode.id] });
    results.push(episode.id);
  }

  return results;
}
```

## UI Design

### Sidebar Navigation

Add "Hunting" as a dedicated sidebar section (like Dashboard, Library, etc.):

```
┌──────────────┐
│ 🏠 Dashboard │
│ 📚 Library   │
│ 🔍 Search    │
│ 🎬 Discover  │
│ 📊 Stats     │
│ ────────────│
│ 🎯 Hunting   │  ← New section
│ ────────────│
│ ⚙️  Settings  │
└──────────────┘
```

### Hunting Routes

```
/hunting              # Overview/status page (default)
/hunting/activity     # Activity log with found items
/hunting/config       # Instance configuration
/hunting/exclusions   # Manage exclusions
```

### Page 1: Hunting Overview (`/hunting`)

Main status dashboard for hunting:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🎯 Hunting                                                       │
├─────────────────────────────────────────────────────────────────┤
│ [Overview] [Activity] [Config] [Exclusions]                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ ┌─────────────────────────┐  ┌─────────────────────────┐        │
│ │ 📊 Today's Stats        │  │ ⏱️  Next Scheduled       │        │
│ │                         │  │                         │        │
│ │ Searches: 45            │  │ Sonarr Main: 3 mins     │        │
│ │ Found: 12 items         │  │ Radarr 4K: 18 mins      │        │
│ │ Skipped: 3 (queue full) │  │ Radarr Main: 45 mins    │        │
│ │ Errors: 1               │  │                         │        │
│ └─────────────────────────┘  └─────────────────────────┘        │
│                                                                  │
│ Instance Status                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🟢 Sonarr - Main     │ Missing ✓  Upgrade ✓ │ 23/100 API   │ │
│ │    Last: 5 mins ago  │ Queue: 8/25          │ [Trigger ▶]  │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ 🟢 Radarr - 4K       │ Missing ✓  Upgrade ○ │ 15/100 API   │ │
│ │    Last: 12 mins ago │ Queue: 3/25          │ [Trigger ▶]  │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ 🟡 Radarr - Main     │ Missing ✓  Upgrade ✓ │ Paused       │ │
│ │    Queue threshold exceeded (28/25)         │ [Resume ▶]   │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ ⚪ Sonarr - Anime    │ Hunting disabled      │ [Enable]     │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ Recent Activity (last 5)                          [View All →]  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🟢 12:45 │ Sonarr Main │ Found: Breaking Bad S02E05 (1080p) │ │
│ │ 🟢 12:45 │ Sonarr Main │ Found: The Office S04E12 (720p)    │ │
│ │ 🟢 12:30 │ Radarr 4K   │ Searched 3 movies, 0 found         │ │
│ │ 🟡 12:15 │ Sonarr Main │ Skipped - queue full               │ │
│ │ 🟢 12:00 │ Sonarr Main │ Found: House M.D. S03E08 (1080p)   │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Page 2: Activity Log (`/hunting/activity`)

Detailed log of all hunt activity with found items:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🎯 Hunting > Activity                                            │
├─────────────────────────────────────────────────────────────────┤
│ [Overview] [Activity] [Config] [Exclusions]                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Filters: [All Instances ▼] [All Types ▼] [Found Only ○] [24h ▼]│
│                                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🟢 Today 12:45 PM │ Sonarr Main │ Missing Hunt              │ │
│ │                                                             │ │
│ │ Searched 5 series:                                          │ │
│ │   • Breaking Bad ────────────────── ✅ Found S02E05 (1080p) │ │
│ │   • The Office ──────────────────── ✅ Found S04E12 (720p)  │ │
│ │   • Better Call Saul ────────────── ○ No results            │ │
│ │   • Parks and Recreation ────────── ○ No results            │ │
│ │   • The Wire ────────────────────── ○ No results            │ │
│ │                                                             │ │
│ │ Duration: 12s │ API calls: 5                                │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🟢 Today 12:30 PM │ Radarr 4K │ Upgrade Hunt                │ │
│ │                                                             │ │
│ │ Searched 3 movies:                                          │ │
│ │   • Inception (2010) ────────────── ○ No upgrade available  │ │
│ │   • The Dark Knight (2008) ──────── ○ No upgrade available  │ │
│ │   • Interstellar (2014) ─────────── ○ No upgrade available  │ │
│ │                                                             │ │
│ │ Duration: 8s │ API calls: 3                                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🟡 Today 12:15 PM │ Sonarr Main │ Missing Hunt │ SKIPPED    │ │
│ │                                                             │ │
│ │ Reason: Queue threshold exceeded (28/25 items)              │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│                        [Load More]                              │
└─────────────────────────────────────────────────────────────────┘
```

### Page 3: Configuration (`/hunting/config`)

Per-instance hunt settings:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🎯 Hunting > Configuration                                       │
├─────────────────────────────────────────────────────────────────┤
│ [Overview] [Activity] [Config] [Exclusions]                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📺 Sonarr - Main                                [Enabled ●] │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │                                                             │ │
│ │ Hunt Missing Episodes                                       │ │
│ │ [✓] Enabled                                                 │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │ Batch Size    [5    ▼] series per cycle                 │ │ │
│ │ │ Interval      [60   ▼] minutes between cycles           │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ Hunt Quality Upgrades                                       │ │
│ │ [✓] Enabled                                                 │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │ Batch Size    [3    ▼] episodes per cycle               │ │ │
│ │ │ Interval      [120  ▼] minutes between cycles           │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ Rate Limiting                                               │ │
│ │ ┌─────────────────────────────────────────────────────────┐ │ │
│ │ │ Hourly API Cap     [100  ] max calls per hour           │ │ │
│ │ │ Queue Threshold    [25   ] pause if queue exceeds       │ │ │
│ │ └─────────────────────────────────────────────────────────┘ │ │
│ │                                                             │ │
│ │ Exclusions: 3 series excluded                [Manage →]     │ │
│ │                                                             │ │
│ │                              [Save Changes]                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🎬 Radarr - 4K                               [Disabled ○]   │ │
│ │ Click to configure hunting for this instance                │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Page 4: Exclusions (`/hunting/exclusions`)

Manage excluded series/movies:

```
┌─────────────────────────────────────────────────────────────────┐
│ 🎯 Hunting > Exclusions                                          │
├─────────────────────────────────────────────────────────────────┤
│ [Overview] [Activity] [Config] [Exclusions]                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Excluded items will be skipped during hunting.                  │
│                                                                  │
│ Filter: [All Instances ▼] [Series ○ Movies ○ All ●]            │
│                                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 📺 Series                                                   │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ Breaking Bad          │ Sonarr Main │ Complete     │ [🗑️]   │ │
│ │ Game of Thrones       │ Sonarr Main │ Quality OK   │ [🗑️]   │ │
│ │ The Simpsons          │ Sonarr Main │ Too many eps │ [🗑️]   │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🎬 Movies                                                   │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ Avatar (2009)         │ Radarr 4K   │ Waiting 4K   │ [🗑️]   │ │
│ │ Tenet (2020)          │ Radarr Main │ Quality OK   │ [🗑️]   │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ + Add Exclusion                                             │ │
│ │                                                             │ │
│ │ Instance: [Sonarr Main ▼]                                   │ │
│ │ Search:   [_________________________] 🔍                    │ │
│ │                                                             │ │
│ │ Results:                                                    │ │
│ │   ○ The Office (2005) - 201 episodes                        │ │
│ │   ○ The Office (UK) (2001) - 14 episodes                    │ │
│ │                                                             │ │
│ │ Reason:   [_________________________] (optional)            │ │
│ │                                                             │ │
│ │                                   [Add Exclusion]           │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Foundation
- [ ] Add Prisma models (HuntConfig, HuntLog, HuntExclusion)
- [ ] Create database migration
- [ ] Add sidebar navigation entry for Hunting
- [ ] Create hunt configuration API endpoints
- [ ] Basic in-process scheduler with node-cron (auto-start on boot if enabled)
- [ ] Missing content hunt for Sonarr/Radarr
- [ ] Hunting overview page (`/hunting`)

### Phase 2: Core Features
- [ ] Quality upgrade hunting
- [ ] Activity log page (`/hunting/activity`)
- [ ] Configuration page (`/hunting/config`)
- [ ] Manual trigger buttons
- [ ] API rate limiting enforcement
- [ ] Queue threshold checking

### Phase 3: Exclusions & Polish
- [ ] Exclusions model and API
- [ ] Exclusions page (`/hunting/exclusions`)
- [ ] Search within instance for adding exclusions
- [ ] Statistics cards on overview page
- [ ] "Next scheduled" countdown display

### Phase 4: Future Enhancements (Optional)
- [ ] Browser notifications when items found
- [ ] Webhook notifications
- [ ] Priority hunting (some series more frequently)
- [ ] Export activity logs
- [ ] BullMQ for scale (if needed)

## File Structure

```
apps/
├── api/
│   └── src/
│       ├── lib/
│       │   └── hunting/
│       │       ├── scheduler.ts      # Cron-based hunt scheduler
│       │       ├── executor.ts       # Hunt execution logic
│       │       └── index.ts
│       └── routes/
│           └── hunting.ts            # Hunt API routes
└── web/
    ├── app/
    │   └── hunting/
    │       ├── page.tsx              # Overview (redirect or main)
    │       ├── layout.tsx            # Hunting layout with tabs
    │       ├── activity/
    │       │   └── page.tsx          # Activity log
    │       ├── config/
    │       │   └── page.tsx          # Configuration
    │       └── exclusions/
    │           └── page.tsx          # Exclusions management
    └── src/
        ├── features/
        │   └── hunting/
        │       ├── components/
        │       │   ├── hunting-overview.tsx
        │       │   ├── hunting-activity.tsx
        │       │   ├── hunting-config.tsx
        │       │   ├── hunting-exclusions.tsx
        │       │   ├── instance-status-card.tsx
        │       │   └── activity-log-entry.tsx
        │       └── hooks/
        │           ├── useHuntingStatus.ts
        │           ├── useHuntingConfig.ts
        │           ├── useHuntingLogs.ts
        │           └── useHuntingExclusions.ts
        └── hooks/
            └── api/
                └── useHunting.ts     # React Query hooks
```

## Dependencies

```json
{
  "node-cron": "^3.0.3"  // For scheduling
}
```

No Redis required for MVP - can add BullMQ later for scale.
