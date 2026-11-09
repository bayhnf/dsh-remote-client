/**
 * DeepSeek Harness Remote: a thin Electron client for a dsh server on another machine.
 *
 * Everything (profiles, sessions, credentials, agents, files) stays on the server. This
 * app only opens an SSH local forward and shows the server's own Web UI through it, the
 * same split Orca uses between `orca serve` and its desktop client. The window, preload
 * bridges and keyboard handling mirror the official app so the UI renders its Desktop layout.
 */
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell, session, systemPreferences } from 'electron'
import { join } from 'node:path'
import { appendFile, chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadConfig, updateConfig, slug, nextLocalPort, HOST_DEFAULTS } from './lib/config.js'
import { launchScript, parseLaunchUrl, localLaunchUrl, redact } from './lib/launch.js'
import { Tunnel, LoopbackProxy, runRemote, sshRun } from './lib/tunnel.js'
import { PENDING_PARTITION, partitionName, belongsTo, staleNames, partitionDirs, loadKnown, saveKnown } from './lib/sessions.js'
import { authenticate, hostRpc, hasConfiguredApiKey } from './lib/host-rpc.js'
import { watchAccountSignIn } from './lib/account-watch.js'
import { probeScript, parseProbe, setupScript } from './lib/server-setup.js'
import { readSshAliases } from './lib/ssh-aliases.js'
import { installDesktopShortcuts } from './vendor/desktop-keyboard.js'

const RECONNECT_DELAY_MS = 3_000
const IPC = {
  onboardingApiKey: 'dsh-desktop:onboarding-api-key',
  onboardingActive: 'dsh-desktop:onboarding-active',
  deviceInfo: 'dsh-desktop:device-info',
  nativeThemeSet: 'dsh-desktop:native-theme-set',
  windowFullscreen: 'dsh-desktop:window-fullscreen',
  remoteList: 'dsh-remote:list',
  remoteAdd: 'dsh-remote:add',
  remoteRemove: 'dsh-remote:remove',
  remoteProbe: 'dsh-remote:probe',
  remoteSetup: 'dsh-remote:setup',
  remoteSwitch: 'dsh-remote:switch',
  remoteSshAliases: 'dsh-remote:ssh-aliases',
}

// The bundle keeps DeepSeek's CFBundleName for Electron's helper lookup; give this client its
// own profile directory so it never shares storage or the single-instance lock with the
// official app.
app.setName('DeepSeek Harness Remote')
app.setPath('userData', join(app.getPath('appData'), 'DeepSeek Harness Remote'))

let config
let mainWindow
let shortcuts
let lastSignInOpen = 0
/** Sign-in popups of the current window; closed when the window changes server. */
const popups = new Set()
/** One app-owned listener per server port, bound for the life of the app (see lib/tunnel.js). */
const proxies = new Map()
function proxyFor(host) {
  let proxy = proxies.get(host.localPort)
  if (proxy === undefined) { proxy = new LoopbackProxy(host.localPort); proxies.set(host.localPort, proxy) }
  return proxy
}
/**
 * Private (0700, from mkdtemp) directory for the ssh forward sockets, under /tmp so every path
 * stays far below the AF_UNIX length limit. Each attempt gets its own socket name, so cleanup of
 * an old attempt can never touch a newer one.
 */
let socketRoot
let socketCounter = 0
let quitting = false
/** host id -> persistent partition of the server it last connected to (sessions.json). */
let knownSessions = new Map()

function logFile() { return join(app.getPath('userData'), 'remote.log') }
function configFile() { return join(app.getPath('userData'), 'remote.json') }
function sessionsFile() { return join(app.getPath('userData'), 'sessions.json') }
function log(message) {
  const line = `${new Date().toISOString()} ${redact(message)}\n`
  void appendFile(logFile(), line, { mode: 0o600 }).catch(() => undefined)
}

/** The host selected in remote.json. */
function activeHost() { return config.hosts.find(host => host.id === config.activeHostId) ?? config.hosts[0] }
function hostById(id) {
  const host = config.hosts.find(item => item.id === id)
  if (host === undefined) throw new Error(`unknown host ${String(id)}`)
  return host
}
/** Origin of a host's app-owned loopback port. */
function originOf(host) { return `http://127.0.0.1:${host.localPort}` }

