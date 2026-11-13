import { randomUUID } from "node:crypto";
import type { RuntimeSchemaExecution } from "./runtime-schema-registry.js";
import { RuntimeSchemaStartupError } from "./runtime-schema-startup.js";

export type RuntimeSchemaMigrationReceipt = Readonly<{
	id: string;
	protocolVersion: 1;
	registryVersion: number;
	provider: "sqlite" | "postgresql";
	targetDigest: string;
	planDigest: string;
	completedAt: string;
}>;

const fields = [
	"id",
	"protocolVersion",
	"registryVersion",
	"provider",
	"targetDigest",
	"planDigest",
	"completedAt",
] as const;

export function parseRuntimeSchemaMigrationReceipt(value: unknown): RuntimeSchemaMigrationReceipt {
	try {
		if (
			value === null ||
			typeof value !== "object" ||
			![Object.prototype, null].includes(Object.getPrototypeOf(value))
		)
			throw new RuntimeSchemaStartupError();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (
			Reflect.ownKeys(value).length !== fields.length ||
			fields.some((field) => !descriptors[field] || !("value" in descriptors[field]!))
		)
			throw new RuntimeSchemaStartupError();
		const row = Object.fromEntries(fields.map((field) => [field, descriptors[field]!.value]));
		if (
			typeof row.id !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id) ||
			row.protocolVersion !== 1 ||
			!Number.isSafeInteger(row.registryVersion) ||
			row.registryVersion < 1 ||
			!["sqlite", "postgresql"].includes(row.provider) ||
			[row.targetDigest, row.planDigest].some(
				(digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest),
			) ||
			typeof row.completedAt !== "string" ||
			new Date(row.completedAt).toISOString() !== row.completedAt
		)
			throw new RuntimeSchemaStartupError();
		return Object.freeze(row) as RuntimeSchemaMigrationReceipt;
	} catch {
		throw new RuntimeSchemaStartupError();
	}
}

export function createRuntimeSchemaMigrationReceipt(
	plan: RuntimeSchemaExecution,
): RuntimeSchemaMigrationReceipt {
	return parseRuntimeSchemaMigrationReceipt({
		id: randomUUID(),
		protocolVersion: 1,
		registryVersion: plan.version,
		provider: plan.provider,
		targetDigest: plan.targetDigest,
		planDigest: plan.planDigest,
		completedAt: new Date().toISOString(),
	});
}
