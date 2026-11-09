/**
 * Browser storage per server.
 *
 * Each server gets its own persistent Electron session, named after the host entry and the
 * identity its SSH connection verified (host key and endpoint, see tunnel.js). One server's
 * cookie is therefore never sent to another: not after a switch, and not after an SSH alias or a
 * remote.json entry is pointed at a different machine.
 *
 * sessions.json remembers the last session each host used, so a window can open in it before the
 * connection is up; the connection still checks the identity before anything is loaded.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

const PREFIX = 'dsh-remote_'
/** In-memory session for a window that shows only status pages until its server is known. */
export const PENDING_PARTITION = 'dsh-remote-pending'

/**
 * @param {string} hostId - validated host id ([a-z0-9-], so `_` separates the parts).
 * @param {string} identity - verified server identity digest.
 * @returns {string} persistent partition name.
 */
export function partitionName(hostId, identity) {
  return `persist:${PREFIX}${hostId}_${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
}

/**
 * Whether a partition directory (as under userData/Partitions) belongs to a host id. Host ids
 * have no `_`, so one id's prefix never matches another's. Names from earlier versions belong
 * to no host: startup clears them all (staleNames).
 * @param {string} hostId - host id.
 * @param {string} name - directory name.
 * @returns {boolean} true for that host's storage.
 */
export function belongsTo(hostId, name) {
  return name.startsWith(`${PREFIX}${hostId}_`)
}

/**
 * Partition directories no current host can use: every name from earlier versions, and current
 * names of hosts that are no longer configured.
 * @param {readonly string[]} names - directory names under userData/Partitions.
 * @param {readonly string[]} hostIds - configured host ids.
 * @returns {string[]} names to clear.
 */
export function staleNames(names, hostIds) {
  return names.filter((name) => {
    if (name.startsWith('dsh-remote-') && name !== PENDING_PARTITION) return true
    const current = new RegExp(`^${PREFIX}([a-z0-9-]+)_[0-9a-f]{16}$`, 'u').exec(name)
    return current !== null && !hostIds.includes(current[1])
  })
}

/**
 * @param {string} userData - the app's userData directory.
 * @returns {Promise<string[]>} names of the partition directories on disk; [] only when there is
 *   no Partitions directory. Any other error rejects, so nothing is reported as cleared that was
 *   not looked at.
 */
export async function partitionDirs(userData) {
  try {
    return await readdir(join(userData, 'Partitions'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Read sessions.json; entries for unknown hosts or with a malformed name are dropped.
 * @param {string} file - absolute path of sessions.json.
 * @param {readonly string[]} hostIds - configured host ids.
 * @returns {Promise<Map<string, string>>} host id -> partition.
 */
export async function loadKnown(file, hostIds) {
  let raw
  try { raw = JSON.parse(await readFile(file, 'utf8')) } catch { return new Map() }
  const known = new Map()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return known
  for (const id of hostIds) {
    const value = raw[id]
    if (typeof value === 'string' && new RegExp(`^persist:${PREFIX}${id}_[0-9a-f]{16}$`, 'u').test(value)) known.set(id, value)
  }
  return known
}

let saveQueue = Promise.resolve()

/**
 * Atomically replace sessions.json (owner-only); saves run in the order requested.
 * @param {string} file - absolute path of sessions.json.
 * @param {ReadonlyMap<string, string>} known - host id -> partition.
 * @returns {Promise<void>} resolves once written.
 */
export function saveKnown(file, known) {
  const text = `${JSON.stringify(Object.fromEntries(known), null, 2)}\n`
  const run = saveQueue.then(async () => {
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, text, { mode: 0o600, flag: 'wx' })
      await rename(temp, file)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  })
  saveQueue = run.catch(() => undefined)
  return run
}
