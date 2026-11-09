/**
 * Remote-client preload: give the remote Web UI the same Desktop bridges the official app's
 * preload-app provides, so it renders the Desktop layout (inset traffic lights, sidebar
 * vibrancy, New Session in the header) and uses native shortcuts.
 *
 * Bridges implemented here: platform/fullscreen marks, native theme sync, keyboard + shortcut
 * preferences (main side is DeepSeek's own keyboard.ts), onboarding API-key presence, device
 * info. Bridges that need the official local Host are left out on purpose: file save/drag,
 * the embedded Platform view, update channels and the native folder picker (the Web UI falls
 * back to its own Host directory browser, which lists the server's folders).
 *
 * Every bridge is exposed only to the tunnel origin passed by main in `--dsh-remote-origin`.
 */
const { contextBridge, ipcRenderer } = require('electron')

const IPC = {
  shortcutsInput: 'dsh-desktop:shortcuts-input',
  shortcutsCloseWindow: 'dsh-desktop:shortcuts-close-window',
  shortcutsGet: 'dsh-desktop:shortcuts-get',
  shortcutsEdit: 'dsh-desktop:shortcuts-edit',
  shortcutsChanged: 'dsh-desktop:shortcuts-changed',
  shortcutsRecording: 'dsh-desktop:shortcuts-recording',
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

// The active server's tunnel origin changes when the user switches servers, so it is read from
// main on every document load instead of being fixed at window creation.
let appOrigin
try { appOrigin = ipcRenderer.sendSync('dsh-remote:active-origin') } catch { appOrigin = undefined }
const trusted = typeof appOrigin === 'string' && location.origin === appOrigin && process.isMainFrame

function onRoot(run) {
  if (document.documentElement !== null) run()
  else window.addEventListener('DOMContentLoaded', run, { once: true })
}

if (trusted) {
  // Same marks preload-platform.ts sets; shared CSS scopes the Desktop layout on them.
  onRoot(() => { document.documentElement.dataset.platform = process.platform })
  ipcRenderer.on(IPC.windowFullscreen, (_event, fullscreen) => {
    const root = document.documentElement
    if (root === null) return
    if (fullscreen) root.dataset.fullscreen = 'true'
    else delete root.dataset.fullscreen
  })

  // preload-theme.ts: keep the native vibrancy material in step with the page theme.
  let sentTheme
  const sendTheme = () => {
    const value = document.documentElement.getAttribute('data-ds-theme-source')
    if (value === null || value === sentTheme) return
    sentTheme = value
    ipcRenderer.send(IPC.nativeThemeSet, value)
  }
  const observeTheme = () => {
    new MutationObserver(sendTheme).observe(document.documentElement, { attributeFilter: ['data-ds-theme-source'] })
    sendTheme()
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', observeTheme, { once: true })
  else observeTheme()

  // Remote servers page (dsh-remote-servers plugin): host list, checks, setup and switching.
  contextBridge.exposeInMainWorld('dshRemote', {
    version: 1,
    list: () => ipcRenderer.invoke(IPC.remoteList),
    add: draft => ipcRenderer.invoke(IPC.remoteAdd, draft),
    remove: id => ipcRenderer.invoke(IPC.remoteRemove, id),
    probe: id => ipcRenderer.invoke(IPC.remoteProbe, id),
    setup: id => ipcRenderer.invoke(IPC.remoteSetup, id),
    switchTo: id => ipcRenderer.invoke(IPC.remoteSwitch, id),
    pickSshAlias: () => ipcRenderer.invoke(IPC.remoteSshAliases),
  })

  contextBridge.exposeInMainWorld('dshOnboarding', {
    hasApiKey: () => ipcRenderer.invoke(IPC.onboardingApiKey),
    setActive: (active) => { ipcRenderer.send(IPC.onboardingActive, active === true) },
  })

  contextBridge.exposeInMainWorld('dshDesktop', {
    protocolVersion: 1,
    deviceInfo: () => ipcRenderer.invoke(IPC.deviceInfo),
    keyboard: {
      closeWindow: revision => ipcRenderer.invoke(IPC.shortcutsCloseWindow, revision),
      subscribe: (listener) => {
        const handle = (_event, input) => {
          // preload-app.ts: frame-scoped inputs only reach the focused matching frame.
          if (input.kind === 'iframe') {
            const element = document.activeElement
            if (!(element instanceof HTMLIFrameElement) || !element.isConnected
              || !element.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')) return
            if (input.frameName === '' || element.name !== input.frameName) return
          }
          if (input.kind === 'webview') return
          listener(input)
        }
        ipcRenderer.on(IPC.shortcutsInput, handle)
        return () => { ipcRenderer.off(IPC.shortcutsInput, handle) }
      },
    },
    shortcuts: {
      get: definitions => ipcRenderer.invoke(IPC.shortcutsGet, definitions),
      edit: (edit, revision) => ipcRenderer.invoke(IPC.shortcutsEdit, edit, revision),
      recording: active => ipcRenderer.invoke(IPC.shortcutsRecording, active),
      subscribe(listener) {
        const handle = (_event, snapshot) => { listener(snapshot) }
        ipcRenderer.on(IPC.shortcutsChanged, handle)
        return () => { ipcRenderer.off(IPC.shortcutsChanged, handle) }
      },
    },
  })
}
