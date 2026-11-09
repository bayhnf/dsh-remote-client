/**
 * SSH transport: one remote command runner, and per server an app-owned loopback listener that
 * forwards to an `ssh -L` unix socket.
 *
 * The app binds 127.0.0.1:<localPort> itself and keeps it for as long as it runs, so no other
 * process can take that port between a tunnel stopping and the next one starting. ssh forwards
 * to a unix socket inside a private (0700) directory; a connection is passed on only after the
 * owner of a running tunnel routes the port to it, and refused otherwise.
 *
 * Every ssh reports which server it reached. ssh runs a KnownHostsCommand (which prints nothing,
 * so host keys are still verified against known_hosts as usual) and passes it the final
 * destination's user, host, port and host key (or host certificate) when it looks that host up by
 * name; ProxyJump and ProxyCommand hosts are separate ssh processes and are never recorded. The
 * record goes to a private file of this app, so nothing the server prints can change it. That
 * identity, not the alias text, decides which browser storage a server gets (see sessions.js).
 */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const SSH = '/usr/bin/ssh'
const SSH_OPTIONS = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
  // With connection sharing, ssh would reuse a master connection (no host key check of its own)
  // or hand a forward to the master and exit, so this process would no longer own it.
  '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
]
const READY_TIMEOUT_MS = 20_000

/**
 * A private record of the server one ssh process verified.
 * `options` are the ssh arguments that make ssh write it; `identity()` reads it back.
 */
async function identityRecord() {
  // ssh splits the KnownHostsCommand line on whitespace, so the record path must have none.
  const base = /^[A-Za-z0-9._/-]+$/u.test(tmpdir()) ? tmpdir() : '/tmp'
  const dir = await mkdtemp(join(base, 'dshrc-id-'))
  const file = join(dir, 'record')
  // ssh expands %-tokens itself and runs the command without a shell; the arguments reach
  // /bin/sh as positional parameters, so no value is parsed as shell text. The script prints
  // nothing (host keys come from known_hosts) and exits 0, so it never changes what ssh accepts.
  // `%%` is ssh's escape for a literal `%`.
  const script = 'f=$1; shift; [ "$1" = HOSTNAME ] && [ "$5" != NONE ] && printf "%%s\\n" "$*" >> "$f"; exit 0'
  return {
    options: ['-o', `KnownHostsCommand=/bin/sh -c '${script}' dshrc ${file} %I %r %h %p %t %f %K`],
    /** @returns {Promise<string>} digest of user@host:port + key, or '' when ssh verified none. */
    async identity() {
      const text = await readFile(file, 'utf8').catch(() => '')
      const lines = [...new Set(text.split('\n').filter(Boolean))]
      // One lookup by name per connection; more than one distinct target is never trusted.
      if (lines.length !== 1) return ''
      const [, user, host, port, keyType, , key] = lines[0].split(' ')
      if (!user || !host || !port || !keyType || !key) return ''
      return createHash('sha256').update(`${user}@${host}:${port}|${keyType} ${key}`).digest('hex')
    },
    dispose: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  }
}

/** Keeps the tail of ssh's stderr for error messages. */
class SshOutput {
  constructor() { this.messages = '' }
  /** @param {string} chunk - next piece of stderr. */
  push(chunk) { this.messages = `${this.messages}${chunk}`.slice(-4096) }
  /** What ssh printed (its error messages and the remote stderr). */
  get error() { return this.messages.trim() }
}

/**
 * Run one command on the SSH host.
 * @param {string} sshHost - validated destination.
 * @param {string} script - remote shell line.
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - kill the command after
 *   `timeoutMs` (default 90 s), or when `signal` aborts.
 * @returns {Promise<{ out: string, identity: string }>} stdout and the identity of the server
 *   that ran it; rejects with ssh's message on failure.
 */
