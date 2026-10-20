import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  "pr create") echo "https://github.com/me/vps/pull/1" ;;
  "pr list") if grep -q "pr create" "${root}/gh.log"; then echo "https://github.com/me/vps/pull/1"; fi ;;
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
		env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: root, NIX_ACCESS_TOKEN: '', WDK_VPS_REPO: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
	});
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}
const log = (dir) => Bun.spawnSync(['git', 'log', '--format=%s'], { cwd: dir }).stdout.toString().trim().split('\n');
const g = (cwd, ...a) => Bun.spawnSync(['git', '-C', cwd, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).stdout.toString().trim();
// A vps repo at ~/src/vps with the files `wdk new` edits, pushed to a bare origin (root/vps.git).
function vpsRepo(root, tfvars) {
	const vps = join(root, 'src', 'vps');
	for (const d of ['nix/hosts/production', 'nix/modules', 'tofu/dns']) mkdirSync(join(vps, d), { recursive: true });
	writeFileSync(join(vps, 'nix/hosts/production/default.nix'), '{ ... }:\n{\n  imports = [\n    ../../modules/site.nix\n  ];\n}\n');
	writeFileSync(join(vps, 'nix/modules/site.nix'), '{ }\n');
	writeFileSync(join(vps, 'tofu/dns/dns.auto.tfvars'), tfvars);
	g(root, 'init', '-q', '--bare', '-b', 'main', join(root, 'vps.git'));
	for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'init'], ['remote', 'add', 'origin', join(root, 'vps.git')], ['push', '-q', 'origin', 'main']]) g(vps, ...a);
	return { vps, bare: join(root, 'vps.git') };
}

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

