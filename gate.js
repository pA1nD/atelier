/* atelier · the build gate — shared by `package` (a cut that doesn't build
 * never lands) and `update` (a merge that doesn't build never swaps in).
 *
 * Mirrors what the shell will actually do with the module: per-file esbuild
 * transform for frontend sources (they're served per-file), a real bundle for
 * backend.js, and a full bundle for a chrome (chromes bundle with their
 * node_modules, which must be installed for the gate to prove anything).
 * Returns a list of problems — empty means the module builds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as esbuildBuild, transform as esbuildTransform } from 'esbuild';

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'data') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsx|js)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export async function buildProblems(dir, { isChrome = false } = {}) {
  const problems = [];
  const backend = path.join(dir, 'backend.js');
  const frontend = path.join(dir, 'frontend.jsx');
  for (const f of sourceFiles(dir)) {
    if (f === backend) continue;   // the bundle below covers it, with better errors
    try {
      await esbuildTransform(fs.readFileSync(f, 'utf8'), {
        loader: 'jsx', format: 'esm', jsx: 'transform',
        jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
        target: 'es2020', sourcefile: f,
      });
    } catch (e) { problems.push(e.message); }
  }
  if (fs.existsSync(backend)) {
    try {
      await esbuildBuild({
        entryPoints: [backend], bundle: true, format: 'esm', platform: 'node',
        write: false, packages: 'external', target: 'node20', logLevel: 'silent',
        define: { 'import.meta.url': JSON.stringify(pathToFileURL(backend).href) },
      });
    } catch (e) { problems.push(e.message); }
  }
  if (isChrome && fs.existsSync(frontend)) {
    try {
      await esbuildBuild({
        entryPoints: [frontend], bundle: true, format: 'esm', platform: 'browser',
        absWorkingDir: dir, write: false, target: 'es2020', logLevel: 'silent',
        loader: { '.jsx': 'jsx', '.js': 'jsx' },
        jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
        external: ['react', 'react-dom', '@atelier/kit'],
      });
    } catch (e) {
      problems.push(fs.existsSync(path.join(dir, 'node_modules')) ? e.message
        : `${e.message}\n  (a chrome bundles its node_modules — run npm install in ${dir} first)`);
    }
  }
  return problems;
}
