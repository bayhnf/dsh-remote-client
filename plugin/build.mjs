/**
 * Build dsh-remote-servers:
 *   lib/index.js  - Node half: an empty Cordis plugin (the page needs no Host service).
 *   lib/client.js - browser half in the client module system's lazy factory format:
 *                   window.__ModuleLoader__.load({ id, factory(require) { ... } }).
 *
 * Shared modules (React, slots, primitives) are left as require() calls that resolve through
 * the page's frozen module table (packages/client/web/src/platform.ts PLATFORM_MODULES).
 * CSS Modules are compiled to scoped class names and injected once at materialization.
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const here = import.meta.dirname
const manifest = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
const PLATFORM = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives']

/** Compile `*.module.css` into a scoped class map plus a one-time <style> injection. */
const cssModules = {
  name: 'css-modules',
  setup(b) {
    // esbuild filters are Go regular expressions: no JS flags.
    b.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      const scope = createHash('sha1').update(path.slice(here.length)).digest('hex').slice(0, 6)
      const names = {}
      const css = source.replace(/\.([A-Za-z_][\w-]*)/gu, (_match, name) => {
        names[name] = `rs_${name}_${scope}`
        return `.${names[name]}`
      })
      return {
        loader: 'js',
        contents: [
          `const css = ${JSON.stringify(css)}`,
          `if (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-remote-servers="${scope}"]')) {`,
          `  const tag = document.createElement('style'); tag.dataset.dshRemoteServers = ${JSON.stringify(scope)}; tag.textContent = css; document.head.appendChild(tag)`,
          '}',
          `export default ${JSON.stringify(names)}`,
        ].join('\n'),
      }
    })
  },
}

await mkdir(join(here, 'lib'), { recursive: true })
await writeFile(join(here, 'lib/index.js'), [
  '/** dsh-remote-servers Node half: nothing to run on the Host; the page is browser-only. */',
  "export const name = 'dsh-remote-servers'",
  'export function apply() {}',
  '',
].join('\n'))

const result = await build({
  entryPoints: [join(here, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [cssModules],
  logLevel: 'warning',
})
const body = result.outputFiles[0].text
const wrapped = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(manifest.name)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  body.split('\n').map(line => `\t\t${line}`).join('\n'),
  '\t\treturn module.exports;',
  '\t}',
  '});',
  '',
].join('\n')
await writeFile(join(here, 'lib/client.js'), wrapped)
console.log(`built lib/index.js and lib/client.js (${wrapped.length} bytes)`)
