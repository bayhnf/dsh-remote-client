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
  assert.deepEqual(parseProbe(out), { hostname: 'gpu-box', os: 'Linux', node: 'v24.22.0', dsh: '', dshTui: false, unit: 'inactive', plugin: false, ready: false })
  const ready = '@@DSH-REMOTE-REPORT@@{"hostname":"b","os":"Linux","node":"v22","dsh":"0.2.2","dshTui":"yes","unit":"active","launchLines":3,"plugin":"yes"}'
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
import { mkdtemp, writeFile as writeFileFs, readFile as readFileFs, mkdir as mkdirFs, chmod as chmodFs, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
