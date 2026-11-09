/** The Remote servers settings page: list, check, set up, switch and add SSH-hosted dsh servers. */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteBridge, RemoteConfig, RemoteHost, RemoteProbe } from './bridge.ts'
import css from './RemoteServersSection.module.css'

/** Values the plugin's inject face provides. */
export interface RemoteServersInjected {
  bridge: RemoteBridge | undefined
}

type Props = PropsRuntime<'settings.section'> & PropsLocale<'settings.remoteServers'> & InjectFace<RemoteServersInjected>

type HostStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly text: string }
  | { readonly kind: 'probe'; readonly probe: RemoteProbe }
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

const IDLE: HostStatus = { kind: 'idle' }
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Render the page.
 * @param props - section owner props, locale seat and the injected desktop bridge.
 * @returns the page element tree.
 */
export function RemoteServersSection({ bridge, t }: Props) {
  if (bridge === undefined) {
    return <section className={css.page}><Header t={t} /><p className={css.notice}>{t('browserOnly')}</p></section>
  }
  return <ManagedServers bridge={bridge} t={t} />
}

function Header({ t }: { t: Props['t'] }) {
  return <header className={css.header}>
    <h2 className={css.title}>{t('title')}</h2>
    <p className={css.description}>{t('description')}</p>
  </header>
}

function ManagedServers({ bridge, t }: { bridge: RemoteBridge; t: Props['t'] }) {
  const [config, setConfig] = useState<RemoteConfig | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<Readonly<Record<string, HostStatus>>>({})
  const setHostStatus = (id: string, next: HostStatus): void => { setStatus(current => ({ ...current, [id]: next })) }

  const probe = useCallback(async (id: string) => {
    setStatus(current => ({ ...current, [id]: { kind: 'busy', text: t('checking') } }))
    try {
      const report = await bridge.probe(id)
      setStatus(current => ({ ...current, [id]: { kind: 'probe', probe: report } }))
    } catch (error) {
      setStatus(current => ({ ...current, [id]: { kind: 'error', text: t('failed', { message: message(error) }) } }))
    }
  }, [bridge, t])

  useEffect(() => {
    let live = true
    bridge.list().then((value) => {
      if (!live) return
      setConfig(value)
      for (const host of value.hosts) void probe(host.id)
    }, (error: unknown) => { if (live) setLoadError(message(error)) })
    return () => { live = false }
  }, [bridge, probe])

  const run = async (id: string, busyText: string, action: () => Promise<RemoteConfig | void>, doneText?: string) => {
    setHostStatus(id, { kind: 'busy', text: busyText })
    try {
      const next = await action()
      if (next !== undefined) setConfig(next)
      if (doneText !== undefined) setHostStatus(id, { kind: 'done', text: doneText })
      else setHostStatus(id, IDLE)
    } catch (error) {
      setHostStatus(id, { kind: 'error', text: t('failed', { message: message(error) }) })
    }
  }

  if (loadError !== undefined) return <section className={css.page}><Header t={t} /><p role="alert" className={css.error}>{t('failed', { message: loadError })}</p></section>
  if (config === undefined) return <section className={css.page}><Header t={t} /></section>

  return <section className={css.page}>
    <Header t={t} />
    <ul className={css.list}>
      {config.hosts.map(host => <HostRow key={host.id} host={host} active={host.id === config.activeHostId}
        status={status[host.id] ?? IDLE} t={t}
        onCheck={() => { void probe(host.id) }}
        onSetup={() => { void run(host.id, t('settingUp'), async () => { await bridge.setup(host.id); await probe(host.id) }, t('setupDone')) }}
        onSwitch={() => { void run(host.id, t('checking'), () => bridge.switchTo(host.id)) }}
        onRemove={() => {
          if (!window.confirm(t('removeConfirm', { name: host.name }))) return
          void bridge.remove(host.id).then(setConfig, (error: unknown) => { setHostStatus(host.id, { kind: 'error', text: t('failed', { message: message(error) }) }) })
        }} />)}
    </ul>
    <AddServer bridge={bridge} t={t} onAdded={(next) => {
      setConfig(next)
      const added = next.hosts.at(-1)
      if (added !== undefined) void probe(added.id)
    }} />
  </section>
}

