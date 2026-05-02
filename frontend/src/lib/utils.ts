export function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export function pathParts(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).join('/')
}

/** Given a list of file paths, return direct child folder names under `prefix` */
export function childFolders(allFolderPaths: string[], prefix: string): string[] {
  const depth = prefix ? prefix.split('/').length : 0
  const seen = new Set<string>()
  for (const p of allFolderPaths) {
    if (prefix && !p.startsWith(prefix + '/') && p !== prefix) continue
    if (!prefix && p === '') continue
    const parts = p.split('/').filter(Boolean)
    if (parts.length > depth) {
      seen.add(parts[depth])
    }
  }
  return [...seen].sort()
}
