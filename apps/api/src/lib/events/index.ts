/**
 * Events Module
 *
 * Provides real-time event broadcasting via WebSocket (primary) and SSE (fallback).
 */

export {
	EventBroadcaster,
	getEventBroadcaster,
	type DashboardFeature,
	type DashboardUpdateEvent,
	type ConnectionEvent,
	type HeartbeatEvent,
	type BroadcastEvent,
} from "./event-broadcaster.js";

// Legacy aliases for backward compatibility
export {
	EventBroadcaster as SSEBroadcaster,
	getEventBroadcaster as getSSEBroadcaster,
} from "./event-broadcaster.js";
