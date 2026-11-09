/** Read the dsh web launch URL from the server and map it onto the local tunnel. */

const LAUNCH_LINE = /dsh web: (http:\/\/\S+\/\?token=[A-Za-z0-9_-]+)/gu

/**
 * Pick the newest launch URL printed by `dsh web`.
 * @param {string} text - server log excerpt.
 * @returns {{ host: string, port: number, token: string } | undefined} tunnel target and launch token.
 */
export function parseLaunchUrl(text) {
  let last
  for (const match of text.matchAll(LAUNCH_LINE)) last = match[1]
  if (last === undefined) return undefined
  const url = new URL(last)
  const token = url.searchParams.get('token')
  if (url.protocol !== 'http:' || url.port === '' || !token) return undefined
  return { host: url.hostname, port: Number(url.port), token }
}

/**
 * Launch URL as seen through the tunnel. Loopback is required: DeepSeek account sign-in
 * accepts only http://localhost|127.0.0.1|[::1]:<port> callback origins.
 * @param {number} localPort - tunnel port on this Mac.
 * @param {string} token - launch token from the server.
 * @returns {string} URL that mints the session cookie and redirects to the app.
 */
export function localLaunchUrl(localPort, token) {
  return `http://127.0.0.1:${localPort}/?token=${encodeURIComponent(token)}`
}

/**
 * Remote shell line that makes sure the server unit runs, then prints its launch line.
 * After a fresh start it waits for a line newer than the log's previous end, so a stale
 * token from the last run is never returned.
 * @param {{ serverLog: string, serverUnit: string }} config - validated settings.
 * @returns {string} POSIX sh script for `ssh host <script>`.
 */
export function launchScript({ serverLog, serverUnit }) {
  const log = serverLog.startsWith('~/') ? `"$HOME/${serverLog.slice(2)}"` : `"${serverLog}"`
  return [
    `L=${log}; U=${serverUnit}`,
    'if ! systemctl --user is-active --quiet "$U"; then',
    '  n=$(wc -l < "$L" 2>/dev/null || echo 0); mkdir -p "$(dirname "$L")"',
    '  systemctl --user reset-failed "$U" 2>/dev/null; systemctl --user start "$U" || exit 3',
    '  for i in $(seq 1 60); do',
    '    t=$(tail -n +$((n+1)) "$L" 2>/dev/null | grep -a "dsh web: http" | tail -n 1)',
    '    [ -n "$t" ] && { printf "%s\\n" "$t"; exit 0; }; sleep 1',
    '  done; exit 4',
    'fi',
    'tail -n 400 "$L" | grep -a "dsh web: http" | tail -n 1',
  ].join('\n')
}

/**
 * Replace launch tokens before text reaches a log file.
 * @param {string} text - any message.
 * @returns {string} text with token values masked.
 */
export function redact(text) {
  return String(text).replace(/token=[A-Za-z0-9_-]+/gu, 'token=<redacted>')
}
