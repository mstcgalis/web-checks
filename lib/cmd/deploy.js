// wdk deploy [release|rollback|list] [--host user@host] [--no-build] [--build-only] [--if-current SHA]
// A release is the built site streamed to the host's restricted deploy key (vps `site-release`): ~seconds.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';

const sh = (cmd, env = {}) => Bun.spawnSync(['bash', '-o', 'pipefail', '-c', cmd], { env: { ...process.env, ...env }, stdio: ['inherit', 'inherit', 'inherit'] });

// Local files by relative path -> sha256 (symlinks -> null: always sent).
function localFiles(dir) {
	const out = new Map();
	for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		const rel = join(e.parentPath, e.name).slice(dir.length).replace(/^\/+/, '');
		if (e.isSymbolicLink()) out.set(rel, null);
		else if (e.isFile()) out.set(rel, new Bun.CryptoHasher('sha256').update(readFileSync(join(dir, rel))).digest('hex'));
	}
	return out;
}

// The host's current release as path -> sha256 ('' when there is none or the host predates `manifest`).
function remoteFiles(host) {
	const r = Bun.spawnSync(['ssh', '-o', 'BatchMode=yes', host, 'manifest']);
	const out = new Map();
	if (r.exitCode) return out;
	for (const line of r.stdout.toString().split('\n')) {
		const m = /^([0-9a-f]{64}) {2}\.\/(.+)$/.exec(line);
		if (m) out.set(m[2], m[1]);
	}
	return out;
}

const fail = (b) => {
	throw new Error(`build failed (${b}); fix it, then deploy again`);
};

export async function run(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { host: { type: 'string' }, 'no-build': { type: 'boolean' }, 'build-only': { type: 'boolean' }, 'if-current': { type: 'string' } } });
	const { deploy } = await loadConfig();
	if (values['build-only']) return sh(deploy.build).exitCode ? fail(deploy.build) : 0; // CI builds before the deploy key is on disk
	const host = values.host || deploy.host;
	if (!host) throw new Error('no deploy host: set deploy.host in wdk.config.js or pass --host user@host');
	const [sub = 'release'] = positionals;
	if (!['release', 'rollback', 'list'].includes(sub)) throw new Error(`unknown deploy command "${sub}" (release | rollback | list)`);
	const remote = sub === 'rollback' && values['if-current'] ? `rollback --if-current ${values['if-current']}` : sub;
	let sha = '';
	if (sub === 'release') {
		sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim();
		if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('not a git repository with a commit: deploy names a release by commit sha');
		if (!values['no-build'] && sh(deploy.build).exitCode) fail(deploy.build);
		if (!existsSync(deploy.dir)) throw new Error(`deploy.dir "${deploy.dir}" does not exist: run the build, or set deploy.dir in wdk.config.js`);
	}
	let delta = null;
	if (sub === 'release') {
		const remote = remoteFiles(host);
		if (remote.size) {
			const local = localFiles(deploy.dir);
			const changed = [...local].filter(([p, h]) => h === null || remote.get(p) !== h).map(([p]) => p);
			const removed = [...remote.keys()].filter((p) => !local.has(p));
			const tmp = mkdtempSync(join(tmpdir(), 'wdk-deploy-'));
			// .wdk-delete rides in the tar from the deploy dir itself (bsdtar applies a later -C to the whole -T list); removed after.
			writeFileSync(join(deploy.dir, '.wdk-delete'), removed.join('\n') + (removed.length ? '\n' : ''));
			writeFileSync(join(tmp, 'list'), [...changed, '.wdk-delete'].map((p) => `./${p}`).join('\n') + '\n');
			delta = { tmp, summary: `${changed.length} changed, ${removed.length} removed` };
		}
	}
	const full = 'tar -C "$DIR" -cf - . | zstd -q -3 | ssh -o BatchMode=yes "$HOST" "release $SHA"';
	const inc = 'cd "$DIR" && tar -cf - -T "$TMP/list" | zstd -q -3 | ssh -o BatchMode=yes "$HOST" "release $SHA --delta"';
	const cmd = sub === 'release' ? (delta ? inc : full) : 'ssh -o BatchMode=yes "$HOST" "$REMOTE"';
	const r = sh(cmd, { DIR: deploy.dir, HOST: host, SHA: sha, REMOTE: remote, TMP: delta?.tmp ?? '', COPYFILE_DISABLE: '1' });
	if (delta) rmSync(join(deploy.dir, '.wdk-delete'), { force: true });
	if (!r.exitCode && delta) console.log(`wdk deploy: ${delta.summary}`);
	if (r.exitCode) {
		console.error(`wdk deploy: deploy to ${host} failed (exit ${r.exitCode}). Key rejected? Check DEPLOY_SSH_KEY and that the vps site has deployKey set to its public half.`);
		return 1;
	}
	return 0;
}
