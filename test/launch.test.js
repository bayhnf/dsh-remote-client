import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLaunchUrl, localLaunchUrl, redact, launchScript } from '../app/lib/launch.js'
import { resolveConfig, resolveHost, DEFAULT_CONFIG, HOST_DEFAULTS, nextLocalPort, slug } from '../app/lib/config.js'
import { parseProbe, probeScript, setupScript } from '../app/lib/server-setup.js'
import { parseSshAliases } from '../app/lib/ssh-aliases.js'
import { authorizeDestination } from '../app/lib/account-watch.js'

const LOG = [
  'dsh web: listening on 192.0.2.10 over plain HTTP; restrict this port to a trusted proxy or network',
  'dsh web: http://192.0.2.10:3080/?token=OLD_tok-1',
  'dsh web: http://192.0.2.10:3080/?token=-_NEW_tok-2',
].join('\n')
const HOST = DEFAULT_CONFIG.hosts[0]

test('parseLaunchUrl returns the newest launch line', () => {
  assert.deepEqual(parseLaunchUrl(LOG), { host: '192.0.2.10', port: 3080, token: '-_NEW_tok-2' })
  assert.equal(parseLaunchUrl('dsh web: listening on 1.2.3.4'), undefined)
  assert.equal(parseLaunchUrl(''), undefined)
})

test('localLaunchUrl targets loopback so DeepSeek sign-in accepts the origin', () => {
  assert.equal(localLaunchUrl(43080, '-_a'), 'http://127.0.0.1:43080/?token=-_a')
})

test('redact masks tokens and auth cookies', () => {
  assert.equal(redact(LOG).includes('NEW_tok'), false)
  assert.equal(redact(LOG).includes('OLD_tok'), false)
  assert.equal(redact('token=a.b~c%2F').includes('a.b'), false)
  assert.equal(redact('set-cookie: dsh-auth-x=SECRETVALUE; Path=/').includes('SECRETVALUE'), false)
  assert.equal(redact('dsh-auth-abc=SECRETVALUE').includes('SECRETVALUE'), false)
})

test('launchScript expands a home-relative log path and names the unit', () => {
  assert.match(launchScript(HOST), /L="\$HOME\/\.dsh\/logs\/server-web\.log"; U=dsh-server\.service/u)
})

test('resolveHost rejects values that could inject into ssh or the remote shell', () => {
  const base = { id: 'x', sshHost: 'x', localPort: 43080 }
  assert.throws(() => resolveHost({ ...base, sshHost: '-oProxyCommand=evil' }), /sshHost/u)
  assert.throws(() => resolveHost({ ...base, sshHost: 'host; rm -rf ~' }), /sshHost/u)
  assert.throws(() => resolveHost({ ...base, serverLog: '~/x"; reboot; "' }), /serverLog/u)
  assert.throws(() => resolveHost({ ...base, serverLog: '~/../../etc/passwd' }), /serverLog/u)
  assert.throws(() => resolveHost({ ...base, serverUnit: 'x.service; id' }), /serverUnit/u)
  assert.throws(() => resolveHost({ ...base, localPort: 80 }), /localPort/u)
  assert.throws(() => resolveHost({ ...base, id: '../etc' }), /host id/u)
  assert.throws(() => resolveHost({ ...base, serverPort: 0 }), /serverPort/u)
  assert.throws(() => resolveHost({ ...base, serverLog: '-f' }), /serverLog/u)
  assert.throws(() => resolveHost({ ...base, serverLog: 'relative/log' }), /serverLog/u)
  assert.throws(() => resolveHost({ ...base, serverUnit: '--x.service' }), /serverUnit/u)
})

test('resolveConfig migrates the single-host form and keeps a valid active host', () => {
  const migrated = resolveConfig({ sshHost: 'dev@192.0.2.10', localPort: 43080, serverLog: HOST_DEFAULTS.serverLog, serverUnit: HOST_DEFAULTS.serverUnit })
  assert.equal(migrated.hosts.length, 1)
  assert.equal(migrated.hosts[0].sshHost, 'dev@192.0.2.10')
  assert.equal(migrated.activeHostId, migrated.hosts[0].id)
  const two = resolveConfig({ activeHostId: 'gone', hosts: [HOST, { id: 'gpu-box', sshHost: 'gpu-box', localPort: 43081 }] })
  assert.equal(two.activeHostId, 'dsh-server')
})

test('resolveConfig rejects duplicate ids, shared ports and an empty list', () => {
  assert.throws(() => resolveConfig({ hosts: [] }), /at least one/u)
  assert.throws(() => resolveConfig({ hosts: [HOST, { ...HOST, localPort: 43081 }] }), /duplicate/u)
  assert.throws(() => resolveConfig({ hosts: [HOST, { id: 'gpu-box', sshHost: 'gpu-box', localPort: HOST.localPort }] }), /used by two/u)
})

test('slug and nextLocalPort derive safe ids and free ports', () => {
  assert.equal(slug('root@Build Box!'), 'build-box')
  assert.equal(slug('$$$'), 'host')
  assert.equal(nextLocalPort([{ localPort: 43080 }, { localPort: 43081 }]), 43082)
})

