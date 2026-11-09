/**
 * Remote server checks and one-step setup over SSH.
 *
 * `probeScript` reports what a host has. `setupScript` adds only what is missing, so it is safe
 * on a server that is already partly or fully set up: it never upgrades an installed dsh, never
 * replaces an existing systemd unit, and keeps existing profiles and sessions. Missing pieces:
 * @deepseek-ai/dsh and the dsh-tui launcher (npm, under $HOME when the global prefix is not
 * writable), the `server` profile, the dsh-remote-servers bundle (uploaded inline), and a
 * systemd --user unit that runs `dsh --profile server` on 127.0.0.1.
 */

/** Marker printed before the JSON report so login-shell noise cannot break parsing. */
const REPORT = '@@DSH-REMOTE-REPORT@@'

/** Versions setup installs when they are missing; the versions this project is tested with. */
export const PINNED = Object.freeze({
  dsh: '@deepseek-ai/dsh@0.2.2-rc.1',
  dshTui: '@deepseek-harness-tui/dsh-tui@0.19.0',
  pnpm: 'pnpm@10.33.0',
})
const PLUGIN = 'dsh-remote-servers'

const logPath = serverLog => serverLog.startsWith('~/') ? `$HOME/${serverLog.slice(2)}` : serverLog

/**
 * POSIX script that prints one JSON report about a host.
 * @param {{ serverUnit: string, serverLog: string }} host - validated host.
 * @returns {string} remote shell line.
 */
export function probeScript({ serverUnit, serverLog }) {
  return [
    'export PATH="$PATH:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.local/bin"',
    `U=${serverUnit}; L="${logPath(serverLog)}"`,
    // Keep only characters a version string needs, so the value is safe inside the JSON report.
    'v() { "$@" 2>/dev/null | head -n 1 | tr -cd "A-Za-z0-9._+-" ; }',
    'node_v=$(v node --version); dsh_v=$(v dsh --version); tui=$(command -v dsh-tui >/dev/null && echo yes || echo no)',
    'unit=$(systemctl --user is-active "$U" 2>/dev/null || true); [ -n "$unit" ] || unit=unknown',
    'launch=$(grep -a -c "dsh web: http" -- "$L" 2>/dev/null); case "$launch" in ""|*[!0-9]*) launch=0;; esac',
    `plugin=$(grep -q '"${PLUGIN}"' "$HOME/.dsh/profiles/server/package.json" 2>/dev/null && echo yes || echo no)`,
    `printf '${REPORT}{"hostname":"%s","os":"%s","node":"%s","dsh":"%s","dshTui":"%s","unit":"%s","launchLines":%s,"plugin":"%s"}\\n' "$(hostname)" "$(uname -s)" "$node_v" "$dsh_v" "$tui" "$unit" "$launch" "$plugin"`,
  ].join('\n')
}

/**
 * Parse the probe output.
 * @param {string} text - ssh stdout.
 * @returns {{ hostname: string, os: string, node: string, dsh: string, dshTui: boolean, unit: string, plugin: boolean, ready: boolean }} report;
 *   `ready` means the client can open the server and its Remote servers page.
 */
export function parseProbe(text) {
  const line = text.split('\n').find(row => row.startsWith(REPORT))
  if (line === undefined) throw new Error('server check printed no report')
  const raw = JSON.parse(line.slice(REPORT.length))
  const plugin = raw.plugin === 'yes'
  return {
    hostname: String(raw.hostname), os: String(raw.os), node: String(raw.node), dsh: String(raw.dsh),
    dshTui: raw.dshTui === 'yes', unit: String(raw.unit), plugin,
    ready: raw.dsh !== '' && raw.unit === 'active' && Number(raw.launchLines) > 0 && plugin,
  }
}

/**
 * POSIX script that completes a dsh server on the host.
 * @param {{ serverUnit: string, serverLog: string, serverPort: number }} host - validated host.
 * @param {string} pluginTarball - base64 of the dsh-remote-servers `npm pack` tarball.
 * @returns {string} remote shell line; exits non-zero with a message on failure.
 */
