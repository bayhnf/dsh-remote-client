/** Read the dsh web launch URL from the server and map it onto the local tunnel. */

const LAUNCH_LINE = /dsh web: (http:\/\/\S+\/\?token=[A-Za-z0-9_-]+)/gu

/**
 * Shell functions that keep the server log private. `private_log` checks $L (the log, which holds
 * the reusable launch token) and fails with a message when another user could read the log, or
 * replace it or any directory on its path before the service opens it:
 *
 * - The path is absolute and contains no symlink in any component, so the path that is checked
 *   is the path the service opens. (`~/` is expanded first, so a symlinked home directory is
 *   refused too; point serverLog at the real directory.)
 * - Every directory from / down to the log's directory belongs to this user or root, carries no
 *   ACL (`+` in `ls -ld`), and cannot be written by anyone else: not other users, and not a group
 *   with other members. A sticky directory owned by root or this user (such as /tmp) is allowed
 *   above the log's directory; there others cannot rename what they do not own.
 * - The log's own directory belongs to this user and is not sticky. Inside the home directory
 *   it is tightened to 0700; directories elsewhere are checked, never changed.
 * - The log is a regular file that belongs to this user (created when missing), with no ACL, and
 *   is set to 0600.
 */
export const PRIVATE_LOG_FN = [
  // own_group GID: true when nobody but this user and root can be a member of the group.
  'own_group() {',
  '  og_u=$(id -un); og_m=$(getent group "$1") || return 1',
  '  for og_x in $(printf "%s" "${og_m##*:}" | tr "," " "); do [ "$og_x" = "$og_u" ] || [ "$og_x" = root ] || return 1; done',
  '  og_p=$(getent passwd) || return 1',
  '  ! printf "%s\\n" "$og_p" | awk -F: -v g="$1" -v u="$og_u" \'$4 == g && $1 != u && $1 != "root" { f = 1 } END { exit !f }\'',
  '}',
  // has_acl PATH: true when PATH has an extended ACL. getfacl answers when installed; otherwise
  // GNU ls marks it with "+" after the mode. Without either, ACLs cannot be seen and are not refused.
  'has_acl() {',
  '  if command -v getfacl >/dev/null 2>&1; then getfacl -c -s -p -- "$1" 2>/dev/null | grep -q . && return 0; fi',
  '  case "$(ls -ld -- "$1" 2>/dev/null)" in ??????????+*) return 0;; esac',
  '  return 1',
  '}',
  // safe_dir DIR WHAT: fail with a message when someone other than this user or root could
  // create, rename or remove entries in DIR, or DIR is a symlink. WHAT is `parent` (sticky allowed)
  // or `leaf` (must also belong to this user and not be sticky).
  'safe_dir() {',
  '  [ -L "$1" ] && { echo "$1 is a symlink; give serverLog a path without symlinks" >&2; return 1; }',
  '  [ -d "$1" ] || { echo "$1 is not a directory" >&2; return 1; }',
  '  sd_s=$(stat -c "%u %g %f" -- "$1") || return 1',
  '  sd_u=${sd_s%% *}; sd_r=${sd_s#* }; sd_g=${sd_r%% *}; sd_m=$((0x${sd_r#* }))',
  '  if has_acl "$1"; then echo "$1 has an ACL, so other users may be able to change it; choose a serverLog in a directory without ACLs" >&2; return 1; fi',
  '  if [ "$2" = leaf ]; then',
  '    [ "$sd_u" = "$(id -u)" ] || { echo "$1 must belong to $(id -un); choose a serverLog under your home" >&2; return 1; }',
  '    [ $((sd_m & 512)) -eq 0 ] || { echo "$1 can be changed by other users; choose a serverLog under your home" >&2; return 1; }',
  '  else',
  '    [ "$sd_u" = 0 ] || [ "$sd_u" = "$(id -u)" ] || { echo "$1 belongs to another user, who could replace the log; choose a serverLog under a private directory" >&2; return 1; }',
  '    [ $((sd_m & 512)) -ne 0 ] && return 0',
  '  fi',
  '  if [ $((sd_m & 2)) -ne 0 ] || { [ $((sd_m & 16)) -ne 0 ] && ! own_group "$sd_g"; }; then',
  '    echo "$1 can be changed by other users, who could replace the log; choose a serverLog under a private directory" >&2; return 1',
  '  fi',
  '}',
  'private_log() {',
  '  case "$L" in /*) ;; *) echo "serverLog must be an absolute path" >&2; return 1;; esac',
  '  pl_h=$(cd "$HOME" 2>/dev/null && pwd -P) || pl_h=/',
  // Walk from / to the log directory, one component at a time, so no symlink goes unseen.
  '  pl_d=""; pl_rest=${LD#/}',
  '  safe_dir / parent || return 1',
  '  while [ -n "$pl_rest" ]; do',
  '    pl_c=${pl_rest%%/*}; case "$pl_rest" in */*) pl_rest=${pl_rest#*/};; *) pl_rest="";; esac',
  '    [ "$pl_c" != .. ] || { echo "serverLog must not contain .." >&2; return 1; }',
  '    [ -n "$pl_c" ] && [ "$pl_c" != . ] || continue',
  '    pl_d="$pl_d/$pl_c"',
  '    if [ -n "$pl_rest" ]; then safe_dir "$pl_d" parent || return 1; fi',
  '  done',
  '  [ -n "$pl_d" ] || { echo "serverLog must not be directly under /" >&2; return 1; }',
  // The log directory: inside home it is made 0700 first (its parents were checked above), then checked.
  '  if [ "$pl_h" != / ] && [ ! -L "$pl_d" ] && [ -d "$pl_d" ] && [ -O "$pl_d" ]; then',
  '    case "$pl_d" in "$pl_h"/?*) pl_m=$((0x$(stat -c %f -- "$pl_d"))); if [ $((pl_m & 512)) -eq 0 ] && [ $((pl_m & 63)) -ne 0 ]; then chmod 700 "$pl_d" || return 1; fi;; esac',
  '  fi',
  '  safe_dir "$pl_d" leaf || return 1',
  '  if [ -L "$L" ] || { [ -e "$L" ] && { [ ! -f "$L" ] || [ ! -O "$L" ]; }; }; then echo "$L must be a regular file that belongs to $(id -un)" >&2; return 1; fi',
  '  [ -e "$L" ] || (umask 077; : >> "$L") || return 1',
  '  chmod 600 "$L" || return 1',
  '  if has_acl "$L"; then echo "$L has an ACL; remove it (setfacl -b), then retry" >&2; return 1; fi',
  '  return 0',
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
