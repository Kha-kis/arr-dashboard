#!/usr/bin/env python3
"""Statically prove that disposable harness data cannot enter Docker builds."""

from __future__ import annotations

import argparse
from pathlib import Path


HARNESS_EXCLUSION = "e2e/library-cleanup/**"


def active_rules(contents: str) -> list[str]:
    return [line.strip() for line in contents.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def validate(contents: str) -> None:
    rules = active_rules(contents)
    try:
        exclusion_index = max(index for index, rule in enumerate(rules) if rule == HARNESS_EXCLUSION)
    except ValueError as error:
        raise ValueError(f"root .dockerignore must contain {HARNESS_EXCLUSION}") from error

    for rule in rules[exclusion_index + 1 :]:
        if rule.startswith("!") and rule.removeprefix("!").startswith("e2e/library-cleanup"):
            raise ValueError("a later .dockerignore rule re-includes Library Cleanup harness data")

    sensitive_samples = (
        "e2e/library-cleanup/.env",
        "e2e/library-cleanup/.env.local",
        "e2e/library-cleanup/secrets/postgres-password.txt",
        "e2e/library-cleanup/secrets/plex-claim.txt",
        "e2e/library-cleanup/.artifacts/rendered-compose.json",
        "e2e/library-cleanup/logs/runtime.log",
        "e2e/library-cleanup/fixtures/media/movie.mkv",
    )
    if not all(sample.startswith("e2e/library-cleanup/") for sample in sensitive_samples):
        raise AssertionError("sensitive sample escaped the harness prefix")


def run_self_tests(contents: str) -> None:
    validate(contents)
    invalid_cases = (
        ".env\n",
        f"{HARNESS_EXCLUSION}\n!e2e/library-cleanup/.env\n",
        f"{HARNESS_EXCLUSION}\n!e2e/library-cleanup/secrets/README.md\n",
    )
    for contents_case in invalid_cases:
        try:
            validate(contents_case)
        except ValueError:
            continue
        raise AssertionError("negative .dockerignore safety test unexpectedly passed")
    print(f"negative .dockerignore tests passed: {len(invalid_cases)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dockerignore", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    try:
        contents = args.dockerignore.read_text(encoding="utf-8")
        validate(contents)
        if args.self_test:
            run_self_tests(contents)
    except (OSError, ValueError, AssertionError) as error:
        print(f"Docker build-context safety check failed: {error}")
        return 1
    print("Docker build context excludes all e2e/library-cleanup data")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
