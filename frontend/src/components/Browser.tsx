import { useState, useEffect } from 'react'
import {
  Grid, List, FolderOpen, Layers, Image, FileVideo,
  FileAudio, File, Download, X, ChevronRight, RefreshCw,
  Share2, Folder,
} from 'lucide-react'
import { api, FileDoc, MediaType } from '../lib/api'
import { useStore } from '../lib/store'
import { childFolders, parentPath } from '../lib/utils'
import { FileGrid } from './FileGrid'
import { Lightbox } from './Lightbox'
import { DownloadManager } from './DownloadManager'
import { ShareModal } from './ShareModal'

export function Browser() {
  const {
    channel, folderPath, setFolderPath,
    browseMode, setBrowseMode,
    viewMode, setViewMode,
    typeFilter, setTypeFilter,
    selected, clearSelection, selectAll,
  } = useStore()

  const [files, setFiles] = useState<FileDoc[]>([])
  const [allFolders, setAllFolders] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)

  // Lightbox
  const [lightboxFile, setLightboxFile] = useState<FileDoc | null>(null)
  // Download manager
  const [dlFiles, setDlFiles] = useState<FileDoc[] | null>(null)
  // Share modal
  const [shareOpen, setShareOpen] = useState(false)

  const channelId = channel?.channel_id

  // Load folder list once per channel
  useEffect(() => {
    if (!channelId) return
    api.files.folders(channelId).then(r => setAllFolders(r.folders))
  }, [channelId])

  // Load files
  useEffect(() => {
    if (!channelId) return
    setLoading(true)
    const params: Parameters<typeof api.files.list>[0] = {
      channel_id: channelId,
      limit: 500,
    }
    if (browseMode === 'folder') {
      params.path = folderPath
    } else {
      params.recursive = true
      if (folderPath) params.path = folderPath
      if (typeFilter) params.type = typeFilter
    }
    api.files.list(params)
      .then(r => { setFiles(r.items); setTotal(r.total) })
      .finally(() => setLoading(false))
  }, [channelId, folderPath, browseMode, typeFilter])

  if (!channel) return null

  const childFolderNames = childFolders(allFolders, folderPath)
  const selectedFiles = files.filter(f => selected.has(f.message_id))

  const handleOpen = (file: FileDoc) => {
    if (file.type === 'image' && !file.is_split) setLightboxFile(file)
  }

  const handleDownloadSelected = () => {
    if (selectedFiles.length > 0) setDlFiles(selectedFiles)
  }

  const handleDownloadSingle = (file: FileDoc) => setDlFiles([file])

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      overflow: 'hidden', background: 'var(--bg)',
    }}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={{
        borderBottom: '1px solid var(--border)',
        padding: '8px 16px',
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        background: 'var(--bg-1)',
      }}>
        {/* Breadcrumb */}
        <BreadCrumb path={folderPath} onNavigate={setFolderPath} />

        <div style={{ flex: 1 }} />

        {/* Mode toggle: folder / type */}
        <ModeToggle
          value={browseMode}
          onChange={(m) => { setBrowseMode(m as any); setTypeFilter('') }}
          options={[
            { value: 'folder', icon: <FolderOpen size={13} />, label: 'Folders' },
            { value: 'type', icon: <Layers size={13} />, label: 'By type' },
          ]}
        />

        {/* Type filter (only in type mode) */}
        {browseMode === 'type' && (
          <TypeFilter value={typeFilter} onChange={setTypeFilter} />
        )}

        {/* View toggle: grid / list */}
        <ModeToggle
          value={viewMode}
          onChange={setViewMode as any}
          options={[
            { value: 'grid', icon: <Grid size={13} />, label: '' },
            { value: 'list', icon: <List size={13} />, label: '' },
          ]}
        />

        {/* Share */}
        <ToolBtn onClick={() => setShareOpen(true)} title="Share this folder">
          <Share2 size={13} /> Share
        </ToolBtn>

        {/* Sync */}
        <ToolBtn
          onClick={() => api.sync.start(channel.channel_id)}
          title="Sync DB from Telegram"
        >
          <RefreshCw size={13} />
        </ToolBtn>
      </div>

      {/* ── Selection bar ─────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div style={{
          background: 'var(--accent-dim)', borderBottom: '1px solid var(--accent)',
          padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 13,
        }}>
          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>
            {selected.size} selected
          </span>
          <button onClick={() => selectAll(files.map(f => f.message_id))}
            style={{ color: 'var(--text-2)', fontSize: 12 }}>
            Select all {total}
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={handleDownloadSelected}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'var(--accent)', color: '#fff',
              borderRadius: 'var(--radius)', padding: '4px 10px', fontSize: 12,
            }}
          >
            <Download size={12} /> Download {selected.size}
          </button>
          <button onClick={clearSelection} style={{ color: 'var(--text-3)' }}>
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Folder sidebar — only in folder mode */}
        {browseMode === 'folder' && childFolderNames.length > 0 && (
          <div style={{
            width: 200, borderRight: '1px solid var(--border)',
            overflowY: 'auto', padding: '8px 0', flexShrink: 0,
          }}>
            {folderPath && (
              <button
                onClick={() => setFolderPath(parentPath(folderPath))}
                style={{
                  width: '100%', padding: '6px 12px',
                  textAlign: 'left', fontSize: 12,
                  color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                ← Back
              </button>
            )}
            {childFolderNames.map(name => {
              const fullPath = folderPath ? `${folderPath}/${name}` : name
              return (
                <button
                  key={name}
                  onClick={() => setFolderPath(fullPath)}
                  style={{
                    width: '100%', padding: '6px 12px',
                    textAlign: 'left', fontSize: 13,
                    display: 'flex', alignItems: 'center', gap: 7,
                    color: 'var(--text-2)',
                    borderRadius: 0,
                  }}
                >
                  <Folder size={13} color="var(--text-3)" />
                  <span className="truncate">{name}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Files area */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {loading ? (
            <div style={{ padding: 24, color: 'var(--text-3)' }}>Loading…</div>
          ) : files.length === 0 ? (
            <div style={{ padding: 24, color: 'var(--text-3)' }}>No files here.</div>
          ) : (
            <FileGrid files={files} onOpen={handleOpen} />
          )}
        </div>
      </div>

      {/* ── Overlays ───────────────────────────────────────────────── */}
      {lightboxFile && (
        <Lightbox
          file={lightboxFile}
          files={files}
          onClose={() => setLightboxFile(null)}
          onDownload={handleDownloadSingle}
        />
      )}
      {dlFiles && (
        <DownloadManager files={dlFiles} onClose={() => { setDlFiles(null); clearSelection() }} />
      )}
      {shareOpen && (
        <ShareModal
          channel={channel}
          path={folderPath || undefined}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  )
}

/* ── Small pieces ─────────────────────────────────────────────────────────── */

function BreadCrumb({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const parts = path ? path.split('/') : []
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
      <button
        onClick={() => onNavigate('')}
        style={{ color: path ? 'var(--text-2)' : 'var(--text)', fontWeight: path ? 400 : 500 }}
      >
        Root
      </button>
      {parts.map((part, i) => {
        const p = parts.slice(0, i + 1).join('/')
        const isLast = i === parts.length - 1
        return (
          <span key={p} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ChevronRight size={12} color="var(--text-3)" />
            <button
              onClick={() => onNavigate(p)}
              style={{ color: isLast ? 'var(--text)' : 'var(--text-2)', fontWeight: isLast ? 500 : 400 }}
            >
              {part}
            </button>
          </span>
        )
      })}
    </div>
  )
}

function ModeToggle({ value, onChange, options }: {
  value: string
  onChange: (v: string) => void
  options: { value: string; icon: React.ReactNode; label: string }[]
}) {
  return (
    <div style={{
      display: 'flex', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', overflow: 'hidden',
    }}>
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          style={{
            padding: '5px 10px', fontSize: 12,
            display: 'flex', alignItems: 'center', gap: 5,
            background: value === opt.value ? 'var(--bg-3)' : 'transparent',
            color: value === opt.value ? 'var(--text)' : 'var(--text-3)',
          }}
        >
          {opt.icon}{opt.label}
        </button>
      ))}
    </div>
  )
}

function TypeFilter({ value, onChange }: { value: MediaType | ''; onChange: (v: MediaType | '') => void }) {
  const types: { v: MediaType | ''; icon: any; label: string }[] = [
    { v: '', icon: Layers, label: 'All' },
    { v: 'image', icon: Image, label: 'Images' },
    { v: 'video', icon: FileVideo, label: 'Videos' },
    { v: 'audio', icon: FileAudio, label: 'Audio' },
    { v: 'document', icon: File, label: 'Docs' },
  ]
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {types.map(t => (
        <button
          key={t.v}
          onClick={() => onChange(t.v)}
          style={{
            padding: '4px 10px', fontSize: 12, borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: value === t.v ? 'var(--bg-3)' : 'transparent',
            color: value === t.v ? 'var(--text)' : 'var(--text-3)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <t.icon size={11} /> {t.label}
        </button>
      ))}
    </div>
  )
}

function ToolBtn({ children, onClick, title }: {
  children: React.ReactNode; onClick: () => void; title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: '5px 10px', fontSize: 12,
        display: 'flex', alignItems: 'center', gap: 5,
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        color: 'var(--text-2)',
      }}
    >
      {children}
    </button>
  )
}
