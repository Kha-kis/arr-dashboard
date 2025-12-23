/**
 * Realtime Events Hook
 *
 * Subscribes to real-time events from the API via WebSocket and automatically
 * invalidates React Query caches when dashboard features are updated.
 *
 * Uses WebSocket (preferred) with SSE fallback for environments where
 * WebSocket is not available.
 */

import type { DashboardFeature, SSEEvent } from "@arr/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Maps dashboard features to their React Query keys for invalidation
 */
const FEATURE_QUERY_KEYS: Record<DashboardFeature, string[][]> = {
	library: [["library"]],
	queue: [["dashboard", "queue"]],
	history: [["dashboard", "history"]],
	calendar: [["dashboard", "calendar"]],
	statistics: [["dashboard", "statistics"]],
};

interface UseRealtimeEventsOptions {
	/** Whether realtime events are enabled (default: true) */
	enabled?: boolean;
	/** Callback when an event is received */
	onEvent?: (event: SSEEvent) => void;
	/** Callback when connection status changes */
	onConnectionChange?: (connected: boolean) => void;
}

interface RealtimeConnectionState {
	connected: boolean;
	clientId: string | null;
	lastEventTime: Date | null;
	reconnectAttempts: number;
	connectionType: "websocket" | "sse" | null;
}

/**
 * Get WebSocket URL for connection
 *
 * Strategy:
 * 1. In production with reverse proxy: Use same host (proxy handles WS upgrade)
 * 2. In development: Use direct API connection (Next.js dev server doesn't proxy WS)
 *
 * The NEXT_PUBLIC_WS_URL env var can override this for custom deployments.
 */
function getWebSocketUrl(): string {
	if (typeof window === "undefined") return "";

	// Allow override via environment variable
	const envWsUrl = process.env.NEXT_PUBLIC_WS_URL;
	if (envWsUrl) {
		return envWsUrl;
	}

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const host = window.location.host;

	// In development (localhost or 127.0.0.1 on port 3000), connect directly to API
	// In production, use same host (reverse proxy handles WebSocket)
	const isDev = host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
	const isPort3000 = host.endsWith(":3000");

	if (isDev && isPort3000) {
		return "ws://localhost:3001/api/events/ws";
	}

	return `${protocol}//${host}/api/events/ws`;
}

/**
 * Hook to subscribe to real-time events for dashboard updates.
 *
 * Automatically invalidates React Query caches when events
 * affect dashboard features.
 *
 * @example
 * ```tsx
 * // In a layout or provider component
 * useRealtimeEvents({
 *   onEvent: (event) => console.log('Event:', event),
 *   onConnectionChange: (connected) => console.log('Connected:', connected),
 * });
 * ```
 */
