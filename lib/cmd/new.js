// wdk new <stack> <dir> [--domain D --vps HOST] [--public] [--no-github]: a project from a template, committed,
// on GitHub (private by default) with its CI secrets. Each step is skipped when already done, so a re-run
// finishes a half-made project. --domain/--vps add the deploy: a fresh key in the repo secrets, deploy.host
// in wdk.config.js, and the vps site entry as a PR in the vps repo ($WDK_VPS_REPO, default ~/src/vps; printed if absent).
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { repin } from './update.js';

const ROOT = join(import.meta.dir, '..', '..');
const STACKS = readdirSync(join(ROOT, 'templates'));

const sh = (args, opts = {}) => {
	const r = Bun.spawnSync(args, { stderr: 'pipe', ...opts });
	return { code: r.exitCode, out: r.stdout?.toString().trim() ?? '', err: r.stderr.toString().trim() };
};
const must = (args, opts) => {
	const r = sh(args, opts);
	if (r.code) throw new Error(`\`${args.join(' ')}\` failed: ${r.err || r.out}`);
	return r.out;
};

// The token Nix already uses (nix.conf access-tokens), or $NIX_ACCESS_TOKEN.
function nixToken() {
	if (process.env.NIX_ACCESS_TOKEN) return process.env.NIX_ACCESS_TOKEN;
	try {
		return readFileSync(join(homedir(), '.config', 'nix', 'nix.conf'), 'utf8').match(/^\s*access-tokens\s*=.*github\.com=(\S+)/m)?.[1];
	} catch {}
}

