/**
 * Events Routes
 *
 * Provides WebSocket (primary) and SSE (fallback) endpoints for real-time
 * dashboard updates. Frontend clients connect here to receive notifications
 * when library syncs or other background operations update dashboard data.
 */

import type { FastifyPluginCallback } from "fastify";
import { getEventBroadcaster } from "../lib/events/index.js";

// ============================================================================
// Routes
// ============================================================================

export const registerEventsRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Start heartbeat interval when first client connects
	let heartbeatInterval: NodeJS.Timeout | null = null;
	const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

	const startHeartbeat = () => {
		if (heartbeatInterval) return;
		const broadcaster = getEventBroadcaster();
		heartbeatInterval = setInterval(() => {
			broadcaster.sendHeartbeat();
			broadcaster.cleanup();
		}, HEARTBEAT_INTERVAL_MS);
	};

	const stopHeartbeat = () => {
		if (heartbeatInterval) {
			clearInterval(heartbeatInterval);
			heartbeatInterval = null;
		}
	};

	/**
	 * GET /events/ws
	 * WebSocket endpoint for real-time dashboard updates.
	 * Requires authentication via session cookie.
	 */
	app.get("/events/ws", { websocket: true }, (socket, request) => {
		// Require authentication
		if (!request.currentUser?.id) {
			socket.close(4001, "Authentication required");
			return;
		}

		const userId = request.currentUser.id;
		const broadcaster = getEventBroadcaster();

		// Add client to broadcaster
		const clientId = broadcaster.addWebSocketClient(socket, userId);
		startHeartbeat();

		app.log.info({ userId, clientId }, "WebSocket client connected");

		// Handle incoming messages (for future bidirectional features)
		socket.on("message", (message) => {
			try {
				const data = JSON.parse(message.toString());
				// Handle ping/pong for connection health
				if (data.type === "ping") {
					socket.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
				}
			} catch {
				// Ignore malformed messages
			}
		});

		// Handle client disconnect
		socket.on("close", () => {
			broadcaster.removeClient(clientId);
			app.log.info({ userId, clientId }, "WebSocket client disconnected");

			// Stop heartbeat if no more clients
			if (broadcaster.getClientCount() === 0) {
				stopHeartbeat();
			}
		});

		// Handle errors
		socket.on("error", (error) => {
			app.log.error({ userId, clientId, error }, "WebSocket error");
			broadcaster.removeClient(clientId);
		});
	});

	/**
	 * GET /events/stream
	 * SSE endpoint for real-time dashboard updates (legacy fallback).
	 * Requires authentication.
	 */
	app.get("/events/stream", (request, reply) => {
		// Require authentication
		if (!request.currentUser?.id) {
			return reply.status(401).send({ error: "Authentication required" });
		}

		const userId = request.currentUser.id;
		const broadcaster = getEventBroadcaster();

		// Set SSE headers - use hijack to take control of the socket
		reply.hijack();
		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no", // Disable nginx buffering
		});

		// Add client to broadcaster
		const clientId = broadcaster.addSSEClient(reply, userId);
		startHeartbeat();

		app.log.info({ userId, clientId }, "SSE client connected");

		// Handle client disconnect
		request.raw.on("close", () => {
			broadcaster.removeClient(clientId);
			app.log.info({ userId, clientId }, "SSE client disconnected");

			// Stop heartbeat if no more clients
			if (broadcaster.getClientCount() === 0) {
				stopHeartbeat();
			}
		});

		// Connection stays open until client disconnects
	});

	/**
	 * GET /events/status
	 * Get current connection status (for debugging)
	 */
	app.get("/events/status", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({ error: "Authentication required" });
		}

		const broadcaster = getEventBroadcaster();
		const counts = broadcaster.getClientCountByType();
		return {
			connectedClients: broadcaster.getClientCount(),
			websocketClients: counts.websocket,
			sseClients: counts.sse,
		};
	});

	done();
};

export default registerEventsRoutes;
