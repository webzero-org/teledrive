/**
 * Thumbnail — lazy-loaded, IntersectionObserver-gated thumbnail
 * Uses IDB-backed cache via loadThumbnail() in api.ts
 */
import { useState, useRef, useEffect } from 'react'
import { FileDoc, loadThumbnail } from '../lib/api'
import { ImageIcon, FileVideo, FileAudio, File, Package, Play } from 'lucide-react'

interface Props {
  file: FileDoc
  /** Tile size in pixels (used for square tiles in grid, or small thumb in list) */
  size?: number
}

const typeIcon = {
  image: ImageIcon,
  video: FileVideo,
  audio: FileAudio,
  document: File,
}

export function Thumbnail({ file, size = 160 }: Props) {
  const [phase, setPhase] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const hasThumbnail = !!file.thumb_msg_id

  useEffect(() => {
    if (!hasThumbnail) return

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        obs.disconnect()
        setPhase('loading')
        loadThumbnail(file.message_id, file.channel_id)
          .then(url => { setThumbUrl(url) })
          .catch(() => setPhase('error'))
      },
      { rootMargin: '300px' },
    )

    if (ref.current) obs.observe(ref.current)
    return () => obs.disconnect()
  }, [hasThumbnail, file.message_id, file.channel_id])

  const Icon = typeIcon[file.type] ?? File
  const isSmall = size <= 40

  return (
    <div
      ref={ref}
      style={{
        width: size,
        height: size,
        position: 'relative',
        background: 'var(--bg-2)',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        borderRadius: isSmall ? 4 : 0,
      }}
    >
      {/* Fallback icon */}
      {(!hasThumbnail || phase === 'error') && (
        <Icon size={Math.max(16, size * 0.28)} color="var(--text-3)" strokeWidth={1} />
      )}

      {/* Shimmer skeleton while loading */}
      {phase === 'loading' && !thumbUrl && (
        <div className="skeleton" style={{ position: 'absolute', inset: 0 }} />
      )}

      {/* Actual image — fade in once loaded */}
      {thumbUrl && phase !== 'error' && (
        <img
          src={thumbUrl}
          alt=""
          onLoad={() => setPhase('loaded')}
          onError={() => setPhase('error')}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: phase === 'loaded' ? 1 : 0,
            transition: 'opacity 0.25s ease',
          }}
        />
      )}

      {/* Video play indicator */}
      {!isSmall && file.type === 'video' && phase === 'loaded' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.18)',
            pointerEvents: 'none',
          }}
        >
          <div style={{
            background: 'rgba(0,0,0,0.55)',
            borderRadius: '50%',
            padding: 6,
            backdropFilter: 'blur(2px)',
          }}>
            <Play size={Math.min(32, size * 0.28)} fill="#fff" color="#fff" strokeWidth={0} />
          </div>
        </div>
      )}

      {/* Split badge */}
      {file.is_split && (
        <div style={{
          position: 'absolute',
          top: 4,
          right: 4,
          background: 'rgba(0,0,0,0.72)',
          borderRadius: 4,
          padding: '2px 5px',
          fontSize: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          color: 'var(--warn)',
        }}>
          <Package size={9} />
          {file.total_parts}
        </div>
      )}
    </div>
  )
}