export function useRealtimeEvents(options: UseRealtimeEventsOptions = {}) {
	const { enabled = true, onEvent, onConnectionChange } = options;
	const queryClient = useQueryClient();
	const websocketRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const reconnectAttemptsRef = useRef(0);
	const mountedRef = useRef(true);
	const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);

	// Store callbacks in refs to avoid dependency issues
	const onEventRef = useRef(onEvent);
	const onConnectionChangeRef = useRef(onConnectionChange);

	// Update refs when callbacks change (without triggering reconnection)
	useEffect(() => {
		onEventRef.current = onEvent;
		onConnectionChangeRef.current = onConnectionChange;
	}, [onEvent, onConnectionChange]);

	const [state, setState] = useState<RealtimeConnectionState>({
		connected: false,
		clientId: null,
		lastEventTime: null,
		reconnectAttempts: 0,
		connectionType: null,
	});

	/**
	 * Invalidate query caches for affected features
	 */
	const invalidateFeatures = useCallback(
		(features: DashboardFeature[]) => {
			for (const feature of features) {
				const queryKeys = FEATURE_QUERY_KEYS[feature];
				if (queryKeys) {
					for (const queryKey of queryKeys) {
						void queryClient.invalidateQueries({ queryKey });
					}
				}
			}
		},
		[queryClient],
	);

	// Main connection effect
	useEffect(() => {
		mountedRef.current = true;

		if (!enabled) {
			return;
		}

		const connectWebSocket = () => {
			// Don't connect if already connected
			if (websocketRef.current?.readyState === WebSocket.OPEN) {
				return;
			}

			// Close existing connection if any
			if (websocketRef.current) {
				websocketRef.current.close();
				websocketRef.current = null;
			}

			// Clear any existing ping interval
			if (pingIntervalRef.current) {
				clearInterval(pingIntervalRef.current);
				pingIntervalRef.current = null;
			}

			const wsUrl = getWebSocketUrl();
			if (!wsUrl) return;

			try {
				const ws = new WebSocket(wsUrl);

				ws.onopen = () => {
					if (!mountedRef.current) return;

					reconnectAttemptsRef.current = 0;

					// Start ping interval to keep connection alive
					pingIntervalRef.current = setInterval(() => {
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(JSON.stringify({ type: "ping" }));
						}
					}, 25000); // Ping every 25 seconds
				};

				ws.onmessage = (event: MessageEvent<string>) => {
					if (!mountedRef.current) return;

					try {
						const data = JSON.parse(event.data) as SSEEvent;

						// Update last event time
						setState((prev) => ({
							...prev,
							lastEventTime: new Date(),
						}));

						// Handle event by type
						switch (data.type) {
							case "connected":
								setState((prev) => ({
									...prev,
									connected: true,
									clientId: data.clientId,
									reconnectAttempts: 0,
									connectionType: "websocket",
								}));
								onConnectionChangeRef.current?.(true);
								break;

							case "dashboard-update":
								// Invalidate queries for affected features
								invalidateFeatures(data.features);
								break;

							case "heartbeat":
							case "pong":
								// Just update timestamp, already handled above
								break;
						}

						onEventRef.current?.(data);
					} catch (error) {
						console.error("Failed to parse WebSocket message:", error);
					}
				};

				ws.onerror = () => {
					// Errors during unmount are expected - onclose handles reconnection
				};

				ws.onclose = (event) => {
					if (!mountedRef.current) return;

					// Clear ping interval
					if (pingIntervalRef.current) {
						clearInterval(pingIntervalRef.current);
						pingIntervalRef.current = null;
					}

					setState((prev) => ({
						...prev,
						connected: false,
						connectionType: null,
					}));
					onConnectionChangeRef.current?.(false);

					// Don't reconnect if closed normally (code 1000) or auth failed (4001)
					if (event.code === 1000 || event.code === 4001) {
						return;
					}

					// Auto-reconnect with exponential backoff
					const attempts = reconnectAttemptsRef.current;
					const delay = Math.min(1000 * 2 ** attempts, 30000); // Max 30s

					reconnectTimeoutRef.current = setTimeout(() => {
						if (!mountedRef.current) return;
						reconnectAttemptsRef.current += 1;
						setState((prev) => ({
							...prev,
							reconnectAttempts: reconnectAttemptsRef.current,
						}));
						connectWebSocket();
					}, delay);
				};

				websocketRef.current = ws;
			} catch {
				// WebSocket creation can fail during HMR or unmount - retry silently
				// Retry after delay
				const attempts = reconnectAttemptsRef.current;
				const delay = Math.min(1000 * 2 ** attempts, 30000);

				reconnectTimeoutRef.current = setTimeout(() => {
					if (!mountedRef.current) return;
					reconnectAttemptsRef.current += 1;
					connectWebSocket();
				}, delay);
			}
		};

		connectWebSocket();

		// Cleanup on unmount or when disabled
		return () => {
			mountedRef.current = false;

			if (pingIntervalRef.current) {
				clearInterval(pingIntervalRef.current);
				pingIntervalRef.current = null;
			}

			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
				reconnectTimeoutRef.current = null;
			}

			if (websocketRef.current) {
				websocketRef.current.close(1000, "Component unmounted");
				websocketRef.current = null;
			}

			reconnectAttemptsRef.current = 0;
		};
	}, [enabled, invalidateFeatures]);

	/**
	 * Manual disconnect function
	 */
	const disconnect = useCallback(() => {
		if (pingIntervalRef.current) {
			clearInterval(pingIntervalRef.current);
			pingIntervalRef.current = null;
		}

		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}

		if (websocketRef.current) {
			websocketRef.current.close(1000, "Manual disconnect");
			websocketRef.current = null;
		}

		reconnectAttemptsRef.current = 0;
		setState({
			connected: false,
			clientId: null,
			lastEventTime: null,
			reconnectAttempts: 0,
			connectionType: null,
		});
		onConnectionChangeRef.current?.(false);
	}, []);

	return {
		...state,
		disconnect,
	};
}
