/**
 * Prisma Client Re-exports
 *
 * This module re-exports all Prisma types from the generated client.
 * Use this module for all Prisma imports instead of importing directly
 * from the generated path or @prisma/client.
 *
 * Example:
 *   import { PrismaClient, ServiceType } from "../lib/prisma.js";
 *   import type { Prisma, User } from "../lib/prisma.js";
 */

// Re-export everything from the generated Prisma client
export * from "../generated/prisma/client.js";

// Import the PrismaClient constructor for creating an instance type
import { PrismaClient as PrismaClientClass } from "../generated/prisma/client.js";

/**
 * PrismaClientInstance type - represents any instantiated PrismaClient
 * regardless of the options used during construction.
 *
 * Use this type when declaring PrismaClient as a property (e.g., Fastify decoration)
 * to avoid generic type parameter issues.
 */
export type PrismaClientInstance = InstanceType<typeof PrismaClientClass>;
