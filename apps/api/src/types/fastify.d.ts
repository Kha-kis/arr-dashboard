import "fastify";
import type { PrismaClientInstance, User } from "../lib/prisma.js";
import type { ApiEnv } from "../config/env";
import type { Encryptor } from "../lib/auth/encryption";
import type { SessionService } from "../lib/auth/session";
import type { ArrClientFactory } from "../lib/arr/client-factory";

declare module "fastify" {
	interface FastifyInstance {
		config: ApiEnv;
		prisma: PrismaClientInstance;
		encryptor: Encryptor;
		sessionService: SessionService;
		arrClientFactory: ArrClientFactory;
	}

	interface FastifyRequest {
		currentUser: User | null;
		sessionToken: string | null;
		userId?: string;
	}
}
