import type { FastifyPluginCallback } from "fastify";
import { calendarRoutes } from "./dashboard/calendar-routes";
import { historyRoutes } from "./dashboard/history-routes";
import { queueRoutes } from "./dashboard/queue-routes";
import { statisticsRoutes } from "./dashboard/statistics-routes";

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
