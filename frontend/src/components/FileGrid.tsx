import { useRef, useState, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { CheckSquare, Square } from 'lucide-react'
import { FileDoc } from '../lib/api'
import { Thumbnail } from './Thumbnail'
import { fmtBytes, fmtDate } from '../lib/utils'
import { useStore } from '../lib/store'

const GRID_ITEM_W = 200
const GRID_ITEM_H = 200
const LIST_ITEM_H = 52

interface Props {
  files: FileDoc[]
  onOpen: (file: FileDoc) => void
}

export function FileGrid({ files, onOpen }: Props) {
  const { viewMode, selected, toggleSelect } = useStore()
  const containerRef = useRef<HTMLDivElement>(null)

  /* ── Grid mode ─────────────────────────────────────────────────────────── */
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

  /* ── List mode ─────────────────────────────────────────────────────────── */
  return (
    <ListView
      files={files}
      selected={selected}
      toggleSelect={toggleSelect}
      onOpen={onOpen}
    />
  )
}

/* ── Grid view ─────────────────────────────────────────────────────────────── */

function GridView({ files, selected, toggleSelect, onOpen, containerRef }: any) {
  const [cols, setCols] = useState(7)

  const rows = Math.ceil(files.length / cols)
  const rowVirtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => containerRef.current,
    estimateSize: () => GRID_ITEM_H  + 4,
    overscan: 3,
  })

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map(vRow => {
          const rowFiles = files.slice(vRow.index * cols, (vRow.index + 1) * cols)
          return (
            <div
              key={vRow.key}
              style={{
                position: 'absolute', top: vRow.start, left: 0, right: 0,
                display: 'flex', gap: 4, padding: '0 16px', 
              }}
            >
              {rowFiles.map((file: FileDoc) => (
                <GridCell
                  key={file.message_id}
                  file={file}
                  selected={selected.has(file.message_id)}
                  onToggle={() => toggleSelect(file.message_id)}
                  onOpen={() => onOpen(file)}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GridCell({ file, selected, onToggle, onOpen }: {
  file: FileDoc; selected: boolean; onToggle: () => void; onOpen: () => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: GRID_ITEM_W, flexShrink: 0,
        cursor: 'pointer', position: 'relative',
        // borderRadius: 'var(--radius)',
        outline: selected ? '2px solid var(--accent)' : 'none',
        outlineOffset: 2,
      }}
    >
      {/* Checkbox */}
      <button
        onClick={e => { e.stopPropagation(); onToggle() }}
        style={{
          position: 'absolute', top: 6, left: 6, zIndex: 2,
          opacity: hovered || selected ? 1 : 0,
          transition: 'opacity 0.12s',
          background: 'rgba(0,0,0,0.6)', borderRadius: 4, padding: 2,
          color: selected ? 'var(--accent)' : 'var(--text)',
          height: "20px",
        }}
      >
        {selected ? <CheckSquare size={16} /> : <Square size={16} />}
      </button>

      <div onClick={onOpen}>
        <Thumbnail file={file} size={GRID_ITEM_W} />
        {/* <div style={{ padding: '6px 2px' }}>
          <div className="truncate" style={{ fontSize: 12, fontWeight: 500 }}>
            {file.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            {fmtBytes(file.size)}
            {file.resolution !== '-' && <> · {file.resolution}</>}
          </div>
        </div> */}
      </div>
    </div>
  )
}

/* ── List view ─────────────────────────────────────────────────────────────── */

function ListView({ files, selected, toggleSelect, onOpen }: any) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => LIST_ITEM_H,
    overscan: 10,
  })

  return (
    <div ref={parentRef} style={{ flex: 1, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '24px 32px 1fr 80px 100px 90px',
        gap: 8, padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text-3)', fontSize: 11, textTransform: 'uppercase',
        letterSpacing: '0.05em', position: 'sticky', top: 0,
        background: 'var(--bg)', zIndex: 1,
      }}>
        <span />
        <span />
        <span>Name</span>
        <span style={{ textAlign: 'right' }}>Size</span>
        <span>Resolution</span>
        {/* <span>Date</span> */}
      </div>

      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map(vRow => {
          const file: FileDoc = files[vRow.index]
          const isSel = selected.has(file.message_id)
          return (
            <div
              key={vRow.key}
              style={{
                position: 'absolute', top: vRow.start, left: 0, right: 0,
                height: LIST_ITEM_H,
                display: 'grid',
                gridTemplateColumns: '24px 32px 1fr 80px 100px 90px',
                gap: 8, padding: '0 16px',
                alignItems: 'center',
                borderBottom: '1px solid var(--border)',
                background: isSel ? 'var(--accent-dim)' : 'transparent',
                cursor: 'pointer',
              }}
              onClick={() => onOpen(file)}
            >
              <button
                onClick={e => { e.stopPropagation(); toggleSelect(file.message_id) }}
                style={{ color: isSel ? 'var(--accent)' : 'var(--text-3)' }}
              >
                {isSel ? <CheckSquare size={13} /> : <Square size={13} />}
              </button>

              <Thumbnail file={file} size={28} />

              <span className="truncate" style={{ fontSize: 13 }}>{file.name}</span>

              <span style={{
                textAlign: 'right', fontSize: 12,
                color: 'var(--text-3)', fontFamily: 'var(--font-mono)',
              }}>
                {fmtBytes(file.size)}
              </span>

              <span style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                {file.resolution !== '-' ? file.resolution : '—'}
              </span>

              {/* <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {file.date ? fmtDate(file.date) : '—'}
              </span> */}
            </div>
          )
        })}
      </div>
    </div>
  )
}
