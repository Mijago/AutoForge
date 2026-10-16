import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Check, Eraser, Loader2, Pipette, Pin, Play, Trash2, X } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { usePersistentState } from '../hooks/usePersistentState'
import { useGuidanceTargets, useQuickPreview, useResultFollowed } from '../hooks/useGuidanceViews'
import { HeightRegionsOverlay, useHeightRegions, type HeightTool } from './HeightRegions'
import {
  ORDER_HINTS,
  ORDER_LABELS,
  addColorPick,
  describeStrength,
  guidanceForSettings,
  normalizeGuidance,
  removeColorPick,
  removePin,
  sliderFromStrength,
  strengthFromSlider,
  summarizeReport,
  updateColorPick,
  type HeightGuidanceSettings,
  type HeightOrder,
} from '../lib/heightGuidance'

/** What the picture shows in Heights mode — all of it real: the picture,
 * what you asked for, a quick real run, and how a run follows the ask. */
export type HeightView = 'picture' | 'targets' | 'preview' | 'followed'

const VIEW_LABELS: Record<HeightView, string> = { picture: 'Picture', targets: 'Targets', preview: 'Preview', followed: 'Followed' }
const VIEW_HINTS: Record<HeightView, string> = {
  picture: 'The picture and your painted regions',
  targets: 'What you ask for: where depth, painted regions and picked colors pull each part (light = high, dark = low)',
  preview: 'The quick preview: a small real run with your suggestions — its print heights (light = high) or its colors',
  followed: 'Where the result keeps to your targets (green) and where it gives way to the colors (amber to red)',
}

/** The id of the finished result on screen (a prune's, once one finished). */
function useResultJobId(): string | null {
  return useAppStore((s) =>
    s.pruningJob?.status === 'completed' ? s.pruningJob.job_id : s.currentJob?.status === 'completed' ? s.currentJob.job_id : null,
  )
}

/** Everything Heights mode shares between the panel's toolbar, view and
 * controls: the guidance (one undo step per change), the painted regions,
 * the tools and the views. */
export function useHeightsMode(enabled: boolean) {
  const stored = useAppStore((s) => s.settings.height_guidance)
  const hasRegions = useAppStore((s) => !!s.settings.height_regions)
  const setHeightGuidance = useAppStore((s) => s.setHeightGuidance)
  const guidance = useMemo(() => normalizeGuidance(stored), [stored])
  const regions = useHeightRegions()
  const [tool, setTool] = useState<HeightTool>('raise')
  const [brushPercent, setBrushPercent] = usePersistentState<number>('autoforge-heights-brush-size', 8)
  const [view, setView] = usePersistentState<HeightView>('autoforge-heights-view', 'targets')
  const [opacity, setOpacity] = usePersistentState<number>('autoforge-heights-opacity', 80)
  const [previewColors, setPreviewColors] = useState(false)
  const targets = useGuidanceTargets(enabled)
  const quick = useQuickPreview()
  const resultJobId = useResultJobId()
  // The followed map of a quick preview that still matches the settings,
  // else of the finished result on screen.
  const useQuick = !!quick.preview && !quick.stale
  const result = useResultFollowed(resultJobId, enabled && view === 'followed' && !useQuick)

  const update = useCallback(
    (change: (g: HeightGuidanceSettings) => HeightGuidanceSettings, label: string) => {
      const current = normalizeGuidance(useAppStore.getState().settings.height_guidance)
      const hasRegionsNow = !!useAppStore.getState().settings.height_regions
      setHeightGuidance(guidanceForSettings(change(current), hasRegionsNow), label)
    },
    [setHeightGuidance],
  )

  return {
    guidance, hasRegions, regions, tool, setTool, brushPercent, setBrushPercent, view, setView, opacity, setOpacity,
    previewColors, setPreviewColors, targets, quick, result, useQuick, resultJobId, update,
  }
}

export type HeightsModeState = ReturnType<typeof useHeightsMode>

const segButton = (on: boolean) =>
  `flex items-center gap-1 px-2 py-0.5 whitespace-nowrap ${on ? 'bg-gray-600 text-gray-100' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/60'}`
const outlineButton = 'flex items-center gap-1 px-2 py-0.5 rounded text-xs text-gray-300 hover:bg-gray-700 border border-gray-600 whitespace-nowrap'

