// Connection lifecycle of app/main.js, run with a stand-in Electron (test/fake-electron.mjs), a
// fake ssh that reports a configurable server identity, and the real Tunnel, LoopbackProxy,
// host authentication and account watch. Each test boots a fresh copy of main.js with its own
// userData, ports and fake servers. Run: node --test test/main.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtemp, writeFile, chmod, readFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createFakeElectron } from './fake-electron.mjs'

const APP = join(import.meta.dirname, '..', 'app')
const TUNNEL = pathToFileURL(join(APP, 'lib', 'tunnel.js')).href

// main.js imports `electron`, the bundled keyboard module and lib/tunnel.js; the test swaps the
// first two for stand-ins and points tunnel.js at the fake ssh of the current test.
registerHooks({
  resolve(specifier, context, next) {
    // One module instance per main.js copy, so each copy talks to its own test's Electron.
    if (specifier === 'electron') return { url: `fake:electron?${encodeURIComponent(context.parentURL ?? '')}`, shortCircuit: true }
    if (specifier === './vendor/desktop-keyboard.js') return { url: 'fake:keyboard', shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('fake:electron')) {
      const names = ['app', 'BrowserWindow', 'Menu', 'dialog', 'ipcMain', 'nativeTheme', 'shell', 'session', 'systemPreferences']
      return { format: 'module', shortCircuit: true, source: `const fake = globalThis.__fakeElectron\n${names.map(name => `export const ${name} = fake.${name}`).join('\n')}` }
    }
    if (url === 'fake:keyboard') {
      return { format: 'module', shortCircuit: true, source: 'export function installDesktopShortcuts() { return { attach() {}, fileMenu: () => ({ role: "fileMenu" }), dispose() {} } }' }
    }
    if (url.startsWith(`${TUNNEL}?ssh=`)) {
      const ssh = decodeURIComponent(url.slice(`${TUNNEL}?ssh=`.length))
      const source = readFileSync(fileURLToPath(TUNNEL), 'utf8').replace("const SSH = '/usr/bin/ssh'", `const SSH = ${JSON.stringify(ssh)}`)
      return { format: 'module', shortCircuit: true, source }
    }
    if (url.startsWith(pathToFileURL(join(APP, 'main.js')).href)) {
      const ssh = new URL(url).searchParams.get('ssh')
      const source = readFileSync(join(APP, 'main.js'), 'utf8').replace("from './lib/tunnel.js'", `from ${JSON.stringify(`${TUNNEL}?ssh=${encodeURIComponent(ssh)}`)}`)
      return { format: 'module', shortCircuit: true, source }
    }
    return next(url, context)
  },
})

const servers = []
after(() => { for (const server of servers) server.close() })

async function freePort() {
  const srv = net.createServer()
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address()
  await new Promise(resolve => srv.close(resolve))
  return port
}

/**
 * A dsh web stand-in: `/?token=…` answers 303 with a cookie naming the server; other paths echo
 * the cookie they received, so a test can see which cookie each request carried.
 */
