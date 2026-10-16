import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/appStore'
import { describeApiError } from '../lib/apiError'
import { brushDiameter, clientToMask, maskCanvasSize, maskHasPaint } from '../lib/focusMask'
import { pixelHex, regionShares, regionStrokeColor, type HeightDirection } from '../lib/heightGuidance'

/** What the pointer does in Heights mode: paint raised / lowered regions,
 * erase them, or pick a color of the picture. */
export type HeightTool = HeightDirection | 'erase' | 'pick'

/** Wait after the last stroke before uploading (one upload and one undo
 * step per burst of strokes). */
const SAVE_DELAY = 700

export interface HeightRegionsState {
  /** Red strokes raise, blue strokes lower; alpha = how fully painted. */
  canvas: HTMLCanvasElement | null
  width: number
  height: number
  version: number
  share: { raise: number; lower: number }
  saving: boolean
  touch: () => void
  markChanged: () => void
  clear: () => void
}

/** The painted height regions of the current picture: loads the saved ones
 * (a restored session, undo/redo) and uploads edits as an RGBA PNG the
 * optimizer reads (see backend HeightGuidance.build_target_maps). */
export function useHeightRegions(): HeightRegionsState {
  const inputImage = useAppStore((s) => s.inputImage)
  const savedName = useAppStore((s) => s.settings.height_regions || '')
  const setHeightRegions = useAppStore((s) => s.setHeightRegions)
  const pushToast = useAppStore((s) => s.pushToast)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [version, setVersion] = useState(0)
  const [share, setShare] = useState({ raise: 0, lower: 0 })
  const [saving, setSaving] = useState(false)
  const shownNameRef = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveSeqRef = useRef(0)

  const refreshShare = useCallback(() => {
    const c = canvasRef.current
    const ctx = c?.getContext('2d', { willReadFrequently: true })
    if (!c || !ctx) return setShare({ raise: 0, lower: 0 })
    setShare(regionShares(ctx.getImageData(0, 0, c.width, c.height).data))
  }, [])

  // A canvas the size of the picture (capped), fresh for every picture.
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    saveSeqRef.current++
    canvasRef.current = null
    shownNameRef.current = null
    setSize({ width: 0, height: 0 })
    setShare({ raise: 0, lower: 0 })
    if (!inputImage) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const { width, height } = maskCanvasSize(img.naturalWidth, img.naturalHeight)
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      canvasRef.current = c
      setSize({ width, height })
      setVersion((v) => v + 1)
    }
    img.src = inputImage
    return () => {
      cancelled = true
    }
  }, [inputImage])

  // Show the saved regions whenever they aren't the ones on the canvas.
  useEffect(() => {
    const c = canvasRef.current
    if (!c || shownNameRef.current === savedName) return
    shownNameRef.current = savedName
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.clearRect(0, 0, c.width, c.height)
    if (!savedName) {
      setShare({ raise: 0, lower: 0 })
      setVersion((v) => v + 1)
      return
    }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled || shownNameRef.current !== savedName) return
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.drawImage(img, 0, 0, c.width, c.height)
      refreshShare()
      setVersion((v) => v + 1)
    }
    img.onerror = () => {
      if (!cancelled) pushToast('The painted height regions could not be loaded. Paint them again, or clear them.', 'warning')
    }
    img.src = `/uploads/${encodeURIComponent(savedName)}`
    return () => {
      cancelled = true
    }
  }, [savedName, size, pushToast, refreshShare])

  const save = useCallback(async () => {
    const c = canvasRef.current
    const ctx = c?.getContext('2d', { willReadFrequently: true })
    if (!c || !ctx) return
    const seq = ++saveSeqRef.current
    if (!maskHasPaint(ctx.getImageData(0, 0, c.width, c.height).data)) {
      shownNameRef.current = ''
      setHeightRegions('')
      return
    }
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'))
    if (!blob || seq !== saveSeqRef.current) return
    setSaving(true)
    try {
      const form = new FormData()
      form.append('file', blob, 'height-regions.png')
      const response = await fetch('/api/images/upload', { method: 'POST', body: form })
      if (!response.ok) throw new Error(describeApiError(await response.json().catch(() => null), response.status))
      const { filename } = await response.json()
      if (seq !== saveSeqRef.current || !filename) return
      shownNameRef.current = filename
      setHeightRegions(filename)
    } catch (e) {
      pushToast(`Couldn't save the height regions: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      if (seq === saveSeqRef.current) setSaving(false)
    }
  }, [setHeightRegions, pushToast])

  const markChanged = useCallback(() => {
    setVersion((v) => v + 1)
    refreshShare()
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      save()
    }, SAVE_DELAY)
  }, [save, refreshShare])

  const touch = useCallback(() => setVersion((v) => v + 1), [])

  const clear = useCallback(() => {
    const c = canvasRef.current
    if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    saveSeqRef.current++
    shownNameRef.current = ''
    setShare({ raise: 0, lower: 0 })
    setVersion((v) => v + 1)
    setHeightRegions('')
  }, [setHeightRegions])

  // An edit still waiting for its upload when the panel goes away is saved now.
  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        save()
      }
    },
    [save],
  )

  return { canvas: canvasRef.current, width: size.width, height: size.height, version, share, saving, touch, markChanged, clear }
}

/** The painted regions over the picture (red raised, blue lowered) and,
 * while editing, the pointer as a brush or a color picker. Sits in the zoom
 * viewport's transformed layer with the picture's object-fit, like the
 * focus mask overlay. `onPick` gets the picked pixel's color. */
export const HeightRegionsOverlay: React.FC<{
  regions: HeightRegionsState
  editing: boolean
  tool: HeightTool
  brushPercent: number
  /** The picture, for the color picker. */
  imageSrc: string | null
  onPick: (hex: string) => void
}> = ({ regions, editing, tool, brushPercent, imageSrc, onPick }) => {
  const viewRef = useRef<HTMLCanvasElement>(null)
  const cursorRef = useRef<HTMLCanvasElement>(null)
  const strokeRef = useRef<{ x: number; y: number } | null>(null)
  const pickRef = useRef<HTMLCanvasElement | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number; scale: number } | null>(null)
  const { canvas, width, height, version } = regions
  const diameter = brushDiameter(brushPercent, width, height)

  // The picture at the regions' size, for picking colors.
  useEffect(() => {
    pickRef.current = null
    if (!imageSrc || !width) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      c.getContext('2d', { willReadFrequently: true })?.drawImage(img, 0, 0, width, height)
      pickRef.current = c
    }
    img.src = imageSrc
    return () => {
      cancelled = true
    }
  }, [imageSrc, width, height])

  useEffect(() => {
    const view = viewRef.current
    const ctx = view?.getContext('2d')
    if (!view || !ctx || !canvas) return
    ctx.clearRect(0, 0, view.width, view.height)
    ctx.globalAlpha = 0.45
    ctx.drawImage(canvas, 0, 0)
    ctx.globalAlpha = 1
  }, [canvas, version])

  useEffect(() => {
    const el = cursorRef.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    ctx.clearRect(0, 0, el.width, el.height)
    if (!editing || !cursor || tool === 'pick') return
    const px = 1 / cursor.scale
    ctx.beginPath()
    ctx.arc(cursor.x, cursor.y, diameter / 2, 0, Math.PI * 2)
    ctx.lineWidth = 3 * px
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.stroke()
    ctx.lineWidth = 1.5 * px
    ctx.strokeStyle = tool === 'erase' ? 'rgb(251, 146, 60)' : tool === 'raise' ? 'rgb(248, 113, 113)' : 'rgb(96, 165, 250)'
    if (tool === 'erase') ctx.setLineDash([4 * px, 3 * px])
    ctx.stroke()
    ctx.setLineDash([])
  }, [editing, cursor, diameter, tool])

  const toMask = (e: React.PointerEvent) => {
    const el = cursorRef.current
    return el ? clientToMask(e.clientX, e.clientY, el.getBoundingClientRect(), width, height) : null
  }

  const drawTo = (x: number, y: number) => {
    const ctx = canvas?.getContext('2d')
    if (!ctx || tool === 'pick') return
    ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over'
    const color = tool === 'erase' ? '#ffffff' : regionStrokeColor(tool)
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = diameter
    const from = strokeRef.current
    ctx.beginPath()
    if (from) {
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(x, y)
      ctx.stroke()
    } else {
      ctx.arc(x, y, diameter / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
    strokeRef.current = { x, y }
    regions.touch()
  }

  const endStroke = () => {
    if (!strokeRef.current) return
    strokeRef.current = null
    regions.markChanged()
  }

  if (!canvas || !width) return null
  const layer = 'absolute inset-0 w-full h-full object-contain'
  return (
    <>
      <canvas ref={viewRef} width={width} height={height} className={`${layer} pointer-events-none`} data-testid="height-regions-overlay" />
      {editing && (
        <canvas
          ref={cursorRef}
          width={width}
          height={height}
          className={`${layer} ${tool === 'pick' ? 'cursor-copy' : 'cursor-crosshair'}`}
          style={{ touchAction: 'none' }}
          data-testid="height-regions-canvas"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            const p = toMask(e)
            if (!p) return
            e.stopPropagation()
            if (tool === 'pick') {
              const ctx = pickRef.current?.getContext('2d', { willReadFrequently: true })
              const x = Math.max(0, Math.min(width - 1, Math.floor(p.x)))
              const y = Math.max(0, Math.min(height - 1, Math.floor(p.y)))
              const px = ctx?.getImageData(x, y, 1, 1).data
              if (px) onPick(pixelHex(px[0], px[1], px[2]))
              return
            }
            e.currentTarget.setPointerCapture(e.pointerId)
            strokeRef.current = null
            drawTo(p.x, p.y)
            setCursor(p)
          }}
          onPointerMove={(e) => {
            const p = toMask(e)
            if (!p) return
            setCursor(p)
            if (strokeRef.current && e.buttons & 1) drawTo(p.x, p.y)
          }}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={() => {
            if (!strokeRef.current) setCursor(null)
          }}
        />
      )}
    </>
  )
}
