import { trackIdForFile } from './trackIdentity.ts'

const cachedFileUrls = new Map<string, string>()
const ownedUrls = new Set<string>()
const urlReferenceCounts = new Map<string, number>()

function retainOwnedUrl(url: string): void {
  ownedUrls.add(url)
  urlReferenceCounts.set(url, (urlReferenceCounts.get(url) ?? 0) + 1)
}

/** Reusing the same File's URL prevents duplicate artwork imports from leaking blobs. */
export function objectUrlForFile(file: File): string {
  const key = `${file.type}:${trackIdForFile(file)}`
  const existing = cachedFileUrls.get(key)
  if (existing) {
    retainOwnedUrl(existing)
    return existing
  }
  const url = URL.createObjectURL(file)
  cachedFileUrls.set(key, url)
  retainOwnedUrl(url)
  return url
}

/** Embedded artwork is a fresh Blob, not a re-imported file. */
export function objectUrlForBlob(blob: Blob): string {
  const url = URL.createObjectURL(blob)
  retainOwnedUrl(url)
  return url
}

export function revokeOwnedObjectUrls(): void {
  for (const url of ownedUrls) URL.revokeObjectURL(url)
  ownedUrls.clear()
  cachedFileUrls.clear()
}
