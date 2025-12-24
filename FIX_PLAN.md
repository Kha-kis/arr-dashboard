# Release 2.7.0 Fix Plan

Generated from comprehensive code review by 4 specialized agents.

---

## Phase 1: Critical Error Handling Fixes

### 1.1 Add Error Logging to executeOnInstances
**File:** `apps/api/src/lib/arr/client-helpers.ts`
**Lines:** 154-170
**Priority:** CRITICAL

**Current Code:**
```typescript
} catch (error) {
    if (!continueOnError) {
        throw error;
    }

    const statusCode = error instanceof ArrError ? arrErrorToHttpStatus(error) : 500;
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    return {
        // ... error result without logging
    };
}
```

**Fix:** Add structured logging before returning error result:
```typescript
} catch (error) {
    if (!continueOnError) {
        throw error;
    }

    const statusCode = error instanceof ArrError ? arrErrorToHttpStatus(error) : 500;
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // ADD: Log error for debugging
    app.log.error(
        {
            err: error,
            instanceId: instance.id,
            instanceName: instance.label,
            service,
        },
        "Instance operation failed"
    );

    return {
        instanceId: instance.id,
        instanceName: instance.label,
        service,
        success: false,
        error: errorMessage,
        statusCode,
    };
}
```

---

### 1.2 Add WebSocket Error Handler Logging
**File:** `apps/web/src/hooks/api/useRealtimeEvents.ts`
**Lines:** 222-224
**Priority:** CRITICAL

**Current Code:**
```typescript
ws.onerror = () => {
    // Errors during unmount are expected - onclose handles reconnection
};
```

**Fix:**
```typescript
ws.onerror = (event) => {
    // Log error for debugging - onclose handles reconnection
    console.warn("[WebSocket] Connection error occurred:", event);
};
```

---

### 1.3 Add WebSocket Creation Error Logging
**File:** `apps/web/src/hooks/api/useRealtimeEvents.ts`
**Lines:** 263-274
**Priority:** HIGH

**Current Code:**
```typescript
} catch {
    // WebSocket creation can fail during HMR or unmount - retry silently
    // Retry after delay
    ...
}
```

**Fix:**
```typescript
} catch (error) {
    // Log WebSocket creation failure for debugging
    console.warn("[WebSocket] Failed to create connection:", error);

    // Limit retry attempts to prevent infinite loops
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        console.error("[WebSocket] Max reconnection attempts reached, giving up");
        return;
    }
    // ... existing retry logic
}
```

---

### 1.4 Fix Statistics Route Assertion Pattern
**File:** `apps/api/src/routes/dashboard/statistics-routes.ts`
**Line:** ~43
**Priority:** HIGH

**Current Code:**
```typescript
const instances = await app.prisma.serviceInstance.findMany({
    where: { enabled: true, userId: request.currentUser?.id },
});
```

**Fix:** Use non-null assertion since preHandler guarantees auth:
```typescript
const instances = await app.prisma.serviceInstance.findMany({
    where: { enabled: true, userId: request.currentUser!.id },
});
```

---

## Phase 2: Silent Failure Fixes

### 2.1 Add Prowlarr Indexer Fetch Logging
**File:** `apps/api/src/lib/search/prowlarr-api.ts`
**Lines:** 131-150
**Priority:** HIGH

**Current Code:**
```typescript
} catch {
    return null;
}
```

**Fix:**
```typescript
} catch (error) {
    console.warn(`[Prowlarr] Failed to fetch indexer details for ID ${indexerId}:`, error);
    return null;
}
```

---

### 2.2 Add Library Cache Parse Error Logging
**File:** `apps/api/src/routes/library/fetch-routes.ts`
**Lines:** 185-206
**Priority:** HIGH

**Current Code:**
```typescript
try {
    return JSON.parse(item.data) as LibraryItem;
} catch {
    // Fallback if JSON parsing fails
    return { ... } as LibraryItem;
}
```

**Fix:**
```typescript
try {
    return JSON.parse(item.data) as LibraryItem;
} catch (parseError) {
    request.log.warn(
        { err: parseError, itemId: item.id, arrItemId: item.arrItemId },
        "Failed to parse cached library item - returning minimal fallback"
    );
    return { ... } as LibraryItem;
}
```

---

### 2.3 Add Sync Engine Profile Fetch Error Logging
**File:** `apps/api/src/lib/trash-guides/sync-engine.ts`
**Lines:** 221-229
**Priority:** MEDIUM

**Current Code:**
```typescript
} catch (profileError) {
    warnings.push(
        "Could not fetch quality profiles from instance. Profile validation will be skipped.",
    );
}
```

**Fix:**
```typescript
} catch (profileError) {
    console.warn(
        `[SyncEngine] Failed to fetch quality profiles from instance ${instance.label}:`,
        profileError
    );
    warnings.push(
        "Could not fetch quality profiles from instance. Profile validation will be skipped.",
    );
}
```

---

### 2.4 Improve Discover Add Route Error Messages
**File:** `apps/api/src/routes/discover/add-routes.ts`
**Lines:** 163-170
**Priority:** MEDIUM

**Current Code:**
```typescript
return reply.send({ message: "Failed to add title" });
```

**Fix:**
```typescript
return reply.send({
    message: "Failed to add title",
    error: error instanceof Error ? error.message : undefined
});
```

