// wdk new <stack> <dir> [--domain D --vps HOST] [--public] [--no-github]: a project from a template, committed,
// on GitHub (private by default) with its CI secrets. Each step is skipped when already done, so a re-run
// finishes a half-made project. --domain/--vps add the deploy: a fresh key in the repo secrets, deploy.host
// in wdk.config.js, and the vps site entry printed for you to add.
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
			secret('DEPLOY_HOST_KEY', scan);
			secret('DEPLOY_SSH_KEY', readFileSync(key, 'utf8'));
			const kind = stack === 'kirby' ? '\n    kind = "kirby";' : '';
			say(`vps: add this site entry and switch, then deploys work:\n  services.sites."${values.domain}" = {${kind}\n    deployKey = "${readFileSync(`${key}.pub`, 'utf8').trim()}";\n  };`);
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