/** The host the main window belongs to (fixed for the window's life). */
function windowHost() { return mainWindow === undefined ? undefined : windowState.get(mainWindow)?.host }
/** True for URLs served by the main window's server through its tunnel. */
function isAppUrl(url) {
  const host = windowHost()
  if (host === undefined) return false
  try { return new URL(url).origin === originOf(host) } catch { return false }
}

const configuredSessions = new Set()
/**
 * The Electron session for a partition, with the permission policy every window session gets:
 * only the main window's top frame on the tunnel origin may ask, only for audio (dictation, and
 * macOS still asks the user); clipboard and notifications for that same frame; nothing else.
 */
function sessionFor(partition) {
  const ses = session.fromPartition(partition)
  if (!configuredSessions.has(ses)) {
    configuredSessions.add(ses)
    const owned = (contents, frameUrl, isMainFrame) => contents != null && contents === mainWindow?.webContents && isMainFrame && isAppUrl(frameUrl)
    ses.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (permission === 'media') {
        return owned(contents, origin, details.isMainFrame) && details.mediaType === 'audio'
          && (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted')
      }
      return ['clipboard-read', 'clipboard-sanitized-write', 'notifications'].includes(permission) && owned(contents, origin, details.isMainFrame)
    })
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'media') {
        const audioOnly = Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'
        if (!owned(contents, details.requestingUrl, details.isMainFrame) || !audioOnly) { callback(false); return }
        if (process.platform !== 'darwin') { callback(true); return }
        void systemPreferences.askForMediaAccess('microphone').then(callback, () => { callback(false) })
        return
      }
      callback(['clipboard-read', 'clipboard-sanitized-write', 'notifications'].includes(permission)
        && owned(contents, details.requestingUrl, details.isMainFrame))
    })
  }
  return ses
}