test('parseProbe reads the marked report past login-shell noise', () => {
  const out = 'welcome banner\n@@DSH-REMOTE-REPORT@@{"hostname":"gpu-box","os":"Linux","node":"v24.22.0","dsh":"","dshTui":"no","unit":"inactive","launchLines":0,"plugin":"no"}\n'
  assert.deepEqual(parseProbe(out), { hostname: 'gpu-box', os: 'Linux', node: 'v24.22.0', dsh: '', dshTui: false, unit: 'inactive', plugin: false, web: false, stale: false, ready: false })
  const ready = '@@DSH-REMOTE-REPORT@@{"hostname":"b","os":"Linux","node":"v22","dsh":"0.2.2","dshTui":"yes","unit":"active","launchLines":3,"plugin":"yes","web":"yes"}'
  assert.equal(parseProbe(ready).ready, true)
  assert.equal(parseProbe(ready.replace('"plugin":"yes"', '"plugin":"no"')).ready, false)
  assert.equal(parseProbe(ready.replace('"web":"yes"', '"web":"yes","stale":"yes"')).ready, false)
  assert.throws(() => parseProbe('nothing'), /no report/u)
})

test('probe and setup scripts are valid POSIX sh', async () => {
  const { execFileSync } = await import('node:child_process')
  for (const script of [probeScript(HOST), setupScript(HOST, 'AAAA')]) execFileSync('sh', ['-n', '-c', script])
  assert.match(setupScript(HOST, 'AAAA'), /--host 127\.0\.0\.1 --port 3080 --no-open/u)
  assert.match(setupScript(HOST, 'AAAA'), /UMask=0077/u)
  assert.match(setupScript(HOST, 'AAAA'), /chmod 600 "\$L"/u)
  assert.match(launchScript(HOST), /chmod 600 "\$L"/u)
  assert.throws(() => setupScript(HOST, "x'; reboot; '"), /base64/u)
})

test('parseSshAliases keeps concrete names only', () => {
  assert.deepEqual(parseSshAliases('Host gpu-box devbox\n  HostName x\nHost *.example *\nhost laptop\nHost !bad'), ['devbox', 'gpu-box', 'laptop'])
})

test('authorizeDestination accepts the DeepSeek Platform host and loopback http only', () => {
  assert.equal(authorizeDestination('https://platform.deepseek.com/dsh/authorize?x=1'), 'https://platform.deepseek.com/dsh/authorize?x=1')
  assert.equal(authorizeDestination('https://phish.example/dsh/authorize'), undefined)
  assert.equal(authorizeDestination('http://127.0.0.1:43080/oauth/callback'), 'http://127.0.0.1:43080/oauth/callback')
  assert.equal(authorizeDestination('http://evil.example/dsh/authorize'), undefined)
  assert.equal(authorizeDestination('https://user:pw@platform.deepseek.com/dsh/authorize'), undefined)
  assert.equal(authorizeDestination('file:///etc/passwd'), undefined)
  assert.equal(authorizeDestination('not a url'), undefined)
})

// ---- regression tests for the pre-release audit (offline, temporary homes only) ----
import { mkdtemp, writeFile as writeFileFs, readFile as readFileFs, mkdir as mkdirFs, chmod as chmodFs, readdir, symlink } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { PRIVATE_LOG_FN } from '../app/lib/launch.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { saveConfig, updateConfig, loadConfig } from '../app/lib/config.js'
import { watchAccountSignIn } from '../app/lib/account-watch.js'
import net from 'node:net'

/** Run a generated script with a fake systemctl that reports the given state. */
async function runScript(script, { active, log }) {
  const home = await mkdtemp(join(tmpdir(), 'dshrc-'))
  const bin = join(home, 'bin')
  await mkdirFs(join(home, '.dsh', 'logs'), { recursive: true })
  await mkdirFs(bin)
  await writeFileFs(join(bin, 'systemctl'), `#!/bin/sh\nexit ${active ? 0 : 3}\n`)
  await chmodFs(join(bin, 'systemctl'), 0o755)
  if (log !== undefined) await writeFileFs(join(home, '.dsh', 'logs', 'server-web.log'), log)
  return execFileSync('sh', ['-c', script], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' })
}

test('probe reports a numeric not-ready state for empty or launch-less logs', async () => {
  for (const log of [undefined, '', 'starting\nfailed\n']) {
    const report = parseProbe(await runScript(probeScript(HOST), { active: false, log }))
    assert.equal(report.ready, false)
  }
})

test('launchScript finds the launch line however long the log has grown', async () => {
  const log = `dsh web: http://127.0.0.1:3080/?token=abc_1\n${'noise\n'.repeat(5000)}`
  const out = await runScript(launchScript(HOST), { active: true, log })
  assert.deepEqual(parseLaunchUrl(out), { host: '127.0.0.1', port: 3080, token: 'abc_1' })
})

test('concurrent config writes stay consistent on disk and in memory', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'dshrc-')), 'remote.json')
  let current = await saveConfig(file, { activeHostId: 'a', hosts: [{ id: 'a', sshHost: 'a', localPort: 43080 }, { id: 'b', sshHost: 'b', localPort: 43081 }] })
  const writes = []
  for (let i = 0; i < 20; i++) {
    const target = i % 2 === 0 ? 'a' : 'b'
    writes.push(updateConfig(file, c => ({ ...c, activeHostId: target }), () => current).then((next) => { current = next }))
  }
  await Promise.all(writes)
  const onDisk = JSON.parse(await readFileFs(file, 'utf8'))
  assert.equal(onDisk.activeHostId, current.activeHostId)
  assert.equal(onDisk.activeHostId, 'b')
  assert.deepEqual((await readdir(join(file, '..'))).filter(name => name.endsWith('.tmp')), [])
})