export async function sshRun(sshHost, script, { timeoutMs = 90_000, signal } = {}) {
  const record = await identityRecord()
  try {
    const out = await new Promise((resolve, reject) => {
      // The script travels on stdin, so its size is not bound by the remote argv limit. It is
      // saved to a private temp file and run with stdin closed: under `sh -s`, commands that read
      // stdin (npm, pnpm) would swallow the rest of the script.
      const runner = 'umask 077; f=$(mktemp) || exit 90; trap \'rm -f "$f"\' EXIT; cat >"$f"; sh "$f" </dev/null'
      const child = execFile(SSH, [...SSH_OPTIONS, ...record.options, '--', sshHost, runner], { timeout: timeoutMs, maxBuffer: 4 << 20, signal }, (error, stdout, stderr) => {
        if (error) reject(new Error(`ssh ${sshHost}: ${(String(stderr).trim() || error.message).slice(-2000)}`))
        else resolve(stdout)
      })
      child.stdin.on('error', () => { /* ssh exited early; the callback reports why */ })
      child.stdin.end(script)
    })
    return { out, identity: await record.identity() }
  } finally { await record.dispose() }
}

/**
 * Run one command on the SSH host.
 * @param {string} sshHost - validated destination.
 * @param {string} script - remote shell line.
 * @param {number} [timeoutMs] - kill the command after this long (default 90 s).
 * @returns {Promise<string>} stdout; rejects with ssh's message on failure.
 */
export function runRemote(sshHost, script, timeoutMs) {
  return sshRun(sshHost, script, { timeoutMs }).then(result => result.out)
}

/** The app-owned listener on 127.0.0.1:<port>; it stays bound while the app runs. */
export class LoopbackProxy {
  /** @param {number} port - loopback port the window loads. */
  constructor(port) {
    this.port = port
    this.server = undefined
    this.upstream = undefined
    this.connections = new Set()
  }

  /** Bind the port once; rejects (fails closed) when another program already holds it. */
  listen() {
    if (this.server !== undefined) return this.ready
    this.server = net.createServer((client) => {
      const path = this.upstream
      if (path === undefined) { client.destroy(); return }
      const upstream = net.connect(path)
      const pair = { client, upstream }
      this.connections.add(pair)
      const done = () => { this.connections.delete(pair); client.destroy(); upstream.destroy() }
      client.on('error', done).on('close', done)
      upstream.on('error', done).on('close', done)
      client.pipe(upstream).pipe(client)
    })
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', (error) => {
        this.server = undefined
        reject(error.code === 'EADDRINUSE'
          ? new Error(`port 127.0.0.1:${this.port} is in use by another program; quit it or change localPort in remote.json`)
          : error)
      })
      this.server.listen(this.port, '127.0.0.1', () => {
        // Once bound, an accept error (such as EMFILE) concerns one connection; the port stays held.
        this.server?.on('error', () => {})
        resolve()
      })
    })
    return this.ready
  }

  /** Route new connections to `path`, or refuse them; open connections to an old upstream end. */
  setUpstream(path) {
    if (path === this.upstream) return
    this.upstream = path
    for (const { client, upstream } of this.connections) { client.destroy(); upstream.destroy() }
    this.connections.clear()
  }

  /** Release the port (the server was removed or the app is quitting). */
  close() {
    this.setUpstream(undefined)
    this.server?.close()
    this.server = undefined
  }
}

function canConnectPath(path) {
  return new Promise((resolve) => {
    const socket = net.connect(path)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { resolve(false) })
  })
}

const stoppedError = () => new Error('tunnel stopped before it started')

/**
 * One `ssh -N -L <private socket>:<listener>` forward. `start()` opens it and learns which server
 * it reached; nothing is routed to it until its owner calls `route()`.
 */