function statusPage(title, detail) {
  const escape = text => text.replace(/[&<>]/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
  const html = `<!doctype html><meta charset="utf-8"><title>DeepSeek Harness Remote</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;background:#161616;color:#ddd;display:grid;place-items:center;height:100vh;margin:0;-webkit-app-region:drag}
main{max-width:560px;padding:24px}h1{font-size:18px;color:#fff}pre{white-space:pre-wrap;color:#f88;background:#1c1c1c;padding:12px;border-radius:8px;-webkit-app-region:no-drag}</style>
<main><h1>${escape(title)}</h1>${detail ? `<pre>${escape(detail)}</pre>` : ''}</main>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** Load a page; a load replaced by a newer one rejects with ERR_ABORTED, which is expected. */
function show(window, url) {
  if (window === undefined || window.isDestroyed()) return
  window.loadURL(url).catch((error) => { if (error?.code !== 'ERR_ABORTED') log(`load failed: ${error.message}`) })
}

/** device-info.ts: the machine description the account feedback form attaches. */
function readDeviceInfo() {
  const fields = [`platform=${process.platform}`]
  const collect = (name, read) => {
    try { const value = read(); if (value) fields.push(`${name}=${value}`) } catch { /* omitted when unavailable */ }
  }
  collect('os', () => process.getSystemVersion())
  fields.push(`app_arch=${process.arch}`)
  collect('cpu', () => cpus()[0]?.model)
  collect('memory_gib', () => (totalmem() / 1024 ** 3).toFixed(1))
  return fields.join('; ')
}

// ---- connections -----------------------------------------------------------------------------
//
// A window belongs to one host and one browser partition for its whole life. It has at most one
// connection attempt and one live connection. An attempt owns what it opens (tunnel, account
// watch, RPC) until it publishes them on the window or releases them; nothing else clears or
// replaces them. Starting an attempt cancels the previous one first, and an attempt checks after
// every await that it is still the window's own.

/**
 * @typedef {{ cancelled: boolean, tunnel?: Tunnel }} Attempt
 * @typedef {{ tunnel: Tunnel, invoke: (method: string, args?: object) => Promise<unknown>, stopWatch: (() => void) & { retry(): void } }} Live
 * @typedef {object} WindowState
 * @property {ReturnType<typeof hostById>} host - the server this window shows.
 * @property {string} partition - the window's session partition.
 * @property {Attempt | undefined} attempt - the connection attempt in progress.
 * @property {Live | undefined} live - the connection in use.
 * @property {number} delay - next automatic reconnect delay (ms).
 * @property {NodeJS.Timeout | undefined} retryTimer - pending automatic reconnect.
 */
/** @type {WeakMap<Electron.BrowserWindow, WindowState>} */
const windowState = new WeakMap()

/** Thrown inside an attempt that is no longer the window's own (newer attempt, closed window, quit). */
class Cancelled extends Error {}
/** Thrown when the server's verified identity does not match the window's session. */
class IdentityChanged extends Error {
  constructor(partition) { super('server identity changed'); this.partition = partition }
}

/** Close a published connection: account watch and RPC first, then the forward. */
function closeLive(state) {
  const live = state.live
  if (live === undefined) return
  state.live = undefined
  live.stopWatch()
  void live.tunnel.stop()
}

/** Cancel the window's attempt and any pending automatic reconnect. */
function cancelAttempt(state) {
  clearTimeout(state.retryTimer)
  state.retryTimer = undefined
  const attempt = state.attempt
  if (attempt === undefined) return
  state.attempt = undefined
  attempt.cancelled = true
  void attempt.tunnel?.stop()
  attempt.tunnel = undefined
}

/** Release everything a window holds (it is closing, or the app is quitting). */
function releaseWindow(state) {
  cancelAttempt(state)
  closeLive(state)
}

/**
 * One connection attempt: the launch token over SSH, a fresh forward, the server's verified
 * identity checked against the window's session, then authentication and the page.
 */
async function runAttempt(window, state, attempt) {
  const { host } = state
  const check = () => { if (attempt.cancelled || quitting || window.isDestroyed() || state.attempt !== attempt) throw new Cancelled() }
  const launchRun = await sshRun(host.sshHost, launchScript(host))
  check()
  const launch = parseLaunchUrl(launchRun.out)
  if (launch === undefined) throw new Error(`no "dsh web" launch line in ${host.serverLog} on ${host.sshHost}; use Settings → Remote servers → Set up server`)
  const tunnel = new Tunnel(host.sshHost, host.localPort, launch, (code, stderr) => { onTunnelExit(window, state, tunnel, code, stderr) },
    { proxy: proxyFor(host), socketPath: join(socketRoot, `${++socketCounter}.s`) })
  attempt.tunnel = tunnel
  await tunnel.start()
  check()
  // The launch token and the forward must come from the same server, and that server must be the
  // one this window's session belongs to; otherwise the session's cookies must not reach it.
  if (launchRun.identity === '' || tunnel.identity !== launchRun.identity) throw new Error('the two SSH connections reached different servers; check the SSH settings for this host, then reconnect')
  const partition = partitionName(host.id, tunnel.identity)
  if (partition !== state.partition) throw new IdentityChanged(partition)
  // The window's previous connection goes before the new one is routed.
  closeLive(state)
  tunnel.route()
  const url = localLaunchUrl(host.localPort, launch.token)
  const cookie = await authenticate(url)
  check()
  if (!tunnel.alive) throw new Error('ssh tunnel closed while signing in')
  const stopWatch = watchAccountSignIn(originOf(host), cookie, {
    open: (target) => {
      if (window.isDestroyed() || !window.isFocused()) { log('sign-in page not opened: window not focused'); return false }
      if (Date.now() - lastSignInOpen < 10_000) return false
      lastSignInOpen = Date.now()
      void shell.openExternal(target)
      return true
    },
    theme: () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    log,
  })
  state.live = { tunnel, invoke: hostRpc(originOf(host), cookie), stopWatch }
  attempt.tunnel = undefined
  log(`connected ${host.id} (${host.sshHost}) -> ${launch.host}:${launch.port} on 127.0.0.1:${host.localPort}`)
  await window.loadURL(url).catch((error) => { if (error?.code !== 'ERR_ABORTED') throw error })
  check()
}

/**
 * Connect a window to its host, replacing any attempt in progress.
 * @param {Electron.BrowserWindow} window - a main window.
 * @param {{ automatic?: boolean }} [options] - automatic reconnects back off; manual ones reset it.
 * @returns {Promise<'connected' | 'failed' | 'cancelled'>} outcome of this attempt.
 */
async function connectWindow(window, { automatic = false } = {}) {
  const state = windowState.get(window)
  if (state === undefined || window.isDestroyed() || quitting) return 'cancelled'
  cancelAttempt(state)
  if (!automatic) state.delay = RECONNECT_DELAY_MS
  const attempt = { cancelled: false }
  state.attempt = attempt
  const { host } = state
  window.setTitle(`DeepSeek Harness — ${host.name}`)
  show(window, statusPage(`Connecting to ${host.name}…`, ''))
  try {
    await runAttempt(window, state, attempt)
    state.attempt = undefined
    state.delay = RECONNECT_DELAY_MS
    return 'connected'
  } catch (error) {
    if (state.attempt !== attempt || attempt.cancelled || error instanceof Cancelled) return 'cancelled'
    state.attempt = undefined
    void attempt.tunnel?.stop()
    attempt.tunnel = undefined
    if (error instanceof IdentityChanged) {
      // Another machine answers for this host now: open it in its own session, in a new window.
      log(`${host.id}: the server's identity is new; opening it in its own session`)
      void serialHostChange(() => replaceWindow(window, host, error.partition)).catch((failure) => { log(`opening ${host.id} failed: ${failure.message}`) })
      return 'cancelled'
    }
    // A failed load leaves nothing half-open: the connection it published is closed too.
    closeLive(state)
    log(`connect failed: ${error.message}`)
    const others = config.hosts.filter(item => item.id !== host.id).map(item => item.name).join(', ')
    show(window, statusPage(`Cannot reach DeepSeek Harness on ${host.name}`,
      `${redact(error.message)}\n\nNot set up yet? Connection → Set up this server…\nReconnect: Cmd+Shift+R${others ? `\nSwitch server: Connection menu (${others})` : ''}\nAdd servers before any is set up: Connection → Open settings file`))
    scheduleReconnect(window, state)
    return 'failed'
  }
}

