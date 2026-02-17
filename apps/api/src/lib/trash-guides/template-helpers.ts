/**
 * Template ownership helpers for TRaSH Guides routes.
 *
 * Provides `requireTemplate()` — the template analogue of `requireInstance()`.
 */

import type { TrashTemplate } from "../../lib/prisma.js";
import type { PrismaClientInstance } from "../../lib/prisma.js";
import { TemplateNotFoundError } from "../errors.js";

/**
 * Verify that a trash template exists and is owned by the given user.
 * Throws {@link TemplateNotFoundError} if not found, which the centralized
 * error handler in server.ts maps to a 404 response.
 *
 * Note: Does NOT filter `deletedAt` — override and deployment routes
 * intentionally operate on soft-deleted templates.
 */
export async function requireTemplate(
	prisma: PrismaClientInstance,
	userId: string,
	templateId: string,
): Promise<TrashTemplate> {
	const template = await prisma.trashTemplate.findFirst({
		where: { id: templateId, userId },
	});

	if (!template) {
		throw new TemplateNotFoundError(templateId);
	}

	return template;
}
