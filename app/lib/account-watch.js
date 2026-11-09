/**
 * Desktop-mode DeepSeek sign-in, ported from the official account-backend.ts watch(): in Desktop
 * mode the Web UI only calls account/startSignIn, and the shell opens the authorization page in
 * the system browser when the Host reports the attempt as waiting-browser.
 */
import { randomUUID } from 'node:crypto'

const STREAM_PATH = '/api/remote.mux'

/** Hosts whose sign-in pages the app opens; override with DSH_REMOTE_SIGNIN_HOSTS (comma-separated). */
const SIGNIN_HOSTS = (process.env.DSH_REMOTE_SIGNIN_HOSTS ?? 'platform.deepseek.com').split(',').map(host => host.trim()).filter(Boolean)

/**
 * Accept DeepSeek Platform pages over https, or loopback http, without URL credentials
 * (account-backend.ts validateBrowserDestination, narrowed to the sign-in hosts).
 * @param {string} value - authorizeUrl from the Host.
 * @returns {string | undefined} the URL, or undefined when it is not an allowed destination.
 */
export function authorizeDestination(value) {
  let url
  try { url = new URL(value) } catch { return undefined }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password) return undefined
  if (!((url.protocol === 'https:' && SIGNIN_HOSTS.includes(url.hostname)) || (loopback && url.protocol === 'http:'))) return undefined
  return url.href
}

/**
 * Follow account/watch on the Host and open each new waiting-browser attempt once.
 * @param {string} origin - tunnel origin (http://127.0.0.1:<port>).
 * @param {string} cookie - Host authentication cookie.
 * @param {{ open(url: string): boolean, theme(): 'dark' | 'light', log(message: string): void }} shell - side effects.
 * @returns {(() => void) & { retry(): void }} stop watching; `.retry()` offers a pending sign-in again.
 */
export function watchAccountSignIn(origin, cookie, shell) {
  let closed = false
  let socket
  let retry
  let opened
  /** The newest attempt waiting for the browser that has not been opened yet. */
  let pending
  const tryOpen = () => {
    if (pending === undefined || opened === pending.id) return
    if (shell.open(pending.url) === true) { opened = pending.id; pending = undefined }
  }
  const connect = () => {
    const streamId = randomUUID()
    const url = new URL(STREAM_PATH, origin)
    url.protocol = 'ws:'
    socket = new WebSocket(url, { headers: { cookie, origin } })
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'account/watch', payload: { args: {} } }))
    })
    socket.addEventListener('message', (event) => {
      let frame
      try { frame = JSON.parse(String(event.data)) } catch { return }
      if (frame?.streamId !== streamId || frame.type !== 'item') return
      const attempt = frame.value?.attempt
      if (attempt?.phase !== 'waiting-browser') { if (attempt?.id === pending?.id) pending = undefined; return }
      if (typeof attempt.authorizeUrl !== 'string' || opened === attempt.id) return
      const destination = authorizeDestination(attempt.authorizeUrl)
      if (destination === undefined) { shell.log('account: rejected authorization URL'); return }
      const target = new URL(destination)
      target.searchParams.set('theme', shell.theme())
      pending = { id: attempt.id, url: target.href }
      tryOpen()
    })
    socket.addEventListener('close', () => { if (!closed) retry = setTimeout(connect, 1000) })
    // An error is always followed by close, which schedules the retry; closing here would recurse.
    socket.addEventListener('error', () => {})
  }
  connect()
  const stop = () => {
    if (closed) return
    closed = true
    pending = undefined
    clearTimeout(retry)
    try { socket?.close() } catch { /* already closing */ }
  }
  /** Offer a sign-in that was waiting while the app could not open it (call when focus returns). */
  stop.retry = () => { if (!closed) tryOpen() }
  return stop
}
