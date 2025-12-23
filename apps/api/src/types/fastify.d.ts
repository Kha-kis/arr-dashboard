import "fastify";
import type { PrismaClient, User } from "@prisma/client";
import type { ApiEnv } from "../config/env";
import type { Encryptor } from "../lib/auth/encryption";
import type { SessionService } from "../lib/auth/session";
import type { ArrClientFactory } from "../lib/arr/client-factory";

declare module "fastify" {
	interface FastifyInstance {
		config: ApiEnv;
		prisma: PrismaClient;
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