interface HostRowProps {
  host: RemoteHost
  active: boolean
  status: HostStatus
  t: Props['t']
  onCheck(): void
  onSetup(): void
  onSwitch(): void
  onRemove(): void
}

function HostRow({ host, active, status, t, onCheck, onSetup, onSwitch, onRemove }: HostRowProps) {
  const busy = status.kind === 'busy'
  const probe = status.kind === 'probe' ? status.probe : undefined
  return <li className={css.row} data-active={active || undefined}>
    <div className={css.identity}>
      <div className={css.nameLine}>
        <span className={css.name}>{host.name}</span>
        {active && <Tag tone="solid">{t('current')}</Tag>}
        {probe !== undefined && <Tag tone={probe.ready ? 'success' : 'neutral'}>{probe.ready ? t('ready') : t('notReady')}</Tag>}
      </div>
      <div className={css.meta}>{host.sshHost} · 127.0.0.1:{host.localPort}</div>
      {probe !== undefined && <div className={css.meta}>{t('details', {
        dsh: probe.dsh || '—', node: probe.node || '—', unit: probe.unit, tui: probe.dshTui ? t('yes') : t('no'), page: probe.plugin ? t('yes') : t('no'),
      })}</div>}
      {status.kind === 'busy' && <div className={css.progress} aria-live="polite">{status.text}</div>}
      {status.kind === 'done' && <div className={css.success} aria-live="polite">{status.text}</div>}
      {status.kind === 'error' && <div role="alert" className={css.error}>{status.text}</div>}
    </div>
    <div className={css.actions}>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onCheck}>{t('check')}</Button>
      {probe !== undefined && !probe.ready && <Button variant="outline" size="sm" disabled={busy} onClick={onSetup}>{t('setup')}</Button>}
      {!active && <Button variant="primary" size="sm" disabled={busy} onClick={onSwitch}>{t('switch')}</Button>}
      {!active && <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>{t('remove')}</Button>}
    </div>
  </li>
}

function AddServer({ bridge, t, onAdded }: { bridge: RemoteBridge; t: Props['t']; onAdded(next: RemoteConfig): void }) {
  const [name, setName] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [aliases, setAliases] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    bridge.sshConfigHosts().then((value) => { if (live) setAliases(value) }, () => { /* the alias list is a convenience only */ })
    return () => { live = false }
  }, [bridge])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (sshHost.trim() === '') return
    setBusy(true)
    setError(undefined)
    bridge.add({ name: name.trim() || sshHost.trim(), sshHost: sshHost.trim() }).then((next) => {
      setName('')
      setSshHost('')
      onAdded(next)
    }, (failure: unknown) => { setError(t('failed', { message: message(failure) })) }).finally(() => { setBusy(false) })
  }
  return <form className={css.add} onSubmit={submit}>
    <h3 className={css.addTitle}>{t('addTitle')}</h3>
    <p className={css.description}>{t('addHint')}</p>
    <div className={css.fields}>
      <label className={css.field}>
        <span className={css.label}>{t('sshHost')}</span>
        <Input value={sshHost} list="dsh-remote-ssh-aliases" placeholder="my-server, user@host" autoComplete="off" spellCheck={false}
          onChange={(event) => { setSshHost(event.currentTarget.value) }} />
        <datalist id="dsh-remote-ssh-aliases">{aliases.map(alias => <option key={alias} value={alias} />)}</datalist>
      </label>
      <label className={css.field}>
        <span className={css.label}>{t('name')}</span>
        <Input value={name} placeholder={sshHost || 'My server'} autoComplete="off" onChange={(event) => { setName(event.currentTarget.value) }} />
      </label>
      <Button type="submit" variant="primary" size="sm" disabled={busy || sshHost.trim() === ''}>{t('add')}</Button>
    </div>
    {error !== undefined && <div role="alert" className={css.error}>{error}</div>}
  </form>
}
