/**
 * FileGrid — Google-Photos-style media grid
 *
 * Features:
 *  • Responsive column count derived purely from container width (no hardcodes)
 *  • Touch-friendly: long-press (500 ms) to enter multi-select mode on mobile
 *  • Smooth check-mark overlay with scale animation
 *  • Virtualised rows via @tanstack/react-virtual
 *  • List view with proper responsive columns
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CheckCircle, Circle } from 'lucide-react'
import { FileDoc, prefetchThumbnail } from '../lib/api'
import { Thumbnail } from './Thumbnail'
import { fmtBytes } from '../lib/utils'
import { useStore } from '../lib/store'

// ── Constants ──────────────────────────────────────────────────────────────────
/** Desired tile width in pixels — grid adapts to always fill the container */
const TARGET_TILE_PX = 182
const MIN_COLS = 2
const GAP_PX = 0

interface Props {
  files: FileDoc[]
  onOpen: (file: FileDoc) => void
}

export function FileGrid({ files, onOpen }: Props) {
  const { viewMode, selected, toggleSelect } = useStore()
  const containerRef = useRef<HTMLDivElement>(null)

  if (viewMode === 'grid') {
    return (
      <GridView
        files={files}
        selected={selected}
        toggleSelect={toggleSelect}
        onOpen={onOpen}
        containerRef={containerRef}
      />
    )
  }

  return (
    <ListView
      files={files}
      selected={selected}
      toggleSelect={toggleSelect}
      onOpen={onOpen}
    />
  )
}

// ── Grid view ──────────────────────────────────────────────────────────────────

interface GridViewProps {
  files: FileDoc[]
  selected: Set<number>
  toggleSelect: (id: number) => void
  onOpen: (file: FileDoc) => void
  containerRef: React.RefObject<HTMLDivElement>
}

