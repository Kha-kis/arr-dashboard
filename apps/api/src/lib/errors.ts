/** Thrown when a service instance is not found or user lacks access. Maps to HTTP 404. */
export class InstanceNotFoundError extends Error {
	readonly statusCode = 404;
	constructor(public readonly instanceId: string) {
		super("Instance not found or access denied");
		this.name = "InstanceNotFoundError";
	}
}

/** Thrown when a trash template is not found or user lacks access. Maps to HTTP 404. */
export class TemplateNotFoundError extends Error {
	readonly statusCode = 404;
	constructor(public readonly templateId: string) {
		super("Template not found or access denied");
		this.name = "TemplateNotFoundError";
	}
}

/** Thrown when creating a resource that already exists. Maps to HTTP 409. */
export class ConflictError extends Error {
	readonly statusCode = 409;
	constructor(message: string) {
		super(message);
		this.name = "ConflictError";
	}
}

/** Thrown for application-level validation failures. Maps to HTTP 400. */
export class AppValidationError extends Error {
	readonly statusCode = 400;
	constructor(message: string) {
		super(message);
		this.name = "AppValidationError";
	}
}
