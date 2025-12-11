import "dotenv/config";
import { envSchema } from "./config/env.js";
import { getPortConfig, logPortConfig } from "./lib/config/port-config.js";
import { buildServer } from "./server.js";

// Get port configuration (env var > database > default)
const portConfig = getPortConfig();
logPortConfig(portConfig);

// Override env with resolved port config so the rest of the app sees it
process.env.API_PORT = String(portConfig.apiPort);

const env = envSchema.parse(process.env);

const start = async () => {
	const app = buildServer({ env });

	try {
		await app.listen({
			port: portConfig.apiPort,
			host: env.API_HOST,
		});
		app.log.info(
			{ port: portConfig.apiPort, host: env.API_HOST },
			"API server started"
		);
	} catch (error) {
		app.log.error({ err: error }, "Failed to start API server");
		process.exit(1);
	}
};

void start();
