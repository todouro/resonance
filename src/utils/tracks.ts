import type { CoverLookup, Track } from '../types'
import { isAudioFile, readDuration } from './audioFiles.ts'
import { colorFromString, normalizeName } from './covers.ts'
import { autoDetectTrackMetadata, cleanMusicString } from './metadata.ts'
import { forEachWithConcurrency } from './concurrency.ts'
import { objectUrlForFile, revokeOwnedObjectUrl } from './objectUrls.ts'
import { trackIdForFile } from './trackIdentity.ts'

export function cleanDisplayTitle(raw: string): string {
  return cleanMusicString(raw)
}

export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00'
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function uniqueTracks(existing: Track[], incoming: Track[]): Track[] {
  const seen = new Set(existing.map((track) => track.id))
  return incoming.filter((track) => {
    if (seen.has(track.id)) return false
    seen.add(track.id)
    return true
  })
}

export async function tracksFromFiles(
  files: File[],
  covers: CoverLookup,
  existingIds: ReadonlySet<string> = new Set(),
): Promise<Track[]> {
  const seen = new Set(existingIds)
  const audioFiles = files.filter(isAudioFile).filter((file) => {
    const id = trackIdForFile(file)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })

  const tracks: Array<Track | undefined> = new Array(audioFiles.length)
  let hasError = false
  let firstError: unknown

  // Share the same four-worker limiter as native imports. Keep processing the batch after
  // an individual failure so every worker can release its temporary URLs before we reject.
  await forEachWithConcurrency(audioFiles, 4, async (file, fileIndex) => {
    let audioUrl: string | undefined
    let embeddedCoverUrl: string | undefined
    try {
      const detected = await autoDetectTrackMetadata(file.name, file)
      embeddedCoverUrl = detected.coverUrl
      audioUrl = objectUrlForFile(file)
      const duration = await readDuration(audioUrl)

      // Direct name matches: by filename, detected title, or clean title
      let coverUrl =
        covers.get(normalizeName(file.name)) ||
        covers.get(normalizeName(detected.title)) ||
        covers.get(normalizeName(cleanDisplayTitle(detected.title)))
      let coverSource: Track['coverSource'] = coverUrl ? 'direct' : undefined

      // Check parent folder name if relative path exists (e.g. Album folder artwork)
      if (!coverUrl && file.webkitRelativePath) {
        const parts = file.webkitRelativePath.split('/').filter(Boolean)
        if (parts.length > 1) {
          const parentFolder = normalizeName(parts[parts.length - 2])
          if (parentFolder && covers.has(parentFolder)) {
            coverUrl = covers.get(parentFolder)
            coverSource = 'direct'
          }
        }
      }

      // Check album name match in covers
      if (!coverUrl && detected.album) {
        const normAlbum = normalizeName(detected.album)
        if (normAlbum && covers.has(normAlbum)) {
          coverUrl = covers.get(normAlbum)
          coverSource = 'direct'
        }
      }

      // If no folder cover matched, but file had an embedded ID3 cover, use it
      if (!coverUrl && embeddedCoverUrl) {
        coverUrl = embeddedCoverUrl
        coverSource = 'embedded'
      } else if (embeddedCoverUrl) {
        // Metadata parsing created a blob URL that a direct cover made unnecessary.
        revokeOwnedObjectUrl(embeddedCoverUrl)
        embeddedCoverUrl = undefined
      }

      // If album name is missing or "Local files", but file came from folder structure, infer album from folder
      let album = detected.album
      if ((!album || album === 'Local files') && file.webkitRelativePath) {
        const parts = file.webkitRelativePath.split('/').filter(Boolean)
        if (parts.length > 1) {
          album = parts[parts.length - 2]
        }
      }

      tracks[fileIndex] = {
        id: trackIdForFile(file),
        title: detected.title,
        artist: detected.artist,
        album: album || 'Local files',
        duration,
        fileName: file.name,
        audioUrl,
        coverUrl,
        coverSource,
        accent: colorFromString(file.name),
      } satisfies Track
    } catch (error) {
      if (audioUrl) revokeOwnedObjectUrl(audioUrl)
      if (embeddedCoverUrl) revokeOwnedObjectUrl(embeddedCoverUrl)
      if (!hasError) {
        hasError = true
        firstError = error
      }
    }
  })

  if (hasError) {
    // Successful siblings are also discarded when the batch rejects, so release their URLs.
    for (const track of tracks) {
      if (!track) continue
      revokeOwnedObjectUrl(track.audioUrl)
      if (track.coverSource === 'embedded' && track.coverUrl) {
        revokeOwnedObjectUrl(track.coverUrl)
      }
    }
    throw firstError
  }

  return tracks.filter((track): track is Track => track !== undefined)
}
