import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pin, X } from 'lucide-react'
import { useAppStore } from '../store/appStore'
import { colorCoreLayerAt, colorCoreLayerY } from '../lib/colorStack'
import {
  PIN_TOLERANCE,
  addPin,
  guidanceForSettings,
  movePin,
  normalizeGuidance,
  pinLayer,
  positionFromLayer,
  removePin,
  type HeightGuidanceSettings,
} from '../lib/heightGuidance'

/** Edit the height guidance as one undo step (see useHeightsMode.update). */
export function updateGuidance(change: (g: HeightGuidanceSettings) => HeightGuidanceSettings, label: string) {
  const { settings, setHeightGuidance } = useAppStore.getState()
  setHeightGuidance(guidanceForSettings(change(normalizeGuidance(settings.height_guidance)), !!settings.height_regions), label)
}

/** Pin a filament at a layer of a column of layers 0..top. */
export function pinFilamentAt(uuid: string, layer: number, top: number, name?: string) {
  const position = positionFromLayer(layer, top)
  updateGuidance((g) => addPin(g, uuid, position), `Pinned ${name ?? 'a filament'} at ${Math.round(position * 100)}%`)
}

/** The layer under a pointer at `clientY` over the column `el` (its box
 * spans layers 0..top). */
export function layerAtPointer(el: HTMLElement, clientY: number, top: number): number {
  const rect = el.getBoundingClientRect()
  return colorCoreLayerAt(rect.bottom - clientY, top, rect.height)
}

/** Width (px) of the pins' lane, right of the color track. */
export const PIN_LANE = 26

/** The pins of the height guidance on the color column (Heights mode): a
 * marker per pin in its own lane right of the track, at its height, with
 * its "roughly here" range over the track; dragged up and down, nudged
 * with the arrow keys, removed with × or Delete. */
export const ColorCorePins: React.FC<{
  topLayer: number
  height: number
  columnRef: React.RefObject<HTMLDivElement>
}> = ({ topLayer, height, columnRef }) => {
  const stored = useAppStore((s) => s.settings.height_guidance)
  const activeFilaments = useAppStore((s) => s.activeFilaments)
  const pins = normalizeGuidance(stored).pins
  // The pin being dragged and where it is now (committed on release).
  const [drag, setDrag] = useState<{ index: number; layer: number } | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag

  const filamentOf = (uuid: string) => activeFilaments.find((f) => f.uuid === uuid)

  const commit = useCallback((index: number, layer: number) => {
    const position = positionFromLayer(layer, topLayer)
    updateGuidance((g) => movePin(g, index, position), `Moved a pin to ${Math.round(position * 100)}%`)
  }, [topLayer])

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const el = columnRef.current
      if (!el) return
      const layer = layerAtPointer(el, e.clientY, topLayer)
      setDrag((d) => (d && d.layer !== layer ? { ...d, layer } : d))
    }
    const up = () => {
      const d = dragRef.current
      setDrag(null)
      if (d) commit(d.index, d.layer)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [drag !== null, columnRef, topLayer, commit]) // eslint-disable-line react-hooks/exhaustive-deps

  const rowHeight = height / (topLayer + 1)

  return (
    <div className="absolute inset-0 pointer-events-none z-30" data-testid="color-core-pins">
      {pins.map((p, i) => {
        const f = filamentOf(p.uuid)
        const color = f?.color ?? '#777777'
        const layer = drag?.index === i ? drag.layer : pinLayer(p.position, topLayer)
        const y = colorCoreLayerY(layer, topLayer, height)
        const span = Math.max(rowHeight, PIN_TOLERANCE * topLayer * rowHeight)
        const name = f?.name ?? 'Inactive filament'
        return (
          <React.Fragment key={i}>
            {/* "Roughly here": the range the pin is met in. */}
            <div
              className="absolute rounded-sm border-2 border-dashed"
              style={{ left: 56, right: PIN_LANE, top: y - span, height: span * 2, backgroundColor: `${color}40`, borderColor: color }}
              data-testid={`color-core-pin-range-${i}`}
            />
            <div
              role="slider"
              tabIndex={0}
              aria-label={`Pin: ${name}`}
              aria-valuemin={0}
              aria-valuemax={topLayer}
              aria-valuenow={layer}
              aria-valuetext={`layer ${layer} (${Math.round((layer / Math.max(1, topLayer)) * 100)}% of the height)`}
              className="absolute right-0 flex flex-col items-center justify-center rounded-r-md rounded-l-sm text-[9px] font-mono font-bold shadow-lg border border-black/60 outline outline-1 outline-white/50 pointer-events-auto cursor-ns-resize select-none group focus:ring-2 focus:ring-cyan-400"
              style={{ top: y, width: PIN_LANE - 2, height: 30, transform: 'translateY(-50%)', backgroundColor: color, touchAction: 'none' }}
              title={`${name}: keep a band of it near layer ${layer}. Drag to move, Delete to remove.`}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.preventDefault()
                e.stopPropagation()
                ;(e.currentTarget as HTMLElement).focus({ preventScroll: true })
                setDrag({ index: i, layer: pinLayer(p.position, topLayer) })
              }}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0
                if (step) {
                  e.preventDefault()
                  commit(i, Math.max(0, Math.min(topLayer, pinLayer(p.position, topLayer) + step * (e.shiftKey ? 5 : 1))))
                } else if (e.key === 'Delete' || e.key === 'Backspace') {
                  e.preventDefault()
                  updateGuidance((g) => removePin(g, i), `Removed the pin of ${name}`)
                }
              }}
              data-testid={`color-core-pin-${i}`}
              data-layer={layer}
              data-position={p.position}
            >
              <Pin className="w-3.5 h-3.5" style={{ color: '#fff', filter: 'drop-shadow(0 0 1px #000)' }} />
              <span style={{ color: '#fff', textShadow: '0 0 2px #000' }}>{layer}</span>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  updateGuidance((g) => removePin(g, i), `Removed the pin of ${name}`)
                }}
                className="absolute -top-1.5 -right-1 rounded-full bg-gray-900 border border-gray-500 hover:bg-red-600 text-white opacity-0 group-hover:opacity-100 group-focus:opacity-100"
                aria-label={`Remove the pin of ${name}`}
                data-testid={`color-core-pin-remove-${i}`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}