/** Automatic retry after a failure or a drop: 3 s, 6 s, 12 s … up to 60 s. */
function scheduleReconnect(window, state) {
  if (quitting || window.isDestroyed()) return
  clearTimeout(state.retryTimer)
  const delay = state.delay
  state.delay = Math.min(delay * 2, 60_000)
  state.retryTimer = setTimeout(() => {
    state.retryTimer = undefined
    if (state.attempt === undefined) void connectWindow(window, { automatic: true })
  }, delay)
}

/** The forward of a window's connection dropped. */
function onTunnelExit(window, state, tunnel, code, stderr) {
  log(`tunnel exited code=${String(code)} ${stderr}`)
  if (state.live?.tunnel !== tunnel) return
  // Nothing that carries this server's cookie may outlive its forward.
  closeLive(state)
  if (window.isDestroyed() || quitting || state.attempt !== undefined) return
  show(window, statusPage(`Reconnecting to ${state.host.name}…`, ''))
  scheduleReconnect(window, state)
}

/** Manual reconnect (menu, after setup). */
function reconnectNow() {
  const window = mainWindow
  if (window !== undefined && !window.isDestroyed()) void connectWindow(window)
}

// ---- windows and hosts -----------------------------------------------------------------------

/** Remember (and store) the session a host connected with, so its next window opens in it. */
function rememberSession(hostId, partition) {
  if (knownSessions.get(hostId) === partition) return
  knownSessions = new Map(knownSessions).set(hostId, partition)
  void saveKnown(sessionsFile(), knownSessions).catch((error) => { log(`saving sessions.json failed: ${error.message}`) })
}

/**
 * Replace the main window with one for `host`, keeping its position; with `partition`, that
 * session becomes the host's session first. The old window's connection is closed first.
 */
async function replaceWindow(previous, host, partition) {
  if (quitting || previous !== mainWindow || previous === undefined || previous.isDestroyed()) return
  if (config.hosts.every(item => item.id !== host.id)) return
  if (partition !== undefined) rememberSession(host.id, partition)
  const bounds = previous.getBounds()
  for (const popup of popups) if (!popup.isDestroyed()) popup.close()
  const state = windowState.get(previous)
  if (state !== undefined) releaseWindow(state)
  createWindow(host, bounds)
  previous.destroy()
}

