/**
 * Constants for settings feature
 */

import { ALL_SERVICES, type ArrServiceType } from "@arr/shared";

export type ServiceType = ArrServiceType;

export const SERVICE_TYPES: ServiceType[] = [...ALL_SERVICES];

export const OPTION_STYLE = {
	backgroundColor: "hsl(var(--color-bg))",
	color: "hsl(var(--color-fg))",
} as const;

export const TABS = [
	"services",
	"tags",
	"account",
	"authentication",
	"appearance",
	"backup",
	"notifications",
	"system",
] as const;

export type TabType = (typeof TABS)[number];
