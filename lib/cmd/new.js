// wdk new <stack> <dir> [--domain D --vps HOST [--staging]] [--public] [--no-github]: a project from a template,
// committed, on GitHub (private by default) with its CI secrets. Each step is skipped when already done, so a
// re-run finishes a half-made project. --domain/--vps add the deploy: a fresh key in the repo secrets, deploy.host
// in wdk.config.js, and the vps site entry as a PR in the vps repo ($WDK_VPS_REPO, default ~/src/vps; printed if
// absent). --staging adds staging.<domain>, deployed from a staging branch with its own key. --wait polls until the
// vps entry is switched in and runs the first deploy. Run bare in a terminal, it asks for what the flags would say.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { release, repin } from './update.js';

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

// The sites (production, and staging with --staging) as one vps module each, committed from a temp worktree
// (the user's vps tree is left alone), pushed to site/<slug> and opened as one PR. A new public host is
// tunnel-only, so it starts on `tls internal` (vps portfolio-sites.nix); a subdomain gets no www vhost.
// Their DNS records go in the same PR.
// ponytail: always the production host; a --vps that maps to another nix/hosts/* needs a flag.
const isSub = (domain) => domain.split('.').length > 2; // ponytail: example.co.uk reads as a subdomain; set www by hand there
const entry = (site, kind) =>
	`services.sites."${site.domain}" = {${isSub(site.domain) ? '\n    www = false;' : ''}${site.slug === site.domain.replaceAll('.', '-') ? '' : `\n    slug = "${site.slug}";`}${kind}${site.staging ? '\n    # Unreleased work is never crawled.\n    extraConfig = \'\'header X-Robots-Tag "noindex, nofollow"\'\';' : ''}\n    deployKey = "${site.pub}";\n  };`;
