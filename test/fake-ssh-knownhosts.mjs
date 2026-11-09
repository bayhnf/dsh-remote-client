// What OpenSSH does with a KnownHostsCommand, for the fake ssh programs in the tests: expand the
// %-tokens for the final destination and run the command without a shell (argv split on spaces,
// as ssh does), once with %I=ORDER and once with %I=HOSTNAME and the host key. Real ssh output
// was checked against this on OpenSSH 9.6 (Linux) and 10.5 (macOS).
import { execFileSync } from 'node:child_process'

/**
 * @param {string[]} args - the ssh argument vector.
 * @param {{ user: string, host: string, port: number, keyType: string, key: string, fingerprint?: string }} target
 */
export function runKnownHostsCommand(args, target) {
  const option = args.find(arg => arg.startsWith('KnownHostsCommand='))
  if (option === undefined) return
  const template = option.slice('KnownHostsCommand='.length)
  for (const reason of ['ORDER', 'HOSTNAME']) {
    const tokens = {
      '%%': '%', '%I': reason, '%r': target.user, '%h': target.host, '%p': String(target.port),
      '%t': reason === 'ORDER' ? 'NONE' : target.keyType, '%f': reason === 'ORDER' ? 'NONE' : (target.fingerprint ?? 'SHA256:test'),
      '%K': reason === 'ORDER' ? 'NONE' : target.key,
    }
    // ssh splits the command on whitespace, honouring quotes, then expands tokens per argument.
    const argv = []
    const pattern = /'([^']*)'|"([^"]*)"|(\S+)/gu
    for (const match of template.matchAll(pattern)) argv.push(match[1] ?? match[2] ?? match[3])
    const expanded = argv.map(arg => arg.replace(/%[%IrhptfK]/gu, token => tokens[token]))
    execFileSync(expanded[0], expanded.slice(1), { stdio: 'ignore' })
  }
}
