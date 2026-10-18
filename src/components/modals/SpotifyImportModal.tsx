import { useEffect, useState } from 'react'
import { LoaderCircle, Music2, X } from 'lucide-react'
import { fetchPublicSpotifyLink } from '../../services/spotify'
import type { SpotifyPublicLinkResult, SpotifyTrackSummary } from '../../services/spotify'
import { useMusicStore } from '../../store/useMusicStore'
import type { Track } from '../../types'

type SpotifyImportModalProps = { onClose: () => void }
type ImportSummary = {
  name: string
  kind: string
  trackCount: number
  matched: number
  missing: number
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
): { ids: string[]; matched: number; missing: number; placeholders: Track[] } {
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
  const placeholders: Track[] = []
  let matched = 0
  for (const spotifyTrack of spotifyTracks) {
    const candidates = byTitle.get(normalize(spotifyTrack.name)) ?? []
    const artistKeys = spotifyTrack.artists.map(normalize).filter(Boolean)
    const localTrack = candidates.find((candidate) => {
      const localArtist = normalize(candidate.artist)
      return artistKeys.some((artist) => localArtist === artist || localArtist.includes(artist) || artist.includes(localArtist))
    })
    if (localTrack) {
      matched += 1
      ids.push(localTrack.id)
      continue
    }

    const fallbackIdentity = normalize(`${spotifyTrack.name} ${spotifyTrack.artists.join(' ')}`)
    const id = `spotify-track:${spotifyTrack.id || encodeURIComponent(fallbackIdentity)}`
    ids.push(id)
    placeholders.push({
      id,
      title: spotifyTrack.name,
      artist: spotifyTrack.artists.join(', ') || 'Unknown artist',
      album: spotifyTrack.album || 'Spotify',
      duration: spotifyTrack.duration ?? 0,
      fileName: spotifyTrack.name,
      coverUrl: spotifyTrack.coverUrl,
      accent: '#1ed760',
      source: 'spotify',
      externalUrl: spotifyTrack.externalUrl || `https://open.spotify.com/track/${spotifyTrack.id}`,
      unavailable: true,
    })
  }

  return {
    ids: Array.from(new Set(ids)),
    matched,
    missing: Math.max(0, spotifyTracks.length - matched),
    placeholders: Array.from(new Map(placeholders.map((track) => [track.id, track])).values()),
  }
}

function SpotifyMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" role="img" aria-label="Spotify">
      <circle cx="16" cy="16" r="16" fill="#1ed760" />
      <path d="M7.8 12.1c6.8-2.1 13.6-1 18.1 1.8M9.1 16.2c5.7-1.7 11.4-.8 15.5 1.7M10.4 20.1c4.6-1.3 9.1-.7 12.3 1.4" fill="none" stroke="#07110a" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

export function SpotifyImportModal({ onClose }: SpotifyImportModalProps) {
  const [spotifyUrl, setSpotifyUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<SpotifyPublicLinkResult | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

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

  const handleImport = () => {
    if (!preview || busy) return
    setError(null)
    setBusy(true)
    try {
      const localTracks = useMusicStore.getState().tracks
      const matched = matchLocalTracks(preview.tracks, localTracks)
      const playlistId = `spotify-public:${preview.kind}:${preview.id}`

      useMusicStore.getState().importSpotifyPublicPlaylist({
        id: playlistId,
        name: preview.name,
        externalUrl: preview.externalUrl,
        totalTracks: preview.totalTracks,
        unmatchedTracks: matched.missing,
        trackIds: matched.ids,
      }, matched.placeholders)

      setSummary({
        name: preview.name,
        kind: preview.kind,
        trackCount: preview.tracks.length,
        matched: matched.matched,
        missing: matched.missing,
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not import this Spotify link into Resonance.')
    } finally {
      setBusy(false)
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
              {busy ? <><LoaderCircle size={16} className="spinning" /> Fetching Spotify tracks…</> : <><Music2 size={17} /> Fetch tracks</>}
            </button>
            {preview && (
              <button type="button" className="spotify-secondary-button" disabled={busy} onClick={handleImport}>
                Add to Resonance
              </button>
            )}
          </div>

          {error && <div className="spotify-error" role="alert">{error}</div>}

          {preview && (
            <section className="spotify-public-preview" aria-live="polite">
              <div className="spotify-status-line"><Music2 size={16} /> Public {preview.kind} found</div>
              <strong className="spotify-preview-title">{preview.name}</strong>
              <p className="spotify-import-note">{preview.tracks.length} track(s) exposed by Spotify are ready to import. The list may be partial if Spotify's public page doesn't expose every track.</p>
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

          {summary && (
            <div className="spotify-import-success" role="status">
              <strong>Added “{summary.name}” to Resonance.</strong>
              <p>{summary.trackCount} tracks imported from the public {summary.kind} link; {summary.matched} matched local audio files and {summary.missing} need local audio.</p>
            </div>
          )}
        </div>

        <footer className="spotify-attribution">
          Public Spotify metadata only. Spotify audio is not downloaded or streamed by Resonance. For tracks to play locally, add audio files to your Music folder and rescan.
        </footer>
      </div>
    </div>
  )
}

export default SpotifyImportModal
