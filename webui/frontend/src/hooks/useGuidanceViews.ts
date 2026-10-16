import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { describeApiError } from '../lib/apiError'
import type { GuidanceReport } from '../lib/heightGuidance'

const png = (b64: string | null | undefined) => (b64 ? `data:image/png;base64,${b64}` : null)

/** The inputs a guidance view depends on (picture, guidance, regions,
 * filaments, print), to tell when one is out of date. */
function useGuidanceInputs(): string {
  const settings = useAppStore((s) => s.settings)
  const activeKey = useAppStore((s) => s.activeFilaments.map((f) => `${f.uuid}:${f.color}:${f.td}`).join('|'))
  return JSON.stringify({
    image: settings.input_image,
    guidance: settings.height_guidance,
    regions: settings.height_regions,
    layers: settings.max_layers,
    layerHeight: settings.layer_height,
    size: settings.stl_output_size,
    bg: settings.background_color,
    autoBg: settings.auto_background_color,
    limits: [settings.max_colors, settings.max_swaps],
    activeKey,
  })
}

async function post(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(useAppStore.getState().settings),
    signal,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(describeApiError(data, response.status))
  return data
}

export interface TargetsState {
  status: 'idle' | 'working' | 'ready' | 'error'
  /** Where the guidance pulls each part of the picture (relief); null when
   * nothing pulls pixels (only pins / order). */
  image: string | null
  error: string | null
}

/** The targets view, refreshed (debounced) while `enabled`. */
export function useGuidanceTargets(enabled: boolean): TargetsState {
  const inputs = useGuidanceInputs()
  const image = useAppStore((s) => s.settings.input_image)
  const [state, setState] = useState<TargetsState>({ status: 'idle', image: null, error: null })
  const key = enabled && image ? inputs : null

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    setState((s) => ({ ...s, status: 'working', error: null }))
    const timer = setTimeout(async () => {
      try {
        const data = await post('/api/guidance/targets', controller.signal)
        setState({ status: 'ready', image: png(data.target), error: null })
      } catch (e) {
        if (!controller.signal.aborted) setState((s) => ({ ...s, status: 'error', error: e instanceof Error ? e.message : String(e) }))
      }
    }, 350)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key])

  return state
}

export interface QuickPreview {
  /** The run's heights as a shaded relief, its colors, and where it
   * follows the targets (null without pixel targets). */
  relief: string
  colors: string
  followed: string | null
  /** Share (0–1) of the guided picture within reach of its target. */
  share: number | null
  report: GuidanceReport | null
  seconds: number
  meshUrl: string | null
}

export interface QuickPreviewState {
  status: 'idle' | 'working' | 'ready' | 'error'
  preview: QuickPreview | null
  /** The inputs changed since this preview was made. */
  stale: boolean
  error: string | null
  run: () => void
}

/** A small real run with the current guidance, on request. */
export function useQuickPreview(): QuickPreviewState {
  const inputs = useGuidanceInputs()
  const [state, setState] = useState<Omit<QuickPreviewState, 'run' | 'stale'> & { inputs: string | null }>({
    status: 'idle', preview: null, error: null, inputs: null,
  })
  const inputsRef = useRef(inputs)
  inputsRef.current = inputs
  // A new picture: the old preview belongs to another image.
  const image = useAppStore((s) => s.settings.input_image)
  useEffect(() => setState({ status: 'idle', preview: null, error: null, inputs: null }), [image])

  const run = useCallback(async () => {
    const madeFor = inputsRef.current
    setState((s) => ({ ...s, status: 'working', error: null }))
    try {
      const data = await post('/api/guidance/quick-preview')
      setState({
        status: 'ready',
        error: null,
        inputs: madeFor,
        preview: {
          relief: png(data.relief)!,
          colors: png(data.colors)!,
          followed: png(data.followed),
          share: data.share ?? null,
          report: data.report ?? null,
          seconds: data.seconds,
          meshUrl: data.mesh_url ?? null,
        },
      })
    } catch (e) {
      setState((s) => ({ ...s, status: 'error', error: e instanceof Error ? e.message : String(e) }))
    }
  }, [])

  const stale = !!state.preview && state.inputs !== inputs
  // The 3D view shows the preview's mesh (see Preview3DPanel).
  const setMesh = useAppStore((s) => s.setHeightsPreviewMesh)
  const meshUrl = state.preview?.meshUrl ?? null
  useEffect(() => setMesh(meshUrl ? { url: meshUrl, stale } : null), [meshUrl, stale, setMesh])

  return { status: state.status, preview: state.preview, error: state.error, stale, run }
}

export interface FollowedState {
  status: 'idle' | 'working' | 'ready' | 'error'
  followed: string | null
  relief: string | null
  share: number | null
  error: string | null
}

/** How the finished result `jobId` follows the guidance asked for now
 * (fetched while `enabled`). */
export function useResultFollowed(jobId: string | null, enabled: boolean): FollowedState {
  const inputs = useGuidanceInputs()
  const [state, setState] = useState<FollowedState>({ status: 'idle', followed: null, relief: null, share: null, error: null })
  const key = enabled && jobId ? `${jobId}|${inputs}` : null

  useEffect(() => {
    if (!key || !jobId) return
    const controller = new AbortController()
    setState((s) => ({ ...s, status: 'working', error: null }))
    const timer = setTimeout(async () => {
      try {
        const data = await post(`/api/guidance/followed/${encodeURIComponent(jobId)}`, controller.signal)
        setState({ status: 'ready', followed: png(data.followed), relief: png(data.relief), share: data.share ?? null, error: null })
      } catch (e) {
        if (!controller.signal.aborted) setState((s) => ({ ...s, status: 'error', error: e instanceof Error ? e.message : String(e) }))
      }
    }, 350)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, jobId])

  return state
}