test('a malformed modern config is rejected, not rewritten', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'dshrc-')), 'remote.json')
  const original = JSON.stringify({ activeHostId: 'x', hosts: { id: 'x', sshHost: 'x' } })
  await writeFileFs(file, original)
  await assert.rejects(loadConfig(file), /hosts must be an array/u)
  assert.equal(await readFileFs(file, 'utf8'), original)
})

test('stopping the account watch while it is still connecting does not throw', async () => {
  const server = net.createServer(() => {})
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const stop = watchAccountSignIn(`http://127.0.0.1:${port}`, 'dsh-auth-x=y', { open() {}, theme: () => 'dark', log() {} })
  stop()
  stop()
  await new Promise(resolve => setTimeout(resolve, 300))
  server.close()
})

test('a sign-in the app declined to open is offered again', () => {
  // A stand-in WebSocket lets the test feed account/watch frames directly.
  const sockets = []
  const OriginalWS = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor() { this.listeners = {}; sockets.push(this) }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
    send(text) { this.streamId = JSON.parse(text).streamId }
    close() {}
    emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event) }
  }
  try {
    const opened = []
    let allow = false
    const stop = watchAccountSignIn('http://127.0.0.1:1', 'c=1', {
      open: (url) => { if (!allow) return false; opened.push(url); return true }, theme: () => 'dark', log() {},
    })
    const socket = sockets[0]
    socket.emit('open')
    const frame = id => ({ data: JSON.stringify({ streamId: socket.streamId, type: 'item',
      value: { attempt: { id, phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?x=1' } } }) })
    socket.emit('message', frame('attempt-1'))
    assert.equal(opened.length, 0)
    allow = true
    socket.emit('message', frame('attempt-1'))
    assert.equal(opened.length, 1)
    socket.emit('message', frame('attempt-1'))
    assert.equal(opened.length, 1)
    stop()
  } finally { globalThis.WebSocket = OriginalWS }
})

test('setup gives the service a PATH with the verified pnpm first, then node, dsh and dsh-tui', () => {
  const script = setupScript(HOST, 'AAAA')
  assert.match(script, /SP="\$PNPM_DIR"; for c in node dsh dsh-tui/u)
  assert.match(script, /Environment=PATH=%s:\/usr\/local\/bin/u)
})

// ---- log privacy (SEC-07): every check runs in scratch directories, never on shared paths ----
/** Run private_log for log `L` with HOME `home`; returns { code, err }. */
function privateLog(L, home) {
  try {
    execFileSync('sh', ['-c', `L="${L}"; LD=$(dirname "$L"); ${PRIVATE_LOG_FN}\n(umask 077; mkdir -p "$LD") && private_log`], { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, err: '' }
  } catch (error) { return { code: error.status, err: String(error.stderr) } }
}
const modeOf = path => (statSync(path).mode & 0o7777).toString(8)

test('the default log under the home directory is made private', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshrc-log-'))
  await mkdirFs(join(home, '.dsh'), { mode: 0o775 })
  await chmodFs(join(home, '.dsh'), 0o775)
  const L = join(home, '.dsh', 'logs', 'server-web.log')
  assert.deepEqual(privateLog(L, home), { code: 0, err: '' })
  assert.equal(modeOf(join(home, '.dsh', 'logs')), '700')
  assert.equal(modeOf(L), '600')
})

test('SEC-07: a log below a directory other users can write to is refused, at any depth', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshrc-log-'))
  // A world-writable, non-sticky ancestor: another user could rename the private leaf away.
  const shared = join(home, 'shared')
  await mkdirFs(join(shared, 'logs', 'deep'), { recursive: true })
  await chmodFs(shared, 0o777)
  const { code, err } = privateLog(join(shared, 'logs', 'deep', 'x.log'), home)
  assert.equal(code, 1)
  assert.match(err, /can be changed by other users/u)
  assert.equal(existsSync(join(shared, 'logs', 'deep', 'x.log')), false, 'no log is created')
})

test('SEC-07: a shared or foreign log directory is refused and never changed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshrc-log-'))
  const sticky = join(home, 'sticky')
  await mkdirFs(sticky)
  await chmodFs(sticky, 0o1777)
  assert.equal(privateLog(join(sticky, 'x.log'), home).code, 1)
  assert.equal(modeOf(sticky), '1777', 'a sticky directory is not tightened')
  // A directory owned by root (or another user) is never used, whatever its mode.
  if (process.getuid?.() !== 0) assert.match(privateLog('/etc/dsh-remote-test.log', home).err, /must belong to/u)
})

test('a private directory below a sticky directory such as /tmp is accepted, and left as it is', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'dshrc-log-'))
  await chmodFs(outside, 0o750)
  const home = await mkdtemp(join(tmpdir(), 'dshrc-home-'))
  assert.equal(privateLog(join(outside, 'x.log'), home).code, 0)
  assert.equal(modeOf(outside), '750', 'directories outside the home directory are checked, not changed')
  assert.equal(modeOf(join(outside, 'x.log')), '600')
})

