import "fastify";
import type { PrismaClient, User } from "@prisma/client";
import type { ApiEnv } from "../config/env";
import type { Encryptor } from "../utils/encryption";
import type { SessionService } from "../utils/session";

declare module "fastify" {
  interface FastifyInstance {
    config: ApiEnv;
    prisma: PrismaClient;
    encryptor: Encryptor;
    sessionService: SessionService;
  }

  interface FastifyRequest {
    currentUser: User | null;
    sessionToken: string | null;
  }
}
