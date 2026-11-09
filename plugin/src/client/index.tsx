/**
 * dsh-remote-servers, browser half: a "Remote servers" page in DSH Settings.
 *
 * The page lists the SSH hosts that run a dsh server, shows which one this window is showing,
 * and lets the user add, check, set up, switch to, and remove hosts. The hosts live in the
 * desktop client (DeepSeek Harness Remote.app); this page reaches them through the client's
 * preload bridge `window.dshRemote`. Without that bridge (a plain browser tab) the page explains
 * that remote servers are managed from the desktop client.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { RemoteServersSection } from './RemoteServersSection.tsx'
import { dictionaries, type RemoteServersKey } from './locales.ts'
import type { RemoteBridge, RemoteServersActions } from './bridge.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.remoteServers': RemoteServersKey }
}

/** Plugin identity. */
export const name = 'dsh-remote-servers'
/** Services the page reads. */
export const inject = ['slots', 'locale']

/**
 * Register the Remote servers settings page.
 * @param ctx - client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('settings.remoteServers', dictionaries), 'remote servers: dictionaries')
  const t = ctx.locale.bind('settings.remoteServers')
  const bridge = (globalThis as { dshRemote?: RemoteBridge }).dshRemote
  // Components receive plain callbacks; the bridge object itself stays in this apply closure.
  const actions: RemoteServersActions | undefined = bridge === undefined ? undefined : {
    list: () => bridge.list(),
    add: draft => bridge.add(draft),
    remove: id => bridge.remove(id),
    probe: id => bridge.probe(id),
    setup: id => bridge.setup(id),
    switchTo: id => bridge.switchTo(id),
    pickSshAlias: () => bridge.pickSshAlias(),
  }
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-servers',
    order: 15,
    label: () => t('nav'),
    locale: 'settings.remoteServers',
    inject: () => ({ managed: actions !== undefined, actions }),
  }, RemoteServersSection)), 'remote servers: settings page')
}
