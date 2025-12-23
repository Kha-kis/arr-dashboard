/**
 * Event Broadcaster
 *
 * Manages real-time connections (WebSocket and SSE) and broadcasts updates
 * to connected frontend clients. Used to notify the dashboard when background
 * operations affect different features (queue, history, calendar, library).
 *
 * Supports both WebSocket (preferred) and SSE (legacy fallback) clients.
 */

import { EventEmitter } from "node:events";
import type { FastifyReply } from "fastify";
import type { WebSocket } from "ws";

/**
 * Dashboard features that can receive real-time updates
 */
export type DashboardFeature = "library" | "queue" | "history" | "calendar" | "statistics";

/**
 * Event payload sent to clients
 */
export interface DashboardUpdateEvent {
	type: "dashboard-update";
	features: DashboardFeature[];
	instanceId: string;
	instanceName: string;
	service: "sonarr" | "radarr";
	eventType: string;
	timestamp: string;
}

/**
 * Connection event sent when client connects
 */
export interface ConnectionEvent {
	type: "connected";
	clientId: string;
	timestamp: string;
}

/**
 * Heartbeat event to keep connections alive
 */
export interface HeartbeatEvent {
	type: "heartbeat";
	timestamp: string;
}

export type BroadcastEvent = DashboardUpdateEvent | ConnectionEvent | HeartbeatEvent;

/**
 * Client connection types
 */
type ClientType = "websocket" | "sse";

interface BaseClient {
	type: ClientType;
	userId: string;
}

interface WebSocketClient extends BaseClient {
	type: "websocket";
	socket: WebSocket;
}

interface SSEClient extends BaseClient {
	type: "sse";
	reply: FastifyReply;
}

type ConnectedClient = WebSocketClient | SSEClient;

/**
 * Broadcasts dashboard update events to connected clients.
 * Supports both WebSocket and SSE connections.
 * Singleton pattern - use getInstance() to get the broadcaster.
 */
export class EventBroadcaster extends EventEmitter {
	private static instance: EventBroadcaster | null = null;
	private clients: Map<string, ConnectedClient> = new Map();
	private clientIdCounter = 0;

	private constructor() {
		super();
	}

	static getInstance(): EventBroadcaster {
		if (!EventBroadcaster.instance) {
			EventBroadcaster.instance = new EventBroadcaster();
		}
		return EventBroadcaster.instance;
	}

	/**
	 * Add a new WebSocket client connection
	 */
	addWebSocketClient(socket: WebSocket, userId: string): string {
		const clientId = `ws_${++this.clientIdCounter}_${Date.now()}`;

		this.clients.set(clientId, { type: "websocket", socket, userId });

		// Send initial connection event
		this.sendToClient(clientId, {
			type: "connected",
			clientId,
			timestamp: new Date().toISOString(),
		});

		return clientId;
	}

	/**
	 * Add a new SSE client connection (legacy support)
	 */
	addSSEClient(reply: FastifyReply, userId: string): string {
		const clientId = `sse_${++this.clientIdCounter}_${Date.now()}`;

		this.clients.set(clientId, { type: "sse", reply, userId });

		// Send initial connection event
		this.sendToClient(clientId, {
			type: "connected",
			clientId,
			timestamp: new Date().toISOString(),
		});

		return clientId;
	}

	/**
	 * Remove a client connection
	 */
	removeClient(clientId: string): void {
		const client = this.clients.get(clientId);
		if (client) {
			// Close WebSocket if still open
			if (client.type === "websocket" && client.socket.readyState === 1) {
				try {
					client.socket.close(1000, "Connection closed by server");
				} catch {
					// Ignore close errors
				}
			}
			this.clients.delete(clientId);
		}
	}

	/**
	 * Get current client count
	 */
	getClientCount(): number {
		return this.clients.size;
	}

	/**
	 * Get client count by type
	 */
	getClientCountByType(): { websocket: number; sse: number } {
		let websocket = 0;
		let sse = 0;
		for (const client of this.clients.values()) {
			if (client.type === "websocket") websocket++;
			else sse++;
		}
		return { websocket, sse };
	}

	/**
	 * Broadcast a dashboard update event to all connected clients for a user
	 */
	broadcastUpdate(userId: string, event: DashboardUpdateEvent): void {
		for (const [clientId, client] of this.clients) {
			if (client.userId === userId) {
				this.sendToClient(clientId, event);
			}
		}
	}

	/**
	 * Broadcast to all clients (admin broadcast)
	 */
	broadcastToAll(event: DashboardUpdateEvent): void {
		for (const clientId of this.clients.keys()) {
			this.sendToClient(clientId, event);
		}
	}

	/**
	 * Send an event to a specific client
	 */
	private sendToClient(clientId: string, data: BroadcastEvent): void {
		const client = this.clients.get(clientId);
		if (!client) return;

		try {
			const message = JSON.stringify(data);

			if (client.type === "websocket") {
				// WebSocket: send JSON directly
				if (client.socket.readyState === 1) {
					// OPEN
					client.socket.send(message);
				} else {
					// Socket not open, remove client
					this.removeClient(clientId);
				}
			} else {
				// SSE format: "data: <json>\n\n"
				client.reply.raw.write(`data: ${message}\n\n`);
			}
		} catch {
			// Client disconnected, remove it
			this.removeClient(clientId);
		}
	}

	/**
	 * Send a heartbeat to all clients to keep connections alive
	 */
	sendHeartbeat(): void {
		const heartbeat: HeartbeatEvent = {
			type: "heartbeat",
			timestamp: new Date().toISOString(),
		};
		for (const clientId of this.clients.keys()) {
			this.sendToClient(clientId, heartbeat);
		}
	}

	/**
	 * Clean up disconnected clients
	 */
	cleanup(): void {
		for (const [clientId, client] of this.clients) {
			try {
				if (client.type === "websocket") {
					// Check if WebSocket is still open
					if (client.socket.readyState !== 1) {
						this.removeClient(clientId);
					}
				} else {
					// Check if SSE connection is still writable
					if (!client.reply.raw.writable) {
						this.removeClient(clientId);
					}
				}
			} catch {
				this.removeClient(clientId);
			}
		}
	}
}

// Export singleton getter
export const getEventBroadcaster = (): EventBroadcaster => EventBroadcaster.getInstance();

// Re-export types from shared package for convenience
export type { DashboardFeature } from "@arr/shared";
