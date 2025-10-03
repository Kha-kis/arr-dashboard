import { z } from "zod";

export const arrServiceTypeSchema = z.enum(["sonarr", "radarr", "prowlarr"], {
  description: "Supported *arr service types",
});

export type ArrServiceType = z.infer<typeof arrServiceTypeSchema>;

export const arrTagSchema = z.object({
  id: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1, "Tag name is required"),
});

export type ArrTag = z.infer<typeof arrTagSchema>;

export const serviceInstanceSchema = z.object({
  id: z.string().uuid(),
  label: z
    .string()
    .trim()
    .min(1, "Instance label is required"),
  baseUrl: z.string().url("Valid base URL is required"),
  apiKey: z
    .string()
    .min(10, "API key appears too short"),
  service: arrServiceTypeSchema,
  isDefault: z.boolean().default(false),
  enabled: z.boolean().default(true),
  tags: z.array(arrTagSchema).default([]),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export type ServiceInstance = z.infer<typeof serviceInstanceSchema>;

export const multiInstanceConfigSchema = z.object({
  sonarr: z.array(serviceInstanceSchema).default([]),
  radarr: z.array(serviceInstanceSchema).default([]),
  prowlarr: z.array(serviceInstanceSchema).default([]),
});

export type MultiInstanceConfig = z.infer<typeof multiInstanceConfigSchema>;
