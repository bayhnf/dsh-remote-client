// Mounts the shipped Settings page (plugin/lib/client.js) with real React in jsdom and drives it
// through the same slot registration DSH uses. Needs jsdom, react and react-dom: run with
//   NODE_PATH=<dir containing them> node --test test/plugin.test.mjs
// (see `npm run test:plugin`). No server, SSH or Electron is involved.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(join(process.env.NODE_PATH ?? process.cwd(), 'noop.js'))
const { JSDOM } = require('jsdom')
let React, ReactDOMClient, act

/** Minimal stand-ins for the shared primitives the page imports. */
function primitives() {
  const h = React.createElement
  return {
    Button: ({ children, variant: _v, size: _s, ...rest }) => h('button', rest, children),
    Input: props => h('input', props),
    Tag: ({ children, tone }) => h('span', { 'data-tone': tone }, children),
  }
}

/** Load the shipped bundle and capture the row it registers with the module loader. */
function loadPlugin() {
  let registered
  window.__ModuleLoader__ = { load: (row) => { registered = row } }
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(new URL('../plugin/lib/client.js', import.meta.url), 'utf8'))()
  const modules = { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), '@deepseek-ai/dsh-client-ui-primitives': primitives() }
  const exports = registered.factory(id => modules[id] ?? {})
  return { id: registered.id, exports }
}

/** Run apply() with stand-in slots/locale and return the registered component and inject face. */
function register(exports, bridge) {
  // In Electron globalThis is the window; under Node they differ, so set the one the bundle reads.
  globalThis.dshRemote = bridge
  let section
  const effects = []
  const ctx = {
    effect: (fn) => { effects.push(fn()) },
    locale: { register: () => () => {}, bind: () => t },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => { section = { options, component }; return () => {} },
    },
  }
  exports.apply(ctx)
  return { section, dispose: () => { for (const d of effects) if (typeof d === 'function') d() } }
}

function t(key, values = {}) { return `${key}${Object.keys(values).length ? ':' + Object.values(values).join('|') : ''}` }

async function mount(component, props) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const r = ReactDOMClient.createRoot(root)
  await act(async () => { r.render(React.createElement(component, props)) })
  return { root, unmount: () => act(async () => { r.unmount() }) }
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const click = async (el) => { await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }); await settle() }
const button = (root, label) => [...root.querySelectorAll('button')].find(b => b.textContent === label)

const HOSTS = { activeHostId: 'a', hosts: [
  { id: 'a', name: 'A', sshHost: 'a', localPort: 43080 },
  { id: 'b', name: 'B', sshHost: 'b', localPort: 43081 },
] }
const NOT_READY = { hostname: 'b', os: 'Linux', node: 'v22', dsh: '', dshTui: false, unit: 'inactive', plugin: false, ready: false }
const READY = { ...NOT_READY, dsh: '0.2.2', dshTui: true, unit: 'active', plugin: true, ready: true }

function fakeBridge(overrides = {}) {
  return {
    version: 1,
    list: async () => HOSTS,
    probe: async id => (id === 'a' ? READY : NOT_READY),
    setup: async () => ({ output: '' }),
    add: async () => HOSTS, remove: async () => HOSTS, switchTo: async () => {}, pickSshAlias: async () => null,
    ...overrides,
  }
}

before(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true })
  // Node 22 defines a read-only global navigator; React only needs window and document.
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })
  React = require('react')
  ReactDOMClient = require('react-dom/client')
  act = React.act
})

test('bundle registers one settings.section with plain data and callbacks', () => {
  const { id, exports } = loadPlugin()
  assert.equal(id, 'dsh-remote-servers')
  assert.deepEqual(Object.keys(exports).sort(), ['apply', 'inject', 'name'])
  const { section } = register(exports, fakeBridge())
  assert.equal(section.options.name, 'settings.section')
  assert.equal(section.options.id, 'remote-servers')
  const face = section.options.inject()
  assert.equal(face.managed, true)
  assert.equal(typeof face.actions.setup, 'function')
  assert.equal(face.actions === globalThis.dshRemote, false)
})

test('without the desktop bridge the page shows the browser notice only', async () => {
  const { exports } = loadPlugin()
  const { section } = register(exports, undefined)
  const { root, unmount } = await mount(section.component, { ...section.options.inject(), t })
  assert.match(root.textContent, /browserOnly/u)
  assert.equal(root.querySelector('button'), null)
  await unmount()
})

test('setup reports done only when the follow-up check is ready', async () => {
  for (const [after, expectDone] of [[READY, true], [NOT_READY, false], ['reject', false]]) {
    let calls = 0
    const bridge = fakeBridge({
      probe: async (id) => {
        if (id === 'a') return READY
        calls++
        if (calls === 1) return NOT_READY
        if (after === 'reject') throw new Error('probe failed')
        return after
      },
    })
    const { exports } = loadPlugin()
    const { section } = register(exports, bridge)
    const { root, unmount } = await mount(section.component, { ...section.options.inject(), t })
    await settle()
    await click(button(root, 'setup'))
    await settle()
    assert.equal(root.textContent.includes('setupDone'), expectDone, `after=${JSON.stringify(after?.ready ?? after)}`)
    if (!expectDone) assert.ok(button(root, 'setup') || root.textContent.includes('failed'), 'recovery stays visible')
    await unmount()
  }
})

test('a failed list shows Retry, and Retry loads the servers', async () => {
  let attempts = 0
  const bridge = fakeBridge({ list: async () => { attempts++; if (attempts === 1) throw new Error('offline'); return HOSTS } })
  const { exports } = loadPlugin()
  const { section } = register(exports, bridge)
  const { root, unmount } = await mount(section.component, { ...section.options.inject(), t })
  await settle()
  assert.match(root.textContent, /failed:offline/u)
  await click(button(root, 'retry'))
  await settle()
  assert.match(root.textContent, /A/u)
  assert.doesNotMatch(root.textContent, /failed:offline/u)
  await unmount()
})

test('a cancelled native confirmation is not reported as a failure', async () => {
  const bridge = fakeBridge({ switchTo: async () => { throw new Error("Error invoking remote method 'dsh-remote:switch': Error: cancelled") } })
  const { exports } = loadPlugin()
  const { section } = register(exports, bridge)
  const { root, unmount } = await mount(section.component, { ...section.options.inject(), t })
  await settle()
  await click(button(root, 'switch'))
  assert.doesNotMatch(root.textContent, /failed:/u)
  await unmount()
})

test('unmounting while requests are pending does not throw or warn', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const bridge = fakeBridge({ list: () => pending })
  const errors = []
  const original = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    const { exports } = loadPlugin()
    const { section, dispose } = register(exports, bridge)
    const { unmount } = await mount(section.component, { ...section.options.inject(), t })
    await unmount()
    dispose()
    release(HOSTS)
    await settle()
  } finally { console.error = original }
  assert.deepEqual(errors, [])
})
