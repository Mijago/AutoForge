import type { JobStatus } from '../types'
import type { PruningCounts } from './pruning'

/** Whether a status report may replace the job currently on screen.
 *
 * Status reports arrive asynchronously (socket messages, polls, refreshes);
 * one that resolves after the UI moved on to another job used to replace
 * that job with the old one — and, for a completed old job, re-run its
 * "Optimization completed" side effects (snapshot, automatic prune). Only a
 * report for the job being shown (or one when nothing is shown) is applied;
 * switching to a different job is done explicitly, never by a report. */
export function acceptsStatusFor(current: Pick<JobStatus, 'job_id'> | null, incoming: Pick<JobStatus, 'job_id'> | null): boolean {
  if (!incoming || !current) return true
  return incoming.job_id === current.job_id
}

/** Whether a status update is the job's transition into "failed" — the
 * moment to tell the user, whichever channel (socket or poll) delivered it. */
export function isFailureTransition(previousStatus: string | undefined, job: Pick<JobStatus, 'status'> | null): boolean {
  return !!job && job.status === 'failed' && previousStatus !== 'failed'
}

/** The counts the automatic first prune keeps: the finished result's own
 * counts as the server reports them (result_colors / result_swaps /
 * result_layers) — the color sliders at that moment still show the last
 * training preview, from before the final base and limit searches changed
 * the stack. ``fallback`` (the slider plan's counts) only when the server
 * sent none. */
export function finishedResultCounts(
  job: Pick<JobStatus, 'result_colors' | 'result_swaps' | 'result_layers'>,
  fallback: PruningCounts,
): PruningCounts {
  const { result_colors: colors, result_swaps: swaps, result_layers: layers } = job
  if (typeof colors === 'number' && typeof swaps === 'number' && typeof layers === 'number') {
    return { colors, swaps, layers }
  }
  return fallback
}

export const PRUNING_POLL_MAX_NETWORK_ERRORS = 30

/** What the pruning poll does with one response: keep polling, or stop
 * because the job ended or can't be followed any more (the server forgot it
 * — a restart — or has been unreachable for a long stretch). */
export function pruningPollStep(
  response: { status: number; jobStatus?: string } | null,
  consecutiveNetworkErrors: number,
): 'continue' | 'done' | 'lost' {
  if (response === null) {
    return consecutiveNetworkErrors >= PRUNING_POLL_MAX_NETWORK_ERRORS ? 'lost' : 'continue'
  }
  if (response.status === 404) return 'lost'
  if (response.jobStatus && ['completed', 'failed', 'cancelled'].includes(response.jobStatus)) return 'done'
  return 'continue'
}

const INIT_JOB_SENTINEL = '__init__'

/** Whether a finished prune may become the current job: only while the
 * result it started from is still the one on screen. Undoing (or jumping in
 * History) during a prune used to be overridden when the prune finished.
 * A prune of the auto-preview (`__init__`) started with no result on screen,
 * so it is adopted while there still is none, for the same image. */
export function adoptsPrunedResult(
  currentJobId: string | undefined | null,
  sourceJobId: string,
  image?: { now: string | null | undefined; atStart: string | null | undefined },
): boolean {
  if (sourceJobId === INIT_JOB_SENTINEL) return !currentJobId && (!image || image.now === image.atStart)
  return currentJobId === sourceJobId
}

/** What a prune starts from: the finished result on screen, else the
 * auto-preview with the color layers painted onto it (a loaded project, or
 * an image colored by hand), else nothing. */
export function pruneSource(
  currentJob: Pick<JobStatus, 'job_id' | 'status'> | null,
  initStatus: string,
  sliders: { enabled: boolean; layer: number; filament_uuid: string }[],
): string | null {
  if (currentJob?.status === 'completed') return currentJob.job_id
  if (currentJob && ['pending', 'running', 'paused'].includes(currentJob.status)) return null
  if (initStatus !== 'ready') return null
  return sliders.some((s) => s.enabled && s.layer > 0 && !!s.filament_uuid) ? INIT_JOB_SENTINEL : null
}