/** Switches, removals and session changes run one at a time. */
let hostChange = Promise.resolve()
function serialHostChange(change) {
  const run = hostChange.then(change)
  hostChange = run.catch(() => undefined)
  return run
}

function switchHost(id) { return serialHostChange(() => switchHostNow(id)) }

/** Show another server: a window in that server's session replaces the current one. */
async function switchHostNow(id) {
  hostById(id)
  if (quitting) return
  if (id === config.activeHostId && windowHost()?.id === id) return
  config = await updateConfig(configFile(), (current) => {
    if (!current.hosts.some(host => host.id === id)) throw new Error(`unknown host ${String(id)}`)
    return { ...current, activeHostId: id }
  }, () => config)
  buildMenu()
  await replaceWindow(mainWindow, activeHost(), undefined)
}

/**
 * Install or complete DeepSeek Harness on a server, after a native confirmation.
 * @param {string} id - host id from remote.json.
 * @returns {Promise<{ output: string }>} the tail of the setup output, tokens masked.
 */
async function setupHost(id) {
  const host = hostById(id)
  if (!await confirmNative(`Set up DeepSeek Harness on "${host.name}"?`,
    `SSH host: ${host.sshHost}\nInstalls what is missing: @deepseek-ai/dsh and dsh-tui (npm), pnpm, a "server" profile, the dsh-remote-servers bundle, and the systemd user service ${host.serverUnit} listening on 127.0.0.1:${host.serverPort}.`,
    'Set up')) throw new Error('cancelled')
  log(`setup started on ${host.id}`)
  // build-mac.sh packs the dsh-remote-servers bundle next to main.js.
  const tarball = (await readFile(fileURLToPath(new URL('./dsh-remote-servers.tgz', import.meta.url)))).toString('base64')
  const output = await runRemote(host.sshHost, setupScript(host, tarball), 15 * 60_000)
  log(`setup finished on ${host.id}`)
  return { output: redact(output).slice(-4000) }
}

/** Ask in a native dialog the page cannot answer. */
async function confirmNative(message, detail, action) {
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return false
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', buttons: [action, 'Cancel'], defaultId: 1, cancelId: 1, message, detail,
  })
  return response === 0
}

/**
 * Clear every session that belongs to a host id: each server it ever reached, from any run, and
 * the names earlier versions used.
 */
async function clearHostSessions(hostId) {
  const names = new Set((await partitionDirs(app.getPath('userData'))).filter(name => belongsTo(hostId, name)))
  const known = knownSessions.get(hostId)
  if (known !== undefined) names.add(known.slice('persist:'.length))
  for (const name of names) {
    const ses = session.fromPartition(`persist:${name}`)
    await ses.clearStorageData()
    await ses.clearCache()
  }
}

/**
 * At startup, clear sessions no configured host can use: those named by earlier versions (keyed by
 * the alias, not the verified server) and those of hosts removed outside the app. A failure is
 * logged; such a session is never loaded, because current names include the verified identity.
 */
async function clearStaleSessions() {
  const stale = staleNames(await partitionDirs(app.getPath('userData')), config.hosts.map(host => host.id))
  for (const name of stale) {
    try {
      const ses = session.fromPartition(`persist:${name}`)
      await ses.clearStorageData()
      await ses.clearCache()
    } catch (error) { log(`clearing old session ${name} failed: ${error.message}`) }
  }
}

/**
 * Open the main window for `host`. A host without a verified session starts in an in-memory one
 * that only shows status pages; its first connection then opens it in its own session.
 */
