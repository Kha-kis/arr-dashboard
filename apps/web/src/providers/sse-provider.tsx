"use client";

/**
 * Realtime Events Provider
 *
 * Connects to real-time events (via WebSocket) when the user is on authenticated routes.
 * Automatically invalidates React Query caches when dashboard features are updated.
 *
 * Note: Named SSEProvider for backward compatibility, but now uses WebSocket
 * which works reliably through the Next.js proxy.
 */

import { useRealtimeEvents } from "../hooks/api/useRealtimeEvents";

interface SSEProviderProps {
	readonly children: React.ReactNode;
}

/**
 * Provider component that establishes WebSocket connection for real-time updates.
 * Should be placed inside QueryClientProvider and only rendered on authenticated routes.
 */
export const SSEProvider = ({ children }: SSEProviderProps) => {
	useRealtimeEvents({ enabled: true });
	return <>{children}</>;
};
