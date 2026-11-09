/**
 * SSH transport: one remote command runner, and per server an app-owned loopback listener that
 * forwards to an `ssh -L` unix socket.
 *
 * The app binds 127.0.0.1:<localPort> itself and keeps it for as long as it runs, so no other
 * process can take that port between a tunnel stopping and the next one starting. ssh forwards
 * to a unix socket inside a private (0700) directory; a connection is passed on only while a
 * tunnel whose ssh created that socket is up, and refused otherwise.
 */
import { spawn, execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import net from 'node:net'

const SSH = '/usr/bin/ssh'
const SSH_OPTIONS = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
]
const READY_TIMEOUT_MS = 20_000

/**
 * Run one command on the SSH host.
 * @param {string} sshHost - validated destination.
 * @param {string} script - remote shell line.
 * @param {number} [timeoutMs] - kill the command after this long (default 90 s).
 * @returns {Promise<string>} stdout; rejects with stderr on failure.
 */
export function runRemote(sshHost, script, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    // The script travels on stdin, so its size is not bound by the remote argv limit. It is
    // saved to a private temp file and run with stdin closed: under `sh -s`, commands that read
    // stdin (npm, pnpm) would swallow the rest of the script.
    const runner = 'umask 077; f=$(mktemp) || exit 90; trap \'rm -f "$f"\' EXIT; cat >"$f"; sh "$f" </dev/null'
    const child = execFile(SSH, [...SSH_OPTIONS, '--', sshHost, runner], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`ssh ${sshHost}: ${(stderr || error.message).trim().slice(-2000)}`))
      else resolve(stdout)
    })
    child.stdin.on('error', () => { /* ssh exited early; the callback reports why */ })
    child.stdin.end(script)
  })
}

/**
 * What an SSH destination resolves to (`ssh -G`): user@hostname:port. Used to tie browser storage
 * to the real endpoint, so retargeting an alias in ~/.ssh/config never reuses the old cookies.
 * @param {string} sshHost - validated destination.
 * @returns {Promise<string>} resolved endpoint, or the destination itself when ssh -G fails.
 */
export function resolveEndpoint(sshHost) {
  return new Promise((resolve) => {
    execFile(SSH, ['-G', '--', sshHost], { timeout: 10_000 }, (error, stdout) => {
      if (error) { resolve(sshHost); return }
      const field = name => (stdout.match(new RegExp(`^${name} (.+)$`, 'mu')) ?? [])[1] ?? ''
      resolve(`${field('user')}@${field('hostname')}:${field('port')}`)
    })
  })
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

/** One `ssh -N -L <private socket>:<listener>` forward, exposed through a LoopbackProxy. */
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
    this.stderr = ''
  }

  /** True while this tunnel's ssh runs and it has not been stopped. */
  get alive() { return this.child !== undefined && this.child.exitCode === null && !this.stopping }

  /** @returns {Promise<void>} resolves once ssh's forward accepts connections and the proxy uses it. */
  async start() {
    if (this.proxy === undefined || this.socketPath === undefined) throw new Error('tunnel needs an app-owned proxy and a private socket path')
    await this.proxy.listen()
    if (this.stopping) throw new Error('tunnel stopped before it started')
    await rm(this.socketPath, { force: true })
    if (this.stopping) throw new Error('tunnel stopped before it started')
    const forward = `${this.socketPath}:${this.target.host}:${this.target.port}`
    // ControlMaster/ControlPath off: with connection sharing, ssh hands the forward to a master
    // process and exits at once, so this process would no longer own (or report on) the forward.
    const child = spawn(this.ssh, [...SSH_OPTIONS, '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes',
      '-o', 'StreamLocalBindMask=0177', '-N', '-L', forward, '--', this.sshHost], { stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4096) })
    let exited = false
    let ready = false
    this.exited = new Promise((resolve) => { child.once('exit', resolve) })
    child.once('exit', (code) => {
      exited = true
      if (this.proxy?.upstream === this.socketPath) this.proxy.setUpstream(undefined)
      // Only a drop after a successful start is reported here; start() reports its own failure.
      if (ready && !this.stopping) this.onExit(code, this.stderr.trim())
    })
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exited) throw new Error(`ssh tunnel exited: ${this.stderr.trim() || 'no output'}`)
      // Only this user can create the socket inside the private directory.
      if (await canConnectPath(this.socketPath)) {
        if (exited) break
        ready = true
        this.proxy.setUpstream(this.socketPath)
        return
      }
      await new Promise((resolve) => { setTimeout(resolve, 200) })
    }
    await this.stop()
    throw new Error(exited ? `ssh tunnel exited: ${this.stderr.trim() || 'no output'}` : 'ssh tunnel did not open within 20 s')
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
