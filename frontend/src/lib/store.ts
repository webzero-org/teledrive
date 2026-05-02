import { create } from 'zustand'
import type { Channel, ViewMode, BrowseMode, MediaType } from './api'

interface AppState {
  // Selected channel
  channel: Channel | null
  setChannel: (c: Channel | null) => void

  // Navigation
  folderPath: string          // current folder path in folder mode
  setFolderPath: (p: string) => void

  browseMode: BrowseMode
  setBrowseMode: (m: BrowseMode) => void

  viewMode: ViewMode
  setViewMode: (m: ViewMode) => void

  typeFilter: MediaType | ''
  setTypeFilter: (t: MediaType | '') => void

  // Selection
  selected: Set<number>       // set of message_ids
  toggleSelect: (id: number) => void
  clearSelection: () => void
  selectAll: (ids: number[]) => void
}

export const useStore = create<AppState>((set) => ({
  channel: null,
  setChannel: (c) => set({ channel: c, folderPath: '', selected: new Set() }),

  folderPath: '',
  setFolderPath: (p) => set({ folderPath: p, selected: new Set() }),

  browseMode: 'folder',
  setBrowseMode: (m) => set({ browseMode: m }),

  viewMode: 'grid',
  setViewMode: (m) => set({ viewMode: m }),

  typeFilter: '',
  setTypeFilter: (t) => set({ typeFilter: t }),

  selected: new Set(),
  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selected)
      next.has(id) ? next.delete(id) : next.add(id)
      return { selected: next }
    }),
  clearSelection: () => set({ selected: new Set() }),
  selectAll: (ids) => set({ selected: new Set(ids) }),
}))
