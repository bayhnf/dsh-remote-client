/**
 * Minimal Host RPC over the tunnel, ported from the official app's welcome-backend.ts: only the
 * "is any model API key configured?" read that Desktop onboarding asks through dshOnboarding.
 */
import { randomUUID } from 'node:crypto'

const record = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Exchange the launch URL for the Host's authentication cookie (web-document.ts authenticateWebHost).
 * @param {string} launchUrl - http://127.0.0.1:<port>/?token=…
 * @returns {Promise<string>} Cookie header value.
 */
export async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
  const cookie = response.headers.get('set-cookie')
  await response.body?.cancel()
  if (response.status !== 303 || cookie === null) throw new Error('Host authentication failed')
  const end = cookie.indexOf(';')
  return end < 0 ? cookie : cookie.slice(0, end)
}

/**
 * @param {string} origin - tunnel origin.
 * @param {string} cookie - Host authentication cookie.
 * @returns {(method: string, args?: object) => Promise<unknown>} JSON RPC caller.
 */
export function hostRpc(origin, cookie) {
  return async (method, args = {}) => {
    const rpcId = randomUUID()
    const response = await fetch(new URL(`/api/${method}`, origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    if (!response.ok) throw new Error(`Host ${method} failed: HTTP ${response.status}`)
    const envelope = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) throw new Error(`Host ${method} failed`)
    return envelope.result.value
  }
}

/**
 * Whether any provider credential reference is configured (welcome-backend.ts read().hasApiKey).
 * @param {(method: string, args?: object) => Promise<unknown>} invoke - Host RPC caller.
 * @returns {Promise<boolean>} true when at least one referenced API key is present.
 */
export async function hasConfiguredApiKey(invoke) {
  const settings = await invoke('settings/describe')
  if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('missing settings namespaces')
  const namespaces = settings.namespaces
  const official = namespaces.find(item => record(item) && item.ns === 'llm-deepseek')
  const refs = record(official) && record(official.value) && typeof official.value.apiKeyEnv === 'string' ? [official.value.apiKeyEnv] : []
  const providers = await invoke('llm/listConfigurableProviders')
  if (!Array.isArray(providers)) throw new Error('invalid provider directory')
  for (const provider of providers) {
    if (!record(provider) || typeof provider.settingsNs !== 'string' || !Array.isArray(provider.settingsPath)) continue
    let value = namespaces.find(item => record(item) && item.ns === provider.settingsNs)?.value
    for (const key of provider.settingsPath) value = record(value) && typeof key === 'string' ? value[key] : undefined
    if (record(value) && typeof value.apiKeyEnv === 'string') refs.push(value.apiKeyEnv)
  }
  const unique = [...new Set(refs)]
  for (let offset = 0; offset < unique.length; offset += 64) {
    const batch = await invoke('credentials/describe', { refs: unique.slice(offset, offset + 64) })
    if (record(batch) && Object.values(batch).some(state => record(state) && state.configured === true)) return true
  }
  return false
}
