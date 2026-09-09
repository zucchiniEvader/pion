// Connect-info helpers shared by boot (pion:// log line + interactive QR)
// and the CLI (token/status/install output blocks). Pure presentation — no
// wire semantics here.
import { networkInterfaces, hostname } from 'node:os'
import { renderUnicodeCompact } from 'uqr'

/** The `pion://` link a phone-class client (iOS app) scans to add this
 * runtime: host + WS port + token in one payload. Contract shared with the
 * iOS PionLink parser — keep both sides in sync. */
export function pionLink(host: string, wsPort: number, token: string): string {
  const params = new URLSearchParams({ t: token })
  return `pion://${host}:${wsPort}?${params.toString()}`
}

/** LAN addresses for QR/command output (0.0.0.0 never is one). Virtual
 * adapters (utun/VPN/docker bridges) are excluded — they only ever produce
 * addresses peers cannot reach. hostname() first (mDNS may resolve), then
 * IPv4s. */
export function lanHosts(): string[] {
  const VIRTUAL = /^(utun|lo|docker|tun|tap|br-|veth|awdl|llw|bridge|vmnet)/
  const hosts: string[] = [hostname()]
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue
    for (const ni of list ?? []) {
      if (!ni.internal && ni.family === 'IPv4') hosts.push(ni.address)
    }
  }
  return hosts
}

/** Terminal QR block for a `pion://` link. Half-block unicode keeps it
 * scannable at typical terminal line heights. */
export function renderConnectQr(host: string, wsPort: number, token: string): string {
  return renderUnicodeCompact(pionLink(host, wsPort, token))
}
