/** Height guidance: soft suggestions for where colors sit in the print.
 *
 * The optimizer (backend HeightGuidance) weighs them against the color
 * error by one strength:
 *  - pins: "keep a band of this filament roughly here" — a position on the
 *    color column, as a fraction of the print's height (0 = base, 1 = top);
 *  - order: dark to light / light to dark from the base up;
 *  - depth: the photo's depth estimate, nearer parts higher;
 *  - picked colors: pixels of a color raised or lowered;
 *  - painted regions (a separate image, `height_regions`): red strokes are
 *    raised, blue strokes lowered.
 *
 * Kept free of imports so node's unit tests can load it directly.
 */

export type HeightOrder = 'auto' | 'dark_to_light' | 'light_to_dark'
export type HeightDirection = 'raise' | 'lower'

export interface HeightPin {
  uuid: string
  /** 0 = the base, 1 = the print's top layer. */
  position: number
}

export interface HeightColorPick {
  color: string
  /** Delta E: how different a pixel may be and still count. */
  tolerance: number
  direction: HeightDirection
}

export interface HeightGuidanceSettings {
  strength: number
  order: HeightOrder
  pins: HeightPin[]
  depth: boolean
  depth_flip: boolean
  colors: HeightColorPick[]
}

export const DEFAULT_STRENGTH = 1
/** The slider's ends: measured on photos with depth, 0.05× barely moves
 * anything and 100× follows the heights almost at any color cost (1×:
 * clearly follows them at about no color cost). */
export const MIN_STRENGTH = 0.05
export const MAX_STRENGTH = 100
export const DEFAULT_COLOR_TOLERANCE = 15
/** How far a pin may be off and still count as followed, as the backend
 * judges it (PIN_TOLERANCE), for drawing its "roughly here" range. */
export const PIN_TOLERANCE = 0.06

export const ORDER_LABELS: Record<HeightOrder, string> = {
  auto: 'Auto',
  dark_to_light: 'Dark → light',
  light_to_dark: 'Light → dark',
}

export const ORDER_HINTS: Record<HeightOrder, string> = {
  auto: 'Whatever order fits the picture best',
  dark_to_light: 'Darker filaments low, lighter ones on top (the classic layering)',
  light_to_dark: 'Lighter filaments low, darker ones on top — usually costs color accuracy',
}

export function emptyGuidance(): HeightGuidanceSettings {
  return { strength: DEFAULT_STRENGTH, order: 'auto', pins: [], depth: false, depth_flip: false, colors: [] }
}

/** The stored guidance with every field present (older/partial data). */
export function normalizeGuidance(g: Partial<HeightGuidanceSettings> | null | undefined): HeightGuidanceSettings {
  const base = emptyGuidance()
  if (!g || typeof g !== 'object') return base
  return {
    strength: Number.isFinite(g.strength) ? Math.max(0, Number(g.strength)) : base.strength,
    order: g.order === 'dark_to_light' || g.order === 'light_to_dark' ? g.order : 'auto',
    pins: Array.isArray(g.pins) ? g.pins.filter((p) => p && typeof p.uuid === 'string').map((p) => ({ uuid: p.uuid, position: clamp01(p.position) })) : [],
    depth: !!g.depth,
    depth_flip: !!g.depth_flip,
    colors: Array.isArray(g.colors)
      ? g.colors
          .filter((c) => c && typeof c.color === 'string')
          .map((c) => ({ color: c.color, tolerance: Number(c.tolerance) || DEFAULT_COLOR_TOLERANCE, direction: c.direction === 'lower' ? 'lower' : 'raise' }))
      : [],
  }
}

function clamp01(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
}

/** Is any suggestion set (painted regions count, see `hasRegions`)? */
export function guidanceIsActive(g: HeightGuidanceSettings | null | undefined, hasRegions = false): boolean {
  if (!g) return hasRegions
  if (!(g.strength > 0)) return false
  return hasRegions || g.pins.length > 0 || g.order !== 'auto' || g.depth || g.colors.length > 0
}

/** What the settings hold: null when nothing is suggested, so a run without
 * guidance stays exactly the run it was. */
export function guidanceForSettings(g: HeightGuidanceSettings, hasRegions = false): HeightGuidanceSettings | null {
  if (!guidanceIsActive(g, hasRegions)) return g.strength === DEFAULT_STRENGTH ? null : { ...emptyGuidance(), strength: g.strength }
  return g
}

/** How many suggestions are set, for the Heights button's badge. */
export function suggestionCount(g: HeightGuidanceSettings | null | undefined, hasRegions = false): number {
  if (!g) return hasRegions ? 1 : 0
  return g.pins.length + g.colors.length + (g.order !== 'auto' ? 1 : 0) + (g.depth ? 1 : 0) + (hasRegions ? 1 : 0)
}

// --- strength --------------------------------------------------------------

/** The "color accuracy ↔ follow heights" slider is logarithmic
 * (0–100 → 0.05×–100×). Two significant digits. */
export function strengthFromSlider(position: number): number {
  const t = Math.max(0, Math.min(100, position)) / 100
  const raw = MIN_STRENGTH * Math.pow(MAX_STRENGTH / MIN_STRENGTH, t)
  const digits = Math.pow(10, Math.floor(Math.log10(raw)) - 1)
  return Math.round(raw / digits) * digits
}

export function sliderFromStrength(strength: number): number {
  const s = Math.max(MIN_STRENGTH, Math.min(MAX_STRENGTH, strength || DEFAULT_STRENGTH))
  return Math.round((Math.log(s / MIN_STRENGTH) / Math.log(MAX_STRENGTH / MIN_STRENGTH)) * 100)
}

