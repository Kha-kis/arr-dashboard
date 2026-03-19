/**
 * Shared Zod schemas for Plex analytics routes.
 */

import { z } from "zod";

/** Query params for analytics endpoints: ?days=30 (1–90, default 30) */
export const analyticsQuery = z.object({
	days: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 30;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 30;
		}),
});