test('a symlinked or foreign log file is refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshrc-log-'))
  const dir = join(home, 'logs')
  await mkdirFs(dir, { mode: 0o700 })
  await symlink('/etc/hostname', join(dir, 'x.log'))
  assert.match(privateLog(join(dir, 'x.log'), home).err, /must be a regular file/u)
})

test('launch refuses an unsafe log instead of reading it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshrc-log-'))
  const shared = join(home, 'shared')
  await mkdirFs(join(shared, 'logs'), { recursive: true })
  await chmodFs(shared, 0o777)
  await writeFileFs(join(shared, 'logs', 'x.log'), 'dsh web: http://127.0.0.1:3080/?token=abc\n')
  const script = launchScript({ ...HOST, serverLog: join(shared, 'logs', 'x.log') })
  let code = 0
  try { execFileSync('sh', ['-c', script], { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: 'pipe' }) } catch (error) { code = error.status }
  assert.equal(code, 5)
})

// ---- tunnel: app-owned listener + private socket, with a fake ssh ----
/**
 * A stand-in for /usr/bin/ssh: it parses `-L <socket>:<host>:<port>`, listens on that unix
 * socket and answers every connection with a fixed HTTP response. `mode` 'fail' exits at once.
 */
async function fakeSsh(dir, mode = 'ok') {
  const path = join(dir, `fake-ssh-${mode}.mjs`)
  await writeFileFs(path, `#!${process.execPath}
import net from 'node:net'
const forward = process.argv[process.argv.indexOf('-L') + 1]
const socket = forward.slice(0, forward.lastIndexOf(':', forward.lastIndexOf(':') - 1))
const mode = ${JSON.stringify(mode)}
if (mode === 'fail') { process.stderr.write('debug1: noise\\nbind failed\\n'); process.exit(255) }
// What \`ssh -v\` prints before the forward listens: the server it authenticated to.
if (mode !== 'anonymous') process.stderr.write("debug1: Authenticating to x:22 as 'me'\\ndebug1: Server host key: ssh-ed25519 SHA256:test\\n")
const listen = () => net.createServer(c => { c.on('data', () => c.end('HTTP/1.1 200 OK\\r\\ncontent-length: 8\\r\\nconnection: close\\r\\n\\r\\nupstream')) }).listen(socket)
// 'slow': the socket appears after 1.5 s, and SIGTERM takes 1 s to end the process.
let server
if (mode === 'slow') setTimeout(() => { server = listen() }, 1500); else server = listen()
process.on('SIGTERM', () => { setTimeout(() => { server?.close(); process.exit(0) }, mode === 'slow' ? 1000 : 0) })
setTimeout(() => process.exit(0), 20000).unref()
`)
  await chmodFs(path, 0o755)
  return path
}
async function freePort() {
  const srv = net.createServer()
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address()
  await new Promise(resolve => srv.close(resolve))
  return port
}
const fetchText = url => fetch(url).then(r => r.text()).catch(() => 'REFUSED')

test('the tunnel serves only while its ssh forward is up, and keeps the port while stopped', { timeout: 30000 }, async () => {
  const { Tunnel, LoopbackProxy } = await import('../app/lib/tunnel.js')
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-tun-'))
  await chmodFs(dir, 0o700)
  const port = await freePort()
  const proxy = new LoopbackProxy(port)
  const tunnel = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, 's.sock'), ssh: await fakeSsh(dir) })
  await tunnel.start()
  tunnel.route()
  assert.equal(await fetchText(`http://127.0.0.1:${port}/`), 'upstream')
  await tunnel.stop()
  assert.equal(await fetchText(`http://127.0.0.1:${port}/`), 'REFUSED')
  // DSH-SEC-05/06: no other process can take the port while the app runs.
  await assert.rejects(new Promise((resolve, reject) => { const srv = net.createServer(); srv.once('error', reject); srv.listen(port, '127.0.0.1', () => { srv.close(); resolve() }) }), /EADDRINUSE/u)
  proxy.close()
})

test('a port already held by another program fails closed and no ssh is started', { timeout: 30000 }, async () => {
  const { Tunnel, LoopbackProxy } = await import('../app/lib/tunnel.js')
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-tun-'))
  const squatter = net.createServer(c => c.end('HTTP/1.1 200 OK\r\n\r\nsquatter'))
  await new Promise(resolve => squatter.listen(0, '127.0.0.1', resolve))
  const { port } = squatter.address()
  const sshPath = await fakeSsh(dir)
  const proxy = new LoopbackProxy(port)
  const tunnel = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, 's.sock'), ssh: sshPath })
  await assert.rejects(tunnel.start(), /in use by another program/u)
  assert.equal(tunnel.child, undefined)
  squatter.close()
})

test('a failing ssh reports its error and leaves nothing routed', { timeout: 30000 }, async () => {
  const { Tunnel, LoopbackProxy } = await import('../app/lib/tunnel.js')
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-tun-'))
  const port = await freePort()
  const proxy = new LoopbackProxy(port)
  const tunnel = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => { throw new Error('onExit must not fire for a failed start') }, { proxy, socketPath: join(dir, 's.sock'), ssh: await fakeSsh(dir, 'fail') })
  await assert.rejects(tunnel.start(), /bind failed/u)
  assert.equal(proxy.upstream, undefined)
  assert.equal(await fetchText(`http://127.0.0.1:${port}/`), 'REFUSED')
  proxy.close()
})

