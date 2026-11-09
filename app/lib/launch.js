/** Read the dsh web launch URL from the server and map it onto the local tunnel. */

const LAUNCH_LINE = /dsh web: (http:\/\/\S+\/\?token=[A-Za-z0-9_-]+)/gu

/**
 * Shell functions that keep the server log private. `private_log` checks $L (the log, which holds
 * the reusable launch token) and $LD (its directory) and fails with a message when another user
 * could read the log or replace it before the service opens it:
 *
 * - $LD belongs to this user, is not sticky, and nobody else can write to it (not other users,
 *   and not a group with other members). It is tightened to 0700 only when it lies inside the
 *   home directory; directories elsewhere are checked, never changed.
 * - Every directory above $LD, along the path as written and after resolving symlinks, belongs to
 *   this user or root and cannot be written by anyone else. A sticky directory owned by root or
 *   this user (such as /tmp) is allowed there: others cannot rename what they do not own in it.
 * - $L is a regular file that belongs to this user (created when missing) and is set to 0600.
 */
export const PRIVATE_LOG_FN = [
  // own_group GID: true when this user is the only possible member of the group.
  'own_group() {',
  '  og_u=$(id -un); og_m=$(getent group "$1") || return 1',
  '  for og_x in $(printf "%s" "${og_m##*:}" | tr "," " "); do [ "$og_x" = "$og_u" ] || return 1; done',
  '  og_p=$(getent passwd) || return 1',
  '  ! printf "%s\\n" "$og_p" | awk -F: -v g="$1" -v u="$og_u" \'$4 == g && $1 != u { f = 1 } END { exit !f }\'',
  '}',
  // shared_dir DIR [sticky-ok]: true when someone other than this user or root can create, rename
  // or remove entries in DIR (following symlinks).
  'shared_dir() {',
  '  sd_s=$(stat -L -c "%u %g %f" -- "$1") || return 0',
  '  sd_u=${sd_s%% *}; sd_r=${sd_s#* }; sd_g=${sd_r%% *}; sd_m=$((0x${sd_r#* }))',
  '  [ "$sd_u" = 0 ] || [ "$sd_u" = "$(id -u)" ] || return 0',
  '  [ "${2:-}" = sticky-ok ] && [ $((sd_m & 512)) -ne 0 ] && return 1',
  '  [ $((sd_m & 2)) -eq 0 ] || return 0',
  '  [ $((sd_m & 16)) -eq 0 ] || own_group "$sd_g" || return 0',
  '  return 1',
  '}',
  // safe_above DIR: every directory above DIR is safe from other users, and no symlink along the
  // path belongs to another user (who could point it elsewhere later).
  'safe_above() {',
  '  sa_d=$1',
  '  while [ "$sa_d" != / ] && [ "$sa_d" != . ]; do',
  '    if [ -L "$sa_d" ]; then sa_o=$(stat -c %u -- "$sa_d") || return 1; [ "$sa_o" = 0 ] || [ "$sa_o" = "$(id -u)" ] || { echo "$sa_d is a symlink that belongs to another user" >&2; return 1; }; fi',
  '    sa_d=$(dirname "$sa_d")',
  '    if shared_dir "$sa_d" sticky-ok; then echo "$sa_d can be changed by other users, who could replace the log; choose a serverLog under a private directory" >&2; return 1; fi',
  '  done',
  '}',
  'private_log() {',
  '  pl_p=$(cd "$LD" 2>/dev/null && pwd -P) || { echo "log directory $LD does not exist" >&2; return 1; }',
  '  pl_s=$(stat -c "%u %f" -- "$pl_p") || return 1',
  '  pl_u=${pl_s%% *}; pl_m=$((0x${pl_s#* }))',
  '  [ "$pl_u" = "$(id -u)" ] || { echo "log directory $pl_p must belong to $(id -un); choose a serverLog under your home" >&2; return 1; }',
  '  pl_h=$(cd "$HOME" 2>/dev/null && pwd -P) || pl_h=/',
  // A directory others can change is refused, never repaired: it may be shared on purpose.
  '  if [ $((pl_m & 512)) -ne 0 ] || shared_dir "$pl_p"; then echo "log directory $pl_p can be changed by other users; choose a serverLog under your home" >&2; return 1; fi',
  '  if [ "$pl_h" != / ] && [ $((pl_m & 63)) -ne 0 ]; then case "$pl_p" in "$pl_h"/?*) chmod 700 "$pl_p" || return 1;; esac; fi',
  '  safe_above "$LD" && safe_above "$pl_p" || return 1',
  '  if [ -L "$L" ] || { [ -e "$L" ] && { [ ! -f "$L" ] || [ ! -O "$L" ]; }; }; then echo "$L must be a regular file that belongs to $(id -un)" >&2; return 1; fi',
  '  [ -e "$L" ] || (umask 077; : >> "$L") || return 1',
  '  chmod 600 "$L"',
  '}',
].join('\n')

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
 * token from the last run is never returned. A log another user could read or replace is
 * refused (exit 5) instead of used.
 * @param {{ serverLog: string, serverUnit: string }} config - validated settings.
 * @returns {string} POSIX sh script for `ssh host <script>`.
 */
export function launchScript({ serverLog, serverUnit }) {
  const log = serverLog.startsWith('~/') ? `"$HOME/${serverLog.slice(2)}"` : `"${serverLog}"`
  return [
    `L=${log}; U=${serverUnit}; LD=$(dirname "$L")`,
    PRIVATE_LOG_FN,
    '(umask 077; mkdir -p "$LD") && private_log || exit 5',
    'if ! systemctl --user is-active --quiet "$U"; then',
    '  n=$(wc -l < "$L" 2>/dev/null || echo 0)',
    '  systemctl --user reset-failed "$U" 2>/dev/null; systemctl --user start "$U" || exit 3',
    '  for i in $(seq 1 60); do',
    '    t=$(tail -n +$((n+1)) "$L" 2>/dev/null | grep -a "dsh web: http" | tail -n 1)',
    '    [ -n "$t" ] && { printf "%s\\n" "$t"; exit 0; }; sleep 1',
    '  done; exit 4',
    'fi',
    'grep -a "dsh web: http" -- "$L" | tail -n 1',
  ].join('\n')
}

/**
 * Replace launch tokens before text reaches a log file.
 * @param {string} text - any message.
 * @returns {string} text with token values masked.
 */
export function redact(text) {
  return String(text)
    .replace(/token=[^\s&"'<>]+/gu, 'token=<redacted>')
    .replace(/(dsh-auth-[A-Za-z0-9_-]*=)[^\s;"']+/gu, '$1<redacted>')
    .replace(/((?:set-)?cookie:\s*)[^\n]+/giu, '$1<redacted>')
}