---

## Phase 3: Type Safety Improvements

### 3.1 Validate WebSocket Messages with Zod
**File:** `apps/web/src/hooks/api/useRealtimeEvents.ts`
**Line:** ~184
**Priority:** HIGH

**Current Code:**
```typescript
const data = JSON.parse(event.data) as SSEEvent;
```

**Fix:**
```typescript
import { sseEventSchema } from "@arr/shared";

// In the message handler:
const parseResult = sseEventSchema.safeParse(JSON.parse(event.data));
if (!parseResult.success) {
    console.warn("[WebSocket] Invalid message received:", parseResult.error);
    return;
}
const data = parseResult.data;
```

---

### 3.2 Add yearMin/yearMax Cross-Validation
**File:** `packages/shared/src/types/library.ts`
**Priority:** MEDIUM

**Fix:** Add Zod refine for year range validation:
```typescript
export const libraryFiltersSchema = z.object({
    // ... existing fields
    yearMin: z.number().optional(),
    yearMax: z.number().optional(),
}).refine(
    (data) => {
        if (data.yearMin !== undefined && data.yearMax !== undefined) {
            return data.yearMin <= data.yearMax;
        }
        return true;
    },
    { message: "yearMin must be less than or equal to yearMax" }
);
```

---

### 3.3 Replace eventType string with enum
**File:** `packages/shared/src/types/events.ts`
**Priority:** MEDIUM

**Current Code:**
```typescript
eventType: z.string(),
```

**Fix:**
```typescript
export const arrEventTypes = z.enum([
    "Grab",
    "Download",
    "Rename",
    "SeriesAdd",
    "SeriesDelete",
    "MovieAdd",
    "MovieDelete",
    "EpisodeFileDelete",
    "MovieFileDelete",
    "Health",
    "HealthRestored",
    "ApplicationUpdate",
    "Test"
]);

// In DashboardUpdateEventSchema:
eventType: arrEventTypes,
```

---

## Phase 4: Test Coverage (Critical)

### 4.1 Add ArrClientFactory Tests
**File:** `apps/api/src/lib/arr/__tests__/client-factory.test.ts` (NEW)
**Priority:** CRITICAL

**Tests to add:**
- `create()` returns SonarrClient for SONARR service
- `create()` returns RadarrClient for RADARR service
- `create()` returns ProwlarrClient for PROWLARR service
- `createSonarrClient()` throws for non-SONARR instance
- API key decryption is called with correct parameters
- Error callback is attached to client config
- Default timeout is applied

---

### 4.2 Add SyncEngine Validate Tests
**File:** `apps/api/src/lib/trash-guides/__tests__/sync-engine.test.ts` (NEW)
**Priority:** CRITICAL

**Tests to add:**
- Returns error when template not found
- Returns error when instance not found
- Returns error when service type mismatch
- Returns error when no quality profile mappings
- Returns error for auto-sync with user modifications
- Returns warning for manual sync with user modifications
- Validates instance connectivity
- Validates cache freshness

---

### 4.3 Add getClientForInstance Auth Tests
**File:** `apps/api/src/lib/arr/__tests__/client-helpers.test.ts`
**Priority:** CRITICAL

**Tests to add:**
```typescript
describe("getClientForInstance - authentication", () => {
    it("returns 401 when request.currentUser is undefined", async () => {
        const request = { currentUser: undefined } as FastifyRequest;
        const reply = createMockReply();

        const result = await getClientForInstance(app, request, reply, instanceId);

        expect(reply.status).toHaveBeenCalledWith(401);
        expect(result).toBeNull();
    });

    it("returns 404 when instance belongs to different user", async () => {
        // ... test cross-user access prevention
    });

    it("returns 404 when instance is disabled", async () => {
        // ... test disabled instance access
    });
});
```

---

## Phase 5: Additional Test Coverage

### 5.1 Add ResponseCache Tests
**File:** `apps/api/src/lib/cache/__tests__/response-cache.test.ts` (NEW)
**Priority:** MEDIUM

**Tests to add:**
- get() returns undefined for expired entries
- set() with custom TTL works correctly
- invalidatePrefix() removes matching entries
- cleanup() removes only expired entries

---

### 5.2 Add EventBroadcaster Tests
**File:** `apps/api/src/lib/events/__tests__/event-broadcaster.test.ts` (NEW)
**Priority:** MEDIUM

**Tests to add:**
- registerClient() adds client to correct user
- removeClient() removes client correctly
- broadcast() sends to all clients for user
- broadcast() does NOT send to other users (security)

---

## Execution Order

1. **Phase 1** - Critical error handling (4 fixes)
2. **Phase 2** - Silent failure fixes (4 fixes)
3. **Phase 3** - Type safety improvements (3 fixes)
4. **Phase 4** - Critical test coverage (3 test files)
5. **Phase 5** - Additional test coverage (2 test files)

**Estimated files to modify:** 12
**Estimated new files:** 5
**Estimated total changes:** ~500 lines

---

## Verification Checklist

After all fixes:
- [ ] `pnpm run lint` passes
- [ ] `pnpm run build` passes
- [ ] `pnpm run test` passes
- [ ] Manual testing of sync validation
- [ ] Manual testing of WebSocket reconnection
