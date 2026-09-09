// Git integration for the session header: a branch/worktree overview and
// minimal worktree creation. One-shot `git` invocations only — no daemon,
// no shell, arguments passed as an array.
// (M2-3: hosted by pion-daemon — method registrations live at the bottom.)
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { access, constants as fsConstants, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import type { GitOverview } from '../src/types'
import { safeChildEnvironment } from './pi-rpc'
import { loadProjects } from './projects'
import type { DaemonServer } from './server'

const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_BUFFER = 1024 * 1024

// ──────────────────────────────────────────────────────────────────────────
// Executable discovery (mirrors detectPi in pi-rpc.ts)
// ──────────────────────────────────────────────────────────────────────────

let gitPathPromise: Promise<string | null> | null = null

function gitCandidates(): string[] {
  if (process.platform === 'win32') return []
  return ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
}

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function whichGit(): Promise<string | null> {
  const path = process.env.PATH ?? process.env.Path
  if (!path) return null
  for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    const candidate = join(dir, process.platform === 'win32' ? 'git.exe' : 'git')
    if (await canExecute(candidate)) return candidate
  }
  return null
}

function resolveGit(): Promise<string | null> {
  gitPathPromise ??= (async () => {
    for (const candidate of gitCandidates()) {
      if (await canExecute(candidate)) return candidate
    }
    return whichGit()
  })()
  return gitPathPromise
}

// ──────────────────────────────────────────────────────────────────────────
// One-shot execution
// ──────────────────────────────────────────────────────────────────────────

