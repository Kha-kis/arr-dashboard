import Prisma from "@prisma/client";
import fp from "fastify-plugin";

export const prismaPlugin = fp(async (app) => {
	const prisma = new Prisma.PrismaClient();

	await prisma.$connect();

	app.decorate("prisma", prisma);

	app.addHook("onClose", async (server) => {
		await server.prisma.$disconnect();
	});
}, {
	name: "prisma"
});

export type PrismaPlugin = ReturnType<typeof prismaPlugin>;
