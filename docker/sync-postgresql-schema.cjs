const { spawn } = require("node:child_process");

const prisma = "/app/api/node_modules/.bin/prisma";
const maxSchemaPushAttempts = 5;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runPrisma(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(prisma, args, {
      cwd: "/app/api",
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `Prisma schema command terminated by ${signal}`
            : `Prisma schema command exited with code ${code}`,
        ),
      );
    });
  });
}

async function main() {
  await runPrisma([
    "db",
    "execute",
    "--file",
    "prisma/pre-sync/postgresql-v2.24-list-cache-identity.sql",
    "--config",
    "prisma.config.ts",
  ]);

  for (let attempt = 1; attempt <= maxSchemaPushAttempts; attempt += 1) {
    try {
      await runPrisma(["db", "push", "--schema", "prisma/schema.prisma"]);
      return;
    } catch (error) {
      if (attempt === maxSchemaPushAttempts) {
        throw error;
      }

      const retryDelay = attempt * 500 + Math.floor(Math.random() * 500);
      console.error(
        `PostgreSQL schema synchronization attempt ${attempt} failed; retrying in ${retryDelay}ms`,
      );
      await delay(retryDelay);
    }
  }
}

main().catch((error) => {
  console.error("ERROR: PostgreSQL schema synchronization failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
