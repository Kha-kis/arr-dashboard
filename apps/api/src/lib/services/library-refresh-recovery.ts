import type { FastifyInstance } from "fastify";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";
import {
	getProviderCacheRefreshClaimOrder,
	type ProviderCacheRefreshAttempt,
} from "./provider-cache-status.js";
import type { ProviderPublicationAuthority } from "./provider-identity-guard.js";

export type LibraryRefreshRecoveryProvider = "plex" | "jellyfin";

export type LibraryRefreshRecoveryRequest = {
	provider: LibraryRefreshRecoveryProvider;
	userId: string;
	instanceId: string;
	attempt: ProviderCacheRefreshAttempt;
	authority: ProviderPublicationAuthority;
	/** Present only when this settled producer published canonical data. */
	publishedAt?: Date;
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
	admit(request: LibraryRefreshRecoveryRequest): boolean;
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
	const latestAttempts = new Map<string, { attempt: ProviderCacheRefreshAttempt; order: bigint }>();

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
			if (
				request.authority.id !== request.instanceId ||
				request.authority.userId !== request.userId
			)
				return false;
			const order = getProviderCacheRefreshClaimOrder(
				request.attempt,
				request.provider,
				request.authority,
			);
			if (order === undefined) return false;
			const key = attemptKey(request),
				latest = latestAttempts.get(key);
			if (
				latest &&
				(order < latest.order || (order === latest.order && latest.attempt !== request.attempt))
			)
				return false;
			latestAttempts.set(key, { attempt: request.attempt, order });
			return true;
		},
		async arm(request) {
			const authority = request.authority;
			if (
				!authority ||
				authority.id !== request.instanceId ||
				authority.userId !== request.userId ||
				!authority.enabled ||
				authority.identityStatus !== "VERIFIED" ||
				!authority.expectedIdentity?.trim() ||
				(request.provider === "plex"
					? authority.service !== "PLEX"
					: authority.service !== "JELLYFIN" && authority.service !== "EMBY")
			)
				return { status: "ineligible" };
			const order = getProviderCacheRefreshClaimOrder(request.attempt, request.provider, authority);
			const latest = latestAttempts.get(attemptKey(request));
			if (order === undefined || latest?.attempt !== request.attempt || latest.order !== order) {
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

export function libraryRefreshPublishedAt(value: unknown): Date | undefined {
	if (!isRecord(value) || value.superseded === true) return undefined;
	return value.completedAt instanceof Date && Number.isFinite(value.completedAt.getTime())
		? value.completedAt
		: undefined;
}

function attemptKey(request: LibraryRefreshRecoveryRequest): string {
	return `${request.provider}:${request.userId}:${request.instanceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
