/**
 * Remote server checks and one-step setup over SSH.
 *
 * `probeScript` reports what a host has. `setupScript` adds only what is missing, so it is safe
 * on a server that is already partly or fully set up: it never upgrades an installed dsh, never
 * replaces an existing systemd unit, and keeps existing profiles and sessions. Missing pieces:
 * @deepseek-ai/dsh and the dsh-tui launcher (npm, under $HOME when the global prefix is not
 * writable), pnpm, the `server` profile, the dsh-remote-servers bundle (uploaded inline), and a
 * systemd --user unit that runs `dsh --profile server` on 127.0.0.1.
 */
import { PRIVATE_LOG_FN } from './launch.js'

/**
 * Shell function `bundles FILE`: prints the profile's selected bundles (dsh.profile.bundles), one
 * per line; exits 2 when the manifest is missing or malformed. Package dependencies are not
 * composition, so a name in `dependencies` alone does not count.
 */
const BUNDLES_FN = `bundles() { node -e 'try { const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).dsh.profile.bundles; if (!Array.isArray(b)) process.exit(2); console.log(b.join("\\n")) } catch { process.exit(2) }' "$1" 2>/dev/null; }`

/**
 * Shell function `composed`: prints `web` and/or `plugin` for the parts the composed server
 * profile really enables. It reads `dsh --profile server --dump-config` (the tree the service
 * loads, after every bundle and the user's patches): the Web UI counts when its `web-runtime`
 * entry (@deepseek-ai/dsh-web-app) is present and not disabled, the page when its `remote-servers`
 * entry (dsh-remote-servers) is. A `disabled` value other than plain `false` (such as a
 * profile-dependent expression) counts as disabled. The dump's group comments are ignored.
 */
const COMPOSED_FN = `composed() { cd_dump=$("$DSH" --profile server --dump-config </dev/null 2>/dev/null) || return 1; printf '%s\\n' "$cd_dump" | awk '
function done_entry() { if (id == "web-runtime" && name == "@deepseek-ai/dsh-web-app" && !off) web = 1; if (id == "remote-servers" && name == "dsh-remote-servers" && !off) plugin = 1 }
function bare(text) { gsub(/^["\\047]|["\\047]$/, "", text); return text }
/^- id: / { done_entry(); id = bare(substr($0, 7)); name = ""; off = 0; next }
/^  name: / { name = bare(substr($0, 9)); next }
/^  disabled: / { off = (substr($0, 13) != "false"); next }
END { done_entry(); if (web) print "web"; if (plugin) print "plugin" }'; }`

/** Marker printed before the JSON report so login-shell noise cannot break parsing. */
const REPORT = '@@DSH-REMOTE-REPORT@@'

/** Versions setup installs when they are missing; the versions this project is tested with. */
export const PINNED = Object.freeze({
  dsh: '@deepseek-ai/dsh@0.2.2-rc.1',
  dshTui: '@deepseek-harness-tui/dsh-tui@0.19.0',
  pnpm: 'pnpm@10.33.0',
})

/** Where npm, dsh and dsh-tui usually live when a non-interactive SSH shell has a short PATH. */
const EXTRA_PATH = 'export PATH="$PATH:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.local/bin"'

const logPath = serverLog => serverLog.startsWith('~/') ? `$HOME/${serverLog.slice(2)}` : serverLog

/**
 * Shell lines that set `stale=yes` when the active unit $U started before the profile manifest
 * $P (which selects the bundles) last changed: the running service then still serves the
 * previous composition. Patch files are not compared; dsh reloads them while it runs. When the
 * start time cannot be read, nothing is reported stale.
 */
