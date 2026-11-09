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
import { appendFile, chmod, readFile } from 'node:fs/promises'
import { cpus, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadConfig, updateConfig, slug, nextLocalPort, HOST_DEFAULTS } from './lib/config.js'
import { launchScript, parseLaunchUrl, localLaunchUrl, redact } from './lib/launch.js'
import { Tunnel, runRemote } from './lib/tunnel.js'
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
let tunnel
let mainWindow
let shortcuts
let invokeHost
let stopAccountWatch
/** Bumped by every openApp(); an older in-flight connect sees the change and stops. */
let connectGeneration = 0
let lastSignInOpen = 0
/** Sign-in popups of the current window; closed when the window changes server. */
const popups = new Set()
let quitting = false
let reconnecting = false

function logFile() { return join(app.getPath('userData'), 'remote.log') }
function configFile() { return join(app.getPath('userData'), 'remote.json') }
function log(message) {
  const line = `${new Date().toISOString()} ${redact(message)}\n`
  void appendFile(logFile(), line, { mode: 0o600 }).catch(() => undefined)
}

/** The host this window shows. */
function activeHost() { return config.hosts.find(host => host.id === config.activeHostId) ?? config.hosts[0] }
function hostById(id) {
  const host = config.hosts.find(item => item.id === id)
  if (host === undefined) throw new Error(`unknown host ${String(id)}`)
  return host
}
/** The active server's tunnel origin. */
function appOrigin() { return `http://127.0.0.1:${activeHost().localPort}` }
/**
 * Each server gets its own persistent browser session: cookies ignore ports, so separate
 * loopback ports alone would send one server's auth cookie to another.
 */
