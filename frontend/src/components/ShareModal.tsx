import { useState, useEffect } from 'react'
import { X, Copy, Trash2, Link, Check } from 'lucide-react'
import { api, Share, Channel } from '../lib/api'

interface Props {
  channel: Channel
  path?: string
  onClose: () => void
}

export function ShareModal({ channel, path, onClose }: Props) {
  const [shares, setShares] = useState<Share[]>([])
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const baseUrl = window.location.origin

  useEffect(() => {
    api.shares.list().then(r =>
      setShares(r.shares.filter(s => s.channel_id === channel.channel_id))
    )
  }, [channel.channel_id])

  async function create() {
    setCreating(true)
    try {
      const { token } = await api.shares.create({
        channel_id: channel.channel_id,
        path: path || undefined,
        label: label || (path ? `${channel.title}/${path}` : channel.title),
      })
      const newShare = await api.shares.resolve(token)
      setShares(prev => [{ ...newShare, created_at: new Date().toISOString(), expires_at: null } as Share, ...prev])
      setLabel('')
    } finally {
      setCreating(false)
    }
  }

  async function remove(token: string) {
    await api.shares.delete(token)
    setShares(prev => prev.filter(s => s.token !== token))
  }

  function copy(token: string) {
    navigator.clipboard.writeText(`${baseUrl}/s/${token}`)
    setCopied(token)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 800,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-1)', border: '1px solid var(--border)',
          borderRadius: 8, width: 440, maxHeight: '80vh',
          display: 'flex', flexDirection: 'column',
          animation: 'fade-in 0.15s ease',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Link size={14} />
          <span style={{ fontWeight: 500, flex: 1 }}>Share links</span>
          <button onClick={onClose} style={{ color: 'var(--text-3)' }}>
            <X size={14} />
          </button>
        </div>

        {/* Context */}
        <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-3)' }}>
          {path ? (
            <span>Sharing: <strong style={{ color: 'var(--text-2)' }}>{channel.title}/{path}</strong></span>
          ) : (
            <span>Sharing entire channel: <strong style={{ color: 'var(--text-2)' }}>{channel.title}</strong></span>
          )}
          <div style={{ marginTop: 4 }}>Anyone with the link can view and download — no login needed.</div>
        </div>

        {/* Create */}
        <div style={{
          padding: '0 16px 12px',
          display: 'flex', gap: 8,
        }}>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Label (optional)"
            style={{
              flex: 1, padding: '7px 10px',
              background: 'var(--bg-2)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 13,
            }}
          />
          <button
            onClick={create}
            disabled={creating}
            style={{
              padding: '7px 14px', background: 'var(--accent)',
              borderRadius: 'var(--radius)', color: '#fff', fontSize: 13,
              opacity: creating ? 0.6 : 1,
            }}
          >
            {creating ? 'Creating…' : 'Create link'}
          </button>
        </div>

        {/* Existing shares */}
        <div style={{ overflowY: 'auto', flex: 1, borderTop: '1px solid var(--border)' }}>
          {shares.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
              No share links yet
            </div>
          ) : shares.map(s => (
            <div key={s.token} style={{
              padding: '10px 16px', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }} className="truncate">
                  {s.label || s.token}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                  /s/{s.token}
                  {s.path && <> · {s.path}</>}
                </div>
              </div>
              <button
                onClick={() => copy(s.token)}
                title="Copy link"
                style={{ color: copied === s.token ? 'var(--success)' : 'var(--text-3)', padding: 4 }}
              >
                {copied === s.token ? <Check size={14} /> : <Copy size={14} />}
              </button>
              <button
                onClick={() => remove(s.token)}
                title="Delete"
                style={{ color: 'var(--text-3)', padding: 4 }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
