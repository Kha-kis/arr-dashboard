export function localSocketTarget(value: string): string;
export function socketOrigin(port: number | string, host: string): string;
export function dockerIPv6ApiSocket(
	hostname: string | undefined,
	configuredOrigin: string | undefined,
): { hostname: string; origin: URL; port: string } | undefined;
