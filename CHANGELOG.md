# Changelog

All notable changes to Arr Dashboard will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.7.0] - 2026-01-21

### Major Upgrades

This release includes significant upgrades to the entire technology stack for improved performance, security, and maintainability.

#### Runtime & Build
- **Node.js** 20 → 22 (LTS with improved performance and native fetch)
- **pnpm** 9 → 10 (faster installs with inject-workspace-packages)

#### Backend
- **Prisma** 6 → 7 (driver adapter architecture, improved query performance)
- **Pino** 9 → 10 (logging improvements)
- **Fastify** 4 → 5 (performance optimizations)

#### Frontend
- **Next.js** 15 → 16 (Turbopack by default, improved SSR)
- **Tailwind CSS** 3 → 4 (new architecture, faster builds)
- **Framer Motion** 11 → 12 (improved animations)
- **Zustand** 4 → 5 (smaller bundle, better TypeScript)
- **Zod** 3 → 4 (improved error messages)

#### Development
- **Vitest** 1 → 4 (faster test execution)
- **Biome** 1 → 2 (improved linting rules)
- **TypeScript** 5.7 → 5.9

### Upgrade Notes

> **Important:** If upgrading from a previous version, ensure your `/config` volume is preserved. This directory contains:
> - `prod.db` - Your database with all configurations
> - `secrets.json` - Encryption keys for API credentials
>
> If `secrets.json` is missing after upgrade, your service connections will fail to decrypt. The volume should be automatically preserved in standard Docker setups.

#### Database Changes
- The deprecated `urlBase` column in system settings has been removed. This is handled automatically during startup with no action required.
- New library caching tables (`library_cache`, `library_sync_status`) are created automatically for server-side pagination support.

### Added

#### Dashboard Features
- **Queue sorting** - Sort downloads by title (A-Z, Z-A), size (largest/smallest), progress, or status ([#32](https://github.com/Kha-kis/arr-dashboard/issues/32))

#### CI/CD Improvements
- **Automated testing** in CI pipeline with Vitest
- **Dependency vulnerability auditing** with `pnpm audit`
- **Trivy security scanning** for Docker images on release
- **Dependabot** for automated dependency updates (npm, GitHub Actions, Docker)
- **Turbo build caching** for faster CI runs
- **Version metadata injection** into Docker images (VERSION, COMMIT_SHA, BUILD_DATE)

#### Docker Improvements
- **OCI image labels** with build metadata for registry/scanner compatibility
- **STOPSIGNAL SIGTERM** for graceful container shutdown via tini
- **NODE_OPTIONS** with memory tuning for containerized environments
- **Package manager cleanup** - removed unused yarn/npm/corepack from runtime (~25MB)
- **Pinned Alpine version** (node:22-alpine3.21) for reproducible builds
- **Non-Linux prebuild cleanup** to reduce image size

### Changed

- Docker startup script now uses direct prisma path (`./node_modules/.bin/prisma`) instead of npx
- pnpm workspace configuration uses `inject-workspace-packages=true` for hermetic deployments
- Prisma 7 now requires `prisma.config.ts` for CLI configuration

### Fixed

- **Accessibility**: Removed constant animations from cyberpunk theme
- **Docker**: Fixed pnpm 10 compatibility with proper inject-workspace-packages configuration
- **Docker**: Fixed Prisma 7 CLI compatibility by copying prisma.config.ts to deploy directory

### Security

- Docker images now scanned with Trivy on every release
- Dependencies audited for vulnerabilities in CI
- Automated security updates via Dependabot
- Removed unnecessary package managers from runtime image (reduced attack surface)

### Dependencies

Major dependency updates (see individual PR links for details):
- lucide-react 0.441.0 → 0.562.0
- tailwind-merge 2.6.0 → 3.4.0
- @types/node 22.18.6 → 25.0.9
- dotenv 16.6.1 → 17.2.3
- tsup 8.5.0 → 8.5.1

---

## [2.6.0] - 2025-11-15

### Added
- Hunt search history with reset functionality
- External URL setting for reverse proxy support
- Improved hunting scheduler with batch update optimization

### Fixed
- Various error handling improvements
- Security improvements for authentication flows

---

## [2.5.0] - 2025-10-01

### Added
- TRaSH Guides integration for quality profile management
- Automated backup system with retention policies
- OIDC authentication support (Authelia, Authentik)
- Passkey/WebAuthn authentication

### Changed
- Improved dashboard performance with optimized queries
- Enhanced calendar view with better date handling

---

[2.7.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/Kha-kis/arr-dashboard/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/Kha-kis/arr-dashboard/releases/tag/v2.5.0
