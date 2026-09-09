import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KanbanCard, ProjectRecord } from '@/types'
import { KANBAN_UNASSIGNED } from '@/types'

/**
 * Aggregated board projection across ALL registered projects: kanban:list per
 * project, merged into one card list. Cards carry their projectPath (stamped
 * by main), which is the filter key and the routing target for every card op.
 *
 * kanban:changed names the project — a push refreshes just that project's
 * slice, including projects that had not been fetched yet (a background
 * worker report materializes its board on the fly).
 */
export function useAllKanbanBoards(projects: ProjectRecord[]) {
  const [byProject, setByProject] = useState<Record<string, KanbanCard[]>>({})
  const [error, setError] = useState<string | null>(null)
  // Stable dependency: re-aggregate only when the project SET changes, not on
  // every projects-list refresh (same members → same key → same callback).
  const projectsKey = useMemo(() => projects.map((p) => p.path).join('\n'), [projects])

  const refreshProject = useCallback(async (projectPath: string) => {
    try {
      const board = await window.pi.kanban.list(projectPath)
      setByProject((prev) => ({ ...prev, [projectPath]: board.cards }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const refreshAll = useCallback(async () => {
    const paths = [...projectsKey.split('\n').filter(Boolean), KANBAN_UNASSIGNED]
    const results = await Promise.allSettled(
      paths.map(async (path) => [path, (await window.pi.kanban.list(path)).cards] as const),
    )
    const merged: Record<string, KanbanCard[]> = {}
    let firstError: string | null = null
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'fulfilled') merged[paths[i]] = result.value[1]
      else if (!firstError) firstError = result.reason instanceof Error ? result.reason.message : String(result.reason)
    }
    // A project that vanished from the registry must not linger on the board.
    setByProject(merged)
    setError(firstError)
  }, [projectsKey])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    return window.pi.kanban.onChanged((e) => {
      void refreshProject(e.projectPath)
    })
  }, [refreshProject])

  // Registered projects in registry order, unassigned cards appended.
  const allCards = useMemo(() => {
    const cards = projectsKey.split('\n').filter(Boolean).flatMap((path) => byProject[path] ?? [])
    return [...cards, ...(byProject[KANBAN_UNASSIGNED] ?? [])]
  }, [projectsKey, byProject])

  return { allCards, error, refreshProject }
}
