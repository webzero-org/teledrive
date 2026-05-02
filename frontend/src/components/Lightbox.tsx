import { useEffect, useState, useCallback } from 'react'
import { X, Download, ChevronLeft, ChevronRight, Package } from 'lucide-react'
import { FileDoc, api } from '../lib/api'
import { fmtBytes } from '../lib/utils'

interface Props {
  file: FileDoc
  files: FileDoc[]   // all files in current view (for prev/next)
  onClose: () => void
  onDownload: (file: FileDoc) => void
}

export function Lightbox({ file: initial, files, onClose, onDownload }: Props) {
  const [current, setCurrent] = useState(initial)
  const [thumbLoaded, setThumbLoaded] = useState(false)
  const [fullLoaded, setFullLoaded] = useState(false)
  const [fullUrl, setFullUrl] = useState<string | null>(null)

  // index among image-type files only
  const imageFiles = files.filter(f => f.type === 'image' && !f.is_split)
  const idx = imageFiles.findIndex(f => f.message_id === current.message_id)

  const go = useCallback((delta: number) => {
    const next = imageFiles[idx + delta]
    if (next) {
      setCurrent(next)
      setThumbLoaded(false)
      setFullLoaded(false)
      setFullUrl(null)
    }
  }, [idx, imageFiles])

  // Load full-res in background once thumb is shown
  useEffect(() => {
    setFullUrl(null)
    setFullLoaded(false)
    setThumbLoaded(false)
    const url = api.files.downloadUrl(current.message_id, current.channel_id) + '&inline=true'
    setFullUrl(url)
  }, [current.message_id, current.channel_id])

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [go, onClose])

  const thumbUrl = current.thumb_msg_id
    ? api.files.thumbnailUrl(current.message_id, current.channel_id)
    : null

  const displayUrl = fullLoaded ? fullUrl : thumbUrl

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.92)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'fade-in 0.12s ease',
      }}
    >
      {/* Main image area */}
      <div
        onClick={e => e.stopPropagation()}
        style={{ position: 'relative', maxWidth: '90vw', maxHeight: '88vh' }}
      >
        {/* Loading quality indicator */}
        {!fullLoaded && thumbLoaded && (
          <div style={{
            position: 'absolute', top: 10, left: 10, zIndex: 2,
            background: 'rgba(0,0,0,0.6)', borderRadius: 4,
            padding: '2px 8px', fontSize: 11, color: 'var(--text-3)',
          }}>
            Loading full res…
          </div>
        )}

        {displayUrl && (
          <img
            src={displayUrl}
            alt={current.name}
            onLoad={() => {
              if (!thumbLoaded) setThumbLoaded(true)
            }}
            style={{
              maxWidth: '90vw', maxHeight: '80vh',
              objectFit: 'contain', display: 'block',
              borderRadius: 'var(--radius)',
              filter: fullLoaded ? 'none' : 'blur(0.5px)',
              transition: 'filter 0.3s ease',
            }}
          />
        )}

        {/* Hidden full-res loader */}
        {fullUrl && !fullLoaded && thumbLoaded && (
          <img
            src={fullUrl}
            alt=""
            onLoad={() => setFullLoaded(true)}
            style={{ display: 'none' }}
          />
        )}
      </div>

      {/* Controls */}
      <button
        onClick={onClose}
        style={{
          position: 'fixed', top: 16, right: 16,
          background: 'var(--bg-2)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '6px 10px',
          color: 'var(--text-2)',
        }}
      >
        <X size={16} />
      </button>

      <button
        onClick={() => onDownload(current)}
        style={{
          position: 'fixed', top: 16, right: 56,
          background: 'var(--bg-2)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '6px 10px',
          color: 'var(--text-2)',
        }}
      >
        <Download size={16} />
      </button>

      {/* Prev / Next */}
      {idx > 0 && (
        <button
          onClick={e => { e.stopPropagation(); go(-1) }}
          style={{
            position: 'fixed', left: 16, top: '50%', transform: 'translateY(-50%)',
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '10px 8px', color: 'var(--text-2)',
          }}
        >
          <ChevronLeft size={18} />
        </button>
      )}
      {idx < imageFiles.length - 1 && (
        <button
          onClick={e => { e.stopPropagation(); go(1) }}
          style={{
            position: 'fixed', right: 16, top: '50%', transform: 'translateY(-50%)',
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '10px 8px', color: 'var(--text-2)',
          }}
        >
          <ChevronRight size={18} />
        </button>
      )}

      {/* File info bar */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'linear-gradient(transparent, rgba(0,0,0,0.85))',
        padding: '24px 20px 16px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ fontWeight: 500, flex: 1 }} className="truncate">
          {current.name}
        </span>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
          {current.resolution !== '-' && <>{current.resolution} · </>}
          {fmtBytes(current.size)}
        </span>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
          {idx + 1} / {imageFiles.length}
        </span>
      </div>
    </div>
  )
}
