const BASE = import.meta.env.VITE_API_URL ?? ''

export type MediaType = 'image' | 'video' | 'audio' | 'document'
export type ViewMode = 'grid' | 'list'
export type BrowseMode = 'folder' | 'type'

export interface FileDoc {
  id: string
  message_id: number
  channel_id: number
  type: MediaType
  path: string
  folder_path: string
  name: string
  resolution: string
  thumb_msg_id: number | null
  size: number
  mime_type: string
  date: string
  is_split: boolean
  group_id?: string
  total_parts?: number
  part_num?: number
}

export interface PartInfo {
  part_num: number
  message_id: number
  size: number
}

export interface PartsResponse {
  is_split: boolean
  group_id?: string
  total_parts: number
  filename: string
  parts: PartInfo[]
}

export interface Channel {
  id: string
  channel_id: number
  title: string
}

export interface Share {
  id: string
  token: string
  channel_id: number
  channel_title: string
  path: string | null
  label: string
  created_at: string
  expires_at: string | null
}

async function get<T>(url: string): Promise<T> {
  const r = await fetch(BASE + url)
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

async function del<T>(url: string): Promise<T> {
  const r = await fetch(BASE + url, { method: 'DELETE' })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

export const api = {
  // Channels
  channels: {
    list: () => get<{ channels: Channel[] }>('/api/channels'),
    create: (title: string) => post<{ channel_id: number; title: string }>('/api/channels?title=' + encodeURIComponent(title), { title }),
  },

  // Files
  files: {
    list: (params: {
      channel_id: number
      path?: string
      type?: string
      recursive?: boolean
      skip?: number
      limit?: number
    }) => {
      const q = new URLSearchParams()
      q.set('channel_id', String(params.channel_id))
      if (params.path !== undefined) q.set('path', params.path)
      if (params.type) q.set('type', params.type)
      if (params.recursive) q.set('recursive', 'true')
      if (params.skip) q.set('skip', String(params.skip))
      if (params.limit) q.set('limit', String(params.limit))
      return get<{ total: number; items: FileDoc[] }>(`/api/files?${q}`)
    },
    folders: (channel_id: number) =>
      get<{ folders: string[] }>(`/api/files/folders?channel_id=${channel_id}`),
    thumbnailUrl: (message_id: number, channel_id: number) =>
      `${BASE}/api/files/${message_id}/thumbnail?channel_id=${channel_id}`,
    downloadUrl: (message_id: number, channel_id: number) =>
      `${BASE}/api/files/${message_id}/download?channel_id=${channel_id}`,
    parts: (message_id: number, channel_id: number) =>
      get<PartsResponse>(`/api/files/${message_id}/parts?channel_id=${channel_id}`),
  },

  // Shares
  shares: {
    list: () => get<{ shares: Share[] }>('/api/shares'),
    create: (body: { channel_id: number; path?: string; label?: string; expires_in_days?: number }) =>
      post<{ token: string }>('/api/shares', body),
    resolve: (token: string) => get<Share>(`/api/shares/${token}`),
    delete: (token: string) => del<{ ok: boolean }>(`/api/shares/${token}`),
  },

  // Sync
  sync: {
    start: (channel_id: number) => post<{ ok: boolean }>('/api/sync', { channel_id }),
    status: (channel_id: number) =>
      get<{ running: boolean; processed: number; errors: number }>(`/api/sync/status/${channel_id}`),
  },
}
