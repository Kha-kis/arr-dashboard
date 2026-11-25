import { Agent, buildConnector } from "undici";
import { dockerIPv6ApiSocket, localSocketTarget } from "../../docker-socket-target.cjs";

let apiDispatcher: { authority: string; hostname: string; agent: Agent } | undefined;

/** Preserve the configured origin for HTTP and the verified zone for TCP. */
export function fetchInternalApi(input: string | URL, options?: RequestInit): Promise<Response> {
	const socket = dockerIPv6ApiSocket(process.env.ARR_INTERNAL_API_SOCKET, process.env.API_HOST);
	if (!socket) return fetch(input, options);
	const url = new URL(input);
	if (url.origin !== socket.origin.origin || url.username || url.password)
		throw new Error("Unexpected internal API origin");

	const authority = socket.origin.host;
	if (apiDispatcher?.authority !== authority || apiDispatcher?.hostname !== socket.hostname) {
		const connect = buildConnector({});
		const agent = new Agent({
			connect(params, done) {
				const address = params.hostname.replace(/^\[|\]$/g, "");
				if (
					params.protocol !== "http:" ||
					(params.port || "80") !== socket.port ||
					address !== socket.origin.hostname.slice(1, -1)
				) {
					done(new Error("Unexpected internal API connection"), null);
					return;
				}
				try {
					connect({ ...params, hostname: localSocketTarget(socket.hostname) }, done);
				} catch (error) {
					done(error instanceof Error ? error : new Error("Invalid internal API socket"), null);
				}
			},
		});
		void apiDispatcher?.agent.destroy();
		apiDispatcher = { authority, hostname: socket.hostname, agent };
	}
	const request = { ...options, dispatcher: apiDispatcher.agent };
	return fetch(url, request);
}
