import { useState, useRef, useEffect } from 'react'
import { Download, X, Package, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { FileDoc, api, PartsResponse } from '../lib/api'
import { fmtBytes } from '../lib/utils'

interface DownloadItem {
  file: FileDoc
  state: 'queued' | 'fetching-parts' | 'downloading' | 'done' | 'error'
  progress: number    // 0-100 for single files, part index for split
  total: number       // total bytes or total parts
  loaded: number
  parts?: PartsResponse
  error?: string
}

interface Props {
  files: FileDoc[]
  onClose: () => void
}

async function streamDownload(
  url: string,
  filename: string,
  onProgress: (loaded: number, total: number) => void,
  signal: AbortSignal,
) {
  const r = await fetch(url, { signal })
  const total = parseInt(r.headers.get('content-length') || '0')
  const reader = r.body!.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0

  while (true) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError")
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value!)
    loaded += value!.length
    onProgress(loaded, total || loaded)
  }

  const blob = new Blob(chunks as BlobPart[])
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export function DownloadManager({ files, onClose }: Props) {
  const [items, setItems] = useState<DownloadItem[]>(
    files.map(f => ({
      file: f, state: 'queued', progress: 0, total: f.size, loaded: 0,
    }))
  )
  const [started, setStarted] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    abortControllerRef.current = controller
    return () => {
      controller.abort()
    }
  }, [])

  function update(message_id: number, patch: Partial<DownloadItem>) {
    setItems(prev => prev.map(it =>
      it.file.message_id === message_id ? { ...it, ...patch } : it
    ))
  }

  async function startAll() {
    setStarted(true)
    for (const item of items) {
      const { file } = item

      if (file.is_split) {
        // Fetch parts info first
        update(file.message_id, { state: 'fetching-parts' })
        try {
          const parts = await api.files.parts(file.message_id, file.channel_id)
          update(file.message_id, { parts, state: 'downloading', total: parts.total_parts })

          // Download each part
          for (const part of parts.parts) {
            const url = api.files.downloadUrl(part.message_id, file.channel_id)
            const filename = `${file.name}.part${String(part.part_num).padStart(3, '0')}.zip`
            await streamDownload(url, filename, (loaded, total) => {
              update(file.message_id, {
                progress: part.part_num - 1 + loaded / total,
              })
            }, abortControllerRef.current!.signal)
            update(file.message_id, { progress: part.part_num })
          }
          update(file.message_id, { state: 'done', progress: parts.total_parts })
        } catch (e: any) {
          update(file.message_id, { state: 'error', error: e.message })
        }
      } else {
        update(file.message_id, { state: 'downloading' })
        try {
          const url = api.files.downloadUrl(file.message_id, file.channel_id)
          await streamDownload(url, file.name, (loaded, total) => {
            update(file.message_id, { loaded, total, progress: Math.round(loaded / total * 100) })
          }, abortControllerRef.current!.signal)
          update(file.message_id, { state: 'done', progress: 100 })
        } catch (e: any) {
          update(file.message_id, { state: 'error', error: e.message })
        }
      }
    }
  }

  const allDone = items.every(i => i.state === 'done' || i.state === 'error')

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 900,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
      padding: 20,
    }}>
      <div style={{
        background: 'var(--bg-1)', border: '1px solid var(--border)',
        borderRadius: 8, width: 380, maxHeight: '70vh',
        display: 'flex', flexDirection: 'column',
        animation: 'fade-in 0.15s ease',
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Download size={14} />
          <span style={{ fontWeight: 500, flex: 1 }}>
            Download {items.length} file{items.length > 1 ? 's' : ''}
          </span>
          <button onClick={onClose} style={{ color: 'var(--text-3)' }}>
            <X size={14} />
          </button>
        </div>

        {/* Items */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {items.map(item => (
            <DownloadRow key={item.file.message_id} item={item} />
          ))}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 16px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 8,
        }}>
          {!started ? (
            <button
              onClick={startAll}
              style={{
                flex: 1, padding: '8px 0',
                background: 'var(--accent)', borderRadius: 'var(--radius)',
                color: '#fff', fontWeight: 500, fontSize: 13,
              }}
            >
              Start Download
            </button>
          ) : (
            <button
              onClick={onClose}
              style={{
                flex: 1, padding: '8px 0',
                background: allDone ? 'var(--bg-3)' : 'var(--bg-2)',
                borderRadius: 'var(--radius)',
                color: allDone ? 'var(--text)' : 'var(--danger)',
                fontSize: 13,
              }}
            >
              {allDone ? 'Close' : 'Cancel Download'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const { file, state, progress, total, loaded, parts, error } = item

  return (
    <div style={{
      padding: '10px 16px', borderBottom: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {file.is_split && <Package size={12} color="var(--warn)" />}
        <span className="truncate" style={{ flex: 1, fontSize: 13 }}>{file.name}</span>
        <StatusIcon state={state} />
      </div>

      {file.is_split && parts && (
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {parts.total_parts} parts · {fmtBytes(parts.parts.reduce((s, p) => s + p.size, 0))}
        </div>
      )}

      {!file.is_split && (
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {fmtBytes(file.size)}
        </div>
      )}

      {/* Progress bar */}
      {(state === 'downloading' || state === 'done') && (
        <div style={{
          height: 3, background: 'var(--bg-3)', borderRadius: 2, overflow: 'hidden',
        }}>
          <div style={{
            height: '100%', borderRadius: 2,
            background: state === 'done' ? 'var(--success)' : 'var(--accent)',
            width: file.is_split
              ? `${Math.round(progress / (total || 1) * 100)}%`
              : `${progress}%`,
            transition: 'width 0.2s ease',
          }} />
        </div>
      )}

      {state === 'error' && (
        <div style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</div>
      )}
    </div>
  )
}

function StatusIcon({ state }: { state: DownloadItem['state'] }) {
  if (state === 'done') return <CheckCircle2 size={14} color="var(--success)" />
  if (state === 'error') return <AlertCircle size={14} color="var(--danger)" />
  if (state === 'downloading' || state === 'fetching-parts')
    return <Loader2 size={14} color="var(--accent)" style={{ animation: 'spin 1s linear infinite' }} />
  return <div style={{ width: 14, height: 14, borderRadius: '50%', border: '1px solid var(--border)' }} />
}
