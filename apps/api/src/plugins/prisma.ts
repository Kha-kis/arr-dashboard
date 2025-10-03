import fp from "fastify-plugin";
import Prisma from "@prisma/client";

export const prismaPlugin = fp(async (app) => {
  const prisma = new Prisma.PrismaClient();

  await prisma.$connect();

  app.decorate("prisma", prisma);

  app.addHook("onClose", async (server) => {
    await server.prisma.$disconnect();
  });
});

export type PrismaPlugin = ReturnType<typeof prismaPlugin>;
