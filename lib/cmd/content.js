// wdk content pull|push TARGET [PATH...] [--dry] [--yes]
// Server-owned state (Kirby's content/: the Panel writes it, git never carries it) moves over rsync, merge-only:
// the newer mtime wins on either side, nothing is ever deleted, and every push first takes a server-side backup.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';

const KEEP = 5; // backups per target in ~/.wdk-content-backups on the host
const RSYNC = ['-rlpt', '-u', '-i', '--exclude=.DS_Store', '--exclude=._*'];
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const run1 = (cmd) => Bun.spawnSync(cmd, { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode;

export async function run(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { dry: { type: 'boolean' }, yes: { type: 'boolean' } } });
	const [verb, target, ...rest] = positionals;
	const paths = rest.map((p) => p.replace(/\/+$/, '')); // `a/` would make rsync copy a's contents into the parent
	const { dir: local, targets } = (await loadConfig()).content;
	if (!['pull', 'push'].includes(verb)) throw new Error('usage: wdk content pull|push TARGET [PATH...] [--dry] [--yes]');
	const spec = targets[target];
	const names = Object.keys(targets).join(', ') || 'none';
	if (!spec) throw new Error(`unknown target "${target ?? ''}" (configured: ${names}); set content.targets.NAME = 'user@host:/srv/sites/D/shared/content' in wdk.config.js`);
	const [, host, remote] = spec.match(/^([^:]+):(\/[^']+)$/) ?? [];
	if (!host) throw new Error(`content.targets.${target}: expected 'user@host:/absolute/path', got '${spec}'`);
	const rsync = [...RSYNC, ...(values.dry ? ['-n'] : [])];

	if (verb === 'pull') {
		if (paths.length) throw new Error('pull takes only a target: it merges the whole tree');
		if (!values.dry) mkdirSync(local, { recursive: true });
		if (run1(['rsync', ...rsync, `${host}:${remote}/`, `${local}/`])) return 1;
		console.log(`${values.dry ? 'would pull' : 'pulled'} ${target} into ${local}/ (newer files kept on either side)`);
		return 0;
	}

	if (!existsSync(local) || !readdirSync(local).length) throw new Error(`no local ${local}/ to push: \`wdk content pull ${target}\` first`);
	for (const p of paths) {
		if (p.startsWith('/') || p === '.' || p.split('/').includes('..')) throw new Error(`path '${p}' must be relative to ${local}/ and stay inside it`);
		if (!existsSync(`${local}/${p}`)) throw new Error(`no local ${local}/${p}`);
	}
	if (!values.dry && target === 'production' && !values.yes) throw new Error(`pushing to production: check \`${['wdk content push production', ...paths, '--dry'].join(' ')}\`, then add --yes`);
	if (!values.dry) {
		const tag = remote.slice(1).replaceAll('/', '-');
		const parent = remote.replace(/\/[^/]+\/?$/, '') || '/';
		const name = remote.split('/').filter(Boolean).at(-1);
		const b = '~/.wdk-content-backups';
		// The tree is pool-writable and rsync runs as root: a planted symlink would let a push write anywhere.
		// ponytail: checked once per push, so a link planted mid-push still races it; ssh as the pool user if that matters.
		const links = `[ -z "$(find '${remote}' -type l -print -quit)" ] || { echo "symlink in ${remote}: $(find '${remote}' -type l -print -quit); remove it, a root push would follow it" >&2; exit 3; }`;
		const backup = `${links} && install -d -m 700 ${b} && tar czf ${b}/${tag}-$(date +%Y%m%d-%H%M%S).tar.gz -C '${parent}' '${name}' && ls -1t ${b}/${tag}-*.tar.gz | tail -n +${KEEP + 1} | xargs -r rm -f`;
		if (run1(['ssh', ...SSH, host, backup])) throw new Error(`symlink check or backup on ${host} failed; nothing pushed`);
	}
	const pushes = paths.length ? paths.map((p) => [`${local}/${p}`, `${remote}/${p.includes('/') ? `${p.replace(/\/[^/]+\/?$/, '')}/` : ''}`]) : [[`${local}/`, `${remote}/`]];
	for (const [from, to] of pushes) if (run1(['rsync', ...rsync, from, `${host}:${to}`])) return 1;
	if (values.dry) return console.log(`dry run: nothing changed on ${target}`), 0;
	// Pushed files land as the ssh user; hand them back to whoever owns the tree (the PHP-FPM pool), user and group.
	if (run1(['ssh', ...SSH, host, `chown -R --reference='${remote}' '${remote}'`])) throw new Error(`pushed, but chown on ${host} failed: the Panel cannot edit those files until ${remote} is chowned to the pool user`);
	console.log(`pushed to ${target} (backup in ${host}:.wdk-content-backups, last ${KEEP} kept)`);
	return 0;
}
