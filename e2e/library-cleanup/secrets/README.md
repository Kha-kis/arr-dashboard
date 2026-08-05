# Local harness secrets

Create these ignored files before starting the harness:

- `postgres-password.txt`: a random URL-safe password using only letters,
  numbers, dot, underscore, tilde, or hyphen.
- `plex-claim.txt`: an optional short-lived Plex claim token, or an empty file.

The PostgreSQL and Plex containers receive these as Docker Compose secrets.
The Plex claim value is never placed in Compose environment output.
