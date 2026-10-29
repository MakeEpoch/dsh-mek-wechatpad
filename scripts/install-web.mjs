/** Install a built, immutable package into an existing dsh Web profile. */
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const dshBin = process.env.DSH_BIN || 'dsh';
const home = process.env.DSH_HOME || join(process.env.HOME ?? '.', '.dsh');
const profileName = process.env.DSH_PROFILE || 'web';
const profile = await realpath(join(home, 'profiles', profileName));
const manifestPath = join(profile, 'package.json');
const plugin = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!(manifest.dsh?.profile?.bundles ?? []).includes('@deepseek-ai/dsh-web-app')) {
  throw new Error(`${manifestPath} is not a dsh Web profile`);
}
const client = await readFile(join(project, 'lib/client.js'), 'utf8');
if (!client.includes('window.__ModuleLoader__.load(')) throw new Error('run npm run build first');
for (const name of ['ws', 'qrcode', 'silk-wasm']) {
  if (!plugin.dependencies?.[name]) throw new Error(`missing runtime dependency: ${name}`);
}
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ profile, plugin: plugin.name, version: plugin.version, mode: 'packed archive (no source link)' }, null, 2));
  process.exit(0);
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: project, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ''}`);
  return result.stdout;
}
const artifacts = join(project, 'artifacts');
await mkdir(artifacts, { recursive: true });
const packed = JSON.parse(run(process.env.NPM_BIN || 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', artifacts]));
if (packed.length !== 1) throw new Error('expected one package archive');
const archive = join(artifacts, packed[0].filename);
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
const cache = join(profile, '.plugin-manager', 'packages');
await mkdir(cache, { recursive: true, mode: 0o700 });
const cachedArchive = join(cache, `wechatpad-${plugin.version}-${sha256}.tgz`);
await copyFile(archive, cachedArchive);
const spec = `file:${cachedArchive}`;
const alreadyInstalled = manifest.dependencies?.[plugin.name] === spec;
let backup = null;
if (!alreadyInstalled) {
  backup = join(profile, '.plugin-manager', `wechatpad-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const saved = [];
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'cordis.yml']) {
    try { await copyFile(join(profile, name), join(backup, name)); saved.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await writeFile(join(backup, 'backup.json'), `${JSON.stringify({ profile, files: saved }, null, 2)}\n`, { mode: 0o600 });
  console.log(`backup: ${backup}`);
  run(dshBin, ['plugin', '--profile', profileName, 'add', '-w', spec, '--ignore-scripts', ...(process.argv.includes('--offline') ? ['--offline'] : [])], { stdio: 'inherit' });
}
const installed = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!installed.dsh.profile.bundles.includes(plugin.name)) { installed.dsh.profile.bundles.push(plugin.name); await writeFile(manifestPath, JSON.stringify(installed, null, 2) + '\n'); }
const resolved = await realpath(join(profile, 'node_modules', ...plugin.name.split('/')));
function insideProfile(path) {
  const rel = relative(profile, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
if (installed.dependencies?.[plugin.name] !== spec) throw new Error('profile dependency mismatch');
if (!(installed.dsh?.profile?.bundles ?? []).includes(plugin.name)) throw new Error('bundle not selected');
if (!insideProfile(resolved)) throw new Error(`plugin resolves outside profile: ${resolved}`);
const requireInstalled = createRequire(join(resolved, 'package.json'));
const dependencies = {};
for (const name of ['ws', 'qrcode', 'silk-wasm']) {
  const path = await realpath(requireInstalled.resolve(name));
  if (!insideProfile(path)) throw new Error(`${name} resolves outside profile`);
  dependencies[name] = path;
}
const receipt = { profile, version: plugin.version, sha256, archive: cachedArchive, backup, alreadyInstalled,
  verified: { manifest: true, bundleSelected: true, resolver: resolved, dependencies },
  note: 'Restart dsh web and reload the page. Disk verification does not prove browser activation.' };
await writeFile(join(artifacts, 'dsh-install.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
