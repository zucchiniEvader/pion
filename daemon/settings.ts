// Local pi credentials for the settings Providers section.
//
// Owns exactly one file: pi's credential store `~/.pi/agent/auth.json`
// (shape: `{ "<provider-id>": {"type":"api_key","key":"…"} | {"type":"oauth",…} }`).
// `models.json` is read (never written) to offer the user's custom providers
// as key targets.
//
// Why this lives on the daemon, not Electron main: goal.md §4 — after daemon
// ization every write into pi's config is the daemon's, otherwise main becomes
// a second writer (docs/settings-design.md §3.2 reaches the same conclusion
// for models.json writes). A remote runtime's credentials get written by that
// machine's daemon through these same methods.
//
// Secrets: a key travels renderer → main → daemon → auth.json and never comes
// back. Results carry ids and kinds only, never a value.
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DaemonServer } from './server'
import { DaemonRpcError } from './server'
import type { AuthProviderCandidate, AuthStateResult, ConfiguredAuthProvider } from '../src/types'

const AGENT_DIR = join(homedir(), '.pi', 'agent')
const AUTH_PATH = join(AGENT_DIR, 'auth.json')
const MODELS_PATH = join(AGENT_DIR, 'models.json')

const MAX_PROVIDER_ID = 100
const MAX_KEY = 4096

/** pi's built-in API-key providers (docs/providers.md "API Keys" table).
 * Static on purpose: it is the set `auth.json` entries are meaningful for, and
 * reading it out of pi's own code would mean importing pi's SDK. Providers
 * declared in the user's models.json are appended from that file. */
