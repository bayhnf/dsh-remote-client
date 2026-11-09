/**
 * Desktop-mode DeepSeek sign-in, ported from the official account-backend.ts watch(): in Desktop
 * mode the Web UI only calls account/startSignIn, and the shell opens the authorization page in
 * the system browser when the Host reports the attempt as waiting-browser.
 */
import { randomUUID } from 'node:crypto'

const STREAM_PATH = '/api/remote.mux'

/**
 * Accept https pages or loopback http, without URL credentials (account-backend.ts validateBrowserDestination).
 * @param {string} value - authorizeUrl from the Host.
 * @returns {string | undefined} the URL, or undefined when it is not an allowed destination.
 */
export function authorizeDestination(value) {
  let url
  try { url = new URL(value) } catch { return undefined }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))) return undefined
  return url.href
}

/**
 * Follow account/watch on the Host and open each new waiting-browser attempt once.
 * @param {string} origin - tunnel origin (http://127.0.0.1:<port>).
 * @param {string} cookie - Host authentication cookie.
 * @param {{ open(url: string): void, theme(): 'dark' | 'light', log(message: string): void }} shell - side effects.
 * @returns {() => void} stop watching.
 */
export function watchAccountSignIn(origin, cookie, shell) {
  let closed = false
  let socket
  let retry
  let opened
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
      if (attempt?.phase !== 'waiting-browser' || typeof attempt.authorizeUrl !== 'string' || opened === attempt.id) return
      const destination = authorizeDestination(attempt.authorizeUrl)
      if (destination === undefined) { shell.log('account: rejected authorization URL'); return }
      opened = attempt.id
      const target = new URL(destination)
      target.searchParams.set('theme', shell.theme())
      shell.open(target.href)
    })
    socket.addEventListener('close', () => { if (!closed) retry = setTimeout(connect, 1000) })
    socket.addEventListener('error', () => { socket.close() })
  }
  connect()
  return () => { closed = true; clearTimeout(retry); socket?.close() }
}
