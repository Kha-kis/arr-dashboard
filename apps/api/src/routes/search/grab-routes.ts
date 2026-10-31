import { searchGrabRequestSchema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { validateRequest } from "../../lib/utils/validate.js";
import { searchGrabServiceForRequest, sendSearchGrabError } from "./grab-status-routes.js";

/** Selector and durable intent are the only public submission authority. */
export const registerGrabRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.post("/search/grab", async (request, reply) => {
		let service: ReturnType<typeof searchGrabServiceForRequest>;
		try {
			service = searchGrabServiceForRequest(app, request);
		} catch (error) {
			return sendSearchGrabError(reply, error);
		}
		const payload = validateRequest(searchGrabRequestSchema, request.body ?? {});
		try {
			const status = await service.submit(payload);
			if (status.state === "acknowledged") return reply.code(204).send();
			if (status.state === "rejected")
				return reply.code(422).send({ message: "The recorded submission was rejected.", status });
			if (status.state === "uncertain")
				return reply.code(502).send({
					message:
						"Submission may have reached the download client. Inspect its recorded status before retrying.",
					status,
				});
			return reply.code(202).send({
				message: "Submission is not yet acknowledged. Observe its recorded status.",
				status,
			});
		} catch (error) {
			return sendSearchGrabError(reply, error);
		}
	});
	done();
};
