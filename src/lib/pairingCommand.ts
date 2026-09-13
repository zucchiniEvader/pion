// Shared by main's pairing response and the UI's editable host preview.
// Install native dependencies on the remote, beside the downloaded daemon.
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function buildPairingCommand(host: string, port: number, token: string): string {
  const endpoint = `${host}:${port}`
  return [
    'mkdir -p "$HOME/.pion/bin"',
    `curl -fsSL ${quote(`http://${endpoint}/pion-daemon.cjs`)} -o "$HOME/.pion/bin/pion-daemon.cjs"`,
    'npm install --prefix "$HOME/.pion" --no-save --package-lock=false --no-fund --no-audit node-pty@1.1.0',
    `node "$HOME/.pion/bin/pion-daemon.cjs" --user-data "$HOME/.pion" --connect ${quote(endpoint)} --token ${quote(token)}`,
  ].join(' && ')
}
