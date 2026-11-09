/** Types of the `window.dshRemote` bridge the desktop client's preload exposes. */

/** One SSH host that runs (or will run) a dsh server. */
export interface RemoteHost {
  readonly id: string
  readonly name: string
  readonly sshHost: string
  readonly localPort: number
  readonly serverLog: string
  readonly serverUnit: string
  readonly serverPort: number
}

/** Stored settings: all hosts and the one this window shows. */
export interface RemoteConfig {
  readonly activeHostId: string
  readonly hosts: readonly RemoteHost[]
}

/** What a server check found on a host. */
export interface RemoteProbe {
  readonly hostname: string
  readonly os: string
  readonly node: string
  readonly dsh: string
  readonly dshTui: boolean
  readonly unit: string
  /** The server profile includes this page's bundle. */
  readonly plugin: boolean
  readonly ready: boolean
}

/** Fields the add form submits; the client derives id and local port. */
export interface RemoteHostDraft {
  readonly name: string
  readonly sshHost: string
}

/** Per-action callbacks the page receives through its inject face. */
export type RemoteServersActions = Omit<RemoteBridge, 'version'>

/** Operations implemented by the desktop client's main process. */
export interface RemoteBridge {
  readonly version: 1
  list(): Promise<RemoteConfig>
  add(draft: RemoteHostDraft): Promise<RemoteConfig>
  remove(id: string): Promise<RemoteConfig>
  probe(id: string): Promise<RemoteProbe>
  setup(id: string): Promise<{ readonly output: string }>
  switchTo(id: string): Promise<void>
  /** Shows a native menu of ~/.ssh/config aliases; resolves to the chosen alias or null. */
  pickSshAlias(): Promise<string | null>
}