/** A word for the strength, next to the slider. */
export function describeStrength(strength: number): string {
  if (strength < 0.2) return 'Colors first'
  if (strength < 2) return 'Balanced'
  if (strength < 20) return 'Heights first'
  return 'Heights above all'
}

// --- pins ------------------------------------------------------------------

export function addPin(g: HeightGuidanceSettings, uuid: string, position: number): HeightGuidanceSettings {
  return { ...g, pins: [...g.pins, { uuid, position: clamp01(position) }] }
}

export function movePin(g: HeightGuidanceSettings, index: number, position: number): HeightGuidanceSettings {
  if (index < 0 || index >= g.pins.length) return g
  const pins = g.pins.slice()
  pins[index] = { ...pins[index], position: clamp01(position) }
  return { ...g, pins }
}

export function removePin(g: HeightGuidanceSettings, index: number): HeightGuidanceSettings {
  return { ...g, pins: g.pins.filter((_, i) => i !== index) }
}

/** Pins of filaments that are no longer active are dropped (the backend
 * would ignore them anyway). */
export function prunePins(g: HeightGuidanceSettings, activeUuids: string[]): HeightGuidanceSettings {
  const keep = g.pins.filter((p) => activeUuids.includes(p.uuid))
  return keep.length === g.pins.length ? g : { ...g, pins: keep }
}

/** The layer a pin sits at on a column of layers 0..top. */
export function pinLayer(position: number, top: number): number {
  return Math.round(clamp01(position) * Math.max(1, top))
}

/** A pin position (fraction) from a layer on a column of layers 0..top. */
export function positionFromLayer(layer: number, top: number): number {
  return clamp01(layer / Math.max(1, top))
}

// --- picked colors -----------------------------------------------------------

export function addColorPick(g: HeightGuidanceSettings, color: string, direction: HeightDirection): HeightGuidanceSettings {
  const hex = color.toLowerCase()
  const others = g.colors.filter((c) => c.color.toLowerCase() !== hex)
  return { ...g, colors: [...others, { color: hex, tolerance: DEFAULT_COLOR_TOLERANCE, direction }] }
}

export function updateColorPick(g: HeightGuidanceSettings, index: number, update: Partial<HeightColorPick>): HeightGuidanceSettings {
  if (index < 0 || index >= g.colors.length) return g
  const colors = g.colors.slice()
  colors[index] = { ...colors[index], ...update }
  return { ...g, colors }
}

export function removeColorPick(g: HeightGuidanceSettings, index: number): HeightGuidanceSettings {
  return { ...g, colors: g.colors.filter((_, i) => i !== index) }
}

/** #rrggbb of an RGBA pixel. */
export function pixelHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

// --- painted regions -----------------------------------------------------------

/** Stroke colour of the regions brush: the backend reads red as raise and
 * blue as lower (alpha = how fully painted). */
export function regionStrokeColor(direction: HeightDirection): string {
  return direction === 'raise' ? '#ff0000' : '#0000ff'
}

/** Shares (0–1) of raised and lowered pixels of an RGBA regions buffer. */
export function regionShares(rgba: Uint8ClampedArray): { raise: number; lower: number } {
  let raise = 0
  let lower = 0
  const n = rgba.length / 4
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] <= 127) continue
    if (rgba[i] >= rgba[i + 2]) raise++
    else lower++
  }
  return n ? { raise: raise / n, lower: lower / n } : { raise: 0, lower: 0 }
}

// --- the result's report ---------------------------------------------------

export interface GuidanceReportPin {
  uuid?: string | null
  material: number
  position: number
  nearest: number | null
  met: boolean
}

export interface GuidanceReport {
  top: number
  pins: GuidanceReportPin[]
  order_agreement?: number
  pixel_mean_distance?: number
}

/** "2 of 3 pins followed" and friends, for the result chip. */
export function summarizeReport(report: GuidanceReport | null | undefined): { text: string; followed: number; total: number } | null {
  if (!report) return null
  const total = report.pins.length
  const followed = report.pins.filter((p) => p.met).length
  const parts: string[] = []
  if (total) parts.push(`${followed}/${total} pins`)
  if (report.order_agreement !== undefined) parts.push(`order ${Math.round(report.order_agreement * 100)}%`)
  if (report.pixel_mean_distance !== undefined) parts.push(`heights ±${Math.round(report.pixel_mean_distance * 100)}%`)
  return parts.length ? { text: parts.join(' · '), followed, total } : null
}

/** One line per pin for the result chip's tooltip. */
export function describeReportPins(report: GuidanceReport, nameOf: (uuid: string) => string): string[] {
  return report.pins.map((p) => {
    const name = p.uuid ? nameOf(p.uuid) : `Filament ${p.material + 1}`
    const want = `${Math.round(p.position * 100)}%`
    if (p.nearest === null) return `${name} at ${want}: not used`
    return `${name} at ${want}: ${p.met ? 'followed' : 'nearest band'} at ${Math.round(p.nearest * 100)}%`
  })
}

/** "+4% color error" for the preview's cost line. */
export function describeColorCost(relative: number): string {
  if (!Number.isFinite(relative)) return ''
  if (relative <= 0) return 'no extra color error'
  const pct = Math.round(relative * 100)
  if (pct < 1) return 'under 1% more color error'
  return `≈ +${pct}% color error`
}