/** The panel header in Heights mode: brush tools, size, clear, done. */
export const HeightsToolbar: React.FC<{ mode: HeightsModeState; compact: boolean; onDone: () => void }> = ({ mode, compact, onDone }) => {
  const { tool, setTool, brushPercent, setBrushPercent, regions, hasRegions } = mode
  const tools: { id: HeightTool; label: string; title: string; icon: React.ReactNode }[] = [
    { id: 'raise', label: 'Raise', title: 'Paint parts that should come forward — higher in the print (R)', icon: <ArrowUp className="w-3.5 h-3.5 text-red-400" /> },
    { id: 'lower', label: 'Lower', title: 'Paint parts that should sit back — lower in the print (L)', icon: <ArrowDown className="w-3.5 h-3.5 text-blue-400" /> },
    { id: 'erase', label: 'Erase', title: 'Erase painted regions (E)', icon: <Eraser className="w-3.5 h-3.5" /> },
    { id: 'pick', label: 'Pick color', title: 'Click a color in the picture to raise or lower everything of that color (I)', icon: <Pipette className="w-3.5 h-3.5" /> },
  ]
  return (
    <div className="flex items-center gap-2 min-w-0" data-testid="heights-toolbar">
      <div className="flex rounded border border-gray-600 overflow-hidden text-xs" role="group" aria-label="Heights tool">
        {tools.map((t) => (
          <button key={t.id} onClick={() => setTool(t.id)} aria-pressed={tool === t.id} className={segButton(tool === t.id)} title={t.title} data-testid={`heights-tool-${t.id}`}>
            {t.icon}
            {!compact && t.label}
          </button>
        ))}
      </div>
      {tool !== 'pick' && (
        <label className="flex items-center gap-1.5 text-xs text-gray-400" title="Brush size ([ and ] keys)">
          Size
          <input type="range" min={1} max={25} value={brushPercent} onChange={(e) => setBrushPercent(Number(e.target.value))} className="w-16 accent-cyan-500" aria-label="Brush size" data-testid="heights-brush-size" />
        </label>
      )}
      <button
        onClick={regions.clear}
        disabled={regions.share.raise + regions.share.lower === 0 && !hasRegions}
        className={`${outlineButton} disabled:opacity-40 disabled:hover:bg-transparent`}
        title="Remove all painted regions"
        data-testid="heights-clear-regions"
      >
        <Trash2 className="w-3 h-3" />
        {!compact && 'Clear'}
      </button>
      <button onClick={onDone} className="flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white whitespace-nowrap" title="Finish (Esc)" data-testid="heights-done-btn">
        <Check className="w-3.5 h-3.5" />
        Done
      </button>
    </div>
  )
}

/** The overlay image the current view shows, and whether it has one. */
function viewImage(mode: HeightsModeState): string | null {
  const { view, targets, quick, result, useQuick, previewColors } = mode
  if (view === 'targets') return targets.image
  if (view === 'preview') return quick.preview ? (previewColors ? quick.preview.colors : quick.preview.relief) : null
  if (view === 'followed') return useQuick ? quick.preview?.followed ?? null : result.followed
  return null
}

/** The picture in Heights mode with the chosen view over it and the
 * painted regions; sits in the panel's zoomable, paintable viewport. */
export const HeightsImage: React.FC<{ mode: HeightsModeState; imageSrc: string; originalImg: React.ReactNode }> = ({ mode, imageSrc, originalImg }) => {
  const { view, opacity, regions, tool, brushPercent, update } = mode
  const src = viewImage(mode)
  const onPick = useCallback((hex: string) => update((g) => addColorPick(g, hex, 'raise'), `Raised the color ${hex}`), [update])
  // Heights and the followed map read better over a grey picture.
  const grey = !!src && view !== 'picture'
  return (
    <>
      <div className="absolute inset-0" style={grey ? { filter: 'grayscale(1) brightness(0.7)' } : undefined} data-testid="heights-picture" data-grey={grey || undefined}>
        {originalImg}
      </div>
      {src && (
        <img
          src={src}
          alt={`${VIEW_LABELS[view]} view`}
          draggable={false}
          className="absolute inset-0 w-full h-full object-contain select-none pointer-events-none [image-rendering:pixelated]"
          style={{ opacity: opacity / 100 }}
          data-testid="heights-view-overlay"
          data-view={view}
        />
      )}
      <HeightRegionsOverlay regions={regions} editing tool={tool} brushPercent={brushPercent} imageSrc={imageSrc} onPick={onPick} />
    </>
  )
}