const PI_API_KEY_PROVIDERS: ReadonlyArray<{ id: string; name: string; env: string }> = [
  { id: 'anthropic', name: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  { id: 'ant-ling', name: 'Ant Ling', env: 'ANT_LING_API_KEY' },
  { id: 'azure-openai-responses', name: 'Azure OpenAI Responses', env: 'AZURE_OPENAI_API_KEY' },
  { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', env: 'DEEPSEEK_API_KEY' },
  { id: 'nvidia', name: 'NVIDIA NIM', env: 'NVIDIA_API_KEY' },
  { id: 'google', name: 'Google Gemini', env: 'GEMINI_API_KEY' },
  { id: 'amazon-bedrock', name: 'Amazon Bedrock', env: 'AWS_BEARER_TOKEN_BEDROCK' },
  { id: 'mistral', name: 'Mistral', env: 'MISTRAL_API_KEY' },
  { id: 'groq', name: 'Groq', env: 'GROQ_API_KEY' },
  { id: 'cerebras', name: 'Cerebras', env: 'CEREBRAS_API_KEY' },
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway', env: 'CLOUDFLARE_API_KEY' },
  { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', env: 'CLOUDFLARE_API_KEY' },
  { id: 'xai', name: 'xAI', env: 'XAI_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  { id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', env: 'AI_GATEWAY_API_KEY' },
  { id: 'zai', name: 'ZAI Coding Plan (Global)', env: 'ZAI_API_KEY' },
  { id: 'zai-coding-cn', name: 'ZAI Coding Plan (China)', env: 'ZAI_CODING_CN_API_KEY' },
  { id: 'opencode', name: 'OpenCode Zen', env: 'OPENCODE_API_KEY' },
  { id: 'opencode-go', name: 'OpenCode Go', env: 'OPENCODE_API_KEY' },
  { id: 'radius', name: 'Radius', env: 'RADIUS_API_KEY' },
  { id: 'huggingface', name: 'Hugging Face', env: 'HF_TOKEN' },
  { id: 'fireworks', name: 'Fireworks', env: 'FIREWORKS_API_KEY' },
  { id: 'together', name: 'Together AI', env: 'TOGETHER_API_KEY' },
  { id: 'baseten', name: 'Baseten', env: 'BASETEN_API_KEY' },
  { id: 'kimi-coding', name: 'Kimi For Coding', env: 'KIMI_API_KEY' },
  { id: 'minimax', name: 'MiniMax', env: 'MINIMAX_API_KEY' },
  { id: 'minimax-cn', name: 'MiniMax (China)', env: 'MINIMAX_CN_API_KEY' },
  { id: 'qwen-token-plan', name: 'Qwen Token Plan', env: 'QWEN_TOKEN_PLAN_API_KEY' },
  { id: 'qwen-token-plan-individual', name: 'Qwen Token Plan (Individual)', env: 'QWEN_TOKEN_PLAN_API_KEY' },
  { id: 'qwen-token-plan-cn', name: 'Qwen Token Plan (China)', env: 'QWEN_TOKEN_PLAN_CN_API_KEY' },
  { id: 'xiaomi', name: 'Xiaomi MiMo', env: 'XIAOMI_API_KEY' },
  { id: 'xiaomi-token-plan-cn', name: 'Xiaomi MiMo Token Plan (China)', env: 'XIAOMI_TOKEN_PLAN_CN_API_KEY' },
  { id: 'xiaomi-token-plan-ams', name: 'Xiaomi MiMo Token Plan (Amsterdam)', env: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY' },
  { id: 'xiaomi-token-plan-sgp', name: 'Xiaomi MiMo Token Plan (Singapore)', env: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY' },
]

type AuthFile = Record<string, unknown>

interface Credential {
  kind: 'api_key' | 'oauth'
  /** false for oauth (pi's /login owns refresh+rotation) and for entries whose
   * shape this module does not recognize — never overwrite what we can't read. */
  editable: boolean
}

function classify(value: unknown): Credential | null {
  if (typeof value !== 'object' || value === null) return null
  const type = (value as { type?: unknown }).type
  if (type === 'oauth') return { kind: 'oauth', editable: false }
  if (type === 'api_key') return { kind: 'api_key', editable: true }
  return { kind: 'api_key', editable: false } // unknown shape: show it, don't touch it
}

async function readAuthFile(): Promise<AuthFile> {
  let raw: string
  try {
    raw = await readFile(AUTH_PATH, 'utf8')
  } catch {
    return {} // no file yet: pi treats it as empty
  }
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Refuse to write over a file we cannot parse — a typo in an editor must
    // not cost the user every stored credential.
    throw new DaemonRpcError('bad_request', `${AUTH_PATH} is not valid JSON; fix it before saving a key`)
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as AuthFile) : {}
}

async function readCustomProviderIds(): Promise<string[]> {
  try {
    const data = JSON.parse(await readFile(MODELS_PATH, 'utf8')) as { providers?: Record<string, unknown> }
    return Object.keys(data.providers ?? {})
  } catch {
    return []
  }
}

function candidates(customIds: string[]): AuthProviderCandidate[] {
  const builtinIds = new Set(PI_API_KEY_PROVIDERS.map((p) => p.id))
  const list: AuthProviderCandidate[] = PI_API_KEY_PROVIDERS.map((p) => ({ id: p.id, name: p.name, env: p.env }))
  for (const id of customIds) {
    if (builtinIds.has(id)) continue
    list.push({ id, name: id, custom: true })
  }
  return list
}

async function authState(): Promise<AuthStateResult> {
  const [data, customIds] = await Promise.all([readAuthFile(), readCustomProviderIds()])
  const builtin = new Map(PI_API_KEY_PROVIDERS.map((p) => [p.id, p.name]))
  const configured: ConfiguredAuthProvider[] = []
  for (const [id, value] of Object.entries(data)) {
    const credential = classify(value)
    if (!credential) continue
    configured.push({ id, name: builtin.get(id) ?? id, kind: credential.kind, removable: credential.editable })
  }
  configured.sort((a, b) => a.id.localeCompare(b.id))
  return { configured, candidates: candidates(customIds) }
}

function assertProviderId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_PROVIDER_ID || /[\s/\\]/.test(value)) {
    throw new DaemonRpcError('bad_request', 'provider must be a provider id (non-empty, <=100 chars, no spaces or slashes)')
  }
  return value
}

const OAUTH_MESSAGE = (id: string): string =>
  `${id} is signed in with OAuth — pi's own /login owns that credential. Remove it there to switch to an API key.`

/** Serialized read-modify-write over auth.json. pi itself takes a
 * `proper-lockfile` lock at `<auth.json>.lock` while it refreshes OAuth
 * tokens, so wait that out first; we do not take the lock ourselves.
 * ponytail: last-writer-wins if pi writes in the window after our wait; take
 * the same lock (mkdir) if that race ever bites. */
async function writeAuthFile(next: AuthFile): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await stat(`${AUTH_PATH}.lock`)
    } catch {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  // tmp+rename in the same directory: a crash mid-write cannot truncate pi's
  // credentials. Mode applies on creation only, like pi's own writer (0600).
  const tmp = `${AUTH_PATH}.pion-tmp`
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, AUTH_PATH)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

export function registerSettingsMethods(server: DaemonServer): void {
  server.register('settings.authState', () => authState())

  server.register('settings.authSetKey', async (params) => {
    const p = (params ?? {}) as { provider?: unknown; key?: unknown }
    const provider = assertProviderId(p.provider)
    if (typeof p.key !== 'string') throw new DaemonRpcError('bad_request', 'key must be a string')
    const key = p.key.trim()
    if (!key || key.length > MAX_KEY || /[\r\n]/.test(key)) {
      throw new DaemonRpcError('bad_request', `key must be a single line of 1–${MAX_KEY} characters`)
    }
    const data = await readAuthFile()
    const existing = classify(data[provider])
    if (existing && !existing.editable) throw new DaemonRpcError('bad_request', OAUTH_MESSAGE(provider))
    await writeAuthFile({ ...data, [provider]: { type: 'api_key', key } })
    return authState()
  })

  server.register('settings.authRemove', async (params) => {
    const provider = assertProviderId(((params ?? {}) as { provider?: unknown }).provider)
    const data = await readAuthFile()
    const existing = classify(data[provider])
    if (!existing) throw new DaemonRpcError('not_found', `no stored credential for ${provider}`)
    if (!existing.editable) throw new DaemonRpcError('bad_request', OAUTH_MESSAGE(provider))
    const next = { ...data }
    delete next[provider]
    await writeAuthFile(next)
    return authState()
  })
}
