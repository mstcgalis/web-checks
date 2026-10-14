import { test } from 'bun:test';

// Runs the wdk CLI the way a project does: from the fixture project's root.
export const PROJECT = `${import.meta.dir}/project`;
// Async, so tests can run side by side (test.concurrent).
export async function wdk(args, env = {}, cwd = PROJECT) {
	const p = Bun.spawn(['bun', `${import.meta.dir}/../bin/wdk.js`, ...args], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, out, err };
}

// Browser-heavy end-to-end tests: `just check` (WDK_FAST=1) skips them, `just check-all` and CI run them.
export const slow = process.env.WDK_FAST ? test.skip : test;
