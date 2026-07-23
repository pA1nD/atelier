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
  // Feed the scanner explicit file contents (scanFiles) — never let oxide
  // discover sources itself. With {base, pattern} sources whose patterns
  // escape base via `../..`, its native walker traverses the common ancestor
  // (all of ~/pro) synchronously on the main thread: 6 s warm, 60+ s cold,
  // per styles.css rebuild. Reading the files here is async; the remaining
  // sync parse is ~200 ms.
  const contents = await Promise.all(scanSources.map(async (abs) => ({
    content: await fs.promises.readFile(abs, 'utf8').catch(() => ''),
    extension: path.extname(abs).slice(1) || 'js',
  })));
  const scanner = new Scanner({ sources: [] });
  return compiler.build(scanner.scanFiles(contents));
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
// dependencies (a component library, an animation lib, an icon set, etc.).
// React + ReactDOM are
// externalized: aliased to ./shims/{react,react-dom}.js, which re-export
// `window.React` / `window.ReactDOM` so the chrome shares the same React
// instance as the shell. Returns the same shape as getJsx so the asset
// response path is unified.
export async function getJsxBundle(srcPath, absWorkingDir, nodeEnv = 'development') {
  // Bundle invalidates when ANY file inside absWorkingDir changes (modulo
  // node_modules/dotfiles). A chrome's kit may live in side-by-side .jsx
  // component files; editing one must rebuild the bundle. `nodeEnv` is part of
  // the key so a dev↔prod switch never serves a stale bundle.
  const mtime = maxMtimeRecursive(absWorkingDir);
  const cacheKey = srcPath + '::bundle::' + nodeEnv;
  const cached = cache.get(cacheKey);
  if (cached && cached.mtimeMs === mtime) return cached;
  const prod = nodeEnv === 'production';
  const result = await esbuildBuild({
    entryPoints: [srcPath],
    absWorkingDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    // Production minifies and drops the (large, source-revealing) inline source
    // map; development keeps both off for a readable, debuggable bundle.
    minify: prod,
    sourcemap: prod ? false : 'inline',
    target: ['es2020'],
    loader: { '.jsx': 'jsx', '.js': 'jsx', '.svg': 'dataurl', '.png': 'dataurl' },
    // Automatic JSX runtime — some chrome files use JSX without importing
    // React directly. The runtime import resolves via the alias below.
    jsx: 'automatic',
    // Bundled npm libs check `process.env.NODE_ENV` (dev warnings + tree-shaking)
    // and read `process.env`; the browser has no `process`, so define both. The
    // NODE_ENV value follows the `env` setting ('development' by default).
    define: {
      'process.env.NODE_ENV': JSON.stringify(nodeEnv),
      'process.env': '{}',
    },
    // CSS imports aren't bundled — chrome styles ship via `styles.css` + the
    // render-blocking <link>, not a JS `import`. Fail LOUD (an actionable build
    // error → a 500 on the bundle the author sees) rather than silently dropping
    // the import with an `empty` loader.
    plugins: [{
      name: 'atelier-no-css-import',
      setup(build) {
        build.onLoad({ filter: /\.css$/ }, (args) => ({
          errors: [{ text: `CSS imports aren't bundled in atelier — \`import\` of "${path.basename(args.path)}" is not supported. Put chrome styles in styles.css (served via <link>), not a JS import.` }],
        }));
      },
    }],
    // Route bare `react` / `react-dom` imports (including transitive ones from
    // a bundled UI library) to atelier's shim files. Works for
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

const inflightCss = new Map();   // srcPath → { mtimeMs, promise }

export async function getCss(srcPath, scanSources, scanBase) {
  // scanSources are absolute paths; they drive both mtime checks and the
  // scanner's content list.
  const mtime = maxMtime([srcPath, ...scanSources]);
  const cached = cache.get(srcPath);
  if (cached && cached.mtimeMs === mtime) return cached;
  // After an invalidation every open tab re-requests styles.css at once; they
  // must share ONE build, not run serial rebuilds back-to-back.
  const running = inflightCss.get(srcPath);
  if (running && running.mtimeMs === mtime) return running.promise;
  const promise = (async () => {
    try {
      const entry = {
        mtimeMs: mtime,
        content: await runCss(srcPath, scanSources, scanBase),
        contentType: 'text/css; charset=utf-8',
      };
      cache.set(srcPath, entry);
      return entry;
    } finally {
      // Only clear our own entry — an edit mid-build means a newer build may
      // have replaced it, and deleting that one would let a third concurrent
      // request start a duplicate.
      if (inflightCss.get(srcPath)?.promise === promise) inflightCss.delete(srcPath);
    }
  })();
  inflightCss.set(srcPath, { mtimeMs: mtime, promise });
  return promise;
}
