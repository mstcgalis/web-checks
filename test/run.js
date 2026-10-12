import { test } from 'bun:test';

// Runs the wdk CLI the way a project does: from the fixture project's root.
export const PROJECT = `${import.meta.dir}/project`;
export function wdk(args, env = {}) {
	const r = Bun.spawnSync(['bun', `${import.meta.dir}/../bin/wdk.js`, ...args], { cwd: PROJECT, env: { ...process.env, ...env } });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// Browser-heavy end-to-end tests: `just check` (WDK_FAST=1) skips them, `just check-all` and CI run them.
export const slow = process.env.WDK_FAST ? test.skip : test;
