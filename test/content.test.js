import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WDK = join(import.meta.dir, '..', 'bin', 'wdk.js');
const T = 'root@h:/srv/sites/x.cz/shared/content';

// A project with content/a/b.txt and stub ssh/rsync that log their arguments, one call per line.
function setup(sshExit = 0) {
	const dir = mkdtempSync(join(tmpdir(), 'wdk-content-'));
	mkdirSync(join(dir, 'content', 'a'), { recursive: true });
	writeFileSync(join(dir, 'content', 'a', 'b.txt'), 'x');
	writeFileSync(join(dir, 'wdk.config.js'), `export default { content: { targets: { staging: '${T}', production: '${T}' } } };`);
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	for (const [c, code] of [['ssh', sshExit], ['rsync', 0]]) {
		writeFileSync(join(bin, c), `#!/bin/sh\necho "${c} $*" >> "${dir}/log"\nexit ${code}\n`);
		chmodSync(join(bin, c), 0o755);
	}
	return { dir, bin };
}
function content(s, ...args) {
	const r = Bun.spawnSync(['bun', WDK, 'content', ...args], { cwd: s.dir, env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` } });
	let log = '';
	try { log = readFileSync(join(s.dir, 'log'), 'utf8'); } catch {}
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), log };
}
const R = 'rsync -rlpt -u -i --exclude=.DS_Store --exclude=._*';

test('push backs up, merges the whole tree, then hands it back to the tree owner', () => {
	const r = content(setup(), 'push', 'staging');
	expect(r.code).toBe(0);
	const [backup, sync, chown] = r.log.trim().split('\n');
	expect(backup).toContain("tar czf ~/.wdk-content-backups/srv-sites-x.cz-shared-content-");
	expect(backup).toContain("-C '/srv/sites/x.cz/shared' 'content'");
	expect(backup).toContain('tail -n +6');
	expect(sync).toBe(`${R} content/ root@h:/srv/sites/x.cz/shared/content/`);
	expect(chown).toBe("ssh -o BatchMode=yes -o ConnectTimeout=10 root@h chown -R --reference='/srv/sites/x.cz/shared/content' '/srv/sites/x.cz/shared/content'");
});

test('a path push lands in its parent on the server; --dry touches nothing', () => {
	const r = content(setup(), 'push', 'staging', 'a/b.txt', 'a/', '--dry');
	expect(r.code).toBe(0);
	expect(r.log.trim().split('\n')).toEqual([`${R} -n content/a/b.txt root@h:/srv/sites/x.cz/shared/content/a/`, `${R} -n content/a root@h:/srv/sites/x.cz/shared/content/`]);
});

test('pull merges the server tree into content/', () => {
	const r = content(setup(), 'pull', 'staging');
	expect(r.code).toBe(0);
	expect(r.log.trim()).toBe(`${R} root@h:/srv/sites/x.cz/shared/content/ content/`);
});

test('refusals: production without --yes, escaping paths, missing paths, unknown target, failed backup', () => {
	const s = setup();
	expect(content(s, 'push', 'production', 'a').err).toContain('`wdk content push production a --dry`, then add --yes');
	expect(content(s, 'push', 'staging', '../x').err).toContain('must be relative');
	expect(content(s, 'push', 'staging', 'nope').err).toContain('no local content/nope');
	expect(content(s, 'push', 'prod').err).toContain('configured: staging, production');
	expect(content(s).code).toBe(2);
	expect(content(s).log).toBe('');
	const f = content(setup(1), 'push', 'staging');
	expect([f.code, f.err.includes('nothing pushed'), f.log.includes('rsync')]).toEqual([2, true, false]);
});
