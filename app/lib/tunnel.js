/**
 * SSH transport: one remote command runner, and per server an app-owned loopback listener that
 * forwards to an `ssh -L` unix socket.
 *
 * The app binds 127.0.0.1:<localPort> itself and keeps it for as long as it runs, so no other
 * process can take that port between a tunnel stopping and the next one starting. ssh forwards
 * to a unix socket inside a private (0700) directory; a connection is passed on only after the
 * owner of a running tunnel routes the port to it, and refused otherwise.
 *
 * Every ssh runs with `-v` and connection sharing off, so each one authenticates on its own and
 * reports which server it reached: the endpoint and user (`Authenticating to …`) and the host key
 * ssh verified (`Server host key: …`). That identity, not the alias text, decides which browser
 * storage a server gets (see sessions.js).
 */
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import net from 'node:net'

const SSH = '/usr/bin/ssh'
const SSH_OPTIONS = [
  '-v', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
  // With connection sharing, ssh would reuse a master connection (no host key check of its own)
  // or hand a forward to the master and exit, so this process would no longer own it.
  '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
]
const READY_TIMEOUT_MS = 20_000

/** Collects ssh's `-v` stderr: identity lines apart, the rest (minus debug output) for errors. */
class SshOutput {
  constructor() {
    this.partial = ''
    this.endpoints = new Set()
    this.hostKeys = new Set()
    this.messages = ''
  }

  /** @param {string} chunk - next piece of stderr. */
  push(chunk) {
    const lines = (this.partial + chunk).split('\n')
    this.partial = lines.pop() ?? ''
    for (const line of lines) this.line(line.replace(/\r$/u, ''))
  }

  line(text) {
    const endpoint = /^debug1: Authenticating to (\S+) as '([^']*)'$/u.exec(text)
    if (endpoint !== null) { this.endpoints.add(`${endpoint[2]}@${endpoint[1]}`); return }
    const key = /^debug1: Server host key: (\S+ \S+)$/u.exec(text)
    if (key !== null) { this.hostKeys.add(key[1]); return }
    if (/^(?:debug\d|OpenSSH_|Authenticated to |Transferred: |Bytes per second: )/u.test(text)) return
    this.messages = `${this.messages}${text}\n`.slice(-4096)
  }

  /** What ssh printed that is not debug output (its error messages and the remote stderr). */
  get error() { return this.messages.trim() }

  /**
   * Digest of the server(s) this connection authenticated to (a ProxyJump adds the jump host);
   * empty unless ssh reported both the endpoint and a verified host key.
   */
  get identity() {
    if (this.hostKeys.size === 0 || this.endpoints.size === 0) return ''
    const text = `${[...this.endpoints].sort().join(',')}|${[...this.hostKeys].sort().join(',')}`
    return createHash('sha256').update(text).digest('hex')
  }
}

/**
 * Run one command on the SSH host.
 * @param {string} sshHost - validated destination.
 * @param {string} script - remote shell line.
 * @param {{ timeoutMs?: number }} [options] - kill the command after `timeoutMs` (default 90 s).
 * @returns {Promise<{ out: string, identity: string }>} stdout and the identity of the server
 *   that ran it; rejects with ssh's message on failure.
 */
export function sshRun(sshHost, script, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    // The script travels on stdin, so its size is not bound by the remote argv limit. It is
    // saved to a private temp file and run with stdin closed: under `sh -s`, commands that read
    // stdin (npm, pnpm) would swallow the rest of the script.
    const runner = 'umask 077; f=$(mktemp) || exit 90; trap \'rm -f "$f"\' EXIT; cat >"$f"; sh "$f" </dev/null'
    const child = execFile(SSH, [...SSH_OPTIONS, '--', sshHost, runner], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      const output = new SshOutput()
      output.push(`${stderr}\n`)
      if (error) reject(new Error(`ssh ${sshHost}: ${(output.error || error.message).slice(-2000)}`))
      else resolve({ out: stdout, identity: output.identity })
    })
    child.stdin.on('error', () => { /* ssh exited early; the callback reports why */ })
    child.stdin.end(script)
  })
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
      this.server.listen(this.port, '127.0.0.1', resolve)
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
  }

  /** True while this tunnel's ssh runs and it has not been stopped. */
  get alive() { return this.child !== undefined && this.child.exitCode === null && !this.stopping }

  /** Digest of the server this forward authenticated to (see SshOutput.identity). */
  get identity() { return this.output.identity }

  /** @returns {Promise<void>} resolves once ssh's forward accepts connections and its server is known. */
  async start() {
    if (this.proxy === undefined || this.socketPath === undefined) throw new Error('tunnel needs an app-owned proxy and a private socket path')
    await this.proxy.listen()
    if (this.stopping) throw stoppedError()
    await rm(this.socketPath, { force: true })
    if (this.stopping) throw stoppedError()
    const forward = `${this.socketPath}:${this.target.host}:${this.target.port}`
    const child = spawn(this.ssh, [...SSH_OPTIONS, '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes',
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
      // Only this user can create the socket inside the private directory. ssh prints the server's
      // identity before the forward listens; the pipe may still hold it, so wait for both.
      if (await canConnectPath(this.socketPath) && this.identity !== '') {
        if (this.stopping) throw stoppedError()
        if (exited) throw failure()
        ready = true
        return
      }
      await new Promise((resolve) => { setTimeout(resolve, 200) })
    }
    const message = this.identity === '' ? 'ssh did not report a verified server host key within 20 s' : 'ssh tunnel did not open within 20 s'
    await this.stop()
    throw new Error(message)
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
    return Promise.race([exited.then(() => undefined), new Promise((resolve) => { setTimeout(resolve, 3000) })])
      .then(() => (socket === undefined ? undefined : rm(socket, { force: true }).catch(() => undefined)))
  }
}
