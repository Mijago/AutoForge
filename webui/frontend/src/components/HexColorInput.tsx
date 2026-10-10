import React, { useEffect, useRef, useState } from 'react'
import { parseHexInput } from '../lib/color'

/** A hex field you can type into and paste a color from the web into. The
 * text is kept as typed while focused; every valid color is applied as you go,
 * and on blur the field settles back on the current color. */
export const HexColorInput: React.FC<{
  value: string
  onColor: (rgb: { r: number; g: number; b: number }) => void
  'data-testid'?: string
}> = ({ value, onColor, ...rest }) => {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)

  // Follow the sliders and the color picker, but not what is being typed.
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  return (
    <input
      type="text"
      value={draft}
      spellCheck={false}
      maxLength={16}
      aria-label="Hex color"
      onFocus={(e) => {
        focused.current = true
        e.target.select()
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        const rgb = parseHexInput(e.target.value)
        if (rgb) onColor(rgb)
      }}
      onBlur={() => {
        focused.current = false
        setDraft(value)
      }}
      className={`text-xs bg-gray-800 border rounded px-2 py-1 text-gray-200 font-mono w-24 focus:outline-none focus:border-blue-500 ${parseHexInput(draft) ? 'border-gray-600' : 'border-red-500'}`}
      {...rest}
    />
  )
}
