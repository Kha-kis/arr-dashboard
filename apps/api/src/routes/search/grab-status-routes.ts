import { searchGrabResultStatusRequestSchema } from "@arr/shared";
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { RestoreRuntimeAdmissionError } from "../../lib/backup/restore-runtime-admission.js";
import { SearchGrabRepositoryError } from "../../lib/search/grab-repository.js";
import { createSearchGrabService } from "../../lib/search/grab-service.js";
import { validateRequest } from "../../lib/utils/validate.js";

class SearchGrabAuthenticationError extends Error {
	constructor() {
		super("Authentication required");
	}
}
export function searchGrabServiceForRequest(app: FastifyInstance, request: FastifyRequest) {
	if (!request.currentUser) throw new SearchGrabAuthenticationError();
	return createSearchGrabService({
		prisma: app.prisma,
		runtime: app.restoreRuntime,
		encryptor: app.encryptor,
		arrClientFactory: app.arrClientFactory,
		userId: request.currentUser.id,
	});
}
/** Never forward provider, database, credential or selector diagnostics. */
export function sendSearchGrabError(reply: FastifyReply, error: unknown) {
	if (error instanceof SearchGrabAuthenticationError)
		return reply
			.code(401)
			.send({ message: "Authentication required", category: "authentication-required" });
	if (error instanceof SearchGrabRepositoryError)
		return reply.code(409).send({ message: error.message, category: error.category });
	return reply.code(error instanceof RestoreRuntimeAdmissionError ? 503 : 502).send({
		message: "Submission status is unavailable. Inspect its recorded status before retrying.",
		category: "status-unavailable",
	});
}
const intentParams = z.strictObject({ intentId: z.string().uuid() });
export const registerGrabStatusRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// POST carries sensitive selectors in the body; this handler is strictly read-only.
	app.post("/search/grab/results/status", async (request, reply) => {
		let service: ReturnType<typeof searchGrabServiceForRequest>;
		try {
			service = searchGrabServiceForRequest(app, request);
		} catch (error) {
			return sendSearchGrabError(reply, error);
		}
		const input = validateRequest(searchGrabResultStatusRequestSchema, request.body);
		try {
			return await service.resultStatuses(input);
		} catch (error) {
			return sendSearchGrabError(reply, error);
		}
	});
	app.get("/search/grab/intents/:intentId", async (request, reply) => {
		let service: ReturnType<typeof searchGrabServiceForRequest>;
		try {
			service = searchGrabServiceForRequest(app, request);
		} catch (error) {
			return sendSearchGrabError(reply, error);
		}
		const { intentId } = validateRequest(intentParams, request.params);
		try {
			const status = await service.status(intentId);
			return (
				status ??
				reply.code(404).send({
					message: "Recorded submission status is unavailable.",
					category: "status-unavailable",
				})
			);
		} catch (error) {
			return sendSearchGrabError(reply, error);
		}
	});
	done();
};