// ---- generated setup script, executed against fake commands in a temporary HOME ----
/**
 * Stand-in for `dsh --profile server --dump-config`: one entry per selected bundle in the layout
 * the real command prints (group comment, `- id:`, `  name:`). `patch.json` in the profile
 * directory can override entries ({ "<id>": { "disabled": "<yaml>" } }) and they are then
 * printed under a "patched by" group, the way dsh labels user patches; `skip.json` lists bundles
 * dsh failed to load (left out of the dump).
 */
const DUMP_JS = `
const fs = require('fs'), dir = process.env.HOME + '/.dsh/profiles/server'
const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(dir + '/' + name, 'utf8')) } catch { return fallback } }
const bundles = read('package.json', undefined)?.dsh?.profile?.bundles
if (!Array.isArray(bundles)) process.exit(1)
const patch = read('patch.json', {}), skip = read('skip.json', [])
const entries = { '@deepseek-ai/dsh-base': ['web', '@deepseek-ai/dsh-base'], '@deepseek-ai/dsh-web-app': ['web-runtime', '@deepseek-ai/dsh-web-app'], 'dsh-remote-servers': ['remote-servers', 'dsh-remote-servers'] }
for (const bundle of bundles) {
  if (skip.includes(bundle) || entries[bundle] === undefined) continue
  const [id, name] = entries[bundle], over = patch[id]
  console.log('# == ' + bundle + (over ? ', patched by ' + dir + '/cordis.patch.yml' : ''))
  console.log('- id: ' + id + '\\n  name: ' + (name.startsWith('@') ? "'" + name + "'" : name))
  if (over?.disabled !== undefined) console.log('  disabled: ' + over.disabled)
}`

/**
 * Build a fake server: stub dsh/systemctl/npm/pnpm/loginctl that record what they were asked to
 * do. `profile` writes ~/.dsh/profiles/server files; `active` is the unit state; `pnpm` is the
 * version the installed pnpm reports (null: none installed); `npmInstallsPnpm` makes
 * `npm install pnpm@…` create a working pinned pnpm under the requested prefix.
 */
