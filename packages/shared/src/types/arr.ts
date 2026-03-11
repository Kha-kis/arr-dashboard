import { z } from "zod";

// ── Service Type Taxonomy ────────────────────────────────────────────
// Single source of truth for service categorisation.
// When adding a new service, update the appropriate array(s) below.

/** True *arr services that use the arr-sdk client (Sonarr, Radarr, etc.) */
export const ARR_SERVICES = ["sonarr", "radarr", "prowlarr", "lidarr", "readarr"] as const;

/** Arr services that manage a content library (excludes Prowlarr which is indexer-only) */
export const LIBRARY_SERVICES = ["sonarr", "radarr", "lidarr", "readarr"] as const;

/** Non-arr integration services (different APIs, used as data sources) */
export const INTEGRATION_SERVICES = ["seerr", "tautulli", "plex"] as const;

/** All supported service types */
export const ALL_SERVICES = [...ARR_SERVICES, ...INTEGRATION_SERVICES] as const;

/** Uppercase variants for Prisma enum matching */
export const ARR_SERVICES_UPPER = ARR_SERVICES.map((s) => s.toUpperCase()) as unknown as readonly [
	"SONARR",
	"RADARR",
	"PROWLARR",
	"LIDARR",
	"READARR",
];
export const LIBRARY_SERVICES_UPPER = LIBRARY_SERVICES.map((s) =>
	s.toUpperCase(),
) as unknown as readonly ["SONARR", "RADARR", "LIDARR", "READARR"];

export type ArrService = (typeof ARR_SERVICES)[number];
export type IntegrationService = (typeof INTEGRATION_SERVICES)[number];

export const arrServiceTypeSchema = z.enum([...ALL_SERVICES]).describe("Supported service types");

export type ArrServiceType = z.infer<typeof arrServiceTypeSchema>;

export const arrTagSchema = z.object({
	id: z.string().uuid(),
	name: z.string().trim().min(1, "Tag name is required"),
});

export type ArrTag = z.infer<typeof arrTagSchema>;

export const serviceInstanceSchema = z.object({
	id: z.string().uuid(),
	label: z.string().trim().min(1, "Instance label is required"),
	baseUrl: z.string().url("Valid base URL is required"),
	apiKey: z.string().min(10, "API key appears too short"),
	service: arrServiceTypeSchema,
	isDefault: z.boolean().default(false),
	enabled: z.boolean().default(true),
	tags: z.array(arrTagSchema).default([]),
	storageGroupId: z.string().nullish(),
	createdAt: z.date().optional(),
	updatedAt: z.date().optional(),
});

export type ServiceInstance = z.infer<typeof serviceInstanceSchema>;

export const multiInstanceConfigSchema = z.object({
	sonarr: z.array(serviceInstanceSchema).default([]),
	radarr: z.array(serviceInstanceSchema).default([]),
	prowlarr: z.array(serviceInstanceSchema).default([]),
	lidarr: z.array(serviceInstanceSchema).default([]),
	readarr: z.array(serviceInstanceSchema).default([]),
	seerr: z.array(serviceInstanceSchema).default([]),
	tautulli: z.array(serviceInstanceSchema).default([]),
	plex: z.array(serviceInstanceSchema).default([]),
});

export type MultiInstanceConfig = z.infer<typeof multiInstanceConfigSchema>;
