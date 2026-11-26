import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const output = resolve(process.argv[2] || '');
const root = resolve(import.meta.dirname, '..');
if (!process.argv[2] || output.startsWith(root + '\\') || output.startsWith(root + '/')) throw Error('Use an external package directory');
mkdirSync(output, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: [...['index', 'owner-bind', 'owner-status', 'owner-maintenance', 'owner-update'].map(name => `src/connector/${name}.ts`), 'src/browser-control/mcp-server.ts'],
  outbase: 'src', outdir: join(output, 'build'),
  bundle: true, platform: 'node', target: 'node24', format: 'esm',
  external: ['sharp'],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: 'linked', metafile: true,
});
// sharp's native loader must remain on disk. Copy only its installed runtime
// dependency graph, rather than the web/relay dependency tree.
const copied = new Set();
function copyPackage(name, from) {
  const require = createRequire(join(from, 'package.json'));
  let entry;
  try { entry = require.resolve(name); } catch { entry = require.resolve(name + '/package'); }
  let directory = dirname(entry);
  for (;;) {
    try { if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name === name) break; } catch { }
    const parent = dirname(directory);
    if (parent === directory) throw Error('Cannot locate native dependency ' + name);
    directory = parent;
  }
  if (copied.has(name)) return;
  copied.add(name);
  cpSync(directory, join(output, 'node_modules', name), { recursive: true });
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(metadata.dependencies || {})) copyPackage(dependency, directory);
}
copyPackage('sharp', root);
copyPackage('@img/sharp-win32-x64', root);
const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(output, 'package.json'), JSON.stringify({ name: project.name, version: project.version, type: 'module', private: true }));
writeFileSync(join(output, 'bundle-notice.json'), JSON.stringify({ nativePackages: [...copied], sourceFiles: Object.keys(result.metafile.inputs).length }, null, 2));
console.log(`Bundled Connector and ${copied.size} native runtime packages.`);