// The site entry as its own vps module, committed from a temp worktree (the user's vps tree is left alone),
// pushed to site/<slug> and opened as a PR. A new public host is tunnel-only, so it starts on `tls internal`
// (vps portfolio-sites.nix); a subdomain gets no www vhost.
// ponytail: always the production host; a --vps that maps to another nix/hosts/* needs a flag.
function vpsPr(repo, domain, kind, deployKey) {
	const slug = domain.replaceAll('.', '-');
	const sub = domain.split('.').length > 2; // ponytail: example.co.uk reads as a subdomain; set www by hand there
	const hosts = sub ? [domain] : [domain, `www.${domain}`];
	const nix = `# ${domain}: deployed by \`wdk deploy\` (modules/site.nix), entry from \`wdk new\`.
# tls internal: a new tunnel-only host can't get a first public cert (portfolio-sites.nix).
{ lib, ... }:
{
  services.caddy.virtualHosts = lib.genAttrs [ ${hosts.map((h) => `"${h}"`).join(' ')} ] (_: { extraConfig = lib.mkBefore "tls internal"; });
  services.sites."${domain}" = {${sub ? '\n    www = false;' : ''}${kind}
    deployKey = "${deployKey}";
  };
}
`;
	const branch = `site/${slug}`;
	const wt = mkdtempSync(join(tmpdir(), 'wdk-vps-'));
	const w = (...a) => must(['git', '-C', wt, ...a]);
	try {
		must(['git', '-C', repo, 'fetch', '-q', 'origin', 'main']);
		must(['git', '-C', repo, 'worktree', 'add', '-q', '-f', '-B', branch, wt, 'origin/main']);
		writeFileSync(join(wt, 'nix', 'modules', `${slug}.nix`), nix);
		const host = join(wt, 'nix', 'hosts', 'production', 'default.nix');
		const text = readFileSync(host, 'utf8');
		const next = text.replace(/(imports = \[[^\]]*?)(\n\s*\];)/, `$1\n    ../../modules/${slug}.nix$2`);
		if (next === text) throw new Error(`${host.slice(wt.length + 1)} in ${repo} has no imports list to add ${slug}.nix to`);
		writeFileSync(host, next);
		w('add', '-A');
		w('commit', '-qm', `feat(sites): ${domain}, from wdk new`);
		w('push', '-q', '-f', '-u', 'origin', branch);
		// A re-run after the PR but before the secrets: the push above already put the new key in the open PR.
		return must(['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '-q', '.[0].url'], { cwd: wt }) || must(['gh', 'pr', 'create', '--fill', '--head', branch], { cwd: wt });
	} finally {
		sh(['git', '-C', repo, 'worktree', 'remove', '--force', wt]);
		rmSync(wt, { recursive: true, force: true });
	}
}

export async function run(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { domain: { type: 'string' }, vps: { type: 'string' }, public: { type: 'boolean' }, 'no-github': { type: 'boolean' } },
	});
	const [stack, target] = positionals;
	if (!STACKS.includes(stack) || !target) throw new Error(`usage: wdk new <${STACKS.join('|')}> <dir> [--domain D --vps HOST] [--public] [--no-github]`);
	if (!values.domain !== !values.vps) throw new Error('--domain and --vps go together (the deploy user is <domain with - for .>-deploy@<vps>)');
	const dir = resolve(target);
	const git = (...a) => must(['git', ...a], { cwd: dir });
	const say = (s) => console.log(s);

	if (existsSync(join(dir, 'flake.nix'))) say(`template: ${target} has one`);
	else {
		if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${target} is not empty and has no flake.nix; pick a new dir`);
		cpSync(join(ROOT, 'templates', stack), dir, { recursive: true });
		must(['chmod', '-R', 'u+w', dir]); // the nix store copy is read-only
		const tag = `v${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`;
		const wf = join(dir, '.github', 'workflows');
		for (const f of [join(dir, 'flake.nix'), ...readdirSync(wf).map((f) => join(wf, f))]) writeFileSync(f, repin(readFileSync(f, 'utf8'), tag));
		say(`template: ${stack} (wdk ${tag})`);
	}

	if (!existsSync(join(dir, '.git'))) git('init', '-q', '-b', 'main');
	const commit = (msg) => {
		git('add', '-A');
		if (sh(['git', 'diff', '--cached', '--quiet'], { cwd: dir }).code) (git('commit', '-qm', msg), say(`commit: ${msg}`));
	};
	commit(`chore: start from the wdk ${stack} template`);

	if (values.domain) {
		const slug = values.domain.replaceAll('.', '-');
		if (slug.length > 31 - '-deploy'.length) throw new Error(`"${slug}-deploy" is over 31 chars (vps user name limit); set a short slug in the vps entry and deploy.host by hand`);
		const host = `${slug}-deploy@${values.vps}`;
		const cfg = join(dir, 'wdk.config.js');
		const text = readFileSync(cfg, 'utf8');
		if (!/^\s*deploy:/m.test(text)) {
			writeFileSync(cfg, text.replace(/\/\/ deploy: \{ host: '[^']*'/, `deploy: { host: '${host}'`));
			if (!/^\s*deploy:/m.test(readFileSync(cfg, 'utf8'))) throw new Error('wdk.config.js has no `// deploy:` line to fill in; add deploy: { host, dir } by hand');
			commit(`chore: deploy to ${host}`);
		}
	}

	if (values['no-github']) return 0;
	if (sh(['gh', 'auth', 'status']).code) throw new Error('gh is not logged in: run `gh auth login`, then re-run this');
	if (sh(['git', 'remote', 'get-url', 'origin'], { cwd: dir }).code) {
		must(['gh', 'repo', 'create', basename(dir), values.public ? '--public' : '--private', '--source', dir, '--remote', 'origin'], { cwd: dir });
		say(`github: created ${must(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: dir })}`);
	}

	const have = must(['gh', 'secret', 'list', '--json', 'name', '-q', '.[].name'], { cwd: dir }).split('\n');
	const secret = (name, value) => {
		must(['gh', 'secret', 'set', name], { cwd: dir, stdin: Buffer.from(value) });
		say(`secret: ${name}`);
	};
	if (!have.includes('NIX_ACCESS_TOKEN')) {
		const token = nixToken();
		if (token) secret('NIX_ACCESS_TOKEN', token);
		else say('secret: NIX_ACCESS_TOKEN not found (nix.conf access-tokens or $NIX_ACCESS_TOKEN); the weekly update PR needs it, see docs/reference.md#updates-and-tokens');
	}
	if (values.domain && !have.includes('DEPLOY_SSH_KEY')) {
		const tmp = mkdtempSync(join(tmpdir(), 'wdk-key-'));
		try {
			const key = join(tmp, 'id');
			must(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `${values.domain.replaceAll('.', '-')}-deploy`, '-f', key]);
			const scan = must(['ssh-keyscan', '-t', 'ed25519', values.vps]).split('\n').find((l) => l && !l.startsWith('#'));
			if (!scan) throw new Error(`ssh-keyscan ${values.vps} returned no ed25519 key; is the host up?`);
			// No trust on first use: pin only a key you already trust (markers like @revoked do not count).
			const blob = (l) => l.split(' ')[l.split(' ').indexOf('ssh-ed25519') + 1];
			const known = sh(['ssh-keygen', '-F', values.vps, '-f', join(homedir(), '.ssh', 'known_hosts')]).out.split('\n').filter((l) => !l.startsWith('@') && l.includes(' ssh-ed25519 '));
			let all = '';
			try {
				all = readFileSync(join(homedir(), '.ssh', 'known_hosts'), 'utf8');
			} catch {}
			if (all.split('\n').some((l) => l.startsWith('@revoked') && l.includes(' ssh-ed25519 ') && blob(l) === blob(scan))) throw new Error(`${values.vps} answered with a key ~/.ssh/known_hosts marks @revoked; not pinning it`);
			if (!known.length) throw new Error(`${values.vps} has no ed25519 key in ~/.ssh/known_hosts: \`ssh ${values.vps}\` once and verify the fingerprint, then re-run`);
			if (!known.some((l) => blob(l) === blob(scan))) throw new Error(`${values.vps} answered with a different ed25519 key than ~/.ssh/known_hosts has; not pinning it (check the host, or fix known_hosts)`);
			say('host key: matches ~/.ssh/known_hosts');
			const kind = stack === 'kirby' ? '\n    kind = "kirby";' : '';
			const pub = readFileSync(`${key}.pub`, 'utf8').trim();
			// The PR comes before the secrets: if it fails, a re-run makes a new key instead of finding one set.
			const repo = process.env.WDK_VPS_REPO || join(homedir(), 'src', 'vps');
			if (existsSync(join(repo, '.git'))) say(`vps: ${vpsPr(repo, values.domain, kind, pub)}\n  merge it and \`just deploy-production\` in ${repo}, then deploys work`);
			else say(`vps: no repo at ${repo} ($WDK_VPS_REPO); add this site entry and switch, then deploys work:\n  services.sites."${values.domain}" = {${kind}\n    deployKey = "${pub}";\n  };`);
			secret('DEPLOY_HOST_KEY', scan);
			secret('DEPLOY_SSH_KEY', readFileSync(key, 'utf8'));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	if (sh(['git', 'rev-parse', '--abbrev-ref', '@{u}'], { cwd: dir }).code || git('rev-list', '@{u}..HEAD')) {
		git('push', '-q', '-u', 'origin', 'main');
		say('push: main');
	}
	return 0;
}