/** One line on what the current view shows / where it stands. */
const ViewStatus: React.FC<{ mode: HeightsModeState }> = ({ mode }) => {
  const { view, targets, quick, result, useQuick, resultJobId, previewColors, setPreviewColors } = mode
  const busy = <Loader2 className="w-3 h-3 animate-spin" />
  if (view === 'targets') {
    if (targets.status === 'working' && !targets.image) return <span className="flex items-center gap-1">{busy} Working out the targets…</span>
    if (targets.status === 'error') return <span className="text-red-500">Targets failed: {targets.error}</span>
    return <span>{targets.image ? 'Light = pulled up, dark = pulled down, clear = free' : 'No part of the picture is pulled yet — follow the photo depth, paint, or pick colors'}</span>
  }
  if (view === 'preview') {
    if (!quick.preview) return <span>{quick.status === 'working' ? 'Running the quick preview…' : 'Press Quick preview for a small real run with your suggestions'}</span>
    return (
      <span className="flex items-center gap-2">
        <span className="flex rounded border border-gray-600 overflow-hidden" role="group" aria-label="Preview shows">
          <button onClick={() => setPreviewColors(false)} aria-pressed={!previewColors} className={segButton(!previewColors)} data-testid="heights-preview-relief">Heights</button>
          <button onClick={() => setPreviewColors(true)} aria-pressed={previewColors} className={segButton(previewColors)} data-testid="heights-preview-colors">Colors</button>
        </span>
        {quick.stale && <span className="text-amber-500" data-testid="heights-preview-stale">Suggestions changed — preview again</span>}
      </span>
    )
  }
  if (view === 'followed') {
    const share = useQuick ? quick.preview?.share : result.share
    const source = useQuick ? 'the quick preview' : resultJobId ? 'the last run' : null
    if (!source) return <span>Run, or make a quick preview, to see where the result follows your targets</span>
    if (!useQuick && result.status === 'working' && !result.followed) return <span className="flex items-center gap-1">{busy} Comparing…</span>
    if (!useQuick && result.status === 'error') return <span className="text-red-500">{result.error}</span>
    return (
      <span data-testid="heights-followed-status">
        {share === null || share === undefined ? `Pins and order only — see ${source}'s result chip` : `${Math.round(share * 100)}% of the guided picture within reach in ${source}`}
      </span>
    )
  }
  return <span>Paint on the picture to raise or lower parts of it</span>
}

