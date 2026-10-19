import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Music2, X } from 'lucide-react'
import { fetchPublicSpotifyLink } from '../../services/spotify'
import type { SpotifyPublicLinkResult, SpotifyTrackSummary } from '../../services/spotify'
import { useMusicStore } from '../../store/useMusicStore'
import type { Track } from '../../types'

type SpotifyImportModalProps = {
  onClose: () => void
  musicFolderPath?: string
  isDesktop: boolean
  onRefreshLibrary: () => Promise<unknown> | unknown
}
type ImportSummary = {
  name: string
  kind: string
  trackCount: number
  downloaded: number
  matched: number
  missing: number
  failures: string[]
  playlistCreated: boolean
}
type DownloadProgress = {
  stage: 'preparing' | 'downloading'
  percent: number | null
  speed: string
  eta: string
  message: string
}

function normalize(value: string): string {
  return value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(remaster(?:ed)?|explicit version|clean version)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function matchLocalTracks(
  spotifyTracks: SpotifyTrackSummary[],
  localTracks: Track[],
): { ids: string[]; matched: number; missing: number } {
  const playable = localTracks.filter((track) => !track.unavailable && Boolean(track.filePath || track.audioUrl))
  const byTitle = new Map<string, Track[]>()
  for (const track of playable) {
    const key = normalize(track.title)
    if (!key) continue
    const existing = byTitle.get(key) ?? []
    existing.push(track)
    byTitle.set(key, existing)
  }

  const ids: string[] = []
  let matched = 0
  for (const spotifyTrack of spotifyTracks) {
    const candidates = byTitle.get(normalize(spotifyTrack.name)) ?? []
    const artistKeys = spotifyTrack.artists.map(normalize).filter(Boolean)
    const localTrack = candidates.find((candidate) => {
      const localArtist = normalize(candidate.artist)
      return artistKeys.length === 0 || artistKeys.some((artist) => localArtist === artist || localArtist.includes(artist) || artist.includes(localArtist))
    })
    if (localTrack) {
      matched += 1
      ids.push(localTrack.id)
    }
  }

  const uniqueIds = Array.from(new Set(ids))
  return { ids: uniqueIds, matched, missing: Math.max(0, spotifyTracks.length - matched) }
}

function SpotifyMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" role="img" aria-label="Spotify">
      <circle cx="16" cy="16" r="16" fill="#1ed760" />
      <path d="M7.8 12.1c6.8-2.1 13.6-1 18.1 1.8M9.1 16.2c5.7-1.7 11.4-.8 15.5 1.7M10.4 20.1c4.6-1.3 9.1-.7 12.3 1.4" fill="none" stroke="#07110a" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

export function SpotifyImportModal({ onClose, musicFolderPath, isDesktop, onRefreshLibrary }: SpotifyImportModalProps) {
  const [spotifyUrl, setSpotifyUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SpotifyPublicLinkResult | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [downloadStatus, setDownloadStatus] = useState('')
  const [cancelled, setCancelled] = useState(false)
  const cancelRequested = useRef(false)
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  useEffect(() => {
    if (!isDesktop) return
    let unlisten: (() => void) | undefined
    let disposed = false
    listen<DownloadProgress>('download-progress', (event) => setDownloadProgress(event.payload))
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {
        // A missing progress event must not prevent downloads.
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [isDesktop])

  const handleCancel = async () => {
    cancelRequested.current = true
    setCancelled(true)
    try {
      await invoke<boolean>('cancel_download')
    } catch {
      // There may be no active media process if we are between tracks.
    }
  }

  const handleFetch = async () => {
    setError(null)
    setPreview(null)
    setSummary(null)
    if (!spotifyUrl.trim()) {
      setError('Paste a public Spotify playlist, album, or track link first.')
      return
    }

    setBusy(true)
    try {
      const result = await fetchPublicSpotifyLink(spotifyUrl)
      if (!result.tracks.length) {
        throw new Error('Spotify did not expose any tracks for this link. Try another public link.')
      }
      setPreview(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not fetch this public Spotify link.')
    } finally {
      setBusy(false)
    }
  }

  const handleImport = async () => {
    if (!preview || busy) return
    if (!isDesktop) {
      setError('Track downloads are available in the Resonance Windows desktop app.')
      return
    }
    if (!musicFolderPath) {
      setError('Choose your Music folder in Settings before downloading Spotify tracks.')
      return
    }
    if (preview.tracks.length > 20 && !window.confirm(
      `This link exposes ${preview.tracks.length} tracks. Resonance will search for a likely audio match for each missing local track. Continue downloading?`,
    )) return

    setError(null)
    setSummary(null)
    setBusy(true)
    setCancelled(false)
    cancelRequested.current = false
    setDownloadStatus('Preparing Spotify track downloads…')
    let downloaded = 0
    const failures: string[] = []

    try {
      for (let index = 0; index < preview.tracks.length; index += 1) {
        if (cancelRequested.current) break
        const track = preview.tracks[index]
        const existing = matchLocalTracks([track], useMusicStore.getState().tracks)
        if (existing.matched > 0) {
          setDownloadStatus(`Already in your library: ${track.name} (${index + 1}/${preview.tracks.length})`)
          continue
        }

        const artist = track.artists.join(', ')
        setDownloadStatus(`Finding audio match ${index + 1}/${preview.tracks.length}: ${artist ? `${artist} — ` : ''}${track.name}`)
        setDownloadProgress(null)
        try {
          await invoke<string>('download_spotify_track', {
            title: track.name,
            artist,
            outputDir: musicFolderPath,
            format: 'best',
          })
          downloaded += 1
        } catch (cause) {
          if (cancelRequested.current) break
          const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'No suitable audio source was found.'
          failures.push(`${track.name}: ${detail}`)
        }
      }

      if (downloaded > 0) {
        setDownloadStatus(`Scanning Music folder for ${downloaded} downloaded file(s)…`)
        await onRefreshLibrary()
      }

      const matched = matchLocalTracks(preview.tracks, useMusicStore.getState().tracks)
      const playlistCreated = matched.ids.length > 0
      if (playlistCreated) {
        useMusicStore.getState().importSpotifyPublicPlaylist({
          id: `spotify-public:${preview.kind}:${preview.id}`,
          name: preview.name,
          externalUrl: preview.externalUrl,
          totalTracks: preview.totalTracks,
          unmatchedTracks: matched.missing,
          trackIds: matched.ids,
        }, [])
      }

      setSummary({
        name: preview.name,
        kind: preview.kind,
        trackCount: preview.tracks.length,
        downloaded,
        matched: matched.matched,
        missing: matched.missing,
        failures: failures.slice(0, 5),
        playlistCreated,
      })
      if (!playlistCreated) {
        setError('No playable local audio files were found, so Resonance did not create a metadata-only playlist. Check the download failures below and try again.')
      } else if (failures.length > 0) {
        setError(`Finished with ${failures.length} download failure(s). Only tracks backed by real local files were added to the playlist.`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not download tracks from this Spotify link.')
    } finally {
      setBusy(false)
      setDownloadProgress(null)
      setDownloadStatus(cancelRequested.current ? 'Download cancelled.' : '')
      cancelRequested.current = false
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()} role="dialog" aria-modal="true" aria-labelledby="spotify-import-title">
      <div className="modal-card spotify-modal-card" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="spotify-brand-lockup">
            <SpotifyMark />
            <div>
              <h3 id="spotify-import-title">Import from Spotify</h3>
              <p className="spotify-modal-subtitle">Import a public playlist, album, or track without app setup.</p>
            </div>
          </div>
          <button type="button" className="modal-close-btn" aria-label="Close Spotify import" title="Close" onClick={onClose} disabled={busy}>
            <X size={18} />
          </button>
        </header>

        <div className="spotify-import-body">
          <p className="spotify-import-note">
            No Spotify Developer Dashboard, Client ID, or Premium subscription is needed for public links. Resonance reads metadata Spotify exposes publicly; it cannot access private playlists or your personal Liked Songs through this method.
          </p>

          <label className="spotify-client-id-label">
            Spotify playlist, album, or track link
            <input
              className="spotify-client-id-input"
              value={spotifyUrl}
              onChange={(event) => {
                setSpotifyUrl(event.target.value)
                setPreview(null)
                setSummary(null)
                setError(null)
              }}
              placeholder="https://open.spotify.com/playlist/..."
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !busy) void handleFetch()
              }}
            />
          </label>

          <div className="spotify-import-actions">
            <button type="button" className="spotify-connect-button" disabled={busy || !spotifyUrl.trim()} onClick={() => void handleFetch()}>
              {busy ? <><LoaderCircle size={16} className="spinning" /> Working…</> : <><Music2 size={17} /> Fetch tracks</>}
            </button>
            {preview && (
              <>
                <button type="button" className="spotify-secondary-button" disabled={busy || !isDesktop || !musicFolderPath} onClick={() => void handleImport()}>
                  {busy ? <><LoaderCircle size={15} className="spinning" /> Downloading…</> : 'Download tracks & create playlist'}
                </button>
                {busy && <button type="button" className="spotify-secondary-button" onClick={() => void handleCancel()}>Cancel</button>}
              </>
            )}
          </div>

          {error && <div className="spotify-error" role="alert">{error}</div>}

          {preview && (
            <section className="spotify-public-preview" aria-live="polite">
              <div className="spotify-status-line"><Music2 size={16} /> Public {preview.kind} found</div>
              <strong className="spotify-preview-title">{preview.name}</strong>
              <p className="spotify-import-note">{preview.tracks.length} track(s) exposed by Spotify. Resonance will search available audio sources for tracks not already in your Music folder; only tracks backed by real local audio files will be added to the playlist.</p>
              <div className="spotify-preview-track-list">
                {preview.tracks.slice(0, 8).map((track) => (
                  <div className="spotify-preview-track" key={track.id}>
                    <span>{track.name}</span>
                    <small>{track.artists.join(', ') || 'Artist details unavailable'}</small>
                  </div>
                ))}
                {preview.tracks.length > 8 && <p className="spotify-import-note">Plus {preview.tracks.length - 8} more track(s).</p>}
              </div>
            </section>
          )}

          {busy && (
            <div className="spotify-import-note" role="status" aria-live="polite">
              {downloadStatus || 'Preparing downloads…'}
              {downloadProgress?.stage === 'downloading' && downloadProgress.percent !== null ? ` · ${Math.round(downloadProgress.percent)}%` : ''}
            </div>
          )}

          {summary && (
            <div className="spotify-import-success" role="status">
              <strong>{summary.playlistCreated ? `Downloaded and added “${summary.name}” to Resonance.` : `No local playlist created for “${summary.name}”.`}</strong>
              <p>Downloaded {summary.downloaded} new audio file(s). The playlist contains {summary.matched} track(s) backed by local audio; {summary.missing} track(s) remain unavailable.</p>
              {cancelled && <p>Download was cancelled by you.</p>}
              {summary.failures.length > 0 && <div className="spotify-download-failures"><strong>Download failures</strong>{summary.failures.map((failure) => <p key={failure}>{failure}</p>)}</div>}
            </div>
          )}
        </div>

        <footer className="spotify-attribution">
          Spotify provides metadata, not downloadable audio. Resonance searches for a likely matching media source, saves successfully downloaded files to your selected Music folder, and only adds tracks that exist locally. Check that you have permission to download any source.
        </footer>
      </div>
    </div>
  )
}

export default SpotifyImportModal
