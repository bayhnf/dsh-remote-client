/**
 * Remote-client settings: the SSH hosts that run a dsh server and which one is active.
 *
 * Stored in remote.json under the app's userData. Edited from DSH Settings → Remote servers
 * (the dsh-remote-servers plugin, through the preload's dshRemote bridge) or by hand.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Values every host starts from; a host entry overrides any of them. */
export const HOST_DEFAULTS = Object.freeze({
  /** Server log holding the "dsh web: http://.../?token=..." launch line. */
  serverLog: '~/.dsh/logs/server-web.log',
  /** systemd --user unit that runs `dsh --profile server`. */
  serverUnit: 'dsh-server.service',
  /** Port `dsh web` listens on, used only when setting up a new server. */
  serverPort: 3080,
})

/** First local port; each host gets its own so browser storage never mixes between servers. */
export const FIRST_LOCAL_PORT = 43080

/**
 * Settings written on first launch: one placeholder host named after the SSH alias `dsh-server`.
 * Point that alias at your server in ~/.ssh/config, or edit the host in Settings → Remote servers.
 */
export const DEFAULT_CONFIG = Object.freeze({
  activeHostId: 'dsh-server',
  hosts: Object.freeze([Object.freeze({ id: 'dsh-server', name: 'dsh-server', sshHost: 'dsh-server', localPort: FIRST_LOCAL_PORT, ...HOST_DEFAULTS })]),
})

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u
const SSH_HOST = /^[A-Za-z0-9._][A-Za-z0-9._@:-]*$/u
const LOG_PATH = /^(~\/)?[A-Za-z0-9._/-]+$/u
const UNIT = /^[A-Za-z0-9@._-]+\.service$/u

const fail = (message) => { throw new Error(`remote.json: ${message}`) }
const isPort = (value, min) => Number.isInteger(value) && value >= min && value <= 65535

/**
 * Validate one host; every value reaches an ssh argv or a remote shell line.
 * @param {Record<string, unknown>} raw - host entry (missing optional keys take defaults).
 * @returns {Readonly<{id: string, name: string, sshHost: string, localPort: number, serverLog: string, serverUnit: string, serverPort: number}>} validated host.
 */
export function resolveHost(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('each host must be an object')
  const host = { ...HOST_DEFAULTS, ...raw }
  const { id, sshHost, localPort, serverLog, serverUnit, serverPort } = host
  const name = typeof host.name === 'string' && host.name.trim() !== '' ? host.name.trim().slice(0, 60) : id
  if (typeof id !== 'string' || !ID.test(id)) fail(`invalid host id ${JSON.stringify(id)} (a-z, 0-9, -)`)
  if (typeof sshHost !== 'string' || !SSH_HOST.test(sshHost)) fail(`invalid sshHost ${JSON.stringify(sshHost)}`)
  if (!isPort(localPort, 1024)) fail(`${id}: localPort must be an integer 1024-65535`)
  if (typeof serverLog !== 'string' || !LOG_PATH.test(serverLog) || serverLog.includes('..')) fail(`${id}: invalid serverLog ${JSON.stringify(serverLog)}`)
  if (typeof serverUnit !== 'string' || !UNIT.test(serverUnit)) fail(`${id}: invalid serverUnit ${JSON.stringify(serverUnit)}`)
  if (!isPort(serverPort, 1)) fail(`${id}: serverPort must be an integer 1-65535`)
  return Object.freeze({ id, name, sshHost, localPort, serverLog, serverUnit, serverPort })
}

/**
 * Validate the whole document. Accepts the earlier single-host form ({ sshHost, localPort, ... }).
 * @param {Record<string, unknown>} raw - parsed remote.json.
 * @returns {Readonly<{activeHostId: string, hosts: readonly ReturnType<typeof resolveHost>[]}>} validated settings.
 */
export function resolveConfig(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('expected a JSON object')
  if (!Array.isArray(raw.hosts)) {
    const legacy = { name: raw.sshHost ?? 'dsh-server', localPort: FIRST_LOCAL_PORT, ...DEFAULT_CONFIG.hosts[0], ...raw }
    legacy.id = typeof legacy.sshHost === 'string' ? slug(legacy.sshHost) : legacy.id
    return resolveConfig({ activeHostId: legacy.id, hosts: [legacy] })
  }
  if (raw.hosts.length === 0) fail('at least one host is required')
  const hosts = raw.hosts.map(resolveHost)
  const ids = new Set()
  const ports = new Set()
  for (const host of hosts) {
    if (ids.has(host.id)) fail(`duplicate host id ${host.id}`)
    if (ports.has(host.localPort)) fail(`localPort ${host.localPort} is used by two hosts`)
    ids.add(host.id)
    ports.add(host.localPort)
  }
  const activeHostId = typeof raw.activeHostId === 'string' && ids.has(raw.activeHostId) ? raw.activeHostId : hosts[0].id
  return Object.freeze({ activeHostId, hosts: Object.freeze(hosts) })
}

/**
 * Turn an SSH destination or display name into a host id.
 * @param {string} text - any label.
 * @returns {string} id matching the host id rule.
 */
export function slug(text) {
  const value = String(text).toLowerCase().replace(/^[^@]*@/u, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40)
  return ID.test(value) ? value : 'host'
}

/**
 * Smallest local port at or above FIRST_LOCAL_PORT that no host uses.
 * @param {readonly { localPort: number }[]} hosts - current hosts.
 * @returns {number} free port.
 */
export function nextLocalPort(hosts) {
  const used = new Set(hosts.map(host => host.localPort))
  let port = FIRST_LOCAL_PORT
  while (used.has(port)) port++
  return port
}

/**
 * Read settings, creating the file with defaults on first launch.
 * @param {string} file - absolute path of remote.json.
 * @returns {Promise<ReturnType<typeof resolveConfig>>} validated settings.
 */
export async function loadConfig(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await saveConfig(file, DEFAULT_CONFIG)
    return DEFAULT_CONFIG
  }
  const config = resolveConfig(JSON.parse(text))
  if (!Array.isArray(JSON.parse(text).hosts)) await saveConfig(file, config)
  return config
}

/**
 * Validate and atomically replace remote.json.
 * @param {string} file - absolute path of remote.json.
 * @param {Record<string, unknown>} config - settings to store.
 * @returns {Promise<ReturnType<typeof resolveConfig>>} what was written.
 */
export async function saveConfig(file, config) {
  const valid = resolveConfig(config)
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, file)
  return valid
}
