import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WDK = join(import.meta.dir, '..', 'bin', 'wdk.js');
const SHA_RE = /^[0-9a-f]{40}$/;

// A git project with dist/index.html, plus a stub `ssh` that records its last argument and the tar it was fed.
function setup({ config = '', git = true, dist = true, sshExit = 0 } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-deploy-'));
	if (dist) {
		mkdirSync(join(dir, 'dist'));
		writeFileSync(join(dir, 'dist', 'index.html'), 'hi');
	}
	writeFileSync(join(dir, 'wdk.config.js'), `export default ${config || '{}'};`);
	if (git) {
		for (const c of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']]) Bun.spawnSync(['git', ...c], { cwd: dir });
	}
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nfor a; do last="$a"; done\necho "$last" > "${dir}/ssh-arg"\necho "released (stub)"\nzstd -dc | tar -t > "${dir}/ssh-tar" 2>/dev/null\nexit ${sshExit}\n`);
	chmodSync(join(bin, 'ssh'), 0o755);
	return { dir, bin };
}
function deploy(s, args) {
	const r = Bun.spawnSync(['bun', WDK, 'deploy', ...args], { cwd: s.dir, env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` } });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const arg = (s) => readFileSync(join(s.dir, 'ssh-arg'), 'utf8').trim();

test('release streams the dist dir to the host as `release <HEAD sha>`', () => {
	const s = setup();
	const r = deploy(s, ['--no-build', '--host', 'x@h']);
	expect(r.err).toBe('');
	expect(r.code).toBe(0);
	const [verb, sha] = arg(s).split(' ');
	expect(verb).toBe('release');
	expect(sha).toMatch(SHA_RE);
	expect(readFileSync(join(s.dir, 'ssh-tar'), 'utf8')).toContain('./index.html');
	expect(r.out).toContain('released');
});

test('release runs deploy.build first', () => {
	const s = setup({ config: `{ deploy: { host: 'x@h', build: 'touch built' } }` });
	const r = deploy(s, []);
	expect(r.code).toBe(0);
	expect(existsSync(join(s.dir, 'built'))).toBe(true);
});

test('no host: says where to set it, exit 2', () => {
	const r = deploy(setup(), ['--no-build']);
	expect(r.err).toContain('no deploy host: set deploy.host in wdk.config.js or pass --host user@host');
	expect(r.code).toBe(2);
});

test('missing dist dir: names it and says what to do, exit 2', () => {
	const r = deploy(setup({ dist: false }), ['--no-build', '--host', 'x@h']);
	expect(r.err).toContain('"dist"');
	expect(r.err).toContain('run the build, or set deploy.dir');
	expect(r.code).toBe(2);
});

test('not a git repo: explains the sha, exit 2', () => {
	const r = deploy(setup({ git: false }), ['--no-build', '--host', 'x@h']);
	expect(r.err).toContain('deploy names a release by commit sha');
	expect(r.code).toBe(2);
});

test('a failing ssh: exit 1 with the key hint', () => {
	const r = deploy(setup({ sshExit: 255 }), ['--no-build', '--host', 'x@h']);
	expect(r.err).toContain('deploy to x@h failed');
	expect(r.err).toContain('deployKey');
	expect(r.code).toBe(1);
});

test('rollback --if-current and list pass through as the remote command', () => {
	const s = setup();
	const sha = 'a'.repeat(40);
	expect(deploy(s, ['rollback', '--if-current', sha, '--host', 'x@h']).code).toBe(0);
	expect(arg(s)).toBe(`rollback --if-current ${sha}`);
	expect(deploy(s, ['list', '--host', 'x@h']).code).toBe(0);
	expect(arg(s)).toBe('list');
});

test('a failing build stops before any upload, exit 2', () => {
	const s = setup({ config: `{ deploy: { host: 'x@h', build: 'false' } }` });
	const r = deploy(s, []);
	expect(r.err).toContain('build failed');
	expect(r.code).toBe(2);
	expect(existsSync(join(s.dir, 'ssh-arg'))).toBe(false);
});
