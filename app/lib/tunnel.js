/** SSH transport: one remote command runner and one local port forward. */
import { spawn, execFile } from 'node:child_process'
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
    execFile(SSH, [...SSH_OPTIONS, '--', sshHost, script], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`ssh ${sshHost}: ${(stderr || error.message).trim()}`))
      else resolve(stdout)
    })
  })
}

/**
 * Whether nothing listens on 127.0.0.1:port, so a tunnel can claim it.
 * @param {number} port - local port.
 * @returns {Promise<boolean>} true when the port is free.
 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => { resolve(false) })
    server.listen(port, '127.0.0.1', () => { server.close(() => { resolve(true) }) })
  })
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { resolve(false) })
  })
}

/** One `ssh -N -L` forward from 127.0.0.1:localPort to the server's web listener. */
export class Tunnel {
  /**
   * @param {string} sshHost - validated destination.
   * @param {number} localPort - loopback port on this Mac.
   * @param {{ host: string, port: number }} target - dsh web listener as seen from the server.
   * @param {(code: number | null, stderr: string) => void} onExit - unexpected exit after start.
   */
  constructor(sshHost, localPort, target, onExit) {
    this.sshHost = sshHost
    this.localPort = localPort
    this.target = target
    this.onExit = onExit
    this.child = undefined
    this.stopping = false
    this.stderr = ''
  }

  /** @returns {Promise<void>} resolves once the forward accepts connections. */
  async start() {
    if (!await isPortFree(this.localPort)) throw new Error(`port 127.0.0.1:${this.localPort} is already in use; quit the other program or change localPort in remote.json`)
    const forward = `127.0.0.1:${this.localPort}:${this.target.host}:${this.target.port}`
    const child = spawn(SSH, [...SSH_OPTIONS, '-o', 'ExitOnForwardFailure=yes', '-N', '-L', forward, '--', this.sshHost], { stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    this.stopping = false
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4096) })
    let exited = false
    child.once('exit', (code) => {
      exited = true
      if (!this.stopping) this.onExit(code, this.stderr.trim())
    })
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exited) throw new Error(`ssh tunnel exited: ${this.stderr.trim() || 'no output'}`)
      if (await canConnect(this.localPort)) return
      await new Promise((resolve) => { setTimeout(resolve, 250) })
    }
    this.stop()
    throw new Error('ssh tunnel did not open within 20 s')
  }

  /** Stop the forward; does not report through onExit. */
  stop() {
    this.stopping = true
    this.child?.kill('SIGTERM')
    this.child = undefined
  }
}
