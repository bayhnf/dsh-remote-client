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
 * The KnownHostsCommand ssh would run for `sshHost` from the user's own configuration, as `ssh -G`
 * prints it (the configured text, tokens unexpanded), or undefined when there is none.
 * @param {string} ssh - ssh binary.
 * @param {string} sshHost - validated destination.
 * @param {AbortSignal} [signal] - stop waiting.
 * @returns {Promise<string | undefined>} the configured command line.
 */
function configuredKnownHostsCommand(ssh, sshHost, signal) {
  return new Promise((resolve, reject) => {
    execFile(ssh, ['-G', '--', sshHost], { timeout: 10_000, signal }, (error, stdout) => {
      if (error) { reject(new Error(`ssh -G ${sshHost}: ${error.message}`)); return }
      const line = String(stdout).split('\n').find(row => row.toLowerCase().startsWith('knownhostscommand '))
      const value = line?.slice('knownhostscommand '.length)
      resolve(value === undefined || value === '' || value.toLowerCase() === 'none' ? undefined : value)
    })
  })
}

/**
 * Split a KnownHostsCommand line exactly as OpenSSH does before it expands tokens: argv_split()
 * in misc.c (identical in 9.6 and 10.0), called with terminate_on_comment=0. Separators are space
 * and tab only; `\` escapes `\`, `'` and `"` anywhere, and a space outside quotes; any other `\`
 * is kept; quotes group. An unclosed quote is an error, as it is for ssh.
 * @param {string} text - command line.
 * @returns {string[]} words.
 */
export function splitCommand(text) {
  const words = []
  let i = 0
  while (i < text.length) {
    if (text[i] === ' ' || text[i] === '\t') { i++; continue }
    let quote = ''
    let word = ''
    for (; i < text.length; i++) {
      const c = text[i]
      const next = text[i + 1]
      if (c === '\\') {
        if (next === "'" || next === '"' || next === '\\' || (quote === '' && next === ' ')) { i++; word += next } else word += c
      } else if (quote === '' && (c === ' ' || c === '\t')) break
      else if (quote === '' && (c === '"' || c === "'")) quote = c
      else if (quote !== '' && c === quote) quote = ''
      else word += c
    }
    if (quote !== '') throw new Error('KnownHostsCommand in the SSH configuration contains invalid quotes')
    words.push(word)
  }
  return words
}

/**
 * Quote one word so that splitCommand (and ssh) reads it back unchanged: inside double quotes,
 * `\` `"` and `'` are escaped; nothing else is special there.
 * @param {string} word - any text.
 * @returns {string} quoted word.
 */
export function quoteWord(word) {
  return `"${word.replace(/[\\"']/gu, c => `\\${c}`)}"`
}

/**
 * A private record of the server one ssh process verified.
 *
 * ssh runs KnownHostsCommand for the final destination only (a ProxyJump or ProxyCommand host is
 * another ssh process), and passes it that destination's user, host, port and the host key or
 * certificate it is about to verify. The recorder writes those values, NUL-separated, to a
 * private file, then runs the user's own KnownHostsCommand (from ~/.ssh/config) unchanged, so
 * whatever it prints is still what ssh trusts; without one it prints nothing and ssh uses
 * known_hosts as usual. Nothing the server sends can reach the record.
 * `options` are the ssh arguments; `identity()` reads the record back.
 * @param {string} sshHost - validated destination.
 * @param {{ ssh?: string, signal?: AbortSignal }} [options] - ssh binary (tests) and abort signal.
 */
async function identityRecord(sshHost, { ssh = SSH, signal } = {}) {
  const configured = await configuredKnownHostsCommand(ssh, sshHost, signal)
  // Split now, so a configuration ssh itself would reject fails here with a clear message.
  const userWords = configured === undefined ? [] : splitCommand(configured).map(quoteWord)
  // ssh splits this option on whitespace, so the record path must have none.
  const base = /^[A-Za-z0-9._/-]+$/u.test(tmpdir()) ? tmpdir() : '/tmp'
  const dir = await mkdtemp(join(base, 'dshrc-id-'))
  const file = join(dir, 'record')
  const count = 7
  // $1 record file, $2.. %I %r %h %p %t %f %K, then the user's command words (already expanded by
  // ssh). Only a HOSTNAME lookup with a key is recorded; ssh may also look up by ADDRESS
  // (CheckHostIP) or for algorithm ORDER without a key.
  const script = [
    'f=$1; shift',
    // No single quotes inside: the whole script travels in one single-quoted ssh word.
    'if [ "$1" = HOSTNAME ] && [ "$5" != NONE ]; then printf "%%s\\0" "$2" "$3" "$4" "$5" "$7" >> "$f" || exit 1; printf "\\n" >> "$f" || exit 1; fi',
    `shift ${count}`,
    'if [ $# -gt 0 ]; then exec "$@"; fi',
    'exit 0',
  ].join('; ')
  if (script.includes("'")) throw new Error('identity recorder script must not contain single quotes')
  // The user's words, each quoted, follow the recorder's own: ssh splits the line back into the
  // same words and expands their tokens exactly as it would have for the user's command.
  return {
    options: ['-o', `KnownHostsCommand=/bin/sh -c '${script}' dshrc ${file} %I %r %h %p %t %f %K ${userWords.join(' ')}`.trimEnd()],
    /** @returns {Promise<string>} digest of the final destination and its key, or '' when ssh verified none. */
    async identity() {
      const text = await readFile(file, 'utf8').catch(() => '')
      const records = [...new Set(text.split('\n').filter(Boolean))]
      // One lookup by name per connection; more than one distinct target is never trusted.
      if (records.length !== 1) return ''
      const fields = records[0].split('\0')
      // Five values, each followed by NUL: exactly six parts with an empty last one.
      if (fields.length !== 6 || fields[5] !== '' || fields.slice(0, 5).some(value => value === '')) return ''
      return createHash('sha256').update(JSON.stringify(fields.slice(0, 5))).digest('hex')
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
  const record = await identityRecord(sshHost, { signal })
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
    const server = this.server
    this.ready = new Promise((resolve, reject) => {
      const failed = (error) => {
        if (this.server === server) this.server = undefined
        reject(error.code === 'EADDRINUSE'
          ? new Error(`port 127.0.0.1:${this.port} is in use by another program; quit it or change localPort in remote.json`)
          : error)
      }
      server.once('error', failed)
      server.listen(this.port, '127.0.0.1', () => {
        // Once bound, an accept error (such as EMFILE) concerns one connection: the server and
        // the port stay held, and close() still releases them.
        server.off('error', failed)
        server.on('error', () => {})
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
    this.record = await identityRecord(this.sshHost, { ssh: this.ssh })
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