function vpsPr(repo, sites, kind) {
	const branch = `site/${sites[0].slug}`;
	const wt = mkdtempSync(join(tmpdir(), 'wdk-vps-'));
	const w = (...a) => must(['git', '-C', wt, ...a]);
	try {
		must(['git', '-C', repo, 'fetch', '-q', 'origin', 'main']);
		must(['git', '-C', repo, 'worktree', 'add', '-q', '-f', '-B', branch, wt, 'origin/main']);
		for (const site of sites) {
			const { domain, slug } = site;
			const sub = isSub(domain);
			const hosts = sub ? [domain] : [domain, `www.${domain}`];
			writeFileSync(
				join(wt, 'nix', 'modules', `${slug}.nix`),
				`# ${domain}: deployed by \`wdk deploy\` (modules/site.nix), entry from \`wdk new\`.
# tls internal: a new tunnel-only host can't get a first public cert (portfolio-sites.nix).
{ lib, ... }:
{
  services.caddy.virtualHosts = lib.genAttrs [ ${hosts.map((h) => `"${h}"`).join(' ')} ] (_: { extraConfig = lib.mkBefore "tls internal"; });
  ${entry(site, kind)}
}
`,
			);
			const host = join(wt, 'nix', 'hosts', 'production', 'default.nix');
			const text = readFileSync(host, 'utf8');
			const next = text.replace(/(imports = \[[^\]]*?)(\n\s*\];)/, `$1\n    ../../modules/${slug}.nix$2`);
			if (next === text) throw new Error(`${host.slice(wt.length + 1)} in ${repo} has no imports list to add ${slug}.nix to`);
			writeFileSync(host, next);
			// DNS: a proxied tunnel CNAME, plus www for an apex. The zone must already be on Cloudflare.
			const dns = join(wt, 'tofu', 'dns', 'dns.auto.tfvars');
			const labels = domain.split('.');
			const record = `  "${domain}" = {\n    zone        = "${labels.slice(-2).join('.')}"\n    record_name = "${sub ? labels.slice(0, -2).join('.') : '@'}"\n    tunnel      = true\n  }`;
			const tf = readFileSync(dns, 'utf8');
			let tfNext = tf.replace(/(^domains = \{[\s\S]*?)(\n\}\n)/m, `$1\n${record}$2`);
			if (!sub) tfNext = tfNext.replace(/^(www_redirect_domains = \[)([^\]]*?)\s*\]/m, (_, head, list) => `${head}${list}${list.trim() ? ', ' : ''}"${domain}"]`);
			if (tfNext.split('\n').length !== tf.split('\n').length + 5 || (!sub && !tfNext.includes(`"${domain}"]`))) throw new Error(`tofu/dns/dns.auto.tfvars in ${repo} has no domains map${sub ? '' : ' or www_redirect_domains list'} to add ${domain} to`);
			writeFileSync(dns, tfNext);
		}
		w('add', '-A');
		w('commit', '-qm', `feat(sites): ${sites.map((s) => s.domain).join(', ')}, from wdk new`);
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
		options: { domain: { type: 'string' }, vps: { type: 'string' }, staging: { type: 'boolean' }, wait: { type: 'boolean' }, public: { type: 'boolean' }, 'no-github': { type: 'boolean' } },
	});
	// A person at a terminal gets asked; an agent (no TTY) gets the usage line. WDK_NEW_PROMPT: tests.
	if (!positionals.length && (process.stdin.isTTY || process.env.WDK_NEW_PROMPT)) {
		const ask = (q, d = '') => (prompt(`${q}${d ? ` [${d}]` : ''}:`) ?? '').trim() || d;
		positionals.push(ask(`stack (${STACKS.join('|')})`, 'static'), ask('dir'));
		values.domain ||= ask('domain (empty: no deploy)') || undefined;
		if (values.domain) {
			values.vps ||= ask('vps host');
			values.staging ||= /^y/i.test(ask('staging too? y/N', 'n'));
			values.wait ||= /^y/i.test(ask('wait for the vps switch? y/N', 'n'));
		}
	}
	const [stack, target] = positionals;
	if (!STACKS.includes(stack) || !target) throw new Error(`usage: wdk new <${STACKS.join('|')}> <dir> [--domain D --vps HOST [--staging] [--wait]] [--public] [--no-github]`);
	if (!values.domain !== !values.vps) throw new Error('--domain and --vps go together (the deploy user is <domain with - for .>-deploy@<vps>)');
	if (values.staging && !values.domain) throw new Error('--staging needs --domain and --vps (it deploys staging.<domain>)');
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
		// A tagged wdk's templates are still locked to the previous release (release.sh locks them after tagging).
		if (!readFileSync(join(wf, 'deploy.yml'), 'utf8').includes(`# ${tag}\n`)) {
			const { sha } = release(tag);
			for (const f of [join(dir, 'flake.nix'), ...readdirSync(wf).map((f) => join(wf, f))]) writeFileSync(f, repin(readFileSync(f, 'utf8'), tag, sha));
		}
		say(`template: ${stack} (wdk ${tag})`);
	}

	if (!existsSync(join(dir, '.git'))) git('init', '-q', '-b', 'main');
	const commit = (msg) => {
		git('add', '-A');
		if (sh(['git', 'diff', '--cached', '--quiet'], { cwd: dir }).code) (git('commit', '-qm', msg), say(`commit: ${msg}`));
	};
	commit(`chore: start from the wdk ${stack} template`);

	// Production, and with --staging staging.<domain> as user stg-<slug>-deploy from the staging branch.
	const sites = [];
	if (values.domain) {
		const slug = values.domain.replaceAll('.', '-');
		sites.push({ domain: values.domain, slug, secret: 'DEPLOY_SSH_KEY' });
		if (values.staging) sites.push({ domain: `staging.${values.domain}`, slug: `stg-${slug}`, secret: 'STAGING_DEPLOY_SSH_KEY', staging: true });
		for (const s of sites) if (`${s.slug}-deploy`.length > 31) throw new Error(`"${s.slug}-deploy" is over 31 chars (vps user name limit); set a short slug in the vps entry and deploy.host by hand`);
		const host = `${slug}-deploy@${values.vps}`;
		const cfg = join(dir, 'wdk.config.js');
		const text = readFileSync(cfg, 'utf8');
		if (!/^\s*deploy:/m.test(text)) {
			writeFileSync(cfg, text.replace(/\/\/ deploy: \{ host: '[^']*'/, `deploy: { host: '${host}'`));
			if (!/^\s*deploy:/m.test(readFileSync(cfg, 'utf8'))) throw new Error('wdk.config.js has no `// deploy:` line to fill in; add deploy: { host, dir } by hand');
			commit(`chore: deploy to ${host}`);
		}
		// Kirby: the Panel's content/ syncs over root ssh (wdk content). ponytail: filled once; a later --staging adds its target by hand.
		const now = readFileSync(cfg, 'utf8');
		if (/\/\/ content: \{ targets: \{\} \}/.test(now)) {
			const t = sites.map((s) => `${s.staging ? 'staging' : 'production'}: 'root@${values.vps}:/srv/sites/${s.domain}/shared/content'`).join(', ');
			writeFileSync(cfg, now.replace(/\/\/ content: \{ targets: \{\} \}/, `content: { targets: { ${t} } }`));
			commit('chore: content sync targets');
		}
		const stg = join(dir, '.github', 'workflows', 'deploy-staging.yml');
		if (values.staging && !existsSync(stg)) {
			const tag = readFileSync(join(dir, '.github', 'workflows', 'deploy.yml'), 'utf8').match(/deploy\.yml@(.+)/)?.[1] ?? `v${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`;
			writeFileSync(
				stg,
				`name: deploy-staging
# Push to staging: a release on https://staging.${values.domain}/, not gated on the check (staging is not public).
# A failed curl of the site after the flip rolls the release back.
on:
  push:
    branches: [staging]
jobs:
  deploy:
    uses: mstcgalis/web-dev-kit/.github/workflows/deploy.yml@${tag}
    with:
      host: stg-${slug}-deploy@${values.vps}
      url: https://staging.${values.domain}/
    secrets:
      DEPLOY_SSH_KEY: \${{ secrets.STAGING_DEPLOY_SSH_KEY }}
      DEPLOY_HOST_KEY: \${{ secrets.DEPLOY_HOST_KEY }}
      NIX_ACCESS_TOKEN: \${{ secrets.NIX_ACCESS_TOKEN }}
`,
			);
			commit(`chore: deploy staging to stg-${slug}-deploy@${values.vps}`);
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
	const need = sites.filter((s) => !have.includes(s.secret));
	if (need.length) {
		const tmp = mkdtempSync(join(tmpdir(), 'wdk-key-'));
		try {
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
			for (const s of need) {
				s.key = join(tmp, s.slug);
				must(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', `${s.slug}-deploy`, '-f', s.key]);
				s.pub = readFileSync(`${s.key}.pub`, 'utf8').trim();
			}
			// The PR comes before the secrets: if it fails, a re-run makes new keys instead of finding them set.
			const repo = process.env.WDK_VPS_REPO || join(homedir(), 'src', 'vps');
			if (existsSync(join(repo, '.git'))) say(`vps: ${vpsPr(repo, need, kind)}\n  merge it and \`just deploy-production\` in ${repo}, then deploys work`);
			else say(`vps: no repo at ${repo} ($WDK_VPS_REPO); add ${need.length > 1 ? 'these site entries' : 'this site entry'} and switch, then deploys work:\n${need.map((s) => `  ${entry(s, kind)}`).join('\n')}`);
			secret('DEPLOY_HOST_KEY', scan);
			for (const s of need) secret(s.secret, readFileSync(s.key, 'utf8'));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	if (sh(['git', 'rev-parse', '--abbrev-ref', '@{u}'], { cwd: dir }).code || git('rev-list', '@{u}..HEAD')) {
		git('push', '-q', '-u', 'origin', 'main');
		say('push: main');
	}
	if (values.staging && sh(['git', 'ls-remote', '--exit-code', '--heads', 'origin', 'staging'], { cwd: dir }).code) {
		git('push', '-q', 'origin', 'main:refs/heads/staging');
		say('push: staging');
	}

	// The first deploy fails until the vps entry is switched in (no deploy user yet). Once it is, the site serves
	// the vps seed page; re-run the failed deploy then. Re-running wdk new after the switch is the first deploy.
	// WDK_NEW_WAIT_MS: the poll step (tests); a switch is a PR merge plus a deploy, so 30 min is the ceiling.
	const step = Number(process.env.WDK_NEW_WAIT_MS) || 15_000;
	const until = Date.now() + 30 * 60_000;
	for (const s of sites) {
		const url = `https://${s.domain}/`;
		let res, seed, live;
		for (let waited = false; ; waited = true) {
			res = undefined;
			try {
				// WDK_NEW_ORIGIN: tests serve the sites from http://127.0.0.1:PORT/<domain>/.
				const r = await fetch(process.env.WDK_NEW_ORIGIN ? `${process.env.WDK_NEW_ORIGIN}/${s.domain}/` : url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
				res = { status: r.status, body: await r.text() };
			} catch {}
			// ponytail: the seed is "deploying" for static; a kirby seed has no index.php, so php-fpm's own 404.
			seed = res && (res.body === 'deploying\n' || (res.status === 404 && res.body === 'File not found.\n'));
			live = res?.status >= 200 && res.status < 400 && !seed;
			if (seed || live || !values.wait || Date.now() > until) break;
			if (!waited) say(`waiting: ${url} until the vps entry is switched in (merge the vps PR, \`just deploy-production\`)`);
			await Bun.sleep(step);
		}
		if (live) say(`live: ${url}`);
		else if (seed) {
			const wf = s.staging ? 'deploy-staging.yml' : 'deploy.yml';
			const run = must(['gh', 'run', 'list', '--workflow', wf, '-L', '1', '--json', 'databaseId,conclusion', '-q', '.[0] | "\\(.databaseId) \\(.conclusion)"'], { cwd: dir }).split(' ');
			if (run[1] === 'failure') (must(['gh', 'run', 'rerun', run[0], '--failed'], { cwd: dir }), say(`deploy: re-ran ${wf} (the vps entry is live now); ${url} in a minute`));
			else say(`deploy: ${url} is switched in, waiting on ${wf}${run[0] ? ` (run ${run[0]}: ${run[1] || 'in progress'})` : ''}`);
		} else say(`not live yet: ${url} (merge the vps PR, \`just deploy-production\`, then re-run this to deploy)`);
	}
	return 0;
}
