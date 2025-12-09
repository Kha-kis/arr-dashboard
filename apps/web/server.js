/**
 * Custom Next.js server wrapper that enables runtime API_HOST configuration.
 *
 * The standard Next.js standalone server bakes rewrite destinations at build time.
 * This wrapper patches the config at runtime to use the API_HOST environment variable.
 *
 * Directory structure in Docker:
 * /app/web/                    - standalone output root (this file's location)
 * /app/web/apps/web/           - Next.js app directory with baked server.js
 * /app/web/apps/web/.next/     - Next.js build output
 */

const path = require('path');

// In Docker, this file is at /app/web/server.js
// The Next.js app is at /app/web/apps/web/
const nextDir = path.join(__dirname, 'apps', 'web');

process.env.NODE_ENV = 'production';
process.chdir(nextDir);

const currentPort = parseInt(process.env.PORT, 10) || 3000;
const hostname = process.env.HOSTNAME || '0.0.0.0';
const apiHost = process.env.API_HOST || 'http://localhost:3001';

let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);

// Load the baked config from standalone server
const standaloneServerPath = path.join(nextDir, 'server.js');
const standaloneContent = require('fs').readFileSync(standaloneServerPath, 'utf8');

// Extract the nextConfig from the standalone server
// The config is a single-line JSON object ending with }}
const configMatch = standaloneContent.match(/const nextConfig = (\{.*\})\s*[\r\n]/);
if (!configMatch) {
  console.error('Failed to extract nextConfig from standalone server');
  process.exit(1);
}

let nextConfig;
try {
  nextConfig = eval('(' + configMatch[1] + ')');
} catch (e) {
  console.error('Failed to parse nextConfig:', e);
  process.exit(1);
}

// Patch rewrites to use runtime API_HOST
if (nextConfig._originalRewrites) {
  const patchRewrites = (rewrites) => {
    if (!rewrites) return rewrites;
    return rewrites.map(rewrite => {
      if (rewrite.destination && rewrite.destination.includes('localhost:3001')) {
        return {
          ...rewrite,
          destination: rewrite.destination.replace('http://localhost:3001', apiHost)
        };
      }
      return rewrite;
    });
  };

  nextConfig._originalRewrites.beforeFiles = patchRewrites(nextConfig._originalRewrites.beforeFiles);
  nextConfig._originalRewrites.afterFiles = patchRewrites(nextConfig._originalRewrites.afterFiles);
  nextConfig._originalRewrites.fallback = patchRewrites(nextConfig._originalRewrites.fallback);
}

// Handle basePath from runtime environment
if (process.env.BASE_PATH) {
  nextConfig.basePath = process.env.BASE_PATH;
}

console.log(`Starting Next.js with API_HOST: ${apiHost}`);
if (nextConfig.basePath) {
  console.log(`Base path: ${nextConfig.basePath}`);
}

process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig);

require('next');
const { startServer } = require('next/dist/server/lib/start-server');

if (
  Number.isNaN(keepAliveTimeout) ||
  !Number.isFinite(keepAliveTimeout) ||
  keepAliveTimeout < 0
) {
  keepAliveTimeout = undefined;
}

startServer({
  dir: nextDir,
  isDev: false,
  config: nextConfig,
  hostname,
  port: currentPort,
  allowRetry: false,
  keepAliveTimeout,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
