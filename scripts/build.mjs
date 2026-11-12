// Builds the site into dist/: bundles the editor, the landing-page script and
// the admin page with esbuild, copies the pdf.js runtime files and fonts and
// generates every HTML page.
//
//   node scripts/build.mjs          production build (minified, pre-compressed)
//   node scripts/build.mjs --dev    readable bundles with inline source maps
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');
const dev = process.argv.includes('--dev');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const pdfjsPkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'package.json'), 'utf8'));

// The site is served from the root of its domain (see server/).
const base = '/';

const started = Date.now();
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(path.join(outdir, 'assets'), { recursive: true });

// ---------------------------------------------------------------- pdf.js runtime
// The legacy build carries the polyfills needed by browsers that are a few
// years old; it is used for the display layer and the worker alike.
const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist');
const pdfjsDir = `assets/pdfjs-${pdfjsPkg.version}`;
fs.mkdirSync(path.join(outdir, pdfjsDir), { recursive: true });
fs.copyFileSync(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.worker.min.mjs'), path.join(outdir, pdfjsDir, 'pdf.worker.mjs'));
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = path.join(pdfjsRoot, dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(outdir, pdfjsDir, dir), { recursive: true });
}

// ---------------------------------------------------------------- static assets
fs.cpSync(path.join(root, 'src', 'assets', 'fonts'), path.join(outdir, 'assets', 'fonts'), { recursive: true });
const publicDir = path.join(root, 'src', 'public');
if (fs.existsSync(publicDir)) fs.cpSync(publicDir, outdir, { recursive: true });

// ---------------------------------------------------------------- bundles
const entryPoints = {
  app: path.join(root, 'src', 'renderer', 'js', 'main.js'),
  'app-styles': path.join(root, 'src', 'renderer', 'css', 'app.css'),
};
for (const [name, file] of [
  ['site', path.join(root, 'src', 'site', 'site.js')],
  ['site-styles', path.join(root, 'src', 'site', 'site.css')],
  ['admin', path.join(root, 'src', 'site', 'admin.js')],
  ['pay', path.join(root, 'src', 'site', 'pay.js')],
]) {
  if (fs.existsSync(file)) entryPoints[name] = file;
}

const result = await build({
  entryPoints,
  bundle: true,
  outdir,
  entryNames: 'assets/[name]-[hash]',
  chunkNames: 'assets/chunk-[hash]',
  assetNames: 'assets/[name]-[hash]',
  publicPath: base,
  format: 'esm',
  splitting: true,
  target: ['chrome100', 'edge100', 'firefox100', 'safari15.4'],
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
  loader: { '.svg': 'text', '.woff2': 'file', '.woff': 'file', '.png': 'file', '.jpg': 'file' },
  define: {
    'process.env.NODE_ENV': dev ? '"development"' : '"production"',
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BASE__: JSON.stringify(base),
    __PDFJS_BASE__: JSON.stringify(`${base}${pdfjsDir}/`),
    __FONT_BASE__: JSON.stringify(`${base}assets/fonts/`),
  },
  platform: 'browser',
  mainFields: ['browser', 'module', 'main'],
});

// entry name -> { js, css } URL paths (without the base prefix).
const manifest = {};
for (const [outFile, info] of Object.entries(result.metafile.outputs)) {
  if (!info.entryPoint) continue;
  const rel = path.relative(outdir, path.join(root, outFile)).split(path.sep).join('/');
  const name = Object.keys(entryPoints).find((k) => path.resolve(entryPoints[k]) === path.resolve(root, info.entryPoint));
  if (!name) continue;
  manifest[name] = manifest[name] || {};
  if (rel.endsWith('.css')) manifest[name].css = rel;
  else manifest[name].js = rel;
  if (info.cssBundle) manifest[name].css = path.relative(outdir, path.join(root, info.cssBundle)).split(path.sep).join('/');
}
// CSS-only entry points leave an empty JS stub behind.
for (const name of Object.keys(manifest)) {
  if (name.endsWith('-styles') && manifest[name].js) {
    fs.rmSync(path.join(outdir, manifest[name].js), { force: true });
    delete manifest[name].js;
  }
}

// ---------------------------------------------------------------- pages
const { buildSite } = await import('../src/site/build-site.mjs');
const pages = await buildSite({ root, outdir, base, manifest, version: pkg.version, dev });

fs.writeFileSync(
  path.join(outdir, 'build.json'),
  JSON.stringify({ version: pkg.version, base, builtAt: new Date().toISOString(), manifest, pages }, null, 2),
);

// ---------------------------------------------------------------- pre-compression
// Text assets are compressed once here; the server picks .br / .gz by the
// Accept-Encoding header. HTML is compressed by the server after templating.
let compressed = 0;
if (!dev) {
  const exts = new Set(['.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.txt', '.xml', '.ttf', '.wasm', '.bcmap']);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.has(path.extname(e.name)) && e.name !== 'build.json') {
        const data = fs.readFileSync(p);
        if (data.length < 1024) continue;
        const br = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
        if (br.length < data.length * 0.92) {
          fs.writeFileSync(`${p}.br`, br);
          fs.writeFileSync(`${p}.gz`, zlib.gzipSync(data, { level: 9 }));
          compressed++;
        }
      }
    }
  };
  walk(outdir);
}

const size = (rel) => (rel && fs.existsSync(path.join(outdir, rel)) ? `${(fs.statSync(path.join(outdir, rel)).size / 1024).toFixed(0)} KB` : '-');
console.log(`Built ${pages.length} pages in ${((Date.now() - started) / 1000).toFixed(1)}s (base ${base}${dev ? ', dev' : `, ${compressed} files pre-compressed`})`);
console.log(`  editor: ${size(manifest.app?.js)} js, ${size(manifest['app-styles']?.css)} css · site: ${size(manifest.site?.js)} js, ${size(manifest['site-styles']?.css)} css`);
