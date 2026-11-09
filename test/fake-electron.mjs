// A stand-in for the parts of Electron that app/main.js uses, so its connection lifecycle runs
// under node:test. Registered as the `electron` module by test/main.test.mjs before main.js loads.
// Windows record what they load; sessions record which partition they belong to; dialogs answer
// from a queue the test fills.
import { EventEmitter } from 'node:events'

export function createFakeElectron({ userData }) {
  const handlers = new Map()
  const listeners = new Map()
  const windows = []
  const sessions = new Map()
  const dialogAnswers = []
  let readyResolve
  const ready = new Promise((resolve) => { readyResolve = resolve })

  class FakeSession {
    constructor(partition) { this.partition = partition; this.cleared = 0 }
    setPermissionCheckHandler(fn) { this.check = fn }
    setPermissionRequestHandler(fn) { this.request = fn }
    async clearStorageData() { if (this.failClear) throw new Error('disk busy'); this.cleared++ }
    async clearCache() {}
  }

  class FakeWebContents extends EventEmitter {
    constructor(window) { super(); this.window = window; this.url = ''; this.mainFrame = { url: '' } }
    getURL() { return this.url }
    send() {}
    setWindowOpenHandler(fn) { this.openHandler = fn }
    reload() {}
    toggleDevTools() {}
  }

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.session = options.webPreferences.session
      this.webContents = new FakeWebContents(this)
      this.loads = []
      this.destroyed = false
      this.title = ''
      this.focused = true
      windows.push(this)
    }
    async loadURL(url) {
      if (this.destroyed) throw Object.assign(new Error('destroyed'), { code: 'ERR_FAILED' })
      this.loads.push(url)
      this.webContents.url = url
      this.webContents.mainFrame.url = url
      if (this.failLoad !== undefined && !url.startsWith('data:')) throw this.failLoad
    }
    isDestroyed() { return this.destroyed }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed') }
    close() { this.destroy() }
    getBounds() { return { x: 0, y: 0, width: 1280, height: 820 } }
    setTitle(title) { this.title = title }
    isFocused() { return this.focused }
    isFullScreen() { return false }
    isMinimized() { return false }
    isVisible() { return true }
    setVibrancy() {}
    setBackgroundColor() {}
    setMinimumSize() {}
    setSize() {}
    show() {}
    focus() {}
  }

  const app = new EventEmitter()
  Object.assign(app, {
    setName() {},
    setPath() {},
    getPath: () => userData,
    requestSingleInstanceLock: () => true,
    whenReady: () => ready,
    quit() { app.emit('before-quit'); app.emit('will-quit') },
    exit(code) { app.exitCode = code },
  })

  const electron = {
    app,
    BrowserWindow,
    Menu: { buildFromTemplate: template => ({ template, popup() {} }), setApplicationMenu(menu) { electron.menu = menu } },
    dialog: {
      // An answer may be a promise, so a test can hold a confirmation open while other things happen.
      async showMessageBox() { return { response: await (dialogAnswers.length > 0 ? dialogAnswers.shift() : 1) } },
      showErrorBox(_title, message) { electron.errors.push(message) },
    },
    ipcMain: {
      handle(channel, fn) { handlers.set(channel, fn) },
      on(channel, fn) { listeners.set(channel, fn) },
      removeHandler(channel) { handlers.delete(channel) },
    },
    nativeTheme: { shouldUseDarkColors: true, themeSource: 'system' },
    shell: { opened: [], openExternal(url) { electron.shell.opened.push(url) }, openPath() {} },
    session: {
      fromPartition(partition) {
        if (!sessions.has(partition)) sessions.set(partition, new FakeSession(partition))
        return sessions.get(partition)
      },
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted', askForMediaAccess: async () => true },
    errors: [],
  }

  return {
    electron,
    windows,
    sessions,
    dialogAnswers,
    start: () => readyResolve(),
    /** Call an ipcMain.handle channel as the given window's main frame. */
    invoke(window, channel, ...args) {
      const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
      return handlers.get(channel)(event, ...args)
    },
  }
}
