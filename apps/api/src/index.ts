import "dotenv/config";
import { envSchema } from "./config/env.js";
import { getPortConfig, logPortConfig } from "./lib/config/port-config.js";
import { buildServer } from "./server.js";

// Get port configuration (env var > database > default)
const portConfig = getPortConfig();
logPortConfig(portConfig);

// Override env with resolved port config so the rest of the app sees it
process.env.API_PORT = String(portConfig.apiPort);

// Validate environment variables with friendly error messages
const envResult = envSchema.safeParse(process.env);
if (!envResult.success) {
	console.error("\n========================================");
	console.error("ERROR: Invalid environment configuration");
	console.error("========================================\n");

	for (const issue of envResult.error.issues) {
		const envVar = issue.path.join(".");
		const currentValue = process.env[envVar];
		console.error(`  ✗ ${envVar}: ${issue.message}`);
		if (currentValue !== undefined) {
			console.error(`    Current value: "${currentValue}"`);
		}
		// Add helpful hints for common issues
		if (envVar === "SESSION_TTL_HOURS") {
			console.error("    Hint: Valid range is 1-720 hours (max 30 days). Default is 24 hours.");
		}
	}

	console.error("\nPlease check your environment variables and restart the container.\n");
	process.exit(1);
}
const env = envResult.data;

const start = async () => {
	const app = buildServer({ env });

	try {
		await app.listen({
			port: portConfig.apiPort,
			host: env.API_HOST,
		});
		app.log.info({ port: portConfig.apiPort, host: env.API_HOST }, "API server started");
	} catch (error) {
		app.log.error({ err: error }, "Failed to start API server");
		process.exit(1);
	}
};

void start();