async function fakeServer({ profile, active = false, haveDsh = true, pnpm = '10.33.0', npmInstallsPnpm = false, unitStartedAt = 0 }) {
  const home = await mkdtemp(join(tmpdir(), 'dshrc-setup-'))
  const bin = join(home, 'bin')
  await mkdirFs(bin, { recursive: true })
  const calls = join(home, 'calls.log')
  const stub = async (name, body) => {
    await writeFileFs(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`)
    await chmodFs(join(bin, name), 0o755)
  }
  const unitActive = join(home, 'unit-active')
  if (active) await writeFileFs(unitActive, String(unitStartedAt))
  const log = join(home, '.dsh', 'logs', 'server-web.log')
  // `show -p ActiveEnterTimestamp` prints the start time as "@<epoch>", which date -d accepts.
  await stub('systemctl', `case "$*" in *is-active*) if [ -f "${unitActive}" ]; then case "$*" in *--quiet*) ;; *) echo active;; esac; exit 0; else case "$*" in *--quiet*) ;; *) echo inactive;; esac; exit 3; fi;; *ActiveEnterTimestamp*) echo "@$(cat "${unitActive}" 2>/dev/null || echo 0)";; *enable*|*restart*|*start*) date +%s > "${unitActive}"; mkdir -p "$(dirname "${log}")"; echo "dsh web: http://127.0.0.1:3080/?token=t_\$\$" >> "${log}";; esac; exit 0`)
  await stub('loginctl', 'exit 0')
  await writeFileFs(join(home, 'dump.js'), DUMP_JS)
  if (haveDsh) {
    await stub('dsh', `case "$*" in --version) echo 0.2.2-rc.1;; *from-default-profile*) mkdir -p "$HOME/.dsh/profiles/server"; printf '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}' > "$HOME/.dsh/profiles/server/package.json";; *"plugin --profile server add"*) node -e 'const f=process.argv[1];const d=JSON.parse(require("fs").readFileSync(f));if(!d.dsh.profile.bundles.includes("dsh-remote-servers"))d.dsh.profile.bundles.push("dsh-remote-servers");require("fs").writeFileSync(f,JSON.stringify(d))' "$HOME/.dsh/profiles/server/package.json";; "--profile server --dump-config") node "${join(home, 'dump.js')}";; esac; exit 0`)
    await stub('dsh-tui', 'exit 0')
  }
  if (pnpm !== null) await stub('pnpm', `echo ${pnpm}`)
  const pnpmScript = '#!/bin/sh\\necho 10.33.0\\n'
  await stub('npm', `case "$*" in "config get prefix") echo /usr;; *"pnpm@10.33.0"*) ${npmInstallsPnpm ? `p=$(echo "$*" | sed -n 's/.*--prefix \\([^ ]*\\).*/\\1/p'); mkdir -p "$p/bin"; printf '${pnpmScript}' > "$p/bin/pnpm"; chmod 755 "$p/bin/pnpm";;` : 'exit 1;;'} esac; exit 0`)
  if (profile !== undefined) {
    await mkdirFs(join(home, '.dsh', 'profiles', 'server'), { recursive: true })
    for (const [name, text] of Object.entries(profile)) await writeFileFs(join(home, '.dsh', 'profiles', 'server', name), text)
  }
  // A private bin holding only the stubs, node and the core tools the scripts use, so commands
  // installed on the machine running the tests (a real pnpm, dsh, systemctl) cannot leak in.
  for (const tool of ['sh', 'cat', 'grep', 'tail', 'wc', 'mkdir', 'chmod', 'touch', 'dirname', 'ls', 'id', 'printf', 'base64', 'rm', 'seq', 'sleep', 'tr', 'head', 'hostname', 'uname', 'mktemp', 'env', 'stat', 'date', 'awk', 'getent', 'sed', 'pwd']) {
    const found = ['/usr/bin', '/bin'].map(dir => join(dir, tool)).find(path => existsSync(path))
    if (found !== undefined) await symlink(found, join(bin, tool)).catch(() => undefined)
  }
  await symlink(process.execPath, join(bin, 'node')).catch(() => undefined)
  // The scripts append /usr/local/bin and friends to PATH; point them at an empty directory so a
  // real pnpm or dsh installed on the machine running the tests is never found.
  const run = (script) => {
    const isolated = script.replaceAll(EXTRA_PATH_LINE, `export PATH="$PATH:${join(home, 'empty')}"`)
    try {
      return { code: 0, out: execFileSync(join(bin, 'sh'), ['-c', isolated], { env: { HOME: home, PATH: bin }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    } catch (error) { return { code: error.status, out: String(error.stdout ?? ''), err: String(error.stderr ?? '') } }
  }
  const read = async name => readFileFs(join(home, name), 'utf8').catch(() => '')
  const write = (name, text) => writeFileFs(join(home, '.dsh', 'profiles', 'server', name), text)
  return { home, bin, run, read, write }
}
const tarball = 'AAAA'
const EXTRA_PATH_LINE = 'export PATH="$PATH:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.local/bin"'
const bundlesOf = async server => JSON.parse(await server.read('.dsh/profiles/server/package.json')).dsh.profile.bundles
const SELECTED = JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-servers'] } } })

test('setup on a fresh server creates the profile, adds the bundle and becomes ready', async () => {
  assert.ok(setupScript(HOST, tarball).includes(EXTRA_PATH_LINE) && probeScript(HOST).includes(EXTRA_PATH_LINE), 'the tests isolate PATH by replacing this line')
  const server = await fakeServer({})
  const { code, out } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 0, out)
  assert.match(out, /server ready/u)
  assert.deepEqual(await bundlesOf(server), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-servers'])
  const unit = await server.read('.config/systemd/user/dsh-server.service')
  assert.match(unit, /--host 127\.0\.0\.1 --port 3080/u)
  assert.match(unit, /UMask=0077/u)
  assert.match(unit, /Environment=PATH=/u)
  assert.equal(parseProbe(server.run(probeScript(HOST)).out).ready, true)
})

test('setup never replaces a non-empty profile that lacks package.json', async () => {
  const server = await fakeServer({ profile: { 'cordis.patch.yml': '# user data\n' } })
  const { code, err } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 15)
  assert.match(err, /no valid package\.json/u)
  assert.equal(await server.read('.dsh/profiles/server/cordis.patch.yml'), '# user data\n')
  assert.doesNotMatch(await server.read('calls.log'), /from-default-profile/u)
})

test('setup refuses a profile that lists the web app only as a dependency', async () => {
  const manifest = JSON.stringify({ dependencies: { '@deepseek-ai/dsh-web-app': '*', 'dsh-remote-servers': '*' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
  const server = await fakeServer({ profile: { 'package.json': manifest } })
  const { code, err } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 15)
  assert.match(err, /does not select @deepseek-ai\/dsh-web-app/u)
})

test('probe and setup count the page only when the composed profile enables it', async () => {
  const manifest = JSON.stringify({ dependencies: { 'dsh-remote-servers': '*' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
  const server = await fakeServer({ profile: { 'package.json': manifest }, active: true })
  assert.equal(parseProbe(server.run(probeScript(HOST)).out).plugin, false)
  const { code, out } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 0, out)
  assert.match(out, /add dsh-remote-servers/u)
  assert.match(out, /restart dsh-server\.service/u, 'the running service is restarted to load the page')
  assert.equal(parseProbe(server.run(probeScript(HOST)).out).plugin, true)
})

test('setup on a ready server changes nothing and reports ready', async () => {
  const server = await fakeServer({})
  assert.equal(server.run(setupScript(HOST, tarball)).code, 0)
  const unitBefore = await server.read('.config/systemd/user/dsh-server.service')
  const callsBefore = (await server.read('calls.log')).split('\n').length
  // The service started after the profile last changed.
  await new Promise(resolve => setTimeout(resolve, 1100))
  await writeFileFs(join(server.home, 'unit-active'), String(Math.floor(Date.now() / 1000)))
  const { code, out } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 0, out)
  assert.match(out, /server ready/u)
  assert.equal(await server.read('.config/systemd/user/dsh-server.service'), unitBefore)
  const second = (await server.read('calls.log')).split('\n').slice(callsBefore - 1).join('\n')
  assert.doesNotMatch(second, /from-default-profile|plugin --profile|restart|npm install/u)
})

test('N4-03: a page entry patched by the user (still enabled) counts as present', async () => {
  const server = await fakeServer({ profile: { 'package.json': SELECTED, 'patch.json': JSON.stringify({ 'remote-servers': { disabled: 'false' } }) } })
  const { code, out } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 0, out)
  assert.doesNotMatch(await server.read('calls.log'), /plugin --profile server add/u)
  assert.equal(parseProbe(server.run(probeScript(HOST)).out).plugin, true)
})

test('D06: a disabled or skipped page, or a skipped Web UI, is not ready and setup stops', async () => {
  for (const [label, files, expected] of [
    ['page disabled by a patch', { 'patch.json': JSON.stringify({ 'remote-servers': { disabled: 'true' } }) }, /not enabled/u],
    ['page skipped by dsh', { 'skip.json': JSON.stringify(['dsh-remote-servers']) }, /not enabled/u],
    ['Web UI skipped by dsh', { 'skip.json': JSON.stringify(['@deepseek-ai/dsh-web-app']) }, /does not enable the Web UI/u],
    ['Web UI disabled by an expression', { 'patch.json': JSON.stringify({ 'web-runtime': { disabled: "!!js process.platform === 'linux'" } }) }, /does not enable the Web UI/u],
  ]) {
    const server = await fakeServer({ profile: { 'package.json': SELECTED, ...files }, active: true })
    await mkdirFs(join(server.home, '.dsh', 'logs'), { recursive: true })
    await writeFileFs(join(server.home, '.dsh', 'logs', 'server-web.log'), 'dsh web: http://127.0.0.1:3080/?token=t_1\n')
    assert.equal(parseProbe(server.run(probeScript(HOST)).out).ready, false, label)
    const { code, err } = server.run(setupScript(HOST, tarball))
    assert.equal(code, 18, label)
    assert.match(err, expected, label)
  }
})

test('a service started before the profile changed is not ready, and setup restarts it', async () => {
  const server = await fakeServer({ profile: { 'package.json': SELECTED }, active: true, unitStartedAt: 1000 })
  await mkdirFs(join(server.home, '.dsh', 'logs'), { recursive: true })
  await writeFileFs(join(server.home, '.dsh', 'logs', 'server-web.log'), 'dsh web: http://127.0.0.1:3080/?token=t_1\n')
  const report = parseProbe(server.run(probeScript(HOST)).out)
  assert.equal(report.stale, true)
  assert.equal(report.ready, false)
  const { code, out } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 0, out)
  assert.match(out, /restart dsh-server\.service/u)
  assert.equal(parseProbe(server.run(probeScript(HOST)).out).ready, true)
})

test('N5/Q4-4: without the pinned pnpm, setup installs it into its own directory and the service uses it', async () => {
  // An old pnpm (such as a Corepack shim left beside node) must not shadow the pinned one.
  const server = await fakeServer({ pnpm: '11.0.0', npmInstallsPnpm: true })
  const { code, out } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 0, out)
  assert.match(await server.read('calls.log'), /npm install -g --prefix \S+\/\.dsh\/pnpm-10\.33\.0 .*pnpm@10\.33\.0/u)
  const unit = await server.read('.config/systemd/user/dsh-server.service')
  const path = /Environment=PATH=(\S+)/u.exec(unit)[1]
  const found = execFileSync(join(server.bin, 'sh'), ['-c', 'command -v pnpm; pnpm --version'], { env: { HOME: server.home, PATH: path }, encoding: 'utf8' })
  assert.match(found, /\.dsh\/pnpm-10\.33\.0\/bin\/pnpm\n10\.33\.0\n$/u)
})

test('Q4-4: setup stops with a clear message when the pinned pnpm cannot be installed', async () => {
  for (const pnpm of [null, '9.0.0']) {
    const server = await fakeServer({ pnpm })
    const { code, err } = server.run(setupScript(HOST, tarball))
    assert.equal(code, 16)
    assert.match(err, /pnpm 10\.33\.0 could not be installed; install it and retry/u)
    assert.doesNotMatch(await server.read('calls.log'), /plugin --profile server add/u)
  }
})

test('setup keeps a profile directory it cannot list', async () => {
  if (process.getuid?.() === 0) return // root can list anything
  const server = await fakeServer({ profile: { 'cordis.patch.yml': '# user data\n' } })
  const dir = join(server.home, '.dsh', 'profiles', 'server')
  await chmodFs(dir, 0o300)
  try {
    const { code } = server.run(setupScript(HOST, tarball))
    assert.notEqual(code, 0)
    assert.doesNotMatch(await server.read('calls.log'), /from-default-profile/u)
  } finally { await chmodFs(dir, 0o700) }
})

test('setup refuses an unsafe log location before it installs anything', async () => {
  const server = await fakeServer({})
  const shared = join(server.home, 'shared')
  await mkdirFs(join(shared, 'logs'), { recursive: true })
  await chmodFs(shared, 0o777)
  const { code, err } = server.run(setupScript({ ...HOST, serverLog: join(shared, 'logs', 'x.log') }, tarball))
  assert.equal(code, 17)
  assert.match(err, /can be changed by other users/u)
  assert.equal(await server.read('calls.log'), '', 'nothing was installed or started')
})

test('probe is not ready when the web app bundle is not selected', async () => {
  const manifest = JSON.stringify({ dependencies: { '@deepseek-ai/dsh-web-app': '*' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-remote-servers'] } } })
  const server = await fakeServer({ profile: { 'package.json': manifest }, active: true })
  await mkdirFs(join(server.home, '.dsh', 'logs'), { recursive: true })
  await writeFileFs(join(server.home, '.dsh', 'logs', 'server-web.log'), 'dsh web: http://127.0.0.1:3080/?token=t_1\n')
  const report = parseProbe(server.run(probeScript(HOST)).out)
  assert.equal(report.plugin, true)
  assert.equal(report.web, false)
  assert.equal(report.ready, false)
})

test('a stale stop of an old tunnel never affects a newer one', { timeout: 30000 }, async () => {
  const { Tunnel, LoopbackProxy } = await import('../app/lib/tunnel.js')
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-tun-'))
  await chmodFs(dir, 0o700)
  const port = await freePort()
  const proxy = new LoopbackProxy(port)
  const ssh = await fakeSsh(dir)
  const older = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, '1.s'), ssh })
  await older.start()
  older.route()
  await older.stop()
  const newer = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, '2.s'), ssh })
  await newer.start()
  newer.route()
  await older.stop()
  assert.equal(await fetchText(`http://127.0.0.1:${port}/`), 'upstream')
  await newer.stop()
  proxy.close()
})