async function fakeDshWeb(name) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers.cookie ?? '')
    if (req.url.startsWith('/?token=')) { res.writeHead(303, { 'set-cookie': `dsh-auth-x=${name}; Path=/; HttpOnly`, location: '/' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(name)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { name, port: server.address().port, seen }
}

/**
 * Fake ssh. Behaviour per destination comes from `<dir>/hosts.json`, read on every run:
 * `{ "<dest>": { "key": "<host key>", "web": <port>, "launchDelayMs"?: n, "fail"?: "message",
 * "launchFail"?: "message" } }` (`launchFail` fails only the launch run, not the forward).
 * A `-L` run forwards its unix socket to 127.0.0.1:<web>; any other run prints a launch line.
 * Both print the `-v` identity lines real ssh prints.
 */
async function fakeSsh(dir) {
  const path = join(dir, 'ssh.mjs')
  await writeFile(path, `#!${process.execPath}
import net from 'node:net'
import { readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const dest = args[args.indexOf('--') + 1]
const host = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'hosts.json'))}, 'utf8'))[dest]
// \`ssh -G\` (earlier versions resolved aliases with it) answers after \`resolveDelayMs\`.
if (args[0] === '-G') { setTimeout(() => { process.stdout.write('user me\\nhostname ' + (host?.key ?? dest) + '\\nport 22\\n'); process.exit(0) }, host?.resolveDelayMs ?? 0) }
else {
if (host === undefined || host.fail) { process.stderr.write((host?.fail ?? 'ssh: Could not resolve hostname') + '\\n'); process.exit(255) }
process.stderr.write("OpenSSH_9.6p1\\ndebug1: Authenticating to " + dest + ":22 as 'me'\\ndebug1: Server host key: ssh-ed25519 " + host.key + '\\n')
const forward = args.indexOf('-L')
if (forward < 0 && host.launchFail) { process.stderr.write(host.launchFail + '\\n'); process.exit(255) }
if (forward < 0) {
  process.stdin.resume()
  process.stdin.on('end', () => {
    setTimeout(() => { process.stdout.write('dsh web: http://127.0.0.1:3080/?token=tok_' + dest.replace(/[^a-z0-9]/gu, '') + '\\n'); process.exit(0) }, host.launchDelayMs ?? 0)
  })
} else {
  const spec = args[forward + 1]
  const socket = spec.slice(0, spec.lastIndexOf(':', spec.lastIndexOf(':') - 1))
  const server = net.createServer(c => { const up = net.connect(host.web, '127.0.0.1'); c.pipe(up).pipe(c); up.on('error', () => c.destroy()); c.on('error', () => up.destroy()) })
  server.listen(socket)
  process.on('SIGTERM', () => { server.close(); process.exit(0) })
}
}
`)
  await chmod(path, 0o755)
  return path
}

/** Boot a fresh main.js against fake servers. */
async function boot({ hosts, sshHosts }) {
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-main-'))
  const userData = join(dir, 'userData')
  await mkdir(userData, { recursive: true })
  const ports = []
  for (let i = 0; i < hosts.length; i++) ports.push(await freePort())
  await writeFile(join(userData, 'remote.json'), JSON.stringify({ activeHostId: hosts[0].id, hosts: hosts.map((host, i) => ({ localPort: ports[i], ...host })) }))
  const setHosts = value => writeFile(join(dir, 'hosts.json'), JSON.stringify(value))
  await setHosts(sshHosts)
  const ssh = await fakeSsh(dir)
  const fake = createFakeElectron({ userData })
  globalThis.__fakeElectron = fake.electron
  await import(`${pathToFileURL(join(APP, 'main.js')).href}?ssh=${encodeURIComponent(ssh)}&run=${Math.random()}`)
  fake.start()
  const until = async (condition, label, ms = 8000) => {
    const deadline = Date.now() + ms
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const current = () => fake.windows.filter(w => !w.destroyed).at(-1)
  const appLoads = w => (w === undefined ? [] : w.loads.filter(url => url.startsWith('http://')))
  const lastLoad = w => w?.loads.at(-1) ?? ''
  const connection = () => fake.electron.menu.template.find(item => item.label === 'Connection').submenu
  const click = label => connection().find(item => item.label === label).click()
  const quit = () => { fake.electron.app.quit(); try { execFileSync('pkill', ['-TERM', '-f', `${dir}/ssh.mjs`]) } catch { /* none left */ } }
  return { fake, dir, userData, ports, setHosts, until, current, appLoads, lastLoad, click, quit }
}

test('a host opens in the session of the server its SSH connection verified', { timeout: 20000 }, async () => {
  const web = await fakeDshWeb('A')
  const t = await boot({ hosts: [{ id: 'a', name: 'A', sshHost: 'alias-a' }], sshHosts: { 'alias-a': { key: 'KEY_A', web: web.port } } })
  try {
    await t.until(() => t.appLoads(t.current()).length > 0, 'page load')
    const window = t.current()
    assert.match(window.session.partition, /^persist:dsh-remote_a_[0-9a-f]{16}$/u)
    // The first window had no known session: it showed status pages only, in memory.
    assert.equal(t.fake.windows[0].session.partition, 'dsh-remote-pending')
    assert.deepEqual(t.appLoads(t.fake.windows[0]), [])
    assert.equal(JSON.parse(await readFile(join(t.userData, 'sessions.json'), 'utf8')).a, window.session.partition)
  } finally { t.quit() }
})

test('SEC-01: an alias pointed at another machine gets a new session on a same-window manual reconnect', { timeout: 30000 }, async () => {
  const webA = await fakeDshWeb('A')
  const webB = await fakeDshWeb('B')
  const t = await boot({ hosts: [{ id: 'a', name: 'A', sshHost: 'alias' }], sshHosts: { alias: { key: 'KEY_A', web: webA.port } } })
  try {
    await t.until(() => t.appLoads(t.current()).length > 0, 'first page')
    const first = t.current()
    await t.setHosts({ alias: { key: 'KEY_B', web: webB.port } })
    t.click('Reconnect')
    await t.until(() => t.current() !== first && t.appLoads(t.current()).length > 0, 'replacement window', 15000)
    assert.notEqual(t.current().session.partition, first.session.partition)
    assert.equal(t.appLoads(first).length, 1, 'nothing from the new server was loaded in the old session')
    assert.equal(first.destroyed, true)
  } finally { t.quit() }
})

test('SEC-01: the automatic reconnect after a drop checks the server identity too', { timeout: 30000 }, async () => {
  const webA = await fakeDshWeb('A')
  const webB = await fakeDshWeb('B')
  const t = await boot({ hosts: [{ id: 'a', name: 'A', sshHost: 'alias' }], sshHosts: { alias: { key: 'KEY_A', web: webA.port } } })
  try {
    await t.until(() => t.appLoads(t.current()).length > 0, 'first page')
    const first = t.current()
    await t.setHosts({ alias: { key: 'KEY_B', web: webB.port } })
    execFileSync('pkill', ['-TERM', '-f', `${t.dir}/ssh.mjs .* -L `])
    await t.until(() => t.current() !== first && t.appLoads(t.current()).length > 0, 'replacement after drop', 20000)
    assert.notEqual(t.current().session.partition, first.session.partition)
    assert.equal(t.appLoads(first).length, 1)
  } finally { t.quit() }
})

test('Q4-1/N4-01: a reconnect during a switch never loads the new server in the old window', { timeout: 30000 }, async () => {
  const webA = await fakeDshWeb('A')
  const webB = await fakeDshWeb('B')
  const t = await boot({
    hosts: [{ id: 'a', name: 'A', sshHost: 'host-a' }, { id: 'b', name: 'B', sshHost: 'host-b' }],
    sshHosts: { 'host-a': { key: 'KEY_A', web: webA.port }, 'host-b': { key: 'KEY_B', web: webB.port, resolveDelayMs: 3000 } },
  })
  try {
    await t.until(() => t.appLoads(t.current()).length > 0, 'A page')
    const windowA = t.current()
    t.click('B')
    await new Promise(resolve => setTimeout(resolve, 50))
    t.click('Reconnect')
    await t.until(() => t.fake.windows.some(w => !w.destroyed && t.appLoads(w).some(url => url.includes('tok_hostb'))), 'B page', 15000)
    assert.equal(windowA.loads.some(url => url.includes('tok_hostb')), false, "B is never loaded in A's window")
    for (const window of t.fake.windows.filter(w => t.appLoads(w).some(url => url.includes('tok_hostb')))) {
      assert.notEqual(window.session.partition, windowA.session.partition)
    }
  } finally { t.quit() }
})

test('Q4-2: an automatic retry still in flight cannot undo a later manual reconnect', { timeout: 60000 }, async () => {
  const webA = await fakeDshWeb('A')
  const t = await boot({ hosts: [{ id: 'a', name: 'A', sshHost: 'host-a' }], sshHosts: { 'host-a': { key: 'KEY_A', web: webA.port } } })
  try {
    await t.until(() => t.appLoads(t.current()).length > 0, 'first page')
    const window = t.current()
    const before = t.appLoads(window).length
    // The forward drops; the automatic retry (after 3 s) holds its launch for 2 s.
    await t.setHosts({ 'host-a': { key: 'KEY_A', web: webA.port, launchDelayMs: 2000 } })
    execFileSync('pkill', ['-TERM', '-f', `${t.dir}/ssh.mjs .* -L `])
    await new Promise(resolve => setTimeout(resolve, 3600))
    // While it is in flight the user reconnects; that launch takes 9 s. Launches started after
    // this one fail, so only the manual attempt can succeed.
    await t.setHosts({ 'host-a': { key: 'KEY_A', web: webA.port, launchDelayMs: 9000 } })
    t.click('Reconnect')
    await new Promise(resolve => setTimeout(resolve, 300))
    await t.setHosts({ 'host-a': { key: 'KEY_A', web: webA.port, launchFail: 'ssh: connect to host a port 22: Connection refused' } })
    await t.until(() => t.appLoads(window).length > before, 'manual success', 20000)
    await new Promise(resolve => setTimeout(resolve, 2000))
    assert.equal(window.destroyed, false)
    assert.match(t.lastLoad(window), /^http:/u, 'the manual connection stays loaded')
  } finally { t.quit() }
})

test('quit during a switch opens no further window', { timeout: 30000 }, async () => {
  const webA = await fakeDshWeb('A')
  const webB = await fakeDshWeb('B')
  const t = await boot({
    hosts: [{ id: 'a', name: 'A', sshHost: 'host-a' }, { id: 'b', name: 'B', sshHost: 'host-b' }],
    sshHosts: { 'host-a': { key: 'KEY_A', web: webA.port }, 'host-b': { key: 'KEY_B', web: webB.port, launchDelayMs: 800 } },
  })
  await t.until(() => t.appLoads(t.current()).length > 0, 'A page')
  t.click('B')
  await new Promise(resolve => setTimeout(resolve, 200))
  t.quit()
  const count = t.fake.windows.length
  await new Promise(resolve => setTimeout(resolve, 2500))
  assert.equal(t.fake.windows.length, count, 'no window is created after quit')
  assert.equal(t.fake.windows.some(w => t.appLoads(w).some(url => url.includes('tok_hostb'))), false)
})

test('N4-02: removing a host clears every session it ever used, from any run', { timeout: 30000 }, async () => {
  const webA = await fakeDshWeb('A')
  const t = await boot({
    hosts: [{ id: 'a', name: 'A', sshHost: 'host-a' }, { id: 'b', name: 'B', sshHost: 'host-b' }],
    sshHosts: { 'host-a': { key: 'KEY_A', web: webA.port } },
  })
  try {
    // Sessions B used with earlier servers exist only on disk.
    const old = ['dsh-remote_b_0123456789abcdef', 'dsh-remote_b_fedcba9876543210']
    for (const name of old) await mkdir(join(t.userData, 'Partitions', name), { recursive: true })
    await t.until(() => t.appLoads(t.current()).length > 0, 'A page')
    const window = t.current()
    t.fake.dialogAnswers.push(0)
    await t.fake.invoke(window, 'dsh-remote:remove', 'b')
    for (const name of old) assert.equal(t.fake.sessions.get(`persist:${name}`)?.cleared, 1, `${name} cleared`)
    assert.equal(t.fake.sessions.get(window.session.partition).cleared, 0, 'A keeps its session')
  } finally { t.quit() }
})

test('a host whose session cannot be cleared is kept', { timeout: 30000 }, async () => {
  const webA = await fakeDshWeb('A')
  const t = await boot({
    hosts: [{ id: 'a', name: 'A', sshHost: 'host-a' }, { id: 'b', name: 'B', sshHost: 'host-b' }],
    sshHosts: { 'host-a': { key: 'KEY_A', web: webA.port } },
  })
  try {
    await mkdir(join(t.userData, 'Partitions', 'dsh-remote_b_0123456789abcdef'), { recursive: true })
    await t.until(() => t.appLoads(t.current()).length > 0, 'A page')
    t.fake.electron.session.fromPartition('persist:dsh-remote_b_0123456789abcdef').failClear = true
    t.fake.dialogAnswers.push(0)
    await assert.rejects(t.fake.invoke(t.current(), 'dsh-remote:remove', 'b'), /was not removed/u)
    const config = JSON.parse(await readFile(join(t.userData, 'remote.json'), 'utf8'))
    assert.deepEqual(config.hosts.map(host => host.id), ['a', 'b'])
  } finally { t.quit() }
})

test('a failed page load closes the connection and retries on its own', { timeout: 30000 }, async () => {
  const webA = await fakeDshWeb('A')
  const t = await boot({ hosts: [{ id: 'a', name: 'A', sshHost: 'host-a' }], sshHosts: { 'host-a': { key: 'KEY_A', web: webA.port } } })
  try {
    await t.until(() => t.appLoads(t.current()).length > 0, 'first page')
    const window = t.current()
    window.failLoad = Object.assign(new Error('renderer gone'), { code: 'ERR_FAILED' })
    t.click('Reconnect')
    await t.until(() => t.lastLoad(window).includes('Cannot%20reach'), 'error page')
    const refused = await fetch(`http://127.0.0.1:${t.ports[0]}/`).then(() => false, () => true)
    assert.equal(refused, true, 'nothing is routed after the failed load')
    window.failLoad = undefined
    const before = t.appLoads(window).length
    await t.until(() => t.appLoads(window).length > before, 'automatic retry', 10000)
  } finally { t.quit() }
})