export function setupScript({ serverUnit, serverLog, serverPort }, pluginTarball) {
  if (!/^[A-Za-z0-9+/=]+$/u.test(pluginTarball)) throw new Error('plugin tarball must be base64')
  return [
    'set -eu',
    'export PATH="$PATH:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.local/bin"',
    'say() { printf "== %s\\n" "$*"; }',
    'command -v node >/dev/null || { echo "Node.js 22.19+ is required on this host (install it, then retry)" >&2; exit 10; }',
    'node -e "const [a,b]=process.versions.node.split(\'.\').map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)" || { echo "Node.js $(node --version) is too old; 22.19+ is required" >&2; exit 11; }',
    'command -v systemctl >/dev/null || { echo "systemd is required on this host" >&2; exit 12; }',
    `need=""; command -v dsh >/dev/null || need="$need ${PINNED.dsh}"; command -v dsh-tui >/dev/null || need="$need ${PINNED.dshTui}"`,
    'if [ -n "$need" ]; then',
    '  PREFIX=$(npm config get prefix)',
    '  if [ ! -w "$PREFIX/lib/node_modules" ] && [ ! -w "$PREFIX" ]; then PREFIX="$HOME/.npm-global"; fi',
    '  say "install$need into $PREFIX"; npm install -g --prefix "$PREFIX" --no-fund --no-audit --loglevel=error $need >/dev/null',
    '  export PATH="$PATH:$PREFIX/bin"',
    'fi',
    'DSH=$(command -v dsh); say "dsh $("$DSH" --version) at $DSH"',
    // `dsh plugin` runs pnpm in the profile directory; corepack ships with Node and provides it.
    'if ! command -v pnpm >/dev/null; then',
    '  say "enable pnpm"',
    '  if command -v corepack >/dev/null && corepack enable --install-directory "$(dirname "$DSH")" pnpm 2>/dev/null && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version >/dev/null 2>&1; then :',
    `  else npm install -g --prefix "$(npm config get prefix)" --no-fund --no-audit ${PINNED.pnpm} >/dev/null 2>&1 || npm install -g --prefix "$HOME/.npm-global" --no-fund --no-audit ${PINNED.pnpm} >/dev/null; fi`,
    'fi',
    'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    // The log holds the reusable launch token: keep it owner-only.
    `L="${logPath(serverLog)}"; umask 077; mkdir -p "$(dirname "$L")"; chmod 700 "$(dirname "$L")"; touch "$L"; chmod 600 "$L"`,
    'P="$HOME/.dsh/profiles/server/package.json"',
    // A missing or half-created profile is initialized from the shipped Web template; an existing
    // profile without the Web bundle belongs to the user and is not replaced.
    'if [ ! -f "$P" ]; then say "create server profile"; "$DSH" --profile server --from-default-profile web --dump-config >/dev/null',
    'elif ! grep -q \'"@deepseek-ai/dsh-web-app"\' "$P"; then echo "~/.dsh/profiles/server exists but does not include @deepseek-ai/dsh-web-app; add it or move the profile away, then retry" >&2; exit 15; fi',
    'changed=no',
    `if ! grep -q '"${PLUGIN}"' "$HOME/.dsh/profiles/server/package.json"; then`,
    `  T="$HOME/.dsh/${PLUGIN}.tgz"; printf %s '${pluginTarball}' | base64 -d > "$T"`,
    `  say "add ${PLUGIN} to the server profile"; "$DSH" plugin --profile server add "$T" </dev/null >/dev/null 2>"$T.log" || { tail -n 20 "$T.log" >&2; exit 14; }; changed=yes`,
    'fi',
    `UNIT="$HOME/.config/systemd/user/${serverUnit}"`,
    'if [ ! -f "$UNIT" ]; then',
    '  say "create $UNIT"; mkdir -p "$(dirname "$UNIT")"',
    '  {',
    '    printf "[Unit]\\nDescription=DeepSeek Harness server (dsh-remote-client)\\nAfter=network-online.target\\n[Service]\\nType=simple\\nWorkingDirectory=%%h\\n"',
    // The user manager has its own PATH; give the service the Node that setup found.
    '    printf "Environment=PATH=%s:/usr/local/bin:/usr/bin:/bin\\n" "$(dirname "$(command -v node)")"',
    `    printf "ExecStart=%s --profile server --host 127.0.0.1 --port ${serverPort} --no-open\\n" "$DSH"`,
    '    printf "UMask=0077\\nRestart=always\\nRestartSec=5\\nStandardOutput=append:%s\\nStandardError=append:%s\\n[Install]\\nWantedBy=default.target\\n" "$L" "$L"',
    '  } > "$UNIT"',
    '  loginctl enable-linger "$(id -un)" 2>/dev/null || true',
    '  systemctl --user daemon-reload',
    'fi',
    'touch "$L"; n=$(wc -l < "$L"); started=yes',
    `if systemctl --user is-active --quiet ${serverUnit}; then`,
    `  if [ "$changed" = no ]; then started=no; else say "restart ${serverUnit} to load ${PLUGIN}"; systemctl --user restart ${serverUnit}; fi`,
    `else systemctl --user reset-failed ${serverUnit} 2>/dev/null || true; systemctl --user enable --now ${serverUnit} >/dev/null; fi`,
    // A service started or restarted here must print a new launch line and stay active; an
    // untouched running service is ready when it is active and has printed one before.
    'for i in $(seq 1 60); do',
    `  if systemctl --user is-active --quiet ${serverUnit}; then`,
    '    if [ "$started" = yes ]; then tail -n +$((n+1)) -- "$L" | grep -a -q "dsh web: http" && { say "server ready"; exit 0; }',
    '    else grep -a -q "dsh web: http" -- "$L" && { say "server ready"; exit 0; }; fi',
    '  fi; sleep 1',
    'done',
    'echo "server did not print its launch URL within 60 s; see $L" >&2; exit 13',
  ].join('\n')
}
