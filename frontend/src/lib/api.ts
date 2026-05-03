import { cacheGet, cacheSet } from './thumbCache'

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
    move: (message_ids: number[], channel_id: number, new_folder_path: string) =>
      post<{ ok: boolean; modified: number }>('/api/files/move', { message_ids, channel_id, new_folder_path }),
    thumbnailUrl: (message_id: number, channel_id: number) =>
      `${BASE}/api/files/${message_id}/thumbnail?channel_id=${channel_id}`,
    thumbnailsBatch: (message_ids: string, channel_id: number) =>
      get<Record<string, string>>(`/api/files/thumbnails?message_ids=${message_ids}&channel_id=${channel_id}`),
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

interface ThumbRequest {
  message_id: number
  channel_id: number
  resolve: (url: string) => void
  reject: (err: unknown) => void
}

let thumbQueue: ThumbRequest[] = []
let thumbTimeout: ReturnType<typeof setTimeout> | null = null

export const loadThumbnail = (message_id: number, channel_id: number): Promise<string> => {
  const cacheKey = `${message_id}:${channel_id}`
  return new Promise(async (resolve, reject) => {
    // 1. Check IDB cache first (fast path)
    const cached = await cacheGet(cacheKey)
    if (cached) { resolve(cached); return }

    // 2. Enqueue for batch network fetch
    thumbQueue.push({ message_id, channel_id, resolve, reject })
    if (!thumbTimeout) {
      thumbTimeout = setTimeout(flushThumbnails, 50)
    }
  })
}

const requestedPrefetch = new Set<string>()

export const prefetchThumbnail = (message_id: number, channel_id: number) => {
  const cacheKey = `${message_id}:${channel_id}`
  if (requestedPrefetch.has(cacheKey)) return
  requestedPrefetch.add(cacheKey)
  
  cacheGet(cacheKey).then(cached => {
    if (cached) return
    thumbQueue.push({ 
      message_id, 
      channel_id, 
      resolve: () => {}, 
      reject: () => {} 
    })
    if (!thumbTimeout) {
      thumbTimeout = setTimeout(flushThumbnails, 50)
    }
  }).catch(() => {})
}

async function flushThumbnails() {
  const batch = thumbQueue
  thumbQueue = []
  thumbTimeout = null

  if (batch.length === 0) return

  const channel_id = batch[0].channel_id
  const message_ids = batch.map(b => b.message_id).join(',')

  try {
    const res = await api.files.thumbnailsBatch(message_ids, channel_id)
    for (const b of batch) {
      const url = res[String(b.message_id)]
      if (url) {
        // Write through to IDB cache
        cacheSet(`${b.message_id}:${b.channel_id}`, url).catch(() => {})
        b.resolve(url)
      } else {
        b.reject(new Error('Not found'))
      }
    }
  } catch (err) {
    batch.forEach(b => b.reject(err))
  }
}

