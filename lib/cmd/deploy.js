// wdk deploy [release|rollback|list] [--host user@host] [--no-build] [--build-only] [--if-current SHA]
// A release is the built site streamed to the host's restricted deploy key (vps `site-release`): ~seconds.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';

const sh = (cmd, env = {}) => Bun.spawnSync(['bash', '-o', 'pipefail', '-c', cmd], { env: { ...process.env, ...env }, stdio: ['inherit', 'inherit', 'inherit'] });

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
	const cmd = sub === 'release' ? 'tar -C "$DIR" -cf - . | zstd -q -3 | ssh -o BatchMode=yes "$HOST" "release $SHA"' : 'ssh -o BatchMode=yes "$HOST" "$REMOTE"';
	const r = sh(cmd, { DIR: deploy.dir, HOST: host, SHA: sha, REMOTE: remote, COPYFILE_DISABLE: '1' });
	if (r.exitCode) {
		console.error(`wdk deploy: deploy to ${host} failed (exit ${r.exitCode}). Key rejected? Check DEPLOY_SSH_KEY and that the vps site has deployKey set to its public half.`);
		return 1;
	}
	return 0;
}
