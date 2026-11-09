/** Host aliases from ~/.ssh/config, offered as suggestions in the add-server form. */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ALIAS = /^[A-Za-z0-9._-]+$/u

/**
 * Concrete `Host` names (no wildcards or negations) declared in an ssh config text.
 * @param {string} text - ssh_config content.
 * @returns {string[]} sorted unique aliases.
 */
export function parseSshAliases(text) {
  const aliases = new Set()
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*Host\s+(.+)$/iu)
    if (!match) continue
    for (const name of match[1].trim().split(/\s+/u)) if (ALIAS.test(name)) aliases.add(name)
  }
  return [...aliases].sort()
}

/** @returns {Promise<string[]>} aliases from ~/.ssh/config, or [] when it is absent. */
export async function readSshAliases() {
  try { return parseSshAliases(await readFile(join(homedir(), '.ssh', 'config'), 'utf8')) } catch { return [] }
}
