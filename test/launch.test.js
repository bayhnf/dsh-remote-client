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
  assert.deepEqual(parseProbe(out), { hostname: 'gpu-box', os: 'Linux', node: 'v24.22.0', dsh: '', dshTui: false, unit: 'inactive', plugin: false, web: false, ready: false })
  const ready = '@@DSH-REMOTE-REPORT@@{"hostname":"b","os":"Linux","node":"v22","dsh":"0.2.2","dshTui":"yes","unit":"active","launchLines":3,"plugin":"yes","web":"yes"}'
  assert.equal(parseProbe(ready).ready, true)
  assert.equal(parseProbe(ready.replace('"plugin":"yes"', '"plugin":"no"')).ready, false)
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

test('setup gives the service a PATH with the directories of node, dsh, dsh-tui and pnpm', () => {
  const script = setupScript(HOST, 'AAAA')
  assert.match(script, /for c in dsh dsh-tui pnpm/u)
  assert.match(script, /Environment=PATH=%s:\/usr\/local\/bin/u)
})

test('setup refuses a log directory it does not own (shared /tmp-like parent)', async () => {
  const server = await fakeServer({})
  // /tmp itself is not owned by this user, so a log placed directly in it must be refused.
  const host = { ...HOST, serverLog: '/tmp/dsh-remote-shared-test.log' }
  const { code, err } = server.run(setupScript(host, tarball))
  assert.equal(code, 17)
  assert.match(err, /must be a directory owned by/u)
})

test('launchScript only tightens files this user owns', () => {
  assert.match(launchScript(HOST), /\[ -O "\$LD" \] && chmod 700/u)
  assert.match(launchScript(HOST), /\[ -O "\$L" \] && \[ ! -L "\$L" \] && chmod 600/u)
})

// ---- tunnel: app-owned listener + private socket, with a fake ssh ----
/**
 * A stand-in for /usr/bin/ssh: it parses `-L <socket>:<host>:<port>`, listens on that unix
 * socket and answers every connection with a fixed HTTP response. `mode` 'fail' exits at once.
 */