function createWindow(host, bounds) {
  const darwin = process.platform === 'darwin'
  const partition = knownSessions.get(host.id) ?? PENDING_PARTITION
  const window = new BrowserWindow({
    width: 1280, height: 820, ...(bounds ?? {}), minWidth: 520, minHeight: 600,
    title: 'DeepSeek Harness',
    ...(darwin ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
    } : { backgroundColor: '#161616' }),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      session: sessionFor(partition),
    },
  })
  /** @type {WindowState} */
  const state = { host, partition, attempt: undefined, live: undefined, delay: RECONNECT_DELAY_MS, retryTimer: undefined }
  windowState.set(window, state)
  mainWindow = window
  // The bundled keyboard.ts admits IPC only from this origin (see vendor/build-desktop-keyboard.mjs).
  globalThis.__DSH_REMOTE_APP_ORIGIN__ = originOf(host)
  const contents = window.webContents
  const sendFullscreen = () => { if (!window.isDestroyed()) contents.send(IPC.windowFullscreen, window.isFullScreen()) }
  window.on('enter-full-screen', sendFullscreen)
  window.on('leave-full-screen', sendFullscreen)
  contents.on('did-finish-load', sendFullscreen)
  if (darwin) {
    // Official workaround for electron/electron#25368: opaque base while minimized/hidden.
    const applyBackdrop = () => {
      if (window.isDestroyed()) return
      if (window.isMinimized() || !window.isVisible()) { window.setVibrancy(null); window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#161616' : '#f5f5f5') }
      else { window.setBackgroundColor('#00000000'); window.setVibrancy('sidebar') }
    }
    for (const name of ['minimize', 'restore', 'hide', 'show']) window.on(name, applyBackdrop)
  }
  // Account sign-in opens about:blank, then navigates it to platform.deepseek.com. That page
  // must open in the system browser; its OAuth callback returns to 127.0.0.1:<localPort>,
  // which the tunnel carries to the server.
  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: { show: false, width: 480, height: 640, webPreferences: { sandbox: true } } }
    }
    if (/^https?:\/\//u.test(url) && !isAppUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A server redirect gets the same rule as a page navigation.
  contents.on('will-redirect', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url)
  })
  contents.on('did-create-window', (child) => {
    // The popup is only a hand-off point for the sign-in page; never let it linger in the background.
    popups.add(child)
    const closeTimer = setTimeout(() => { if (!child.isDestroyed()) child.close() }, 30_000)
    child.on('closed', () => { clearTimeout(closeTimer); popups.delete(child) })
    child.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (/^https?:\/\//u.test(url)) void shell.openExternal(url)
      child.close()
    })
  })
  // will-navigate fires only for page-initiated navigation (status pages load through loadURL),
  // so the remote page may navigate within its own origin while it is connected, and nowhere else.
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url) && state.live !== undefined) return
    event.preventDefault()
    if (!isAppUrl(url) && /^https?:\/\//u.test(url)) void shell.openExternal(url)
  })
  shortcuts.attach(window)
  window.on('closed', () => {
    releaseWindow(state)
    if (mainWindow === window) mainWindow = undefined
  })
  // A sign-in the app held back while unfocused is offered when the user returns.
  window.on('focus', () => { state.live?.stopWatch.retry() })
  void connectWindow(window)
  return window
}