test('D02: a tunnel stopped while it waits for its socket never routes and never displaces a newer one', { timeout: 30000 }, async () => {
  const { Tunnel, LoopbackProxy } = await import('../app/lib/tunnel.js')
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-tun-'))
  await chmodFs(dir, 0o700)
  const port = await freePort()
  const proxy = new LoopbackProxy(port)
  // The older ssh takes 1.5 s to open its socket and ignores SIGTERM for a while.
  const slow = await fakeSsh(dir, 'slow')
  const older = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, '1.s'), ssh: slow })
  const olderStart = older.start().then(() => 'started', error => error.message)
  await new Promise(resolve => setTimeout(resolve, 300))
  const stopping = older.stop()
  const newer = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, '2.s'), ssh: await fakeSsh(dir) })
  await newer.start()
  newer.route()
  assert.match(await olderStart, /stopped before it started/u)
  await stopping
  assert.equal(proxy.upstream, join(dir, '2.s'), 'the newer forward keeps the route')
  assert.equal(await fetchText(`http://127.0.0.1:${port}/`), 'upstream')
  assert.throws(() => older.route(), /no longer running/u)
  await newer.stop()
  proxy.close()
})

test('a tunnel reports the identity ssh verified, and only a running one can be routed', { timeout: 30000 }, async () => {
  const { Tunnel, LoopbackProxy } = await import('../app/lib/tunnel.js')
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-tun-'))
  await chmodFs(dir, 0o700)
  const port = await freePort()
  const proxy = new LoopbackProxy(port)
  const tunnel = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, 's'), ssh: await fakeSsh(dir) })
  await tunnel.start()
  assert.match(tunnel.identity, /^[0-9a-f]{64}$/u)
  assert.equal(proxy.upstream, undefined, 'start alone routes nothing')
  tunnel.route()
  await tunnel.stop()
  assert.throws(() => tunnel.route(), /no longer running/u)
  proxy.close()
})

