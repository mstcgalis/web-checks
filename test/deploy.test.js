import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WDK = join(import.meta.dir, '..', 'bin', 'wdk.js');
const SHA_RE = /^[0-9a-f]{40}$/;

// A git project with dist/index.html, plus a stub `ssh` that records its last argument and the tar it was fed.
function setup({ config = '', git = true, dist = true, sshExit = 0, manifestExit = 0, manifest = '' } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-deploy-'));
	if (dist) {
		mkdirSync(join(dir, 'dist'));
		writeFileSync(join(dir, 'dist', 'index.html'), 'hi');
	}
	if (manifest) writeFileSync(join(dir, 'manifest-out'), manifest);
	writeFileSync(join(dir, 'wdk.config.js'), `export default ${config || '{}'};`);
	if (git) {
		for (const c of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']]) Bun.spawnSync(['git', ...c], { cwd: dir });
	}
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nfor a; do last="$a"; done\n[ "$last" = manifest ] && { cat "${dir}/manifest-out" 2>/dev/null; exit ${manifestExit}; }\necho "$last" > "${dir}/ssh-arg"\necho "released (stub)"\nzstd -dc | tar -t > "${dir}/ssh-tar" 2>/dev/null\nexit ${sshExit}\n`);
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

test('--build-only builds and stops: no host needed, no upload', () => {
	const s = setup({ config: `{ deploy: { build: 'touch built' } }` });
	const r = deploy(s, ['--build-only']);
	expect(r.code).toBe(0);
	expect(existsSync(join(s.dir, 'built'))).toBe(true);
	expect(existsSync(join(s.dir, 'ssh-arg'))).toBe(false);
});

const sha256 = (t) => new Bun.CryptoHasher('sha256').update(t).digest('hex');

test('with a remote manifest, only changed files travel and the remote command is --delta', () => {
	const s = setup({ manifest: `${sha256('hi')}  ./index.html\n${sha256('same')}  ./keep.txt\n${sha256('gone')}  ./old.txt\n` });
	writeFileSync(join(s.dir, 'dist', 'keep.txt'), 'same');
	writeFileSync(join(s.dir, 'dist', 'new.txt'), 'new');
	const r = deploy(s, ['--no-build', '--host', 'x@h']);
	expect(r.err).toBe('');
	expect(r.code).toBe(0);
	expect(arg(s)).toMatch(/^release [0-9a-f]{40} --delta$/);
	const tar = readFileSync(join(s.dir, 'ssh-tar'), 'utf8');
	expect(tar).toContain('new.txt');
	expect(tar).toContain('.wdk-delete');
	expect(tar).not.toContain('index.html');
	expect(tar).not.toContain('keep.txt');
	expect(r.out).toContain('1 changed, 1 removed');
});

test('an empty or failing manifest falls back to a full release', () => {
	const none = setup();
	expect(deploy(none, ['--no-build', '--host', 'x@h']).code).toBe(0);
	expect(arg(none)).toMatch(/^release [0-9a-f]{40}$/);
	const bad = setup({ manifest: 'junk', manifestExit: 255 });
	expect(deploy(bad, ['--no-build', '--host', 'x@h']).code).toBe(0);
	expect(arg(bad)).toMatch(/^release [0-9a-f]{40}$/);
});

test('reusable deploy.yml takes host and url, and rolls back when the url check fails', () => {
	const y = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'deploy.yml'), 'utf8');
	expect(y).toContain('host:');
	expect(y).toContain('url:');
	expect(y).toContain('--host {0}');
	expect(y).toContain('curl -fsS --max-time 10 "${{ inputs.url }}"');
	expect(y).toContain('rollback --if-current');
});
