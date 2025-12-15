/**
 * Seed Admin User Script
 *
 * Creates an initial admin user for development/testing purposes.
 *
 * Single-admin architecture: This application assumes a single administrator.
 * The User model has no role/isAdmin field - admin privileges are enforced
 * by convention: the first user created is treated as the administrator.
 * If multi-user support with roles is needed in the future, a schema change
 * would be required to add role-based access control (e.g., adding a 'role'
 * field to the User model).
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/utils/password.js";

const prisma = new PrismaClient();

async function main() {
  const password = process.env.ADMIN_PASSWORD ?? "admin1234";
  const username = process.env.ADMIN_USERNAME ?? "admin";

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.log(`Admin user already exists (${username})`);
    return;
  }

  const hashedPassword = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      username,
      hashedPassword,
      // Note: No role field exists in the schema. Admin privileges are
      // determined by convention (first user = admin), not by a stored role.
    },
  });

  console.log(`Seeded admin user "${user.username}" (password: ${password})`);
}

main()
  .catch((error) => {
    console.error("Failed to seed admin user", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
