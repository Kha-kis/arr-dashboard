/**
 * Unified Automation Engine — composer read surface.
 *
 * GET /api/automation/rules returns every domain's stored rules normalized to
 * the v1 grammar (charter §5.1: "the API serves only v1"). This is the read
 * half of the Operator Console rule composer; authoring + cross-domain rules
 * land in later PRs.
 */

import type { AutomationRulesResponse } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { collectAutomationRules } from "../lib/automation/collect-rules.js";

export const registerAutomationRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/automation/rules", async (request) => {
		const userId = request.currentUser!.id;
		const rules = await collectAutomationRules(app.prisma, userId, request.log);
		return { rules } satisfies AutomationRulesResponse;
	});

	done();
};
