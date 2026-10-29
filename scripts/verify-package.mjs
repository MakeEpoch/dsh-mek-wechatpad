/** Verify the shipped archive with fresh production dependencies, without source links. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'wechatpad-package-'));
function npm(args, cwd) {
  const result = spawnSync(process.env.NPM_BIN || 'npm', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout;
}
try {
  const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory], project));
  for (const required of ['host/index.js', 'lib/client.js', 'cordis.patch.yml']) {
    assert.ok(packed.files.some(({path}) => path === required), `missing ${required}`);
  }
  assert.ok(!packed.files.some(({path}) => /node_modules|\.env|artifacts/.test(path)), 'private/development files in archive');
  const target = join(directory, 'consumer');
  await mkdir(target);
  await writeFile(join(target, 'package.json'), '{"name":"wechatpad-package-check","private":true}');
  npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename)], target);
  const require = createRequire(join(target, 'package.json'));
  const root = await realpath(join(target, 'node_modules/dsh-mek-wechatpad'));
  assert.ok(root.startsWith(target + '/'));
  const installed = createRequire(join(root, 'package.json'));
  for (const name of ['ws', 'qrcode', 'silk-wasm']) {
    const path = await realpath(installed.resolve(name));
    const rel = relative(target, path);
    assert.ok(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), `${name} escaped isolated installation`);
    installed(name);
  }
  const { WebSocketServer } = installed('ws');
  new WebSocketServer({noServer: true}).close();
  const qr = await installed('qrcode').toDataURL('package-check');
  assert.match(qr, /^data:image\/png;base64,/);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.ok(!Object.values(manifest.dependencies).some(value => /^(link:|file:)/.test(value)));
  console.log('PASS: packed Host/Client and all runtime dependencies work in an isolated installation');
} finally { await rm(directory, { recursive: true, force: true }); }