export class Tunnel {
  /**
   * @param {string} sshHost - validated destination.
   * @param {number} localPort - loopback port of `options.proxy` (kept for logs).
   * @param {{ host: string, port: number }} target - dsh web listener as seen from the server.
   * @param {(code: number | null, stderr: string) => void} onExit - unexpected exit after start.
   * @param {{ proxy?: LoopbackProxy, socketPath?: string, ssh?: string }} [options] - the app-owned
   *   listener, a socket path inside a private directory, and the ssh binary (tests).
   */
  constructor(sshHost, localPort, target, onExit, options = {}) {
    this.sshHost = sshHost
    this.localPort = localPort
    this.target = target
    this.onExit = onExit
    this.proxy = options.proxy
    this.socketPath = options.socketPath
    this.ssh = options.ssh ?? SSH
    this.child = undefined
    this.stopping = false
    this.output = new SshOutput()
    this.identity = ''
    this.record = undefined
  }

  /** True while this tunnel's ssh runs and it has not been stopped. */
  get alive() { return this.child !== undefined && this.child.exitCode === null && !this.stopping }

  /** @returns {Promise<void>} resolves once ssh's forward accepts connections and its server is known. */
  async start() {
    if (this.proxy === undefined || this.socketPath === undefined) throw new Error('tunnel needs an app-owned proxy and a private socket path')
    await this.proxy.listen()
    if (this.stopping) throw stoppedError()
    await rm(this.socketPath, { force: true })
    this.record = await identityRecord()
    if (this.stopping) { await this.record.dispose(); throw stoppedError() }
    const forward = `${this.socketPath}:${this.target.host}:${this.target.port}`
    const child = spawn(this.ssh, [...SSH_OPTIONS, ...this.record.options, '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes',
      '-o', 'StreamLocalBindMask=0177', '-N', '-L', forward, '--', this.sshHost], { stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.output.push(chunk) })
    let exited = false
    let ready = false
    this.exited = new Promise((resolve) => { child.once('exit', resolve) })
    child.once('exit', (code) => {
      exited = true
      if (this.proxy?.upstream === this.socketPath) this.proxy.setUpstream(undefined)
      // Only a drop after a successful start is reported here; start() reports its own failure.
      if (ready && !this.stopping) this.onExit(code, this.output.error)
    })
    const failure = () => new Error(`ssh tunnel exited: ${this.output.error || 'no output'}`)
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.stopping) throw stoppedError()
      if (exited) throw failure()
      // Only this user can create the socket inside the private directory. ssh verified the
      // server's host key before the forward listens.
      if (await canConnectPath(this.socketPath)) {
        const identity = await this.record.identity()
        if (this.stopping) throw stoppedError()
        if (exited) throw failure()
        if (identity === '') break
        this.identity = identity
        ready = true
        return
      }
      await new Promise((resolve) => { setTimeout(resolve, 200) })
    }
    const opened = await canConnectPath(this.socketPath)
    await this.stop()
    throw new Error(opened ? 'ssh did not report the host key it verified for this server' : 'ssh tunnel did not open within 20 s')
  }

  /** Send the proxy's new connections to this forward; only a started, running tunnel can be routed. */
  route() {
    if (!this.alive) throw new Error('ssh tunnel is no longer running')
    this.proxy.setUpstream(this.socketPath)
  }

  /** @returns {Promise<void>} stops routing at once, then resolves once ssh has exited. */
  stop() {
    this.stopping = true
    if (this.proxy !== undefined && this.proxy.upstream === this.socketPath) this.proxy.setUpstream(undefined)
    const exited = this.exited ?? Promise.resolve()
    if (this.child !== undefined && this.child.exitCode === null) this.child.kill('SIGTERM')
    this.child = undefined
    const socket = this.socketPath
    const record = this.record
    return Promise.race([exited.then(() => undefined), new Promise((resolve) => { setTimeout(resolve, 3000) })])
      .then(() => Promise.all([
        socket === undefined ? undefined : rm(socket, { force: true }).catch(() => undefined),
        record?.dispose(),
      ])).then(() => undefined)
  }
}