const STALE_CHECK = [
  'stale=no',
  'if systemctl --user is-active --quiet "$U" && [ -f "$P" ]; then',
  // Microsecond start time and nanosecond mtime, so a change in the same second still counts.
  '  t=$(systemctl --user show -p ActiveEnterTimestamp --timestamp=us+utc --value "$U" 2>/dev/null) || t=""',
  '  if [ -n "$t" ] && s=$(date -d "$t" +%s%N 2>/dev/null) && m=$(stat -c %.9Y -- "$P" 2>/dev/null); then',
  '    m=$(printf %s "$m" | tr -d .); [ "$m" -le "$s" ] || stale=yes',
  '  fi',
  'fi',
].join('\n')

/**
 * POSIX script that prints one JSON report about a host.
 * @param {{ serverUnit: string, serverLog: string }} host - validated host.
 * @returns {string} remote shell line.
 */
export function probeScript({ serverUnit, serverLog }) {
  return [
    EXTRA_PATH,
    `U=${serverUnit}; L="${logPath(serverLog)}"; P="$HOME/.dsh/profiles/server/package.json"`,
    // Keep only characters a version string needs, so the value is safe inside the JSON report.
    'v() { "$@" 2>/dev/null | head -n 1 | tr -cd "A-Za-z0-9._+-" ; }',
    'node_v=$(v node --version); dsh_v=$(v dsh --version); tui=$(command -v dsh-tui >/dev/null && echo yes || echo no)',
    'unit=$(systemctl --user is-active "$U" 2>/dev/null || true); [ -n "$unit" ] || unit=unknown',
    'launch=$(grep -a -c "dsh web: http" -- "$L" 2>/dev/null); case "$launch" in ""|*[!0-9]*) launch=0;; esac',
    COMPOSED_FN,
    'DSH=$(command -v dsh || echo false); C=$(composed) || C=""',
    'web=no; plugin=no; case "$C" in *web*) web=yes;; esac; case "$C" in *plugin*) plugin=yes;; esac',
    STALE_CHECK,
    `printf '${REPORT}{"hostname":"%s","os":"%s","node":"%s","dsh":"%s","dshTui":"%s","unit":"%s","launchLines":%s,"plugin":"%s","web":"%s","stale":"%s"}\\n' "$(hostname | tr -cd "A-Za-z0-9._-")" "$(uname -s | tr -cd "A-Za-z0-9._-")" "$node_v" "$dsh_v" "$tui" "$(printf %s "$unit" | tr -cd "a-z-")" "$launch" "$plugin" "$web" "$stale"`,
  ].join('\n')
}

/**
 * Parse the probe output.
 * @param {string} text - ssh stdout.
 * @returns {{ hostname: string, os: string, node: string, dsh: string, dshTui: boolean, unit: string, plugin: boolean, web: boolean, stale: boolean, ready: boolean }} report;
 *   `ready` means the client can open the server and its Remote servers page.
 */
export function parseProbe(text) {
  const line = text.split('\n').find(row => row.startsWith(REPORT))
  if (line === undefined) throw new Error('server check printed no report')
  const raw = JSON.parse(line.slice(REPORT.length))
  const plugin = raw.plugin === 'yes'
  const web = raw.web === 'yes'
  const stale = raw.stale === 'yes'
  return {
    hostname: String(raw.hostname), os: String(raw.os), node: String(raw.node), dsh: String(raw.dsh),
    dshTui: raw.dshTui === 'yes', unit: String(raw.unit), plugin, web, stale,
    ready: raw.dsh !== '' && raw.unit === 'active' && Number(raw.launchLines) > 0 && plugin && web && !stale,
  }
}

/**
 * Setup lines that make pnpm PINNED.pnpm the first `pnpm` on PATH, here and (through $PNPM_DIR,
 * which the unit puts first on its PATH) for the service. An installed pnpm is used when it is
 * that version; otherwise the pinned version goes into a directory of its own, so no other pnpm
 * on the machine (an old Corepack shim, a global install) can take its place.
 */
