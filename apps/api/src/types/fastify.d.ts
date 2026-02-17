import "fastify";
import type { PrismaClientInstance, User } from "../lib/prisma.js";
import type { ApiEnv } from "../config/env";
import type { Encryptor } from "../lib/auth/encryption";
import type { SessionService } from "../lib/auth/session";
import type { ArrClientFactory } from "../lib/arr/client-factory";
import type { DeploymentExecutorService } from "../lib/trash-guides/deployment-executor";

/**
 * The subset of User fields available on request.currentUser.
 * Matches the `select` in SessionService.validateRequest().
 */
type SessionUser = Pick<User, "id" | "username" | "mustChangePassword" | "createdAt" | "updatedAt">;

declare module "fastify" {
	interface FastifyInstance {
		config: ApiEnv;
		prisma: PrismaClientInstance;
		dbProvider: "sqlite" | "postgresql";
		encryptor: Encryptor;
		sessionService: SessionService;
		arrClientFactory: ArrClientFactory;
		deploymentExecutor: DeploymentExecutorService;
	}

	interface FastifyRequest {
		currentUser: SessionUser | null;
		sessionToken: string | null;
		userId?: string;
	}
}