test('a forward without a verified host key is never used', { timeout: 40000 }, async () => {
  const { Tunnel, LoopbackProxy } = await import('../app/lib/tunnel.js')
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-tun-'))
  await chmodFs(dir, 0o700)
  const port = await freePort()
  const proxy = new LoopbackProxy(port)
  const tunnel = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, 's'), ssh: await fakeSsh(dir, 'anonymous') })
  await assert.rejects(tunnel.start(), /verified server host key/u)
  assert.equal(proxy.upstream, undefined)
  proxy.close()
})

test('stop before start finishes prevents ssh from starting', { timeout: 30000 }, async () => {
  const { Tunnel, LoopbackProxy } = await import('../app/lib/tunnel.js')
  const dir = await mkdtemp(join(tmpdir(), 'dshrc-tun-'))
  const port = await freePort()
  const proxy = new LoopbackProxy(port)
  const tunnel = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, 's'), ssh: await fakeSsh(dir) })
  const starting = tunnel.start()
  const outcome = starting.then(() => 'started', error => error.message)
  await tunnel.stop()
  assert.match(await outcome, /stopped before it started/u)
  assert.equal(tunnel.child, undefined)
  proxy.close()
})

test('a pending sign-in is dropped when the account leaves the waiting state, and retried while declined', async () => {
  const sockets = []
  const OriginalWS = globalThis.WebSocket
  globalThis.WebSocket = class {
    constructor() { this.listeners = {}; sockets.push(this) }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
    send(text) { this.streamId = JSON.parse(text).streamId }
    close() {}
    emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event) }
  }
  try {
    let allow = false
    const opened = []
    const stop = watchAccountSignIn('http://127.0.0.1:1', 'c=1', { open: (url) => { if (!allow) return false; opened.push(url); return true }, theme: () => 'dark', log() {} })
    const socket = sockets[0]
    socket.emit('open')
    const frame = attempt => ({ data: JSON.stringify({ streamId: socket.streamId, type: 'item', value: { attempt } }) })
    socket.emit('message', frame({ id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize' }))
    socket.emit('message', frame(null))
    allow = true
    stop.retry()
    assert.equal(opened.length, 0, 'a cleared attempt must not open later')
    allow = false
    socket.emit('message', frame({ id: 'a2', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize' }))
    allow = true
    await new Promise(resolve => setTimeout(resolve, 2300))
    assert.equal(opened.length, 1, 'a declined attempt is retried without a new frame')
    stop()
  } finally { globalThis.WebSocket = OriginalWS }
})
