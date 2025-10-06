import type { FastifyPluginCallback } from "fastify";
import { calendarRoutes } from "./dashboard/calendar-routes.js";
import { historyRoutes } from "./dashboard/history-routes.js";
import { queueRoutes } from "./dashboard/queue-routes.js";
import { statisticsRoutes } from "./dashboard/statistics-routes.js";

/**
 * Dashboard routes aggregator
 * Registers all dashboard-related route modules
 */
const dashboardRoute: FastifyPluginCallback = (app, _opts, done) => {
	// Register all dashboard route modules
	app.register(queueRoutes);
	app.register(historyRoutes);
	app.register(calendarRoutes);
	app.register(statisticsRoutes);

	done();
};

export const registerDashboardRoutes = dashboardRoute;
