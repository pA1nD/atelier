/* atelier · build pipeline — JSX via esbuild, CSS via Tailwind v4 (+ oxide scanner).
 *
 * No registration, no dist/ folder. The runner passes a source path and gets
 * the compiled bytes back. Output is cached keyed by source path and
 * invalidated when any dependency's mtime changes. First request per source
 * pays the compile cost (<500ms typical); every request after is from memory.
 *
 * (Extracted from the former atelier.js when the install CLI was removed —
 * an atelier instance is just a folder you run, never an install step.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform as esbuildTransform, build as esbuildBuild } from 'esbuild';
import { compile as twCompile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

const cache = new Map();   // srcPath → { mtimeMs, content, contentType }

function maxMtime(paths) {
  let m = 0;
  for (const p of paths) {
    try { m = Math.max(m, fs.statSync(p).mtimeMs); } catch {}
  }
  return m;
}

async function runJsx(srcPath) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const result = await esbuildTransform(src, {
    loader: 'jsx',
    format: 'esm',                     // each file is an ES module
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    target: 'es2020',
    sourcefile: srcPath,
    minify: false,
  });
  return result.code;
}

async function runCss(srcPath, scanSources, scanBase) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const compiler = await twCompile(src, {
    base: scanBase,
    onDependency: () => {},
  });
  const scanner = new Scanner({
    sources: scanSources.map((abs) => ({
      base: scanBase,
      pattern: path.relative(scanBase, abs),
      negated: false,
    })),
  });
  return compiler.build(scanner.scan());
}

export async function getJsx(srcPath) {
  const mtime = maxMtime([srcPath]);
  const cached = cache.get(srcPath);
  if (cached && cached.mtimeMs === mtime) return cached;
  const entry = {
    mtimeMs: mtime,
    content: await runJsx(srcPath),
    contentType: 'application/javascript; charset=utf-8',
  };
  cache.set(srcPath, entry);
  return entry;
}

// Recursive max-mtime over a directory tree. Skips node_modules / dotfiles
// / data/ so npm-install timestamps don't dominate the result. Used for
// cache-busting bundled chromes whose source spans many files.
function maxMtimeRecursive(rootDir) {
  let m = 0;
  const skip = new Set(['node_modules', 'data']);
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of names) {
      if (ent.name.startsWith('.') || skip.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        try { m = Math.max(m, fs.statSync(p).mtimeMs); } catch {}
      }
    }
  };
  walk(rootDir);
  return m;
}

// Bundle a JSX entry plus its full first-party dep graph via esbuild (instead
// of the per-file transform). Used for chrome modules that bring real npm
// dependencies (Headless UI, motion, heroicons, etc.). React + ReactDOM are
// externalized: aliased to ./shims/{react,react-dom}.js, which re-export
// `window.React` / `window.ReactDOM` so the chrome shares the same React
// instance as the shell. Returns the same shape as getJsx so the asset
// response path is unified.
export async function getJsxBundle(srcPath, absWorkingDir) {
  // Bundle invalidates when ANY file inside absWorkingDir changes (modulo
  // node_modules/dotfiles). Catalyst-style kits live in side-by-side .jsx
  // files; editing one must rebuild the bundle.
  const mtime = maxMtimeRecursive(absWorkingDir);
  const cacheKey = srcPath + '::bundle';
  const cached = cache.get(cacheKey);
  if (cached && cached.mtimeMs === mtime) return cached;
  const result = await esbuildBuild({
    entryPoints: [srcPath],
    absWorkingDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    sourcemap: 'inline',
    target: ['es2020'],
    loader: { '.jsx': 'jsx', '.js': 'jsx', '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    // Automatic JSX runtime — some chrome files use JSX without importing
    // React directly. The runtime import resolves via the alias below.
    jsx: 'automatic',
    // Most UI libs check `process.env.NODE_ENV`; define it so they tree-shake
    // correctly and don't crash on `process` undefined.
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env': '{}',
    },
    // Route bare `react` / `react-dom` imports (including transitive ones from
    // Headless UI / motion / heroicons) to atelier's shim files. Works for
    // both direct and transitive imports.
    alias: {
      'react': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shims/react.js'),
      'react-dom': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shims/react-dom.js'),
      'react/jsx-runtime': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shims/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shims/jsx-runtime.js'),
    },
    logLevel: 'silent',
  });
  const entry = {
    mtimeMs: mtime,
    content: result.outputFiles[0].text,
    contentType: 'application/javascript; charset=utf-8',
  };
  cache.set(cacheKey, entry);
  return entry;
}

export async function getCss(srcPath, scanSources, scanBase) {
  // scanSources are absolute paths; they drive both mtime checks and the
  // scanner's pattern list.
  const mtime = maxMtime([srcPath, ...scanSources]);
  const cached = cache.get(srcPath);
  if (cached && cached.mtimeMs === mtime) return cached;
  const entry = {
    mtimeMs: mtime,
    content: await runCss(srcPath, scanSources, scanBase),
    contentType: 'text/css; charset=utf-8',
  };
  cache.set(srcPath, entry);
  return entry;
}
