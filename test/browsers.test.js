import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nixBuild } from '../lib/browsers.js';

test('nixBuild asks nix once per flake ref, and again once a path is gone', () => {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-nixbuild-'));
	const [a, b] = [mkdtempSync(join(dir, 'a-')), mkdtempSync(join(dir, 'b-'))];
	// A fake nix: counts its calls, prints one path per attr.
	writeFileSync(join(dir, 'nix'), `#!/bin/sh\necho x >> ${dir}/calls\nprintf '%s\\n%s\\n' ${a} ${b}\n`, { mode: 0o755 });
	const env = { ...process.env };
	Object.assign(process.env, { PATH: `${dir}:${env.PATH}`, XDG_CACHE_HOME: join(dir, 'cache'), WDK_FLAKE: `path:${dir}` });
	const calls = () => readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean).length;
	try {
		expect(nixBuild('one', 'two')).toEqual([a, b]);
		expect(nixBuild('one', 'two')).toEqual([a, b]);
		expect(calls()).toBe(1);
		rmSync(b, { recursive: true });
		nixBuild('one', 'two');
		expect(calls()).toBe(2);
	} finally {
		process.env = env;
	}
});
