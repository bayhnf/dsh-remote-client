// End to end with the real DeepSeek Harness: pack the dsh-remote-servers bundle, add it to a fresh
// `web` profile in a throwaway DSH_HOME with `dsh plugin add`, serve it on loopback with `dsh`, and
// open Settings → Remote servers in headless Chromium through the DevTools protocol. This runs the
// real ModuleLoader, slots, locale and settings UI, not stand-ins.
//
// Needs `dsh` (and the pnpm it uses) on PATH and a Chromium/Chrome headless binary; set
// DSH_REMOTE_E2E_CHROME to its path if it is not found. Without them the test is skipped with the
// reason. Run: node --test test/e2e.test.mjs (also part of `npm test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const ROOT = join(import.meta.dirname, '..')

function findChrome() {
  if (process.env.DSH_REMOTE_E2E_CHROME) return process.env.DSH_REMOTE_E2E_CHROME
  const playwright = join(homedir(), '.cache', 'ms-playwright')
  if (existsSync(playwright)) {
    for (const dir of readdirSync(playwright).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse()) {
      const bin = join(playwright, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
      if (existsSync(bin)) return bin
    }
  }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync)
}

function which(name) {
  try { return execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim() || undefined } catch { return undefined }
}

async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Minimal DevTools-protocol client for one page. */
async function openPage(chrome, profileDir) {
  const proc = spawn(chrome, ['--headless', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium did not start')), 20_000)
    proc.stderr.on('data', (chunk) => { const match = /DevTools listening on (ws:\S+)/u.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(match[1]) } })
  })
  const socket = new WebSocket(wsUrl)
  await new Promise(resolve => socket.addEventListener('open', resolve))
  let next = 0
  const pending = new Map()
  const errors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve) => { const id = ++next; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params, sessionId })) })
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.result?.value
  return {
    errors,
    evaluate,
    navigate: url => send('Page.navigate', { url }, sessionId),
    /** Click the first element whose own text or aria-label matches. */
    click: pattern => evaluate(`(() => { const re = ${pattern}; const el = [...document.querySelectorAll('*')].find(e => re.test(e.getAttribute('aria-label') || '') || (e.children.length === 0 && re.test(e.textContent))); if (!el) return false; (el.closest('button,[role=menuitem],[role=button],a,[role=tab]') || el).click(); return true })()`),
    close: () => { socket.close(); proc.kill('SIGTERM') },
  }
}

async function until(read, label, ms = 30_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

test('the bundle installs with dsh plugin add and its Remote servers page renders in the real Web UI', { timeout: 240_000 }, async (t) => {
  const chrome = findChrome()
  const dsh = which('dsh')
  if (dsh === undefined || chrome === undefined) { t.skip(`needs ${dsh === undefined ? 'dsh on PATH' : 'a headless Chromium (DSH_REMOTE_E2E_CHROME)'}`); return }
  if (!existsSync(join(ROOT, 'plugin', 'lib', 'client.js'))) { t.skip('plugin/lib is not built (cd plugin && node build.mjs)'); return }
  const home = await mkdtemp(join(tmpdir(), 'dshrc-e2e-'))
  await chmod(home, 0o700)
  const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') }
  let server
  let page
  try {
    execFileSync('npm', ['pack', '--silent', '--pack-destination', home], { cwd: join(ROOT, 'plugin'), stdio: 'ignore' })
    const tarball = readdirSync(home).find(name => name.startsWith('dsh-remote-servers-') && name.endsWith('.tgz'))
    assert.ok(tarball, 'npm pack produced the bundle')
    execFileSync(dsh, ['--profile', 'e2e', '--from-default-profile', 'web', '--dump-config'], { env, stdio: 'ignore' })
    execFileSync(dsh, ['plugin', '--profile', 'e2e', 'add', join(home, tarball)], { env, stdio: 'ignore' })
    const dump = execFileSync(dsh, ['--profile', 'e2e', '--dump-config'], { env, encoding: 'utf8' })
    assert.match(dump, /^- id: remote-servers\n {2}name: dsh-remote-servers$/mu, 'the composed profile enables the page')

    const port = await freePort()
    const log = join(home, 'web.log')
    server = spawn('sh', ['-c', `exec "$0" --profile e2e --host 127.0.0.1 --port ${port} --no-open > "$1" 2>&1`, dsh, log], { env, stdio: 'ignore', detached: true })
    const launch = await until(async () => /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u.exec(await readFile(log, 'utf8').catch(() => ''))?.[1], 'dsh web launch line', 90_000)

    page = await openPage(chrome, join(home, 'chrome'))
    await page.navigate(launch)
    await until(() => page.evaluate('document.readyState === "complete" && /Account menu/.test([...document.querySelectorAll("[aria-label]")].map(e => e.getAttribute("aria-label")).join(" "))'), 'Web UI')
    // The preview notice covers the page until it is dismissed.
    await until(async () => { await page.click('/^\\s*Continue\\s*$/'); return !(await page.evaluate('/Preview Notice/.test(document.body.innerText)')) }, 'preview notice dismissed')
    // Open the account menu (again if it closed) until its Settings item is there.
    await until(async () => {
      if (!(await page.evaluate('[...document.querySelectorAll("*")].some(e => e.children.length === 0 && /^\\s*Settings\\s*$/.test(e.textContent))'))) { await page.click('/^Account menu$/'); return false }
      return page.click('/^\\s*Settings\\s*$/')
    }, 'Settings item')
    await until(() => page.click('/^\\s*Remote servers\\s*$/'), 'Remote servers section')
    const text = await until(async () => { const value = await page.evaluate('[...document.querySelectorAll("[role=dialog]")].map(d => d.innerText).join("\\n")'); return /managed from the DeepSeek Harness Remote desktop app/u.test(value) ? value : undefined }, 'section content')
    // A plain browser tab has no desktop bridge: the page explains that instead of offering actions.
    assert.match(text, /Each server runs DeepSeek Harness itself/u)
    assert.deepEqual(page.errors, [], 'no uncaught exception in the page')
  } finally {
    page?.close()
    if (server !== undefined) { try { process.kill(-server.pid, 'SIGTERM') } catch { /* already gone */ } }
    await new Promise(resolve => setTimeout(resolve, 300))
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
})
