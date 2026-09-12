// cron: scheduled prompts. The daemon owns the job store (<userData>/cron.json)
// and the tick loop; firing a job = startRuntime({ projectPath }) (new session,
// prewarm fast path included) + a `prompt` command. Jobs fire only while the
// daemon runs — after a restart each job resumes at its next occurrence, with
// no catch-up for runs missed while the app was closed (user decision: cron is
// an app-runtime feature, not launchd). The fired session surfaces in the UI
// through the ordinary sessions.changed watcher path — no new event channel.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CronCreateInput, CronJob } from '../src/types'
import type { DaemonServer } from './server'
import { commandRuntime, startRuntime } from './agent'
import { loadProjects } from './projects'
import { nextCronRun, parseCron } from './cron-schedule'

// ──────────────────────────────────────────────────────────────────────────
// Store + tick
// ──────────────────────────────────────────────────────────────────────────

const TICK_MS = 30_000

let jobs: CronJob[] = []
let storeFile = ''
const firing = new Set<string>()

async function save(): Promise<void> {
  await mkdir(dirname(storeFile), { recursive: true })
  await writeFile(storeFile, JSON.stringify(jobs, null, 2), { mode: 0o600 })
}

function reschedule(job: CronJob, fromMs: number): void {
  if (!job.enabled) {
    job.nextRunAt = undefined
    return
  }
  const next = nextCronRun(parseCron(job.schedule), fromMs)
  job.nextRunAt = next ? new Date(next).toISOString() : undefined
}

async function fire(job: CronJob): Promise<void> {
  if (firing.has(job.id)) return
  firing.add(job.id)
  try {
    const info = await startRuntime({ projectPath: job.projectPath })
    if (!info.sessionFile) throw new Error('err.cron.noSession')
    await commandRuntime(info.runtimeId, { type: 'prompt', message: job.prompt })
    job.lastRunAt = new Date().toISOString()
    job.lastSessionFile = info.sessionFile
    job.lastError = undefined
    console.log(`[cron] fired ${job.id} → ${info.sessionFile}`)
  } catch (e) {
    job.lastError = e instanceof Error ? e.message : String(e)
    console.log(`[cron] fire failed ${job.id}: ${job.lastError}`)
  } finally {
    firing.delete(job.id)
    // Re-anchor from NOW (not from the missed slot): a tick delayed past
    // several occurrences fires once, not once per occurrence.
    reschedule(job, Date.now())
    await save().catch(() => undefined)
  }
}

function tick(): void {
  const now = Date.now()
  for (const job of jobs) {
    if (job.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= now) void fire(job)
  }
}

function findJob(id: string): CronJob {
  const job = jobs.find((j) => j.id === id)
  if (!job) throw new Error('err.cron.jobMissing')
  return job
}

export function registerCronMethods(server: DaemonServer, userData: string): void {
  storeFile = join(userData, 'cron.json')
  // Load synchronously-at-boot asynchronously: methods below read `jobs`,
  // which stays empty until this resolves (same first-frames window every
  // other store has; the renderer hydrates after hello anyway).
  void readFile(storeFile, 'utf8')
    .then((raw) => {
      const parsed = JSON.parse(raw) as CronJob[]
      if (Array.isArray(parsed)) jobs = parsed.filter((j) => j && typeof j.id === 'string')
    })
    .catch(() => undefined)

  server.register('cron.list', async (params) => {
    const { projectPath } = params as { projectPath: string }
    return jobs.filter((j) => j.projectPath === projectPath)
  })

  server.register('cron.create', async (params): Promise<CronJob> => {
    const input = params as CronCreateInput
    const projects = await loadProjects()
    if (!projects.some((p) => p.path === input.projectPath)) throw new Error('err.cron.projectMissing')
    const schedule = parseCron(input.schedule) // throws err.cron.invalidSchedule
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt || prompt.length > 8192) throw new Error('err.cron.invalidPrompt')
    const job: CronJob = {
      id: 'cron_' + randomBytes(4).toString('hex'),
      projectPath: input.projectPath,
      schedule: input.schedule.trim().replace(/\s+/g, ' '),
      prompt,
      enabled: true,
      createdAt: new Date().toISOString(),
      ...(input.name?.trim() ? { name: input.name.trim().slice(0, 80) } : {}),
    }
    const next = nextCronRun(schedule, Date.now())
    job.nextRunAt = next ? new Date(next).toISOString() : undefined
    jobs.push(job)
    await save()
    return job
  })

  server.register('cron.remove', async (params) => {
    const { id } = params as { id: string }
    const before = jobs.length
    jobs = jobs.filter((j) => j.id !== id)
    if (jobs.length === before) throw new Error('err.cron.jobMissing')
    await save()
    return null
  })

  server.register('cron.setEnabled', async (params): Promise<CronJob> => {
    const { id, enabled } = params as { id: string; enabled: boolean }
    const job = findJob(id)
    job.enabled = enabled === true
    reschedule(job, Date.now())
    await save()
    return job
  })

  server.register('cron.runNow', async (params) => {
    const { id } = params as { id: string }
    await fire(findJob(id))
    return null
  })

  const timer = setInterval(tick, TICK_MS)
  timer.unref?.()
}
