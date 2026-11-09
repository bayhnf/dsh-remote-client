// Mounts the shipped Settings page (plugin/lib/client.js) with real React in jsdom. The bundle is
// loaded through a ModuleLoader stand-in and applied as a plugin of a real cordis Context, the
// framework DSH runs client plugins in; `slots` and `locale` are services that record what the
// plugin registers, so registration and disposal are observed as DSH would see them.
// Dependencies are this repository's devDependencies (`npm install`, then `npm test`).
// No server, SSH or Electron is involved.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const { Context } = await import('@deepseek-ai/cordis')
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

/**
 * Apply the bundle as a cordis plugin with recording `slots` and `locale` services.
 * @returns {Promise<{ section, registry, dispose: () => Promise<void> }>} the registered section,
 *   what is currently registered, and a disposer that unloads the plugin.
 */
async function register(exports, bridge) {
  // In Electron globalThis is the window; under Node they differ, so set the one the bundle reads.
  globalThis.dshRemote = bridge
  const registry = { sections: new Map(), dictionaries: new Map(), injections: 0 }
  const ctx = new Context()
  ctx.provide('slots', {
    inject: (name, fn) => {
      registry.injections++
      const dispose = fn()
      return () => { registry.injections--; dispose?.() }
    },
    register: (options, component) => {
      registry.sections.set(options.id, { options, component, slot: options.name })
      return () => { registry.sections.delete(options.id) }
    },
  })
  ctx.provide('locale', {
    register: (namespace, dictionaries) => { registry.dictionaries.set(namespace, dictionaries); return () => { registry.dictionaries.delete(namespace) } },
    bind: () => t,
  })
  const fiber = ctx.plugin({ name: exports.name, inject: exports.inject, apply: exports.apply })
  await fiber.await?.()
  return { section: registry.sections.get('remote-servers'), registry, dispose: () => fiber.dispose() }
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

test('bundle registers one settings.section with plain data and callbacks, and disposal removes it', async () => {
  const { id, exports } = loadPlugin()
  assert.equal(id, 'dsh-remote-servers')
  assert.deepEqual(Object.keys(exports).sort(), ['apply', 'inject', 'name'])
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  const { section, registry, dispose } = await register(exports, fakeBridge())
  assert.equal(section.slot, 'settings.section')
  assert.equal(section.options.id, 'remote-servers')
  assert.equal(section.options.locale, 'settings.remoteServers')
  assert.deepEqual([...registry.dictionaries.keys()], ['settings.remoteServers'])
  for (const language of ['en', 'id', 'zh']) assert.equal(typeof registry.dictionaries.get('settings.remoteServers')[language]?.nav, 'string', language)
  const face = section.options.inject()
  assert.equal(face.managed, true)
  assert.equal(typeof face.actions.setup, 'function')
  assert.equal(face.actions === globalThis.dshRemote, false)
  await dispose()
  assert.equal(registry.sections.size, 0, 'the page is unregistered')
  assert.equal(registry.dictionaries.size, 0, 'the dictionaries are unregistered')
  assert.equal(registry.injections, 0, 'the slot injection is released')
})

test('without the desktop bridge the page shows the browser notice only', async () => {
  const { exports } = loadPlugin()
  const { section } = await register(exports, undefined)
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
    const { section } = await register(exports, bridge)
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
  const { section } = await register(exports, bridge)
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
  const { section } = await register(exports, bridge)
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
    const { section, dispose } = await register(exports, bridge)
    const { unmount } = await mount(section.component, { ...section.options.inject(), t })
    await unmount()
    await dispose()
    release(HOSTS)
    await settle()
  } finally { console.error = original }
  assert.deepEqual(errors, [])
})
