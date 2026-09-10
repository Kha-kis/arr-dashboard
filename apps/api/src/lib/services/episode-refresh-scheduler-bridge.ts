import type { FastifyInstance } from "fastify";

export type EpisodeRefreshProvider = "plex_episode" | "jellyfin_episode";

export interface EpisodeRefreshRetryRequest {
	userId: string;
	instanceId: string;
}

export type EpisodeRefreshRetryResult =
	| { status: "accepted"; backgroundTask?: Promise<void> }
	| { status: "ineligible" }
	| { status: "unavailable" };

type RetryHandler = (request: EpisodeRefreshRetryRequest) => Promise<EpisodeRefreshRetryResult>;

export interface EpisodeRefreshSchedulerBridge {
	register(provider: EpisodeRefreshProvider, handler: RetryHandler): () => void;
	retry(
		provider: EpisodeRefreshProvider,
		request: EpisodeRefreshRetryRequest,
	): Promise<EpisodeRefreshRetryResult>;
}

export type FastifyWithEpisodeRefreshScheduler = FastifyInstance & {
	episodeRefreshScheduler: EpisodeRefreshSchedulerBridge;
};

/**
 * Creates an app-scoped handoff point for manual episode retries.
 * Provider schedulers own the callbacks and their continuation state; the
 * bridge deliberately has no fallback work-item implementation.
 */
export function createEpisodeRefreshSchedulerBridge(): EpisodeRefreshSchedulerBridge {
	const handlers = new Map<EpisodeRefreshProvider, RetryHandler>();

	return {
		register(provider, handler) {
			if (handlers.has(provider)) {
				throw new Error(`Episode refresh scheduler already registered for ${provider}`);
			}
			handlers.set(provider, handler);
			return () => {
				if (handlers.get(provider) === handler) handlers.delete(provider);
			};
		},
		async retry(provider, request) {
			const handler = handlers.get(provider);
			if (!handler) return { status: "unavailable" };
			return handler(request);
		},
	};
}

export function ensureEpisodeRefreshScheduler(
	app: FastifyInstance,
): FastifyWithEpisodeRefreshScheduler {
	if (!app.hasDecorator("episodeRefreshScheduler")) {
		app.decorate("episodeRefreshScheduler", createEpisodeRefreshSchedulerBridge());
	}
	return app as FastifyWithEpisodeRefreshScheduler;
}
