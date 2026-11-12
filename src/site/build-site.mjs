// Generates every HTML page of the site (temporary minimal version).
import fs from 'node:fs';
import path from 'node:path';

export async function buildSite({ outdir, base, manifest }) {
  const html = `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>PDF Edit</title>
    <link rel="stylesheet" href="${base}${manifest['app-styles'].css}" />
    <script type="application/json" id="pe-config">%%PUBLIC_CONFIG%%</script>
  </head>
  <body>
    <div id="app"></div>
    <div id="print-container" aria-hidden="true"></div>
    <script type="module" src="${base}${manifest.app.js}"></script>
  </body>
</html>
`;
  fs.mkdirSync(path.join(outdir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(outdir, 'app', 'index.html'), html);
  return ['app/index.html'];
}
