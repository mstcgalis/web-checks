# Agent and contributor rules

Generic rules from web-dev-kit. Add project specifics below the line.

- One concern per commit; conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Run `just check` before every commit. It must pass.
- Branches: `staging` deploys staging (if the project has one), `main` deploys production. Fast-forward only.
- Never commit secrets. Use the secret store, not the repo.
- Server-owned state (uploads, sessions, content edited on the server) is untouchable from code changes.
- Field and content names are frozen once published; rename only with a migration.
- `just serve-at PORT` must stay a foreground server on PORT: every wdk command relies on it.

---

## Kirby

- `content/` is server-owned (the Panel writes there) and untracked. Never edit it as a side effect;
  author real content only when asked: pull first, edit only the pages asked for, dry-run the push,
  push path-scoped, never delete.
- Blueprint field names are frozen: renaming orphans live data silently. Adding a field is safe.
- No build step and no new runtime composer dependencies; dev-only ones are fine.
- Production secrets come from `/run/secrets`, never `config.php` or the repo.
- Escape at the point of output: `->html()` / `->kt()` for content, `esc()` in quoted attributes.
  Never echo `->value()` or `->url()` raw.
- Every user-facing string goes through `t()` and a language file; no hardcoded text in templates.
- Images go through one shared snippet that emits `width`/`height`, `srcset`, `loading`, `decoding`.