function runGit(cwd: string, args: string[]): Promise<string> {
  return resolveGit().then((exe) => {
    if (!exe) return Promise.reject(new Error('未找到 git 可执行文件。'))
    return new Promise((resolve, reject) => {
      execFile(
        exe,
        args,
        { cwd, shell: false, env: safeChildEnvironment(), windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
        (error, stdout, stderr) => {
          if (error) {
            const detail = stderr.trim().split('\n').pop() ?? error.message
            reject(new Error(detail || 'git 命令执行失败。'))
          } else {
            resolve(stdout)
          }
        },
      )
    })
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Overview: current branch + local branches with their worktree mapping
// ──────────────────────────────────────────────────────────────────────────

export async function gitOverview(projectPath: string): Promise<GitOverview> {
  try {
    await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { isRepo: false, currentBranch: null, branches: [] }
  }
  const [branch, refs] = await Promise.all([
    runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
    runGit(projectPath, ['for-each-ref', '--format=%(refname:short)%09%(worktreepath)', 'refs/heads']).catch(() => ''),
  ])
  const branches = refs
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const index = line.indexOf('\t')
      const name = index < 0 ? line : line.slice(0, index)
      const worktreePath = index < 0 ? '' : line.slice(index + 1).trim()
      return { name, worktreePath: worktreePath || null }
    })
  // A manually deleted worktree folder leaves a stale admin entry that git
  // still reports; drop those paths (and prune once) so the UI never offers
  // a broken "open worktree" action.
  let pruned = false
  for (const branch of branches) {
    if (!branch.worktreePath) continue
    const info = await stat(branch.worktreePath).catch(() => null)
    if (!info?.isDirectory()) {
      branch.worktreePath = null
      if (!pruned) {
        pruned = true
        await runGit(projectPath, ['worktree', 'prune']).catch(() => {})
      }
    }
  }
  return { isRepo: true, currentBranch: branch?.trim() || null, branches }
}

// ──────────────────────────────────────────────────────────────────────────
// Worktree creation
// ──────────────────────────────────────────────────────────────────────────

// Worktrees live under <repo>/.worktree/<branch> so they stay next to the
// project; ensureWorktreeIgnored keeps the folder out of git status.
export function worktreeTarget(projectPath: string, branch: string): string {
  const segment = branch.replaceAll('/', '-')
  return join(projectPath, '.worktree', segment)
}

// A worktree inside the repo shows up as an untracked directory. If nothing
// already ignores it (repo/local/global excludes), record it in the repo's
// local exclude file (.git/info/exclude) — unlike .gitignore that keeps the
// working tree itself clean. Best-effort: a read-only checkout still gets
// its worktree, just with the folder visible in git status.
async function ensureWorktreeIgnored(projectPath: string): Promise<void> {
  const ignored = await runGit(projectPath, ['check-ignore', '-q', '.worktree']).then(() => true).catch(() => false)
  if (ignored) return
  let gitDir = (await runGit(projectPath, ['rev-parse', '--git-dir'])).trim()
  if (!gitDir.startsWith('/')) gitDir = join(projectPath, gitDir)
  const exclude = join(gitDir, 'info', 'exclude')
  let content = ''
  try {
    content = await readFile(exclude, 'utf8')
  } catch {
    /* no exclude file yet */
  }
  if (/^\.worktree\/?\s*$/m.test(content)) return
  const separator = content && !content.endsWith('\n') ? '\n' : ''
  await mkdir(dirname(exclude), { recursive: true })
  await writeFile(exclude, `${content}${separator}.worktree/\n`, 'utf8')
}

export async function createWorktree(projectPath: string, branch: string): Promise<{ path: string }> {
  // Command-line safety first (a leading '-' would parse as a flag), then let
  // git apply its full refname rules.
  if (typeof branch !== 'string' || !branch.trim() || /^\s|-/.test(branch) || branch.includes('..')) {
    throw new Error('err.git.invalidBranch')
  }
  await runGit(projectPath, ['check-ref-format', '--branch', branch]).catch(() => {
    throw new Error(`err.git.invalidBranchName:${branch}`)
  })

  const overview = await gitOverview(projectPath)
  if (!overview.isRepo) throw new Error('err.git.notARepo')
  // Already checked out somewhere (including the main worktree): reuse it.
  const existing = overview.branches.find((b) => b.name === branch)
  if (existing?.worktreePath) return { path: existing.worktreePath }

  const target = worktreeTarget(projectPath, branch)
  await mkdir(dirname(target), { recursive: true })
  // Clear stale admin entries left by manually deleted worktree folders.
  await runGit(projectPath, ['worktree', 'prune']).catch(() => {})
  await runGit(projectPath, existing ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target])
  await ensureWorktreeIgnored(projectPath).catch(() => {})
  // Normalize like git does (macOS /tmp → /private/tmp) so repeated calls and
  // overview comparisons see the same string.
  return { path: await realpath(target) }
}

// ──────────────────────────────────────────────────────────────────────────
// Method registrations (M2-3)
// ──────────────────────────────────────────────────────────────────────────

// Git endpoints write to disk (worktree add), so unlike the read-only
// session listings they require the path to be a registered project that
// still exists on disk. Moved verbatim from Electron main; error texts are
// byte-identical (renderer i18n depends on them).
async function assertProjectDirectory(projectPath: string): Promise<void> {
  if (typeof projectPath !== 'string' || !projectPath) throw new Error('projectPath must be a non-empty string')
  const projects = await loadProjects()
  if (!projects.some((p) => p.path === projectPath)) throw new Error('Not a registered project.')
  const info = await stat(projectPath).catch(() => null)
  if (!info?.isDirectory()) throw new Error('Project directory no longer exists.')
}

export function registerGitMethods(server: DaemonServer): void {
  server.register('git.overview', async (params) => {
    const { projectPath } = params as { projectPath: string }
    await assertProjectDirectory(projectPath)
    return gitOverview(projectPath)
  })
  server.register('git.createWorktree', async (params) => {
    const { projectPath, branch } = params as { projectPath: string; branch: string }
    if (typeof branch !== 'string') throw new Error('branch must be a string')
    await assertProjectDirectory(projectPath)
    return createWorktree(projectPath, branch)
  })
}
