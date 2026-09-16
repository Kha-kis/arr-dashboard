import type { FastifyInstance } from "fastify";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";
import type { ProviderCacheRefreshAttempt } from "./provider-cache-status.js";

export type LibraryRefreshRecoveryProvider = "plex" | "jellyfin";

export type LibraryRefreshRecoveryRequest = {
	provider: LibraryRefreshRecoveryProvider;
	userId: string;
	instanceId: string;
	attempt: ProviderCacheRefreshAttempt;
};

export type LibraryRefreshRecoveryResult =
	| { status: "accepted" }
	| { status: "ineligible" }
	| { status: "unavailable" };

type RecoveryHandler = (
	request: LibraryRefreshRecoveryRequest,
) => Promise<LibraryRefreshRecoveryResult>;

export interface LibraryRefreshRecoveryBridge {
	register(provider: LibraryRefreshRecoveryProvider, handler: RecoveryHandler): () => void;
	admit(request: LibraryRefreshRecoveryRequest): void;
	arm(request: LibraryRefreshRecoveryRequest): Promise<LibraryRefreshRecoveryResult>;
}

export type LibraryRefreshRecoveryHandoff = Pick<LibraryRefreshRecoveryBridge, "admit" | "arm">;

export type FastifyWithLibraryRefreshRecovery = FastifyInstance & {
	libraryRefreshRecovery: LibraryRefreshRecoveryBridge;
};

/**
 * Provider cache schedulers own retry timers. This bridge only carries
 * claim-bound outcomes from request/Pulse background work to those schedulers.
 */
export function createLibraryRefreshRecoveryBridge(): LibraryRefreshRecoveryBridge {
	const handlers = new Map<LibraryRefreshRecoveryProvider, RecoveryHandler>();
	const latestAttempts = new Map<string, string>();

	return {
		register(provider, handler) {
			if (handlers.has(provider)) {
				throw new Error(`Library refresh recovery already registered for ${provider}`);
			}
			handlers.set(provider, handler);
			return () => {
				if (handlers.get(provider) === handler) handlers.delete(provider);
			};
		},
		admit(request) {
			latestAttempts.set(attemptKey(request), request.attempt.resultMarker);
		},
		async arm(request) {
			if (latestAttempts.get(attemptKey(request)) !== request.attempt.resultMarker) {
				return { status: "unavailable" };
			}
			const handler = handlers.get(request.provider);
			if (!handler) return { status: "unavailable" };
			return await handler(request);
		},
	};
}

export function ensureLibraryRefreshRecovery(
	app: FastifyInstance,
): FastifyWithLibraryRefreshRecovery {
	if (!app.hasDecorator("libraryRefreshRecovery")) {
		app.decorate("libraryRefreshRecovery", createLibraryRefreshRecoveryBridge());
	}
	return app as FastifyWithLibraryRefreshRecovery;
}

export function isRetryableLibraryRefreshResult(
	provider: LibraryRefreshRecoveryProvider,
	value: unknown,
	thrown = false,
): boolean {
	if (thrown || !isRecord(value)) return true;
	if (value.superseded === true || value.nativeInventoryStatus === "superseded") return false;
	if (value.nativeInventoryStatus === "failed") return true;
	if (provider === "jellyfin") {
		return value.complete !== true && value.errors !== 0;
	}
	const coverage = evaluateProviderCoverageReceipt(value.receipt);
	return value.complete !== true && (!coverage.valid || coverage.evidence === "unknown");
}

function attemptKey(request: LibraryRefreshRecoveryRequest): string {
	return `${request.provider}:${request.userId}:${request.instanceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
