# Agent and contributor rules: web-dev-kit

## The goal (never sacrificed)

wdk is tooling for making websites with AI agents faster, while conserving tokens and guaranteeing
accessibility, performance and compatibility. Every change serves that goal.

**wdk can never slow down development.**

## What that means

- **Fast.** Commands run very quickly. Setup is as quick as possible.
- **Clear.** Commands are easy to understand and easy to tell apart.
- **No re-downloads.** If a usable version of a dependency is already on the system, use it.
- **Actionable errors.** When something breaks, the error is readable and says what to do next.
- **Built for agents.** Rapid agentic development is the main use case: short output, no noise,
  nothing that costs tokens without telling the agent something.
- **Works and is tested.** Everything has to work, and every behaviour has a test.

## Workflow

- `just check` (bun test) must pass before every commit.
- Conventional commits, one concern per commit. Work on `web-kit`, fast-forward `main`, tag from `main`.
- After changing `bun.lock`, run `just hash` and update `outputHash` in `flake.nix`.