/** IPC sent by the preload; every handler accepts only the main window's top frame on the tunnel origin. */
function installIpc() {
  const owned = (event) => {
    const window = mainWindow
    return window !== undefined && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame.url)
  }
  const assertOwned = (event) => { if (!owned(event)) throw new Error('dsh remote: rejected IPC from an unowned renderer') }
  // Answered only to the main window's top frame; the preload compares it with its own origin.
  ipcMain.on('dsh-remote:active-origin', (event) => {
    const window = mainWindow
    const host = windowHost()
    event.returnValue = window !== undefined && !window.isDestroyed() && host !== undefined && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame ? originOf(host) : null
  })
  ipcMain.handle(IPC.deviceInfo, (event) => { assertOwned(event); return readDeviceInfo() })
  ipcMain.handle(IPC.onboardingApiKey, async (event) => {
    assertOwned(event)
    const live = windowState.get(mainWindow)?.live
    if (live === undefined) return false
    return hasConfiguredApiKey(live.invoke)
  })
  ipcMain.on(IPC.onboardingActive, (event, active) => {
    if (!owned(event) || typeof active !== 'boolean') return
    mainWindow.setMinimumSize(active ? 960 : 520, 600)
    if (active) {
      const { width, height } = mainWindow.getBounds()
      if (width < 960) mainWindow.setSize(960, height)
    }
  })
  ipcMain.on(IPC.nativeThemeSet, (event, source) => {
    if (!owned(event)) return
    if (source === 'light' || source === 'dark' || source === 'system') nativeTheme.themeSource = source
  })

  // Remote servers page. Arguments are untrusted renderer input: ids are looked up, never used
  // as paths or shell text; new hosts go through resolveConfig validation before anything runs.
  // The page is served by the connected server, so a compromised server must not be able to
  // add hosts, switch, remove or install software on the user's other servers: those actions
  // need a native confirmation the page cannot answer. Listing hosts and the read-only check
  // (probe, over the user's SSH keys) do not.
  ipcMain.handle(IPC.remoteList, (event) => { assertOwned(event); return config })
  ipcMain.handle(IPC.remoteAdd, async (event, draft) => {
    assertOwned(event)
    if (typeof draft !== 'object' || draft === null || typeof draft.sshHost !== 'string') throw new Error('invalid server')
    const sshHost = draft.sshHost.trim()
    const name = typeof draft.name === 'string' && draft.name.trim() !== '' ? draft.name.trim() : sshHost
    if (!await confirmNative(`Add the server "${name.slice(0, 60)}"?`,
      `SSH host: ${sshHost.slice(0, 120)}\nThis app will connect to it with your SSH keys.`, 'Add')) throw new Error('cancelled')
    let id
    config = await updateConfig(configFile(), (current) => {
      const taken = new Set(current.hosts.map(host => host.id))
      id = slug(name)
      for (let n = 2; taken.has(id); n++) id = `${slug(name).slice(0, 36)}-${n}`
      return { ...current, hosts: [...current.hosts, { ...HOST_DEFAULTS, id, name, sshHost, localPort: nextLocalPort(current.hosts) }] }
    }, () => config)
    log(`added host ${id} (${sshHost})`)
    buildMenu()
    return config
  })
  ipcMain.handle(IPC.remoteRemove, async (event, id) => {
    assertOwned(event)
    const host = hostById(id)
    if (host.id === config.activeHostId) throw new Error('switch to another server before removing this one')
    if (!await confirmNative(`Remove "${host.name}" from this app?`, `SSH host: ${host.sshHost}\nNothing on the server is deleted.`, 'Remove')) throw new Error('cancelled')
    await serialHostChange(async () => {
      if (config.activeHostId === host.id || windowHost()?.id === host.id) throw new Error('switch to another server before removing this one')
      // Clear the server's cookies and storage first: if that fails, the entry stays and its id
      // cannot be reused by a new server.
      try {
        await clearHostSessions(host.id)
      } catch (error) {
        log(`remove ${host.id}: clearing its session failed: ${error.message}`)
        throw new Error(`could not clear this server's saved session (${error.message}); it was not removed`)
      }
      config = await updateConfig(configFile(), (current) => {
        if (current.activeHostId === host.id) throw new Error('switch to another server before removing this one')
        return { ...current, hosts: current.hosts.filter(item => item.id !== host.id) }
      }, () => config)
      const known = new Map(knownSessions)
      known.delete(host.id)
      knownSessions = known
      await saveKnown(sessionsFile(), knownSessions).catch((error) => { log(`saving sessions.json failed: ${error.message}`) })
    })
    log(`removed host ${host.id}`)
    buildMenu()
    return config
  })
  ipcMain.handle(IPC.remoteProbe, async (event, id) => {
    assertOwned(event)
    const host = hostById(id)
    return parseProbe(await runRemote(host.sshHost, probeScript(host)))
  })
  ipcMain.handle(IPC.remoteSetup, (event, id) => { assertOwned(event); return setupHost(id) })
  ipcMain.handle(IPC.remoteSwitch, async (event, id) => {
    assertOwned(event)
    const target = hostById(id)
    if (target.id !== config.activeHostId
      && !await confirmNative(`Switch to "${target.name}"?`, `SSH host: ${target.sshHost}`, 'Switch')) throw new Error('cancelled')
    // Reply before the window navigates away from the page that asked.
    setTimeout(() => { void switchHost(id).catch((error) => { log(`switch failed: ${error.message}`) }) }, 50)
  })
  // The page never receives ~/.ssh/config contents: aliases are offered in a native menu.
  ipcMain.handle(IPC.remoteSshAliases, async (event) => {
    assertOwned(event)
    const aliases = await readSshAliases()
    const window = mainWindow
    if (aliases.length === 0 || window === undefined || window.isDestroyed()) return null
    return new Promise((resolve) => {
      let picked = null
      Menu.buildFromTemplate(aliases.slice(0, 50).map(alias => ({ label: alias, click: () => { picked = alias } })))
        .popup({ window, callback: () => { resolve(picked) } })
    })
  })
}

