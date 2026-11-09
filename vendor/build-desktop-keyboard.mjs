/**
 * Bundle DeepSeek Harness's own desktop keyboard bridge (apps/desktop/src/keyboard.ts) into
 * app/vendor/desktop-keyboard.js, unmodified, from a deepseek-harness source checkout.
 *
 * The Web UI switches to its Desktop layout (inset traffic lights, native shortcuts) only when
 * a preload provides `dshDesktop.keyboard` and `dshDesktop.shortcuts`. Bundling the upstream
 * implementation keeps shortcut behavior identical to the official app instead of a rewrite.
 *
 * Usage: node vendor/build-desktop-keyboard.mjs <path/to/deepseek-harness>
 */
import { build } from 'esbuild'
import { resolve, join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const repo = resolve(process.argv[2] ?? '../deepseek-harness')
const out = resolve(import.meta.dirname, '../app/vendor')
const pkg = name => join(repo, 'packages', name)

/** Workspace specifiers reached by keyboard.ts → resolved to their TypeScript sources. */
const aliases = {
  '@deepseek-ai/dsh-client-shortcuts/protocol': join(pkg('client/shortcuts'), 'src/protocol.ts'),
  '@deepseek-ai/dsh-atomic-write': join(pkg('util/atomic-write'), 'src/index.ts'),
  '@deepseek-ai/dsh-util-values': join(pkg('util/values'), 'src/index.ts'),
  '@deepseek-ai/dsh-util-crypto': join(pkg('util/crypto'), 'src/index.ts'),
  '@deepseek-ai/dsh-brand': join(pkg('util/brand'), 'src/index.ts'),
}

const commit = (await readFile(join(repo, '.git/HEAD'), 'utf8').catch(() => 'unknown')).trim()
await mkdir(out, { recursive: true })
await build({
  entryPoints: { 'desktop-keyboard': join(repo, 'apps/desktop/src/keyboard.ts') },
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  alias: aliases,
  logLevel: 'warning',
  banner: { js: `// Bundled from deepseek-harness apps/desktop/src/keyboard.ts (MIT, Copyright (c) 2026 DeepSeek). Source: ${commit}` },
})
await retargetSenderCheck(join(out, 'desktop-keyboard.js'))
await writeFile(join(out, 'ipc-channels.json'), `${JSON.stringify(await desktopChannels(), null, 2)}\n`)

/**
 * keyboard.ts admits IPC only from `dsh-app://app` documents (ipc.ts assertDesktopSender). This
 * client serves the same Web UI from the tunnel origin instead, so the one origin test is
 * replaced with a check against `globalThis.__DSH_REMOTE_APP_ORIGIN__`, which main.js sets to
 * http://127.0.0.1:<localPort> before installing the bridge. The window and top-frame checks in
 * keyboard.ts stay as they are.
 */
async function retargetSenderCheck(file) {
  const source = await readFile(file, 'utf8')
  const original = 'if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {'
  const count = source.split(original).length - 1
  if (count !== 1) throw new Error(`assertDesktopSender origin test found ${count} times; upstream changed, review the patch`)
  const replaced = 'if (url.origin !== globalThis.__DSH_REMOTE_APP_ORIGIN__ || hostnames.length === 0) {'
  await writeFile(file, source.replace(original, replaced))
}
console.log(`built ${join(out, 'desktop-keyboard.js')}`)

/** Read the DESKTOP_IPC channel names the shared preload and main must agree on. */
async function desktopChannels() {
  const source = await readFile(join(repo, 'apps/desktop/src/ipc.ts'), 'utf8')
  const block = source.match(/export const DESKTOP_IPC = \{([\s\S]*?)\} as const/u)
  if (!block) throw new Error('DESKTOP_IPC not found in apps/desktop/src/ipc.ts')
  return Object.fromEntries([...block[1].matchAll(/(\w+): '([^']+)'/gu)].map(m => [m[1], m[2]]))
}
