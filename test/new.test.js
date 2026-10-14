import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WDK = join(import.meta.dir, '..', 'bin', 'wdk.js');

// A temp root with stub `gh` (a bare repo stands in for GitHub; secrets land in files) and `ssh-keyscan`.
function setup() {
	const root = mkdtempSync(join(tmpdir(), 'wdk-new-'));
	const bin = join(root, 'bin');
	mkdirSync(bin);
	mkdirSync(join(root, 'secrets'));
	Bun.spawnSync(['git', 'init', '-q', '--bare', join(root, 'remote.git')]);
	writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "${root}/gh.log"
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo create") git remote add origin "${root}/remote.git" ;;
  "repo view") echo me/site ;;
  "secret list") ls "${root}/secrets" ;;
  "secret set") cat > "${root}/secrets/$3" ;;
esac
`);
	Bun.spawnSync(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'hostkey')]);
	const hostkey = readFileSync(join(root, 'hostkey.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
	writeFileSync(join(root, 'hostkey.line'), hostkey);
	mkdirSync(join(root, '.ssh'));
	writeFileSync(join(root, '.ssh', 'known_hosts'), `vps.test ${hostkey}\n`);
	writeFileSync(join(bin, 'ssh-keyscan'), `#!/bin/sh\necho "# comment"\necho "$3 $(cat '${root}/hostkey.line')"\n`);
	for (const f of ['gh', 'ssh-keyscan']) chmodSync(join(bin, f), 0o755);
	return root;
}
function wdkNew(root, args, env = {}) {
	const r = Bun.spawnSync(['bun', WDK, 'new', ...args], {
		cwd: root,
		env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: root, NIX_ACCESS_TOKEN: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
	});
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const log = (dir) => Bun.spawnSync(['git', 'log', '--format=%s'], { cwd: dir }).stdout.toString().trim().split('\n');

test('new: template pinned to this wdk, committed, on GitHub, secrets set, deploy configured; a re-run does nothing', async () => {
	const root = setup();
	const dir = join(root, 'site');
	const r = wdkNew(root, ['static', 'site', '--domain', 'example.com', '--vps', 'vps.test'], { NIX_ACCESS_TOKEN: 'tok' });
	expect(r.err).toBe('');
	expect(r.code).toBe(0);
	const { version } = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
	expect(readFileSync(join(dir, '.github/workflows/deploy.yml'), 'utf8')).toContain(`deploy.yml@v${version}`);
	expect(readFileSync(join(dir, 'wdk.config.js'), 'utf8')).toContain("deploy: { host: 'example-com-deploy@vps.test', dir: 'site' }");
	expect(log(dir)).toEqual(['chore: deploy to example-com-deploy@vps.test', 'chore: start from the wdk static template']);
	expect(readFileSync(join(root, 'gh.log'), 'utf8')).toContain('repo create site --private');
	const secret = (n) => readFileSync(join(root, 'secrets', n), 'utf8');
	expect(secret('NIX_ACCESS_TOKEN')).toBe('tok');
	expect(secret('DEPLOY_HOST_KEY')).toBe(`vps.test ${readFileSync(join(root, 'hostkey.line'), 'utf8')}`);
	expect(r.out).toContain('host key: matches ~/.ssh/known_hosts');
	expect(secret('DEPLOY_SSH_KEY')).toContain('OPENSSH PRIVATE KEY');
	expect(r.out).toContain('services.sites."example.com" = {\n    deployKey = "ssh-ed25519 ');
	expect(Bun.spawnSync(['git', 'rev-parse', 'main'], { cwd: join(root, 'remote.git') }).stdout.toString()).toBe(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout.toString());

	const again = wdkNew(root, ['static', 'site', '--domain', 'example.com', '--vps', 'vps.test'], { NIX_ACCESS_TOKEN: 'other' });
	expect(again.code).toBe(0);
	expect(again.out).toBe('template: site has one\n');
	expect(secret('NIX_ACCESS_TOKEN')).toBe('tok');
	expect(log(dir)).toHaveLength(2);
});

test('new --no-github: a local project only, no gh calls', async () => {
	const root = setup();
	const r = wdkNew(root, ['kirby', 'k', '--no-github']);
	expect(r.code).toBe(0);
	expect(existsSync(join(root, 'k', 'roots.php'))).toBe(true);
	expect(existsSync(join(root, 'gh.log'))).toBe(false);
	expect(log(join(root, 'k'))).toEqual(['chore: start from the wdk kirby template']);
});

test('new: no token anywhere says where to put one; a bad stack, a non-empty dir and a lone --domain exit 2', async () => {
	const root = setup();
	const r = wdkNew(root, ['static', 'site']);
	expect(r.code).toBe(0);
	expect(r.out).toContain('NIX_ACCESS_TOKEN not found');
	expect(existsSync(join(root, 'secrets', 'DEPLOY_SSH_KEY'))).toBe(false);
	expect(wdkNew(root, ['hugo', 'x']).err).toContain('usage: wdk new <');
	mkdirSync(join(root, 'full'));
	writeFileSync(join(root, 'full', 'a'), '');
	expect(wdkNew(root, ['static', 'full']).err).toContain('not empty');
	const lone = wdkNew(root, ['static', 'y', '--domain', 'a.b']);
	expect(lone.code).toBe(2);
	expect(lone.err).toContain('--domain and --vps go together');
});

test('new reads the token Nix already uses from nix.conf', async () => {
	const root = setup();
	mkdirSync(join(root, '.config', 'nix'), { recursive: true });
	writeFileSync(join(root, '.config', 'nix', 'nix.conf'), 'access-tokens = github.com=fromconf\n');
	expect(wdkNew(root, ['static', 'site']).code).toBe(0);
	expect(readFileSync(join(root, 'secrets', 'NIX_ACCESS_TOKEN'), 'utf8')).toBe('fromconf');
});

test('new pins the host key only if ~/.ssh/known_hosts already trusts it', async () => {
	const root = setup();
	const args = ['static', 'site', '--domain', 'example.com', '--vps', 'vps.test'];
	const kh = join(root, '.ssh', 'known_hosts');
	const real = readFileSync(kh, 'utf8');
	for (const [content, msg] of [
		['', 'no ed25519 key in ~/.ssh/known_hosts'],
		[`@revoked ${real}`, 'marks @revoked'],
		[`${real}@revoked * ${real.split(' ').slice(1).join(' ')}`, 'marks @revoked'],
		['vps.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyOtherKeyOtherKeyOtherKeyOtherKey\n', 'different ed25519 key'],
	]) {
		writeFileSync(kh, content);
		const r = wdkNew(root, args);
		expect(r.code).toBe(2);
		expect(r.err).toContain(msg);
		expect(existsSync(join(root, 'secrets', 'DEPLOY_HOST_KEY'))).toBe(false);
	}
	writeFileSync(kh, real);
	expect(wdkNew(root, args).out).toContain('host key: matches ~/.ssh/known_hosts');
});
