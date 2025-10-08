/** @type {import('next').NextConfig} */
const nextConfig = {
	output: "standalone",
	eslint: {
		dirs: ["app", "src"],
	},
	poweredByHeader: false,
	async rewrites() {
		// Proxy /api requests to the backend API server
		// In Docker, uses container name; in dev, uses localhost
		const apiHost = process.env.API_HOST || "http://localhost:3001";

		return [
			{
				source: "/api/:path*",
				destination: `${apiHost}/:path*`,
			},
		];
	},
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{
						key: "Content-Security-Policy",
						value: [
							"default-src 'self'",
							"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
							"style-src 'self' 'unsafe-inline'",
							"img-src 'self' data: https:",
							"font-src 'self' data:",
							"connect-src 'self'",
							"frame-ancestors 'none'",
						].join("; "),
					},
					{
						key: "X-Frame-Options",
						value: "DENY",
					},
					{
						key: "X-Content-Type-Options",
						value: "nosniff",
					},
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
					{
						key: "Permissions-Policy",
						value: "camera=(), microphone=(), geolocation=()",
					},
				],
			},
		];
	},
};

export default nextConfig;
