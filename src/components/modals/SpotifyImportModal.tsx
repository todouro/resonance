import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, Music2, X } from 'lucide-react'
import { disconnectSpotify, fetchSpotifyLibrary, getSavedSpotifyClientId, hasSpotifySession, saveSpotifyClientId, connectSpotify, copySpotifyRedirectUri, openSpotifyDashboard } from '../../services/spotify'
import type { SpotifyTrackSummary } from '../../services/spotify'
import { useMusicStore } from '../../store/useMusicStore'
import type { Track } from '../../types'

type SpotifyImportModalProps = { onClose: () => void }
type ImportSummary = {
  likedTotal: number
  likedMatched: number
  likedMissing: number
  playlistCount: number
  playlistTracksTotal: number
  playlistTracksMatched: number
  playlistTracksMissing: number
  skippedPlaylists: number
}

const REDIRECT_URI = 'http://127.0.0.1:43821/callback'
const DASHBOARD_URL = 'https://developer.spotify.com/dashboard'

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
  declaredTotal: number,
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
      externalUrl: spotifyTrack.externalUrl,
      unavailable: true,
    })
  }
  const uniqueIds = Array.from(new Set(ids))
  const uniquePlaceholders = Array.from(new Map(placeholders.map((track) => [track.id, track])).values())
  return {
    ids: uniqueIds,
    matched,
    missing: Math.max(0, declaredTotal - matched),
    placeholders: uniquePlaceholders,
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
  const [clientId, setClientId] = useState(getSavedSpotifyClientId())
  const [connected, setConnected] = useState(hasSpotifySession())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const handleSync = async (connectFirst = false) => {
    setBusy(true)
    setError(null)
    if (!clientId.trim()) {
      setBusy(false)
      setError('Enter your Spotify Client ID first.')
      return
    }
    try {
      saveSpotifyClientId(clientId.trim())
      if (connectFirst) await connectSpotify(clientId.trim())
      setConnected(hasSpotifySession())
      const library = await fetchSpotifyLibrary()
      const localTracks = useMusicStore.getState().tracks
      const liked = matchLocalTracks(library.likedTracks, localTracks, library.likedTotal)
      const spotifyMetadataTracks = new Map<string, Track>()
      for (const track of liked.placeholders) spotifyMetadataTracks.set(track.id, track)
      const importedPlaylists = library.playlists.map((playlist) => {
        const matched = matchLocalTracks(playlist.tracks, localTracks, playlist.totalTracks)
        for (const track of matched.placeholders) spotifyMetadataTracks.set(track.id, track)
        return {
          id: playlist.id,
          name: playlist.name,
          externalUrl: playlist.externalUrl,
          totalTracks: playlist.totalTracks,
          matchedTracks: matched.matched,
          unmatchedTracks: matched.missing,
          trackIds: matched.ids,
        }
      })
      useMusicStore.getState().syncSpotifyPlaylists(
        importedPlaylists,
        Array.from(spotifyMetadataTracks.values()),
        liked.ids,
        library.likedTotal,
        liked.missing,
      )
      setSummary({
        likedTotal: library.likedTotal,
        likedMatched: liked.matched,
        likedMissing: liked.missing,
        playlistCount: library.playlists.length,
        playlistTracksTotal: library.playlists.reduce((sum, playlist) => sum + playlist.totalTracks, 0),
        playlistTracksMatched: importedPlaylists.reduce((sum, playlist) => sum + playlist.matchedTracks, 0),
        playlistTracksMissing: importedPlaylists.reduce((sum, playlist) => sum + playlist.unmatchedTracks, 0),
        skippedPlaylists: library.skippedPlaylists,
      })
      setConnected(true)
    } catch (cause) {
      setConnected(hasSpotifySession())
      setError(cause instanceof Error ? cause.message : 'Spotify import failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const handleOpenDashboard = async () => {
    setError(null)
    try {
      await openSpotifyDashboard()
    } catch {
      setError('Could not open your browser automatically. Open https://developer.spotify.com/dashboard in your browser.')
    }
  }

  const handleCopyRedirectUri = async () => {
    setError(null)
    setCopyFeedback(null)
    try {
      await copySpotifyRedirectUri()
      setCopyFeedback('Copied! Paste this URI into your Spotify app settings.')
      return
    } catch {
      // Native clipboard access may be unavailable on some desktop environments. Fall back
      // to the WebView clipboard API and then the selection-based clipboard method.
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(REDIRECT_URI)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = REDIRECT_URI
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('Clipboard access was denied.')
      }
      setCopyFeedback('Copied! Paste this URI into your Spotify app settings.')
    } catch {
      setError('Copy did not work. Select the redirect URI above and copy it manually.')
    }
  }

  const handleDisconnect = () => {
    disconnectSpotify()
    setConnected(false)
    setSummary(null)
    setError(null)
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()} role="dialog" aria-modal="true" aria-labelledby="spotify-import-title">
      <div className="modal-card spotify-modal-card" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div className="spotify-brand-lockup">
            <SpotifyMark />
            <div>
              <h3 id="spotify-import-title">Import from Spotify</h3>
              <p className="spotify-modal-subtitle">Bring your saved songs and playlists into Resonance.</p>
            </div>
          </div>
          <button type="button" className="modal-close-btn" aria-label="Close Spotify import" title="Close" onClick={onClose} disabled={busy}>
            <X size={18} />
          </button>
        </header>

        <div className="spotify-import-body">
          {connected ? (
            <div className="spotify-status-line"><Music2 size={17} /> Spotify account connected</div>
          ) : (
            <>
              <p className="spotify-import-note">
                <strong>First, identify your Resonance app to Spotify.</strong> Spotify requires a Client ID for sign-in. This is not your Spotify password or Client Secret; it lets Spotify know which app is requesting access.
              </p>
              <label className="spotify-client-id-label">
                Spotify Client ID
                <input
                  className="spotify-client-id-input"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder="Paste your Spotify app Client ID"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <p className="spotify-import-note">
                1. Create an app in the <button type="button" className="spotify-dashboard-link" onClick={() => void handleOpenDashboard()}>Spotify Developer Dashboard <ExternalLink size={11} /></button> and copy its <strong>Client ID</strong> here.
                <br />
                2. Add this exact redirect URI to the app settings. Then click <strong>Sign in with Spotify</strong>; your browser will open for Spotify login and consent.
              </p>
              <div className="spotify-redirect-row"><code>{REDIRECT_URI}</code><button type="button" className="spotify-secondary-button" onClick={() => void handleCopyRedirectUri()}>Copy URI</button></div>
              {copyFeedback && <p className="spotify-copy-feedback" role="status">{copyFeedback}</p>}
            </>
          )}

          {error && <div className="spotify-error" role="alert">{error}</div>}

          {summary && (
            <>
              <p className="spotify-import-note"><strong>Sync complete.</strong> Playlist names and accessible Spotify track metadata were imported. Songs with local matches play in Resonance; other songs stay visible as Spotify-only entries until you add local audio.</p>
              <div className="spotify-sync-summary">
                <div className="spotify-sync-stat"><strong>{summary.likedMatched}/{summary.likedTotal}</strong><span>Liked Songs matched locally</span></div>
                <div className="spotify-sync-stat"><strong>{summary.playlistCount}</strong><span>Playlists imported</span></div>
                <div className="spotify-sync-stat"><strong>{summary.playlistTracksMatched}</strong><span>Playlist tracks matched</span></div>
                <div className="spotify-sync-stat"><strong>{summary.likedMissing + summary.playlistTracksMissing}</strong><span>Tracks not found locally</span></div>
              </div>
              {summary.skippedPlaylists > 0 && <p className="spotify-import-note">{summary.skippedPlaylists} playlist(s) could not be read by Spotify. Spotify currently limits playlist contents for playlists you do not own or collaborate on.</p>}
              {summary.likedMissing + summary.playlistTracksMissing > 0 && <p className="spotify-import-note">Add the missing songs’ audio files to your Music folder, then use <strong>Rescan music folder</strong> and sync again.</p>}
            </>
          )}

          <div className="spotify-import-actions">
            <button type="button" className="spotify-connect-button" disabled={busy} onClick={() => void handleSync(!connected)}>
              {busy ? <><LoaderCircle size={16} className="spinning" /> {connected ? 'Syncing library…' : 'Opening Spotify…'}</> : <><Music2 size={17} /> {connected ? 'Sync Spotify library' : 'Sign in with Spotify'}</>}
            </button>
            {connected && <button type="button" className="spotify-secondary-button" disabled={busy} onClick={handleDisconnect}>Disconnect</button>}
          </div>
        </div>

        <footer className="spotify-attribution">
          Playlist metadata is provided by <a href="https://open.spotify.com" target="_blank" rel="noreferrer">Spotify</a>. Imported playlists include a link back to Spotify. Spotify audio is not downloaded or streamed by Resonance.
        </footer>
      </div>
    </div>
  )
}

export default SpotifyImportModal
