# Agent and contributor rules

Generic rules from web-dev-kit. Add project specifics below the line.

- One concern per commit; conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Run `just check` before every commit. It must pass.
- Branches: `dev` deploys staging, `main` deploys production. Fast-forward only.
- Never commit secrets. Use the secret store, not the repo.
- Server-owned state (uploads, sessions, content edited on the server) is untouchable from code changes.
- Field and content names are frozen once published; rename only with a migration.
- `just serve-at PORT` must stay a foreground server on PORT: every wdk command relies on it.

---