function hostPartition(host) { return `persist:dsh-remote-${host.id}` }
const configuredSessions = new Set()
function hostSession(host) {
  const ses = session.fromPartition(hostPartition(host))
  if (!configuredSessions.has(ses)) {
    configuredSessions.add(ses)
    // microphone-permissions.ts: only the main window's top frame on the tunnel origin may ask,
    // only for audio (dictation), and macOS still asks the user. Other permissions are denied
    // except clipboard and notifications for that same frame.
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

/** True for URLs served by the remote dsh through the tunnel. */
function isAppUrl(url) {
  try { return new URL(url).origin === appOrigin() } catch { return false }
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

/** Thrown when a newer connect (switch, reconnect) replaced this one while it was in flight. */
class Superseded extends Error {}

/**
 * Resolve the active server's launch token and (re)open its forward.
 * @param {number} generation - value of connectGeneration when this attempt started; a newer
 *   attempt makes every later step of this one stop and release what it opened.
 */
async function connect(generation) {
  const current = () => generation === connectGeneration && !quitting
  const host = activeHost()
  const out = await runRemote(host.sshHost, launchScript(host))
  if (!current()) throw new Superseded()
  const launch = parseLaunchUrl(out)
  if (launch === undefined) throw new Error(`no "dsh web" launch line in ${host.serverLog} on ${host.sshHost}; use Settings → Remote servers → Set up server`)
  tunnel?.stop()
  let started = false
  const opened = new Tunnel(host.sshHost, host.localPort, launch, (code, stderr) => {
    log(`tunnel exited code=${String(code)} ${stderr}`)
    // A failed start is reported by start() itself; only a drop after a working start reconnects.
    if (!started || tunnel !== opened) return
    tunnel = undefined
    if (mainWindow !== undefined && !mainWindow.isDestroyed() && isAppUrl(mainWindow.webContents.getURL())) {
      void mainWindow.loadURL(statusPage(`Reconnecting to ${host.name}…`, ''))
    }
    void reconnect()
  })
  tunnel = opened
  try { await opened.start() } catch (error) {
    if (tunnel === opened) tunnel = undefined
    opened.stop()
    throw error
  }
  started = true
  if (!current()) { opened.stop(); if (tunnel === opened) tunnel = undefined; throw new Superseded() }
  log(`connected ${host.id} (${host.sshHost}) -> ${launch.host}:${launch.port} on 127.0.0.1:${host.localPort}`)
  globalThis.__DSH_REMOTE_APP_ORIGIN__ = appOrigin()
  const url = localLaunchUrl(host.localPort, launch.token)
  const cookie = await authenticate(url)
  if (!current()) throw new Superseded()
  invokeHost = hostRpc(appOrigin(), cookie)
  stopAccountWatch?.()
  stopAccountWatch = watchAccountSignIn(appOrigin(), cookie, {
    open: (target) => {
      if (mainWindow === undefined || mainWindow.isDestroyed() || !mainWindow.isFocused()) { log('sign-in page not opened: window not focused'); return }
      if (Date.now() - lastSignInOpen < 10_000) return
      lastSignInOpen = Date.now()
      void shell.openExternal(target)
    },
    theme: () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    log,
  })
  return url
}

async function openApp() {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  const generation = ++connectGeneration
  const host = activeHost()
  mainWindow.setTitle(`DeepSeek Harness — ${host.name}`)
  void mainWindow.loadURL(statusPage(`Connecting to ${host.name}…`, ''))
  try {
    const url = await connect(generation)
    if (generation === connectGeneration) await mainWindow?.loadURL(url)
  } catch (error) {
    if (error instanceof Superseded || generation !== connectGeneration) return
    log(`connect failed: ${error.message}`)
    const others = config.hosts.filter(item => item.id !== host.id).map(item => item.name).join(', ')
    void mainWindow?.loadURL(statusPage(`Cannot reach DeepSeek Harness on ${host.name}`,
      `${redact(error.message)}\n\nNot set up yet? Connection → Set up this server…\nReconnect: Cmd+Shift+R${others ? `\nSwitch server: Connection menu (${others})` : ''}\nAdd servers before any is set up: Connection → Open settings file`))
  }
}

/** Show another server in this window; the previous tunnel and account watch are closed first. */
async function switchHost(id) {
  hostById(id)
  if (id === config.activeHostId && tunnel !== undefined) return
  config = await updateConfig(configFile(), current => ({ ...current, activeHostId: id }), () => config)
  connectGeneration++
  stopAccountWatch?.()
  stopAccountWatch = undefined
  invokeHost = undefined
  tunnel?.stop()
  tunnel = undefined
  buildMenu()
  // The window belongs to the previous server's session; open the next one in its own.
  const previous = mainWindow
  for (const popup of popups) if (!popup.isDestroyed()) popup.close()
  createWindow(previous !== undefined && !previous.isDestroyed() ? previous.getBounds() : undefined)
  if (previous !== undefined && !previous.isDestroyed()) previous.destroy()
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

async function reconnect() {
  if (quitting || reconnecting || mainWindow === undefined || mainWindow.isDestroyed()) return
  reconnecting = true
  const generation = connectGeneration
  try {
    await new Promise((resolve) => { setTimeout(resolve, RECONNECT_DELAY_MS) })
    if (!quitting && generation === connectGeneration) await openApp()
  } finally { reconnecting = false }
}

/** Official createWindow(): hiddenInset traffic lights inside the sidebar, sidebar vibrancy. */
function createWindow(bounds) {
  const darwin = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
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
      session: hostSession(activeHost()),
    },
  })
  const window = mainWindow
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
  // Without a tunnel, nothing on the tunnel port belongs to the server any more.
  contents.on('will-navigate', (event, url) => { if (isAppUrl(url) && tunnel === undefined) event.preventDefault() })
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
  // will-navigate fires only for page-initiated navigation (status pages load through
  // loadURL), so the remote page may navigate within the tunnel origin and nowhere else.
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (/^https?:\/\//u.test(url)) void shell.openExternal(url)
  })
  shortcuts.attach(window)
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
  void openApp()
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
    event.returnValue = window !== undefined && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame ? appOrigin() : null
  })
  ipcMain.handle(IPC.deviceInfo, (event) => { assertOwned(event); return readDeviceInfo() })
  ipcMain.handle(IPC.onboardingApiKey, async (event) => {
    assertOwned(event)
    if (invokeHost === undefined) return false
    return hasConfiguredApiKey(invokeHost)
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
  // add hosts or install software on the user's other servers: those two actions need a native
  // confirmation the page cannot answer.
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
    config = await updateConfig(configFile(), current => ({ ...current, hosts: current.hosts.filter(item => item.id !== host.id) }), () => config)
    // A later server added under the same id must not inherit this one's cookies or storage.
    await session.fromPartition(hostPartition(host)).clearStorageData().catch(() => undefined)
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
          void setupHost(config.activeHostId).then(() => openApp(), (error) => {
            if (!/cancelled$/u.test(error.message)) void dialog.showMessageBox({ type: 'error', message: 'Setup failed', detail: redact(error.message).slice(-2000) })
          })
        } },
        { label: 'Reconnect', accelerator: 'CmdOrCtrl+Shift+R', click: () => { void openApp() } },
        { label: 'Reload page', click: () => { if (tunnel !== undefined) mainWindow?.webContents.reload() } },
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
      // Logs written by earlier versions were created with the default mode.
      await chmod(logFile(), 0o600).catch(() => undefined)
    } catch (error) {
      dialog.showErrorBox('DeepSeek Harness Remote', error.message)
      app.exit(1)
      return
    }
    // The bundled keyboard.ts admits IPC only from this origin (see vendor/build-desktop-keyboard.mjs).
    globalThis.__DSH_REMOTE_APP_ORIGIN__ = appOrigin()
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
    shortcuts = installDesktopShortcuts(() => mainWindow, app.getPath('userData'), platform,
      () => { buildMenu() }, () => ({ revision: 0, blocked: false }))
    installIpc()
    buildMenu()
    createWindow()
    app.on('activate', () => { if (mainWindow === undefined) createWindow(); else mainWindow.show() })
  }).catch((error) => { dialog.showErrorBox('DeepSeek Harness Remote', String(error)); app.exit(1) })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', () => { quitting = true; connectGeneration++; stopAccountWatch?.(); tunnel?.stop() })
  app.on('will-quit', () => { shortcuts?.dispose() })
}