/** Official macEditMenu(): Paste and Match Style on Shift+Command+V. */
const macEditMenu = () => ({ role: 'editMenu', submenu: [
  { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
  { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
  { role: 'pasteAndMatchStyle', accelerator: 'Shift+Command+V' },
  { role: 'pasteAndMatchStyle', accelerator: 'Option+Shift+Command+V', visible: false, acceleratorWorksWhenHidden: true },
  { role: 'delete' }, { role: 'selectAll' },
] })

function buildMenu() {
  const darwin = process.platform === 'darwin'
  const template = [
    { role: 'appMenu' },
    ...(darwin ? [shortcuts.fileMenu({ fileMenu: 'File', closePage: 'Close Page or Window' }), macEditMenu()] : [{ role: 'editMenu' }]),
    {
      label: 'Connection',
      submenu: [
        ...config.hosts.map((host, index) => ({
          label: host.name, type: 'radio', checked: host.id === config.activeHostId,
          ...(index < 9 ? { accelerator: `CmdOrCtrl+Alt+${index + 1}` } : {}),
          click: () => { void switchHost(host.id).catch((error) => { log(`switch failed: ${error.message}`) }) },
        })),
        { type: 'separator' },
        { label: 'Set up this server…', click: () => {
          void setupHost(windowHost()?.id ?? config.activeHostId).then(() => { reconnectNow() }, (error) => {
            if (!/cancelled$/u.test(error.message)) void dialog.showMessageBox({ type: 'error', message: 'Setup failed', detail: redact(error.message).slice(-2000) })
          })
        } },
        { label: 'Reconnect', accelerator: 'CmdOrCtrl+Shift+R', click: () => { reconnectNow() } },
        { label: 'Reload page', click: () => { if (mainWindow !== undefined && windowState.get(mainWindow)?.live !== undefined) mainWindow.webContents.reload() } },
        { type: 'separator' },
        { label: 'Open settings file', click: () => { void shell.openPath(configFile()) } },
        { label: 'Open log', click: () => { void shell.openPath(logFile()) } },
        { type: 'separator' },
        { label: 'Toggle developer tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => { mainWindow?.webContents.toggleDevTools() } },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus() })
  app.whenReady().then(async () => {
    try {
      config = await loadConfig(configFile())
      socketRoot = await mkdtemp(join('/tmp', 'dshrc-'))
      await chmod(socketRoot, 0o700)
      // Logs written by earlier versions were created with the default mode.
      await chmod(logFile(), 0o600).catch(() => undefined)
      knownSessions = await loadKnown(sessionsFile(), config.hosts.map(host => host.id))
    } catch (error) {
      dialog.showErrorBox('DeepSeek Harness Remote', error.message)
      app.exit(1)
      return
    }
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
    shortcuts = installDesktopShortcuts(() => mainWindow, app.getPath('userData'), platform,
      () => { buildMenu() }, () => ({ revision: 0, blocked: false }))
    installIpc()
    buildMenu()
    await clearStaleSessions()
    createWindow(activeHost())
    app.on('activate', () => {
      if (mainWindow !== undefined) mainWindow.show()
      else if (!quitting) createWindow(activeHost())
    })
  }).catch((error) => { dialog.showErrorBox('DeepSeek Harness Remote', String(error)); app.exit(1) })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', () => {
    quitting = true
    const state = mainWindow === undefined ? undefined : windowState.get(mainWindow)
    if (state !== undefined) releaseWindow(state)
    for (const proxy of proxies.values()) proxy.close()
    if (socketRoot !== undefined) void rm(socketRoot, { recursive: true, force: true })
  })
  app.on('will-quit', () => { shortcuts?.dispose() })
}
