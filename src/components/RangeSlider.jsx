import { useState, useEffect, useRef } from 'react'

// Dual-thumb range slider
export default function RangeSlider({ min, max, step = 1, value, onChange, accent = '#6366f1' }) {
  const trackRef = useRef(null)
  const [dragging, setDragging] = useState(null)
  const [lo, hi] = value

  useEffect(() => {
    if (!dragging) return
    const onMove = (e) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width))
      const raw = min + (x / rect.width) * (max - min)
      const snapped = Math.round(raw / step) * step
      const clamped = Math.max(min, Math.min(max, snapped))
      if (dragging === 'lo') onChange([Math.min(clamped, hi - step), hi])
      else onChange([lo, Math.max(clamped, lo + step)])
    }
    const onUp = () => setDragging(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, lo, hi, min, max, step, onChange])

  const pct = (v) => ((v - min) / (max - min)) * 100

  return (
    <div
      ref={trackRef}
      style={{
        position: 'relative', height: 24, userSelect: 'none',
        cursor: 'pointer', margin: '4px 10px',
      }}
    >
      <div style={{
        position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)',
        height: 4, background: 'var(--bg)', borderRadius: 2,
      }} />
      <div style={{
        position: 'absolute', top: '50%', transform: 'translateY(-50%)',
        left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%`,
        height: 4, background: accent, borderRadius: 2,
      }} />
      <div
        onMouseDown={(e) => { e.preventDefault(); setDragging('lo') }}
        style={{
          position: 'absolute', top: '50%', left: `${pct(lo)}%`,
          transform: 'translate(-50%, -50%)',
          width: 16, height: 16, borderRadius: '50%', background: accent,
          border: '2px solid var(--card-bg, #1a1a24)', cursor: 'grab',
          boxShadow: '0 2px 6px rgba(0,0,0,0.4)', zIndex: dragging === 'lo' ? 3 : 2,
        }}
      />
      <div
        onMouseDown={(e) => { e.preventDefault(); setDragging('hi') }}
        style={{
          position: 'absolute', top: '50%', left: `${pct(hi)}%`,
          transform: 'translate(-50%, -50%)',
          width: 16, height: 16, borderRadius: '50%', background: accent,
          border: '2px solid var(--card-bg, #1a1a24)', cursor: 'grab',
          boxShadow: '0 2px 6px rgba(0,0,0,0.4)', zIndex: dragging === 'hi' ? 3 : 2,
        }}
      />
    </div>
  )
}