function GridView({ files, selected, toggleSelect, onOpen, containerRef }: GridViewProps) {
  const [cols, setCols] = useState(MIN_COLS)
  const [tileSize, setTileSize] = useState(TARGET_TILE_PX)
  const [isSelecting, setIsSelecting] = useState(false)

  // Compute cols & tile size from actual container width
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const compute = (width: number) => {
      // How many cols fit? Each col = TARGET_TILE_PX + GAP, minus one trailing GAP.
      // N*(TARGET+GAP) - GAP <= W  =>  N <= (W+GAP)/(TARGET+GAP)
      const rawCols = Math.floor((width + GAP_PX) / (TARGET_TILE_PX + GAP_PX))
      const newCols = Math.max(MIN_COLS, rawCols)
      // Tile fills remaining space after all inter-column gaps
      const newTile = Math.floor((width - GAP_PX * (newCols - 1)) / newCols)
      setCols(newCols)
      setTileSize(newTile)
    }

    const ro = new ResizeObserver(entries => compute(entries[0].contentRect.width))
    ro.observe(el)
    compute(el.offsetWidth)
    return () => ro.disconnect()
  }, [containerRef])

  // Exit select mode when selection is cleared
  useEffect(() => {
    if (selected.size === 0) setIsSelecting(false)
  }, [selected.size])

  const rows = Math.ceil(files.length / cols)
  // Row height = tile + gap below it. The virtualizer stacks rows absolutely,
  // so the "row gap" is the difference between consecutive vRow.start values.
  // We must NOT use CSS gap for rows — only for columns.
  const rowH = tileSize + GAP_PX

  const rowVirtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => containerRef.current,
    estimateSize: () => rowH,
    overscan: 4,
  })

  // Prefetch next batch of thumbnails
  const virtualItems = rowVirtualizer.getVirtualItems()
  const lastVirtualRow = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1

  useEffect(() => {
    if (lastVirtualRow === -1) return
    const nextItemIndex = (lastVirtualRow + 1) * cols
    // Prefetch roughly 5 rows ahead
    const prefetchCount = cols * 5
    for (let i = nextItemIndex; i < nextItemIndex + prefetchCount && i < files.length; i++) {
      const f = files[i]
      if (f.thumb_msg_id) prefetchThumbnail(f.message_id, f.channel_id)
    }
  }, [lastVirtualRow, cols, files])

  const enterSelectMode = useCallback(() => setIsSelecting(true), [])

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map(vRow => {
          const rowFiles = files.slice(vRow.index * cols, (vRow.index + 1) * cols)
          return (
            <div
              key={vRow.key}
              style={{
                position: 'absolute',
                top: vRow.start,
                left: 0,
                right: 0,
                height: rowH,
                display: 'flex',
                alignItems: 'flex-start',
                columnGap: GAP_PX,
              }}
            >
              {rowFiles.map(file => (
                <GridCell
                  key={file.message_id}
                  file={file}
                  size={tileSize}
                  selected={selected.has(file.message_id)}
                  isSelectMode={isSelecting}
                  onToggle={() => {
                    toggleSelect(file.message_id)
                    setIsSelecting(true)
                  }}
                  onOpen={() => {
                    if (isSelecting) {
                      toggleSelect(file.message_id)
                    } else {
                      onOpen(file)
                    }
                  }}
                  onLongPress={enterSelectMode}
                />
              ))}
              {/* Spacers keep last row left-aligned */}
              {rowFiles.length < cols &&
                Array.from({ length: cols - rowFiles.length }).map((_, i) => (
                  <div key={`spacer-${i}`} style={{ width: tileSize, flexShrink: 0 }} />
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Grid cell ──────────────────────────────────────────────────────────────────

interface GridCellProps {
  file: FileDoc
  size: number
  selected: boolean
  isSelectMode: boolean
  onToggle: () => void
  onOpen: () => void
  onLongPress: () => void
}

function GridCell({ file, size, selected, isSelectMode, onToggle, onOpen, onLongPress }: GridCellProps) {
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const didLongPress = useRef(false)

  const startLongPress = useCallback(() => {
    didLongPress.current = false
    lpTimer.current = setTimeout(() => {
      didLongPress.current = true
      onLongPress()
      onToggle()
    }, 500)
  }, [onLongPress, onToggle])

  const cancelLongPress = useCallback(() => {
    if (lpTimer.current) clearTimeout(lpTimer.current)
  }, [])

  const handleClick = useCallback(() => {
    if (didLongPress.current) { didLongPress.current = false; return }
    onOpen()
  }, [onOpen])

  return (
    <div
      draggable
      onDragStart={e => {
        const ids = selected
          ? Array.from(useStore.getState().selected)
          : [file.message_id]
        if (!ids.includes(file.message_id)) ids.push(file.message_id)
        e.dataTransfer.setData('teledrive/msg-ids', ids.join(','))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onMouseDown={startLongPress}
      onMouseUp={cancelLongPress}
      onMouseLeave={cancelLongPress}
      onTouchStart={startLongPress}
      onTouchEnd={cancelLongPress}
      onTouchMove={cancelLongPress}
      onClick={handleClick}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        position: 'relative',
        cursor: 'pointer',
        overflow: 'hidden',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        // Selected: 2px inset blue border (inset shadow doesn't affect layout)
        boxShadow: selected ? 'inset 0 0 0 3px var(--accent)' : 'none',
      }}
    >
      <Thumbnail file={file} size={size} />

      {/* Blue tint when selected */}
      {selected && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(59,130,246,0.22)',
          pointerEvents: 'none',
        }} />
      )}

      {/* Circular check badge — top-left corner */}
      {(isSelectMode || selected) && (
        <button
          onClick={e => { e.stopPropagation(); onToggle() }}
          style={{
            position: 'absolute', top: 6, left: 6, zIndex: 4,
            width: 22, height: 22,
            borderRadius: '50%',
            background: selected ? 'var(--accent)' : 'rgba(0,0,0,0.45)',
            border: selected ? 'none' : '2px solid rgba(255,255,255,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(2px)',
            transition: 'background 0.15s ease',
          }}
        >
          {selected && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6l3 3 5-5" stroke="#fff" strokeWidth="1.8"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      )}
    </div>
  )
}

// ── List view ──────────────────────────────────────────────────────────────────

const LIST_H = 56

function ListView({ files, selected, toggleSelect, onOpen }: {
  files: FileDoc[]
  selected: Set<number>
  toggleSelect: (id: number) => void
  onOpen: (file: FileDoc) => void
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LIST_H,
    overscan: 10,
  })

  // Prefetch next batch of thumbnails
  const virtualItems = rowVirtualizer.getVirtualItems()
  const lastVirtualRow = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1

  useEffect(() => {
    if (lastVirtualRow === -1) return
    const nextItemIndex = lastVirtualRow + 1
    // Prefetch roughly 20 items ahead for list view
    const prefetchCount = 20
    for (let i = nextItemIndex; i < nextItemIndex + prefetchCount && i < files.length; i++) {
      const f = files[i]
      if (f.thumb_msg_id) prefetchThumbnail(f.message_id, f.channel_id)
    }
  }, [lastVirtualRow, files])

  return (
    <div ref={parentRef} style={{ flex: 1, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '44px 44px 1fr auto auto',
        gap: 8,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text-3)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        position: 'sticky',
        top: 0,
        background: 'var(--bg)',
        zIndex: 1,
      }}>
        <span />
        <span />
        <span>Name</span>
        <span style={{ textAlign: 'right' }}>Size</span>
        <span>Resolution</span>
      </div>

      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map(vRow => {
          const file = files[vRow.index]
          const isSel = selected.has(file.message_id)
          return (
            <div
              key={vRow.key}
              draggable
              onDragStart={e => {
                const ids = isSel ? Array.from(useStore.getState().selected) : [file.message_id]
                if (!ids.includes(file.message_id)) ids.push(file.message_id)
                e.dataTransfer.setData('teledrive/msg-ids', ids.join(','))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onClick={() => onOpen(file)}
              style={{
                position: 'absolute',
                top: vRow.start,
                left: 0,
                right: 0,
                height: LIST_H,
                display: 'grid',
                gridTemplateColumns: '44px 44px 1fr auto auto',
                gap: 8,
                padding: '0 16px',
                alignItems: 'center',
                borderBottom: '1px solid var(--border)',
                background: isSel ? 'var(--accent-dim)' : 'transparent',
                cursor: 'pointer',
                transition: 'background 0.1s ease',
              }}
            >
              {/* Checkbox */}
              <button
                onClick={e => { e.stopPropagation(); toggleSelect(file.message_id) }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: isSel ? 'var(--accent)' : 'var(--text-3)',
                  transition: 'color 0.15s ease',
                }}
              >
                {isSel
                  ? <CheckCircle size={16} fill="var(--accent)" color="#fff" strokeWidth={2} />
                  : <Circle size={16} strokeWidth={1.5} />
                }
              </button>

              {/* Thumb */}
              <Thumbnail file={file} size={36} />

              {/* Name */}
              <span className="truncate" style={{ fontSize: 13 }}>{file.name}</span>

              {/* Size */}
              <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                {fmtBytes(file.size)}
              </span>

              {/* Resolution */}
              <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', minWidth: 80, textAlign: 'right' }}>
                {file.resolution !== '-' ? file.resolution : '—'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
