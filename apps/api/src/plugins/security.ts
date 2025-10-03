import fp from "fastify-plugin";
import { Encryptor } from "../utils/encryption.js";
import { SessionService } from "../utils/session.js";

export const securityPlugin = fp(async (app) => {
  const encryptor = new Encryptor(app.config.ENCRYPTION_KEY);
  const sessionService = new SessionService(app.prisma, app.config);

  app.decorate("encryptor", encryptor);
  app.decorate("sessionService", sessionService);
});
