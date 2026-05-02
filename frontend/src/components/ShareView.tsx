import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { HardDrive, AlertCircle } from 'lucide-react'
import { api, Share, FileDoc, Channel } from '../lib/api'
import { useStore } from '../lib/store'
import { FileGrid } from './FileGrid'
import { Lightbox } from './Lightbox'
import { DownloadManager } from './DownloadManager'
import { fmtBytes } from '../lib/utils'

export function ShareView() {
  const { token } = useParams<{ token: string }>()
  const [share, setShare] = useState<Share | null>(null)
  const [files, setFiles] = useState<FileDoc[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const { selected, clearSelection } = useStore()
  const [lightboxFile, setLightboxFile] = useState<FileDoc | null>(null)
  const [dlFiles, setDlFiles] = useState<FileDoc[] | null>(null)

  useEffect(() => {
    if (!token) return
    api.shares.resolve(token)
      .then(s => {
        setShare(s)
        return api.files.list({
          channel_id: s.channel_id,
          path: s.path || '',
          recursive: !s.path,
          limit: 500,
        })
      })
      .then(r => setFiles(r.items))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [token])

  if (loading) return <CenteredMsg>Loading…</CenteredMsg>
  if (error) return <CenteredMsg icon={<AlertCircle size={20} color="var(--danger)" />}>{error}</CenteredMsg>
  if (!share) return null

  const selectedFiles = files.filter(f => selected.has(f.message_id))

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-1)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <HardDrive size={16} color="var(--accent)" />
        <span style={{ fontWeight: 600, fontSize: 14 }}>TeleDrive</span>
        <div style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {share.label || share.channel_title}
          {share.path && <span style={{ color: 'var(--text-3)' }}> / {share.path}</span>}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {files.length} files · read-only
        </span>
      </div>

      {/* Selection bar */}
      {selected.size > 0 && (
        <div style={{
          background: 'var(--accent-dim)', borderBottom: '1px solid var(--accent)',
          padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
        }}>
          <span style={{ color: 'var(--accent)', fontWeight: 500 }}>{selected.size} selected</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setDlFiles(selectedFiles)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'var(--accent)', color: '#fff',
              borderRadius: 'var(--radius)', padding: '4px 10px', fontSize: 12,
            }}
          >
            Download {selected.size}
          </button>
          <button onClick={clearSelection} style={{ color: 'var(--text-3)', fontSize: 12 }}>Clear</button>
        </div>
      )}

      {/* Files */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {files.length === 0 ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
            This share is empty.
          </div>
        ) : (
          <FileGrid
            files={files}
            onOpen={f => {
              if (f.type === 'image' && !f.is_split) setLightboxFile(f)
            }}
          />
        )}
      </div>

      {lightboxFile && (
        <Lightbox
          file={lightboxFile}
          files={files}
          onClose={() => setLightboxFile(null)}
          onDownload={f => setDlFiles([f])}
        />
      )}
      {dlFiles && (
        <DownloadManager files={dlFiles} onClose={() => { setDlFiles(null); clearSelection() }} />
      )}
    </div>
  )
}

function CenteredMsg({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 10,
      color: 'var(--text-3)', fontSize: 14,
    }}>
      {icon}
      {children}
    </div>
  )
}