test('new with a vps repo: the site entry is a PR from a worktree, the user tree untouched', async () => {
	const root = setup();
	const { vps, bare } = vpsRepo(root, 'domains = {\n  "a.sk" = {\n    zone        = "a.sk"\n    record_name = "@"\n    tunnel      = true\n  }\n}\n\nwww_redirect_domains = ["a.sk"]');
	const r = wdkNew(root, ['kirby', 'site', '--domain', 'k.example.com', '--vps', 'vps.test']);
	expect(r.err).toBe('');
	expect(r.out).toContain('vps: https://github.com/me/vps/pull/1');
	expect(readFileSync(join(root, 'gh.log'), 'utf8')).toContain('pr create --fill --head site/k-example-com');
	expect(g(bare, 'log', '--format=%s', 'site/k-example-com')).toBe('feat(sites): k.example.com, from wdk new\ninit');
	expect(g(bare, 'show', 'site/k-example-com:nix/hosts/production/default.nix')).toContain('../../modules/site.nix\n    ../../modules/k-example-com.nix\n  ];');
	const mod = g(bare, 'show', 'site/k-example-com:nix/modules/k-example-com.nix');
	expect(mod).toContain('lib.genAttrs [ "k.example.com" ]');
	expect(mod).toContain('services.sites."k.example.com" = {\n    www = false;\n    kind = "kirby";\n    deployKey = "ssh-ed25519 ');
	expect(g(bare, 'show', 'site/k-example-com:tofu/dns/dns.auto.tfvars')).toContain('  }\n  "k.example.com" = {\n    zone        = "example.com"\n    record_name = "k"\n    tunnel      = true\n  }\n}\n\nwww_redirect_domains = ["a.sk"]');
	expect(g(vps, 'status', '--porcelain')).toBe('');
	expect(g(vps, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
	expect(g(vps, 'worktree', 'list').split('\n')).toHaveLength(1);
	expect(existsSync(join(root, 'secrets', 'DEPLOY_SSH_KEY'))).toBe(true);

	// Secrets lost after the PR: the re-run updates the open PR with the new key instead of making another.
	rmSync(join(root, 'secrets', 'DEPLOY_SSH_KEY'));
	expect(wdkNew(root, ['kirby', 'site', '--domain', 'k.example.com', '--vps', 'vps.test']).out).toContain('vps: https://github.com/me/vps/pull/1');
	expect(readFileSync(join(root, 'gh.log'), 'utf8').match(/pr create/g)).toHaveLength(1);
	expect(g(bare, 'show', 'site/k-example-com:nix/modules/k-example-com.nix')).not.toBe(mod);
});

test('new with a vps repo, apex domain: www vhost on tls internal and a www record', async () => {
	const root = setup();
	vpsRepo(root, 'domains = {\n}\n\nwww_redirect_domains = ["a.sk"]');
	const r = wdkNew(root, ['static', 'site', '--domain', 'example.com', '--vps', 'vps.test']);
	expect(r.err).toBe('');
	const show = (f) => g(join(root, 'vps.git'), 'show', `site/example-com:${f}`);
	expect(show('nix/modules/example-com.nix')).toContain('lib.genAttrs [ "example.com" "www.example.com" ]');
	expect(show('nix/modules/example-com.nix')).toContain('services.sites."example.com" = {\n    deployKey = ');
	expect(show('tofu/dns/dns.auto.tfvars')).toBe('domains = {\n  "example.com" = {\n    zone        = "example.com"\n    record_name = "@"\n    tunnel      = true\n  }\n}\n\nwww_redirect_domains = ["a.sk", "example.com"]');
});

test('new --staging: staging.<domain> from a staging branch, its own key and vps entry; added to an existing project too', async () => {
	const root = setup();
	const { bare } = vpsRepo(root, 'domains = {\n}\n\nwww_redirect_domains = []');
	const dir = join(root, 'site');
	expect(wdkNew(root, ['static', 'site', '--domain', 'example.com', '--vps', 'vps.test']).code).toBe(0);
	expect(wdkNew(root, ['static', 'x', '--staging']).err).toContain('--staging needs --domain');

	// Opting in later: only staging is new.
	const r = wdkNew(root, ['static', 'site', '--domain', 'example.com', '--vps', 'vps.test', '--staging']);
	expect(r.err).toBe('');
	expect(r.out).toContain('secret: STAGING_DEPLOY_SSH_KEY');
	expect(r.out).not.toContain('secret: DEPLOY_SSH_KEY');
	expect(r.out).toContain('push: staging');
	const wf = readFileSync(join(dir, '.github/workflows/deploy-staging.yml'), 'utf8');
	const { version } = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
	expect(wf).toContain(`deploy.yml@v${version}\n    with:\n      host: stg-example-com-deploy@vps.test\n      url: https://staging.example.com/`);
	expect(wf).toContain('DEPLOY_SSH_KEY: ${{ secrets.STAGING_DEPLOY_SSH_KEY }}');
	expect(log(dir)[0]).toBe('chore: deploy staging to stg-example-com-deploy@vps.test');
	expect(g(join(root, 'remote.git'), 'rev-parse', 'staging')).toBe(g(dir, 'rev-parse', 'HEAD'));
	const mod = g(bare, 'show', 'site/stg-example-com:nix/modules/stg-example-com.nix');
	expect(mod).toContain('services.sites."staging.example.com" = {\n    www = false;\n    slug = "stg-example-com";\n    # Unreleased work is never crawled.\n    extraConfig = \'\'header X-Robots-Tag "noindex, nofollow"\'\';\n    deployKey = "ssh-ed25519 ');
	expect(mod).toContain(' stg-example-com-deploy"');
	expect(g(bare, 'show', 'site/stg-example-com:tofu/dns/dns.auto.tfvars')).toContain('record_name = "staging"');
	expect(g(bare, 'log', '--format=%s', '-1', 'site/stg-example-com')).toBe('feat(sites): staging.example.com, from wdk new');

	// One run with both: one PR, two modules.
	const both = setup();
	const v2 = vpsRepo(both, 'domains = {\n}\n\nwww_redirect_domains = []');
	expect(wdkNew(both, ['static', 'site', '--domain', 'example.com', '--vps', 'vps.test', '--staging']).err).toBe('');
	expect(g(v2.bare, 'log', '--format=%s', '-1', 'site/example-com')).toBe('feat(sites): example.com, staging.example.com, from wdk new');
	expect(g(v2.bare, 'show', 'site/example-com:nix/hosts/production/default.nix')).toContain('example-com.nix\n    ../../modules/stg-example-com.nix\n  ];');
	expect(g(v2.bare, 'show', 'site/example-com:tofu/dns/dns.auto.tfvars')).toEndWith('www_redirect_domains = ["example.com"]');
});