async function fakeSsh(dir, mode = 'ok') {
  const path = join(dir, 'fake-ssh.mjs')
  await writeFileFs(path, `#!${process.execPath}
import net from 'node:net'
const forward = process.argv[process.argv.indexOf('-L') + 1]
const socket = forward.slice(0, forward.lastIndexOf(':', forward.lastIndexOf(':') - 1))
if (${JSON.stringify(mode)} === 'fail') { process.stderr.write('bind failed'); process.exit(255) }
const server = net.createServer(c => { c.on('data', () => c.end('HTTP/1.1 200 OK\\r\\ncontent-length: 8\\r\\nconnection: close\\r\\n\\r\\nupstream')) }).listen(socket)
process.on('SIGTERM', () => { server.close(); process.exit(0) })
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
 * Build a fake server: stub dsh/systemctl/npm/pnpm/corepack/loginctl that record what they were
 * asked to do. `profile` writes ~/.dsh/profiles/server files; `active` is the unit state.
 */
async function fakeServer({ profile, active = false, haveDsh = true, havePnpm = true }) {
  const home = await mkdtemp(join(tmpdir(), 'dshrc-setup-'))
  const bin = join(home, 'bin')
  await mkdirFs(bin, { recursive: true })
  const calls = join(home, 'calls.log')
  const stub = async (name, body) => {
    await writeFileFs(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`)
    await chmodFs(join(bin, name), 0o755)
  }
  const unitActive = join(home, 'unit-active')
  if (active) await writeFileFs(unitActive, '')
  const log = join(home, '.dsh', 'logs', 'server-web.log')
  await stub('systemctl', `case "$*" in *is-active*) [ -f "${unitActive}" ] && exit 0 || exit 3;; *enable*|*restart*|*start*) touch "${unitActive}"; mkdir -p "$(dirname "${log}")"; echo "dsh web: http://127.0.0.1:3080/?token=t_\$\$" >> "${log}";; esac; exit 0`)
  await stub('loginctl', 'exit 0')
  if (haveDsh) {
    await stub('dsh', `case "$*" in --version) echo 0.2.2-rc.1;; *from-default-profile*) mkdir -p "$HOME/.dsh/profiles/server"; printf '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}' > "$HOME/.dsh/profiles/server/package.json";; *"plugin --profile server add"*) node -e 'const f=process.argv[1];const d=JSON.parse(require("fs").readFileSync(f));d.dsh.profile.bundles.push("dsh-remote-servers");require("fs").writeFileSync(f,JSON.stringify(d))' "$HOME/.dsh/profiles/server/package.json";; "--profile server --dump-config") node -e 'try{for(const b of JSON.parse(require("fs").readFileSync(process.argv[1])).dsh.profile.bundles)console.log("# == "+b)}catch{process.exit(1)}' "$HOME/.dsh/profiles/server/package.json";; esac; exit 0`)
    await stub('dsh-tui', 'exit 0')
  }
  if (havePnpm) await stub('pnpm', 'echo 10.33.0')
  await stub('npm', 'case "$*" in "config get prefix") echo /usr;; esac; exit 0')
  await stub('corepack', 'exit 1')
  if (profile !== undefined) {
    await mkdirFs(join(home, '.dsh', 'profiles', 'server'), { recursive: true })
    for (const [name, text] of Object.entries(profile)) await writeFileFs(join(home, '.dsh', 'profiles', 'server', name), text)
  }
  // A private bin holding only the stubs, node and the core tools the scripts use, so commands
  // installed on the machine running the tests (a real pnpm, dsh, systemctl) cannot leak in.
  for (const tool of ['sh', 'cat', 'grep', 'tail', 'wc', 'mkdir', 'chmod', 'touch', 'dirname', 'ls', 'id', 'printf', 'base64', 'rm', 'seq', 'sleep', 'tr', 'head', 'hostname', 'uname', 'mktemp', 'env']) {
    const found = ['/usr/bin', '/bin'].map(dir => join(dir, tool)).find(path => existsSync(path))
    if (found !== undefined) await symlink(found, join(bin, tool)).catch(() => undefined)
  }
  await symlink(process.execPath, join(bin, 'node')).catch(() => undefined)
  const run = (script) => {
    try {
      return { code: 0, out: execFileSync(join(bin, 'sh'), ['-c', script], { env: { HOME: home, PATH: bin }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    } catch (error) { return { code: error.status, out: String(error.stdout ?? ''), err: String(error.stderr ?? '') } }
  }
  const read = async name => readFileFs(join(home, name), 'utf8').catch(() => '')
  return { home, run, read }
}
const tarball = 'AAAA'
const bundlesOf = async server => JSON.parse(await server.read('.dsh/profiles/server/package.json')).dsh.profile.bundles

test('setup on a fresh server creates the profile, adds the bundle and becomes ready', async () => {
  const server = await fakeServer({})
  const { code, out } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 0, out)
  assert.match(out, /server ready/u)
  assert.deepEqual(await bundlesOf(server), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-remote-servers'])
  const unit = await server.read('.config/systemd/user/dsh-server.service')
  assert.match(unit, /--host 127\.0\.0\.1 --port 3080/u)
  assert.match(unit, /UMask=0077/u)
  assert.match(unit, /Environment=PATH=/u)
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

test('probe and setup count the page only when it is a selected bundle', async () => {
  const manifest = JSON.stringify({ dependencies: { 'dsh-remote-servers': '*' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } })
  const server = await fakeServer({ profile: { 'package.json': manifest }, active: true })
  assert.equal(parseProbe(server.run(probeScript(HOST)).out).plugin, false)
  const { code, out } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 0, out)
  assert.match(out, /add dsh-remote-servers/u)
  assert.equal(parseProbe(server.run(probeScript(HOST)).out).plugin, true)
})

test('setup on a ready server changes nothing and reports ready', async () => {
  const server = await fakeServer({})
  assert.equal(server.run(setupScript(HOST, tarball)).code, 0)
  const unitBefore = await server.read('.config/systemd/user/dsh-server.service')
  const callsBefore = (await server.read('calls.log')).split('\n').length
  const { code, out } = server.run(setupScript(HOST, tarball))
  assert.equal(code, 0, out)
  assert.match(out, /server ready/u)
  assert.equal(await server.read('.config/systemd/user/dsh-server.service'), unitBefore)
  const second = (await server.read('calls.log')).split('\n').slice(callsBefore - 1).join('\n')
  assert.doesNotMatch(second, /from-default-profile|plugin --profile|restart|npm install/u)
})

test('setup without pnpm installs the pinned version and puts it on PATH', { skip: existsSync('/usr/local/bin/pnpm') && 'a real pnpm in /usr/local/bin (which setup adds to PATH) would be found first' }, async () => {
  const server = await fakeServer({ havePnpm: false })
  const { code, err } = server.run(setupScript(HOST, tarball))
  assert.match(await server.read('calls.log'), /npm install -g --prefix \/usr --no-fund --no-audit pnpm@10\.33\.0/u)
  // The fake npm installs nothing, so setup must stop with a clear message instead of continuing.
  assert.equal(code, 16)
  assert.match(err, /pnpm could not be installed/u)
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
  await older.stop()
  const newer = new Tunnel('x', port, { host: '127.0.0.1', port: 3080 }, () => {}, { proxy, socketPath: join(dir, '2.s'), ssh })
  await newer.start()
  await older.stop()
  assert.equal(await fetchText(`http://127.0.0.1:${port}/`), 'upstream')
  await newer.stop()
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
