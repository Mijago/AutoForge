export interface PruningCounts {
  colors: number
  swaps: number
  layers: number
}

/** Starting values for the pruning dialog: exactly what the result has now.
 *
 * The dialog used to pre-fill a reduction of its own (one color fewer, a
 * third fewer swaps). That made the numbers a suggestion the user hadn't
 * asked for — pressing Start accepted a target nobody chose, and there was
 * no way to tell what the result actually had without reading the "now"
 * labels. Starting from the current counts means the limits are a floor the
 * user raises or lowers deliberately; pruning still improves the result at
 * equal limits, because it also merges same-color bands and moves swaps.
 *
 * (The old fixed 100/100/75 defaults are a separate, still-fixed problem:
 * they were above any real result, so pruning with them changed nothing.) */
export function suggestPruningLimits(current: PruningCounts): PruningCounts {
  return {
    colors: Math.max(1, current.colors || 1),
    swaps: Math.max(0, current.swaps || 0),
    layers: Math.max(1, current.layers || 1),
  }
}

/** The counts the pruner limits. Max colors is the print's filaments, the
 * base included: the layer bands' filaments plus the base filament, counted
 * once when a band reuses it. A base that is no filament (a custom color, or
 * not known yet) is one color more. */
export function resultCounts(
  plan: { colors: number; colorKeys?: string[]; swaps: number; topLayer: number },
  baseFilamentUuid = '',
): PruningCounts {
  const colors =
    baseFilamentUuid && plan.colorKeys ? new Set([...plan.colorKeys, baseFilamentUuid]).size : plan.colors + 1
  return { colors, swaps: plan.swaps, layers: plan.topLayer }
}

/** The counts to show while pruning runs.
 *
 * The dialog's own numbers come from the color sliders, and those only
 * change when the backend pushes the finished stack — so they sat frozen at
 * the pre-pruning values for the whole run. The pruning job reports the live
 * counts of the solution it is working on; use those whenever they're
 * present, and fall back to the sliders before the first report arrives. */
export function liveCounts(
  fallback: PruningCounts,
  job: { result_colors?: number | null; result_swaps?: number | null; result_layers?: number | null } | null,
): PruningCounts {
  if (!job) return fallback
  const pick = (reported: number | null | undefined, current: number) =>
    typeof reported === 'number' && Number.isFinite(reported) ? reported : current
  return {
    colors: pick(job.result_colors, fallback.colors),
    swaps: pick(job.result_swaps, fallback.swaps),
    layers: pick(job.result_layers, fallback.layers),
  }
}

/** "26 → 12 colors, 25 → 11 swaps, 60 layers" — unchanged counts stay single. */
export function describePruningChange(before: PruningCounts, after: PruningCounts): string {
  const part = (key: keyof PruningCounts, noun: string) =>
    before[key] === after[key] ? `${after[key]} ${noun}` : `${before[key]} → ${after[key]} ${noun}`
  return [part('colors', 'colors'), part('swaps', 'swaps'), part('layers', 'layers')].join(', ')
}

/** A running prune's mesh after its latest step (api/pruning.py's
 * _on_prune_step): `forJob` is the result the prune started from,
 * `pruneJobId` the prune itself. */
export interface LiveMesh {
  forJob: string
  pruneJobId: string
  url: string
}

/** The live mesh to show instead of `currentJobId`'s own, if any: only while
 * that very prune is still running (or paused). Once it completes the
 * pruned result becomes the current job and its final mesh takes over; a
 * cancelled or failed prune is rolled back, so the original's mesh is
 * right again. */
export function liveMeshUrl(
  liveMesh: LiveMesh | null,
  currentJobId: string | undefined,
  pruningJob: { job_id: string; status: string } | null,
): string | null {
  if (!liveMesh || !currentJobId || !pruningJob) return null
  if (liveMesh.forJob !== currentJobId || liveMesh.pruneJobId !== pruningJob.job_id) return null
  if (!['pending', 'running', 'paused'].includes(pruningJob.status)) return null
  return liveMesh.url
}

/** Quality levels for automatic pruning. `maxLoss` is the loss the result may
 * not go over (the same number the dialog shows as "Difference from your
 * image"; lower is closer to the original). Keep in step with
 * helpers/auto_prune.py. */
export const AUTO_PRUNE_PRESETS = [
  {
    id: 'extremely_good',
    label: 'Extremely good',
    maxLoss: 10,
    help: 'Loss under 10. Practically indistinguishable from your image — only prunes what costs almost nothing, so expect a modest reduction.',
  },
  {
    id: 'very_good',
    label: 'Very good',
    maxLoss: 20,
    help: 'Loss under 20. A very faithful print with clearly fewer colors, swaps and layers.',
  },
  {
    id: 'good',
    label: 'Good',
    maxLoss: 30,
    help: 'Loss under 30. Faithful at a glance, with some fine detail and subtle color shifts traded away for a simpler print.',
  },
  {
    id: 'acceptable',
    label: 'Acceptable',
    maxLoss: 40,
    help: 'Loss under 40. Recognizably your image with visible simplification — the simplest print of the four.',
  },
] as const

export type AutoPrunePresetId = (typeof AUTO_PRUNE_PRESETS)[number]['id']

export const DEFAULT_AUTO_PRUNE_PRESET: AutoPrunePresetId = 'good'

/** Your own loss limit instead of a preset: any positive number. */
export const CUSTOM_PRUNE_LOSS_DEFAULT = 25
export const CUSTOM_PRUNE_LOSS_MIN = 1
export const CUSTOM_PRUNE_LOSS_MAX = 1000

export function autoPrunePreset(id: string) {
  return AUTO_PRUNE_PRESETS.find((p) => p.id === id) ?? AUTO_PRUNE_PRESETS[2]
}

/** What to tell the user once automatic pruning has finished, by the reason
 * the backend stopped (`auto_outcome`). */
export function describeAutoOutcome(outcome: string | null | undefined, targetLoss: number | null | undefined): string {
  const limit = typeof targetLoss === 'number' ? ` ${targetLoss}` : ''
  switch (outcome) {
    case 'start_above_limit':
      return `The result is already over the loss limit${limit}, so nothing was pruned. Pick a more relaxed level, or improve the result first.`
    case 'limit_reached':
      return `Stopped just before the loss limit${limit}: the next reduction would have gone over it, so the last pass under it was kept.`
    case 'nothing_left':
      return 'Nothing is left to reduce while staying within the loss limit.'
    case 'pass_limit':
      return 'Stopped at the pass limit; the last pass under the loss limit was kept.'
    default:
      return 'Automatic pruning finished.'
  }
}
