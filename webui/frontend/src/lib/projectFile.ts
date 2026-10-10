/** What makes a saved project file shareable: it carries its own image(s)
 * and heightmap instead of pointing at files only one server has. A file
 * that only named `/uploads/<hash>.png` opened on another machine without
 * its picture, and without the heightmap a loaded project fell back to a
 * fresh auto-preview of the photo — a different surface, with the saved
 * color layers painted onto it.
 *
 * Kept free of imports so node's test runner can load it directly. */

/** The saved heightmap (see the backend's helpers/project_heightmap.py). */
export interface SavedHeightmap {
  /** 16-bit grayscale PNG, base64: printed layers per pixel. */
  heightmap: string
  /** 8-bit PNG, base64, or null when every pixel is printed. */
  alpha: string | null
  width: number
  height: number
  max_layer: number
}

export function isSavedHeightmap(value: unknown): value is SavedHeightmap {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.heightmap === 'string' && v.heightmap.length > 0 && (v.alpha === null || v.alpha === undefined || typeof v.alpha === 'string')
}

/** The render target whose heightmap a save should carry: the result on
 * screen, else the pre-run auto-preview, else none. */
export function heightmapSource(
  currentJob: { job_id: string; status: string } | null,
  initStatus: string,
): string | null {
  if (currentJob?.status === 'completed') return currentJob.job_id
  if (initStatus === 'ready') return '__init__'
  return null
}

export function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'))
    reader.readAsDataURL(blob)
  })
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || 'application/octet-stream'
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** A file name for re-uploading an embedded image, with the extension the
 * server needs to keep its format. */
export function embeddedImageName(dataUrl: string, base: string): string {
  const mime = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl)?.[1]?.toLowerCase() ?? 'png'
  const ext = mime === 'jpeg' ? 'jpg' : mime === 'svg+xml' ? 'svg' : mime
  return `${base}.${ext}`
}
