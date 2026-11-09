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

/**
 * Minimal DevTools-protocol client for one page. The browser is registered with `own` the moment
 * it is spawned, so the test stops it even if startup fails. Every wait is bounded: startup,
 * the WebSocket handshake and each request reject on timeout, browser exit or socket close.
 */
async function openPage(chrome, profileDir, own) {
  const proc = spawn(chrome, ['--headless', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const exited = new Promise((resolve) => { proc.once('exit', () => resolve()); proc.once('error', () => resolve()) })
  const pending = new Map()
  let socket
  const failAll = (error) => { for (const reject of pending.values()) reject(error); pending.clear() }
  own(async () => {
    try { socket?.close() } catch { /* already closed */ }
    failAll(new Error('page closed'))
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM')
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))])
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited }
  })
  const bounded = (promise, ms, label) => Promise.race([
    promise,
    exited.then(() => { throw new Error(`Chromium exited during ${label}`) }),
    new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out: ${label}`)), ms).unref() }),
  ])
  const wsUrl = await bounded(new Promise((resolve, reject) => {
    proc.once('error', reject)
    proc.stderr.on('data', (chunk) => { const match = /DevTools listening on (ws:\S+)/u.exec(String(chunk)); if (match) resolve(match[1]) })
  }), 20_000, 'Chromium startup')
  socket = new WebSocket(wsUrl)
  await bounded(new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('DevTools WebSocket failed')), { once: true })
  }), 10_000, 'DevTools handshake')
  socket.addEventListener('close', () => failAll(new Error('DevTools WebSocket closed')))
  let next = 0
  const errors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) { pending.get(message.id)(undefined, message); pending.delete(message.id) }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    // Console errors from the page count too, not only uncaught exceptions.
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(`console.error: ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`)
  })
  const send = (method, params = {}, sessionId) => bounded(new Promise((resolve, reject) => {
    const id = ++next
    pending.set(id, (error, message) => (error ? reject(error) : resolve(message)))
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  }), 15_000, method)
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
  }
}

/**
 * Run cleanups newest first. Each is awaited once, all of them run even when some fail, and the
 * failures are then reported together. Cleanups are idempotent (they check whether their process
 * is still running), so running one again from an outer hook is harmless.
 */
async function runCleanups(cleanups) {
  const failures = []
  for (const cleanup of [...cleanups].reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  cleanups.length = 0
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} test cleanup(s) failed`)
}

async function until(read, label, ms = 30_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await Promise.race([read(), new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), Math.max(1, deadline - Date.now())).unref() })])
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

test('a browser that never becomes ready, or refuses DevTools, fails promptly and leaves no process behind', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-e2e-ctl-'))
  // Every fake browser is stopped after the test, whatever its assertions did, before the
  // directory holding it is removed.
  const cleanups = []
  t.after(async () => {
    await runCleanups(cleanups)
    await rm(dir, { recursive: true, force: true })
  })
  {
    const { writeFile } = await import('node:fs/promises')
    // Never announces DevTools; ignores SIGTERM for a moment.
    const silent = join(dir, 'silent.mjs')
    await writeFile(silent, `#!${process.execPath}\nprocess.on('SIGTERM', () => setTimeout(() => process.exit(0), 200))\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
    // Announces a WebSocket URL whose handshake is refused (HTTP 400).
    const refusing = join(dir, 'refusing.mjs')
    await writeFile(refusing, `#!${process.execPath}\nimport http from 'node:http'\nconst s = http.createServer((q, r) => { r.writeHead(400); r.end() }).listen(0, '127.0.0.1', () => process.stderr.write('DevTools listening on ws://127.0.0.1:' + s.address().port + '/devtools/browser/x\\\\n'))\nprocess.on('SIGTERM', () => process.exit(0))\n`, { mode: 0o700 })
    for (const [fake, expected] of [[silent, /Chromium startup/u], [refusing, /DevTools/u]]) {
      const own = []
      const started = Date.now()
      await assert.rejects(openPage(fake, join(dir, 'profile'), (cleanup) => { own.push(cleanup); cleanups.push(cleanup) }), expected)
      await runCleanups(own)
      assert.ok(Date.now() - started < 30_000, 'failed within its bound')
      // The fake writes nothing else; look for any process still running it (not this shell).
      const alive = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(fake) && !/\bps\b/u.test(line))
      assert.deepEqual(alive, [], 'no browser process is left')
    }
  }
})

test('the bundle installs with dsh plugin add and its Remote servers page renders in the real Web UI', { timeout: 240_000 }, async (t) => {
  const chrome = findChrome()
  const dsh = which('dsh')
  if (dsh === undefined || chrome === undefined) { t.skip(`needs ${dsh === undefined ? 'dsh on PATH' : 'a headless Chromium (DSH_REMOTE_E2E_CHROME)'}`); return }
  if (!existsSync(join(ROOT, 'plugin', 'lib', 'client.js'))) { t.skip('plugin/lib is not built (cd plugin && node build.mjs)'); return }
  const home = await mkdtemp(join(tmpdir(), 'dshrc-e2e-'))
  await chmod(home, 0o700)
  const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') }
  // Cleanups run in reverse order after the test, whether it passes, fails or times out.
  const cleanups = []
  const own = cleanup => { cleanups.push(cleanup) }
  t.after(async () => {
    await runCleanups(cleanups)
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  })
  {
    execFileSync('npm', ['pack', '--silent', '--pack-destination', home], { cwd: join(ROOT, 'plugin'), stdio: 'ignore' })
    const tarball = readdirSync(home).find(name => name.startsWith('dsh-remote-servers-') && name.endsWith('.tgz'))
    assert.ok(tarball, 'npm pack produced the bundle')
    execFileSync(dsh, ['--profile', 'e2e', '--from-default-profile', 'web', '--dump-config'], { env, stdio: 'ignore' })
    execFileSync(dsh, ['plugin', '--profile', 'e2e', 'add', join(home, tarball)], { env, stdio: 'ignore' })
    const dump = execFileSync(dsh, ['--profile', 'e2e', '--dump-config'], { env, encoding: 'utf8' })
    assert.match(dump, /^- id: remote-servers\n {2}name: dsh-remote-servers$/mu, 'the composed profile enables the page')

    const port = await freePort()
    const log = join(home, 'web.log')
    const server = spawn('sh', ['-c', `exec "$0" --profile e2e --host 127.0.0.1 --port ${port} --no-open > "$1" 2>&1`, dsh, log], { env, stdio: 'ignore', detached: true })
    const serverExited = new Promise((resolve) => { server.once('exit', resolve); server.once('error', resolve) })
    own(async () => {
      try { process.kill(-server.pid, 'SIGTERM') } catch { /* already gone */ }
      await Promise.race([serverExited, new Promise(resolve => setTimeout(resolve, 5000))])
      try { process.kill(-server.pid, 'SIGKILL') } catch { /* already gone */ }
    })
    const launch = await until(async () => /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u.exec(await readFile(log, 'utf8').catch(() => ''))?.[1], 'dsh web launch line', 90_000)

    const page = await openPage(chrome, join(home, 'chrome'), own)
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
    assert.deepEqual(page.errors, [], 'no uncaught exception or console error in the page')
  }
})
