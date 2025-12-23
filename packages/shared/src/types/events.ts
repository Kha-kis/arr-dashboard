/**
 * SSE Event Types
 *
 * Types for Server-Sent Events used for real-time dashboard updates.
 */

import { z } from "zod";

/**
 * Dashboard features that can receive real-time updates
 */
export const dashboardFeatureSchema = z.enum(["library", "queue", "history", "calendar", "statistics"]);
export type DashboardFeature = z.infer<typeof dashboardFeatureSchema>;

/**
 * Dashboard update event sent via SSE
 */
export const dashboardUpdateEventSchema = z.object({
	type: z.literal("dashboard-update"),
	features: z.array(dashboardFeatureSchema),
	instanceId: z.string(),
	instanceName: z.string(),
	service: z.enum(["sonarr", "radarr"]),
	eventType: z.string(),
	timestamp: z.string(),
});
export type DashboardUpdateEvent = z.infer<typeof dashboardUpdateEventSchema>;

/**
 * SSE connection event
 */
export const sseConnectedEventSchema = z.object({
	type: z.literal("connected"),
	clientId: z.string(),
	timestamp: z.string(),
});
export type SSEConnectedEvent = z.infer<typeof sseConnectedEventSchema>;

/**
 * SSE heartbeat event
 */
export const sseHeartbeatEventSchema = z.object({
	type: z.literal("heartbeat"),
	timestamp: z.string(),
});
export type SSEHeartbeatEvent = z.infer<typeof sseHeartbeatEventSchema>;

/**
 * WebSocket pong event (response to ping for keep-alive)
 */
export const wsPongEventSchema = z.object({
	type: z.literal("pong"),
	timestamp: z.string(),
});
export type WSPongEvent = z.infer<typeof wsPongEventSchema>;

/**
 * Union of all SSE/WebSocket event types
 */
export const sseEventSchema = z.discriminatedUnion("type", [
	dashboardUpdateEventSchema,
	sseConnectedEventSchema,
	sseHeartbeatEventSchema,
	wsPongEventSchema,
]);
export type SSEEvent = z.infer<typeof sseEventSchema>;
