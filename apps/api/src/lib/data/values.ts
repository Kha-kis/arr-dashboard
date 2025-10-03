export const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
};

export const toBoolean = (value: unknown): boolean | undefined => {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		if (value.toLowerCase() === "true") {
			return true;
		}
		if (value.toLowerCase() === "false") {
			return false;
		}
	}
	return undefined;
};

export const toStringValue = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value.toString();
	}
	return undefined;
};

export const toStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result = value
		.map((entry) => {
			if (typeof entry === "string") {
				const trimmed = entry.trim();
				return trimmed.length > 0 ? trimmed : undefined;
			}
			if (
				entry &&
				typeof entry === "object" &&
				"name" in entry &&
				typeof (entry as any).name === "string"
			) {
				const trimmed = ((entry as any).name as string).trim();
				return trimmed.length > 0 ? trimmed : undefined;
			}
			return undefined;
		})
		.filter((entry): entry is string => Boolean(entry));
	return result.length > 0 ? result : undefined;
};
