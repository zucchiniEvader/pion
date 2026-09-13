// fs.listFiles: project-relative file paths for the composer's @ file
// mention picker. `git ls-files` is the fast path (tracked + untracked,
// .gitignore-aware, one process call); non-repo projects get a shallow
// recursive walk that skips dependency/build dirs. Files only — no
// directory drill-down. (M3+: hosted by pion-daemon like git.ts.)
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { FsFileList } from '../src/types'
import { assertProjectDirectory, runGit } from './git'
import type { DaemonServer } from './server'

// ponytail: cap the wire payload; ranking then covers a path-ordered prefix
// of huge repos. Raise when a real repo outgrows it.
const MAX_FILES = 20_000
// Fallback walk only (repos rely on .gitignore via git instead).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'build', 'release', '.next', '.cache'])

async function listViaGit(projectPath: string): Promise<string[] | null> {
  try {
    const out = await runGit(projectPath, ['ls-files', '-c', '-o', '--exclude-standard', '-z'])
    return out.split('\0').filter(Boolean)
  } catch {
    return null // not a repo (or no git binary) → walk
  }
}

async function walk(dir: string, prefix: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_FILES) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (acc.length >= MAX_FILES) return
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), `${prefix}${entry.name}/`, acc)
    } else if (entry.isFile()) {
      acc.push(`${prefix}${entry.name}`)
    }
  }
}

export async function listProjectFiles(projectPath: string): Promise<FsFileList> {
  const fromGit = await listViaGit(projectPath)
  const files = fromGit ?? await (async () => {
    const acc: string[] = []
    await walk(projectPath, '', acc)
    return acc.sort()
  })()
  return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES }
}

export function registerFsMethods(server: DaemonServer): void {
  server.register('fs.listFiles', async (params) => {
    const { projectPath } = params as { projectPath: string }
    await assertProjectDirectory(projectPath)
    return listProjectFiles(projectPath)
  })
}
