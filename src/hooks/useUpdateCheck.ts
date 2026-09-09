import { useCallback, useEffect, useState } from 'react'
import type { UpdateCheckResult, UpdateProgressEvent } from '@/types'

/**
 * Pi + extensions upgrade availability (docs/version-check-contract.md).
 * The main process owns the check (24h cache, async at startup); this hook
 * pulls the cached result on mount and stays live via the push channel.
 * `runUpdate` triggers the explicit in-app `pi update --all --no-approve`;
 * its streamed progress surfaces through `progress`.
 */
export function useUpdateCheck() {
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [progress, setProgress] = useState<UpdateProgressEvent | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.pi.updates.result().then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => window.pi.updates.onChanged(setResult), [])
  useEffect(() => window.pi.updates.onProgress(setProgress), [])

  const recheck = useCallback(async () => {
    const fresh = await window.pi.updates.recheck()
    if (fresh) setResult(fresh)
  }, [])

  const runUpdate = useCallback(async () => {
    const res = await window.pi.updates.run()
    if (!res.started && res.error) setProgress({ running: false, done: true, error: res.error })
    return res
  }, [])

  return { result, recheck, progress, runUpdate }
}
