# Contributing to Arr Dashboard

Thanks for your interest in contributing! This guide will help you get started.

## Quick Start

```bash
pnpm install && pnpm run dev  # API (3001) + Web (3000)
```

**Requirements:** Node.js 22+, pnpm 10+

## Development Guide

The main development reference is [`CLAUDE.md`](CLAUDE.md) — it covers:
- Architecture (Fastify + Next.js + Prisma monorepo)
- Code style and conventions (Biome, TypeScript strict mode)
- Key patterns (auth, encryption, API proxy, theming)
- How to add features (routes, pages, database changes)

## Submitting Changes

1. **Fork** the repo and create a branch from `main`
2. **Follow existing patterns** — check `CLAUDE.md` for conventions
3. **Test your changes**:
   ```bash
   pnpm run lint        # Biome (API) + ESLint (Web)
   pnpm run typecheck   # TypeScript strict mode
   pnpm run test        # Vitest unit tests
   pnpm run build       # Production build
   ```
4. **Open a PR** against `main` with a clear description

## What Makes a Good PR

- **Focused** — One concern per PR
- **Tested** — Types pass, lint clean, tests pass
- **Documented** — Update CLAUDE.md if you add patterns, routes, or conventions

## Reporting Issues

- **Bugs**: Use the [bug report template](https://github.com/Kha-kis/arr-dashboard/issues/new?template=bug_report.yml)
- **Features**: Use the [feature request template](https://github.com/Kha-kis/arr-dashboard/issues/new?template=feature_request.yml)
- **Security**: See [SECURITY.md](SECURITY.md) — do NOT open public issues for vulnerabilities

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