/** The controls under the picture. */
export const HeightsControls: React.FC<{ mode: HeightsModeState }> = ({ mode }) => {
  const { guidance, view, setView, opacity, setOpacity, quick, update } = mode
  const activeFilaments = useAppStore((s) => s.activeFilaments)
  const jobActive = useAppStore((s) => !!s.currentJob && ['pending', 'running', 'paused'].includes(s.currentJob.status))
  const filamentOf = (uuid: string) => activeFilaments.find((f) => f.uuid === uuid)
  // The slider's own position while it moves (the strength is rounded).
  const [sliderPos, setSliderPos] = useState<number | null>(null)
  const strength = sliderPos !== null ? strengthFromSlider(sliderPos) : guidance.strength
  useEffect(() => setSliderPos(null), [guidance.strength])
  const commitStrength = () => {
    if (sliderPos === null) return
    const s = strengthFromSlider(sliderPos)
    if (s === guidance.strength) return
    update((g) => ({ ...g, strength: s }), `Height guidance: ${describeStrength(s).toLowerCase()}`)
  }
  const previewSummary = summarizeReport(quick.preview?.report)
  const sectionLabel = 'w-12 flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-gray-500'

  return (
    <div className="flex flex-col gap-1.5 px-3 py-1.5 border-t border-gray-700 text-[11px] text-gray-400" data-testid="heights-controls">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex rounded border border-gray-600 overflow-hidden" role="group" aria-label="Heights view">
          {(Object.keys(VIEW_LABELS) as HeightView[]).map((v) => (
            <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={segButton(view === v)} title={VIEW_HINTS[v]} data-testid={`heights-view-${v}`}>
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        {view !== 'picture' && (
          <label className="flex items-center gap-1.5" title="How strongly the view covers the picture">
            <input type="range" min={10} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-14 accent-cyan-500" aria-label="View opacity" data-testid="heights-view-opacity" />
          </label>
        )}
        <span className="flex-1 min-w-0 truncate" data-testid="heights-status"><ViewStatus mode={mode} /></span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="heights-shape">
        <span className={sectionLabel} title="What is high and what is low in the print">Shape</span>
        <label className="flex items-center gap-1 text-gray-300" title="Use the photo's depth estimate: nearer parts of the scene print higher">
          <input
            type="checkbox"
            checked={guidance.depth}
            onChange={(e) => update((g) => ({ ...g, depth: e.target.checked }), e.target.checked ? 'Follow the photo depth' : 'Stopped following the photo depth')}
            className="accent-cyan-500"
            data-testid="heights-depth"
          />
          Follow photo depth
        </label>
        {guidance.depth && (
          <label className="flex items-center gap-1" title="Far parts higher instead (if the depth estimate got it the wrong way round)">
            <input type="checkbox" checked={guidance.depth_flip} onChange={(e) => update((g) => ({ ...g, depth_flip: e.target.checked }), 'Flipped the photo depth')} className="accent-cyan-500" data-testid="heights-depth-flip" />
            Flip
          </label>
        )}
        <span className="text-gray-500" data-testid="heights-painted">
          {mode.regions.share.raise + mode.regions.share.lower > 0
            ? `Painted: ${Math.round(mode.regions.share.raise * 100)}% raised, ${Math.round(mode.regions.share.lower * 100)}% lowered`
            : 'Paint on the picture to raise or lower parts'}
        </span>
        {guidance.colors.length === 0 && <span className="text-gray-500">· use Pick color to raise or lower a whole color</span>}
        {guidance.colors.map((c, i) => (
          <span key={`color-${c.color}`} className="flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded border border-gray-600 text-gray-300" data-testid={`heights-color-chip-${i}`}>
            <span className="w-3 h-3 rounded-sm border border-gray-500" style={{ backgroundColor: c.color }} />
            <button
              onClick={() => update((g) => updateColorPick(g, i, { direction: c.direction === 'raise' ? 'lower' : 'raise' }), `${c.direction === 'raise' ? 'Lowered' : 'Raised'} the color ${c.color}`)}
              className="flex items-center gap-0.5 px-1 rounded hover:bg-gray-700"
              title={c.direction === 'raise' ? 'Raised — click to lower instead' : 'Lowered — click to raise instead'}
              data-testid={`heights-color-direction-${i}`}
              data-direction={c.direction}
            >
              {c.direction === 'raise' ? <ArrowUp className="w-3 h-3 text-red-400" /> : <ArrowDown className="w-3 h-3 text-blue-400" />}
              {c.direction}
            </button>
            <label className="flex items-center gap-0.5" title="How different a pixel may be and still count (Delta E)">
              ±
              <input
                type="number"
                min={1}
                max={100}
                value={c.tolerance}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(100, Number(e.target.value) || 1))
                  update((g) => updateColorPick(g, i, { tolerance: v }), `Color tolerance ${v}`)
                }}
                className="w-10 bg-gray-800 border border-gray-600 rounded px-0.5 text-[11px] text-gray-200"
                aria-label={`Tolerance of ${c.color}`}
                data-testid={`heights-color-tolerance-${i}`}
              />
            </label>
            <button onClick={() => update((g) => removeColorPick(g, i), `Removed the color ${c.color}`)} className="p-0.5 rounded hover:bg-gray-700" aria-label={`Remove ${c.color}`} data-testid={`heights-color-remove-${i}`}>
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="heights-stack">
        <span className={sectionLabel} title="Which filament sits where in the layer stack">Stack</span>
        <div className="flex rounded border border-gray-600 overflow-hidden" role="group" aria-label="Color order">
          {(Object.keys(ORDER_LABELS) as HeightOrder[]).map((o) => (
            <button
              key={o}
              onClick={() => update((g) => ({ ...g, order: o }), `Height order: ${ORDER_LABELS[o].toLowerCase()}`)}
              aria-pressed={guidance.order === o}
              className={segButton(guidance.order === o)}
              title={ORDER_HINTS[o]}
              data-testid={`heights-order-${o}`}
            >
              {ORDER_LABELS[o]}
            </button>
          ))}
        </div>
        {guidance.pins.length === 0 && (
          <span className="text-gray-500" data-testid="heights-pins-hint">
            <Pin className="inline w-3 h-3 -mt-0.5" /> drop a filament on the color column to keep it at a height
          </span>
        )}
        {guidance.pins.map((p, i) => {
          const f = filamentOf(p.uuid)
          return (
            <span key={`pin-${i}`} className="flex items-center gap-1 pl-1 pr-0.5 py-0.5 rounded border border-gray-600 text-gray-300" data-testid={`heights-pin-chip-${i}`}>
              <Pin className="w-3 h-3 text-gray-400" />
              <span className="w-3 h-3 rounded-sm border border-gray-500" style={{ backgroundColor: f?.color ?? '#555' }} />
              <span className="max-w-[7rem] truncate" title={f ? `${f.brand} ${f.name}` : 'Filament no longer active'}>{f?.name ?? 'Inactive'}</span>
              <span className="tabular-nums text-gray-400">{Math.round(p.position * 100)}%</span>
              <button onClick={() => update((g) => removePin(g, i), `Removed the pin of ${f?.name ?? 'a filament'}`)} className="p-0.5 rounded hover:bg-gray-700" aria-label={`Remove the pin of ${f?.name ?? 'a filament'}`} data-testid={`heights-pin-remove-${i}`}>
                <X className="w-3 h-3" />
              </button>
            </span>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-2 text-gray-300" title="How much color accuracy the optimizer may give up to follow your suggestions. They stay suggestions: towards the left the picture's colors win, towards the right the heights do.">
          <span className="text-gray-400">Color accuracy</span>
          <input
            type="range"
            min={0}
            max={100}
            value={sliderPos ?? sliderFromStrength(guidance.strength)}
            onChange={(e) => setSliderPos(Number(e.target.value))}
            onPointerUp={commitStrength}
            onKeyUp={commitStrength}
            onBlur={commitStrength}
            className="w-32 accent-cyan-500"
            aria-label="Color accuracy or follow heights"
            aria-valuetext={`${describeStrength(strength)} (${strength}×)`}
            data-testid="heights-strength"
          />
          <span className="text-gray-400">Follow heights</span>
          <span className="w-24 font-medium text-cyan-300" data-testid="heights-strength-value" data-strength={strength} title={`${strength}×`}>{describeStrength(strength)}</span>
        </label>
        <span className="ml-auto flex items-center gap-2">
          {quick.status === 'error' && <span className="text-red-500 truncate max-w-[16rem]" title={quick.error ?? ''} data-testid="heights-quick-error">{quick.error}</span>}
          {quick.preview && !quick.stale && (
            <span className="text-gray-400" data-testid="heights-quick-summary">
              {Math.round(quick.preview.seconds)} s{previewSummary ? ` · ${previewSummary.text}` : ''}
            </span>
          )}
          <button
            onClick={() => {
              setView('preview')
              quick.run()
            }}
            disabled={quick.status === 'working' || jobActive}
            className="flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-medium border border-cyan-600 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-50"
            title={jobActive ? 'Not while an optimization runs' : 'A small, short real run with your suggestions (a few seconds) — what a run does, at a lower resolution'}
            data-testid="heights-quick-preview"
          >
            {quick.status === 'working' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Quick preview
          </button>
        </span>
      </div>
    </div>
  )
}

/** Keyboard shortcuts while Heights mode is on. */
export function useHeightsKeys(enabled: boolean, mode: HeightsModeState, onDone: () => void) {
  const { setTool, brushPercent, setBrushPercent } = mode
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ((target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range' && (target as HTMLInputElement).type !== 'checkbox') || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'escape' || key === 'enter') onDone()
      else if (key === 'r') setTool('raise')
      else if (key === 'l') setTool('lower')
      else if (key === 'e') setTool('erase')
      else if (key === 'i') setTool('pick')
      else if (key === '[') setBrushPercent(Math.max(1, brushPercent - 1))
      else if (key === ']') setBrushPercent(Math.min(25, brushPercent + 1))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, onDone, setTool, brushPercent, setBrushPercent])
}