function pnpmSteps() {
  const version = PINNED.pnpm.slice('pnpm@'.length)
  return [
    `PNPM_VERSION=${version}; PNPM_DIR=""`,
    'if [ "$(pnpm --version 2>/dev/null)" = "$PNPM_VERSION" ]; then PNPM_DIR=$(dirname "$(command -v pnpm)")',
    'else',
    '  say "install pnpm $PNPM_VERSION"; PNPM_PREFIX="$HOME/.dsh/pnpm-$PNPM_VERSION"',
    `  if npm install -g --prefix "$PNPM_PREFIX" --no-fund --no-audit --loglevel=error ${PINNED.pnpm} </dev/null >/dev/null 2>&1; then PNPM_DIR="$PNPM_PREFIX/bin"; export PATH="$PNPM_DIR:$PATH"; fi`,
    'fi',
    '[ -n "$PNPM_DIR" ] && [ "$(pnpm --version 2>/dev/null)" = "$PNPM_VERSION" ] || { echo "pnpm $PNPM_VERSION could not be installed; install it and retry" >&2; exit 16; }',
  ]
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
    EXTRA_PATH,
    'say() { printf "== %s\\n" "$*"; }',
    'command -v node >/dev/null || { echo "Node.js 22.19+ is required on this host (install it, then retry)" >&2; exit 10; }',
    'node -e "const [a,b]=process.versions.node.split(\'.\').map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)" || { echo "Node.js $(node --version) is too old; 22.19+ is required" >&2; exit 11; }',
    'command -v systemctl >/dev/null || { echo "systemd is required on this host" >&2; exit 12; }',
    // The log holds the reusable launch token: refuse a location other users could read or swap.
    `U=${serverUnit}; L="${logPath(serverLog)}"; LD=$(dirname "$L")`,
    PRIVATE_LOG_FN,
    '(umask 077; mkdir -p "$LD") && private_log || exit 17',
    `need=""; command -v dsh >/dev/null || need="$need ${PINNED.dsh}"; command -v dsh-tui >/dev/null || need="$need ${PINNED.dshTui}"`,
    'if [ -n "$need" ]; then',
    '  PREFIX=$(npm config get prefix)',
    '  if [ ! -w "$PREFIX/lib/node_modules" ] && [ ! -w "$PREFIX" ]; then PREFIX="$HOME/.npm-global"; fi',
    '  say "install$need into $PREFIX"; npm install -g --prefix "$PREFIX" --no-fund --no-audit --loglevel=error $need </dev/null >/dev/null',
    '  export PATH="$PATH:$PREFIX/bin"',
    'fi',
    'DSH=$(command -v dsh); say "dsh $("$DSH" --version) at $DSH"',
    // `dsh plugin` runs pnpm in the profile directory.
    ...pnpmSteps(),
    BUNDLES_FN,
    COMPOSED_FN,
    'D="$HOME/.dsh/profiles/server"; P="$D/package.json"',
    // Only a missing or empty profile is created from the shipped Web template (which replaces the
    // directory). Anything else belongs to the user and is never replaced; an unlistable one is kept.
    'if [ ! -e "$D" ] && [ ! -L "$D" ]; then say "create server profile"; "$DSH" --profile server --from-default-profile web --dump-config >/dev/null',
    'elif [ -d "$D" ] && [ ! -L "$D" ] && E=$(ls -A "$D") && [ -z "$E" ]; then say "create server profile"; "$DSH" --profile server --from-default-profile web --dump-config >/dev/null',
    'elif ! bundles "$P" >/dev/null; then echo "$D exists but has no valid package.json; move it away (it is kept as is), then retry" >&2; exit 15',
    'elif ! bundles "$P" | grep -qx "@deepseek-ai/dsh-web-app"; then echo "$D does not select @deepseek-ai/dsh-web-app in dsh.profile.bundles; add it or move the profile away, then retry" >&2; exit 15; fi',
    'changed=no',
    'C=$(composed) || { echo "dsh --profile server --dump-config failed; run it on the server to see why, then retry" >&2; exit 18; }',
    'case "$C" in *plugin*) ;; *)',
    `  T="$HOME/.dsh/dsh-remote-servers.tgz"; printf %s '${pluginTarball}' | base64 -d > "$T"`,
    '  say "add dsh-remote-servers to the server profile"; "$DSH" plugin --profile server add "$T" </dev/null >/dev/null 2>"$T.log" || { tail -n 20 "$T.log" >&2; exit 14; }; changed=yes;;',
    'esac',
    // What the service will load must enable both the Web UI and the page, or setup stops here.
    'C=$(composed) || { echo "dsh --profile server --dump-config failed after adding the page; run it on the server to see why, then retry" >&2; exit 18; }',
    'case "$C" in *web*) ;; *) echo "the server profile does not enable the Web UI (web-runtime); check $D/cordis.patch.yml, then retry" >&2; exit 18;; esac',
    'case "$C" in *plugin*) ;; *) echo "dsh-remote-servers is installed but not enabled in the server profile; check $D/cordis.patch.yml and dsh --profile server --dump-config, then retry" >&2; exit 18;; esac',
    'UNIT="$HOME/.config/systemd/user/$U"',
    'if [ ! -f "$UNIT" ]; then',
    '  say "create $UNIT"; mkdir -p "$(dirname "$UNIT")"',
    '  {',
    '    printf "[Unit]\\nDescription=DeepSeek Harness server (dsh-remote-client)\\nAfter=network-online.target\\n[Service]\\nType=simple\\nWorkingDirectory=%%h\\n"',
    // The user manager has its own PATH. The verified pnpm comes first, then node, dsh and dsh-tui.
    '    SP="$PNPM_DIR"; for c in node dsh dsh-tui; do d=$(dirname "$(command -v $c 2>/dev/null || echo /usr/bin/x)"); case ":$SP:" in *":$d:"*) ;; *) SP="$SP:$d";; esac; done',
    '    printf "Environment=PATH=%s:/usr/local/bin:/usr/bin:/bin\\n" "$SP"',
    `    printf "ExecStart=%s --profile server --host 127.0.0.1 --port ${serverPort} --no-open\\n" "$DSH"`,
    '    printf "UMask=0077\\nRestart=always\\nRestartSec=5\\nStandardOutput=append:%s\\nStandardError=append:%s\\n[Install]\\nWantedBy=default.target\\n" "$L" "$L"',
    '  } > "$UNIT"',
    '  loginctl enable-linger "$(id -un)" 2>/dev/null || true',
    '  systemctl --user daemon-reload',
    'fi',
    // Check the log again right before the service opens it.
    'private_log || exit 17',
    'n=$(wc -l < "$L"); started=yes',
    // A running service loaded its profile when it started: restart it when the profile changed since.
    STALE_CHECK,
    'if systemctl --user is-active --quiet "$U"; then',
    '  if [ "$stale" = no ] && [ "$changed" = no ]; then started=no; else say "restart $U to load the updated profile"; systemctl --user restart "$U"; fi',
    'else systemctl --user reset-failed "$U" 2>/dev/null || true; systemctl --user enable --now "$U" >/dev/null; fi',
    // A service started or restarted here must print a new launch line and stay active; an
    // untouched running service is ready when it is active and has printed one before.
    'for i in $(seq 1 60); do',
    '  if systemctl --user is-active --quiet "$U"; then',
    '    if [ "$started" = yes ]; then tail -n +$((n+1)) -- "$L" | grep -a -q "dsh web: http" && { say "server ready"; exit 0; }',
    '    else grep -a -q "dsh web: http" -- "$L" && { say "server ready"; exit 0; }; fi',
    '  fi; sleep 1',
    'done',
    'echo "server did not print its launch URL within 60 s; see $L" >&2; exit 13',
  ].join('\n')
}
