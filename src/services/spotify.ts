import { invoke } from '@tauri-apps/api/core'

export type SpotifyTrackSummary = {
  id: string
  name: string
  artists: string[]
  album?: string
  duration?: number
  coverUrl?: string
  externalUrl?: string
}

export type SpotifyPublicLinkResult = {
  id: string
  name: string
  kind: 'playlist' | 'album' | 'track'
  externalUrl: string
  totalTracks: number
  tracks: SpotifyTrackSummary[]
}

/**
 * Fetches metadata that is publicly exposed on Spotify pages. No Spotify Developer app,
 * client ID, login session, or private-library permission is used by this path.
 */
export async function fetchPublicSpotifyLink(url: string): Promise<SpotifyPublicLinkResult> {
  const cleaned = url.trim()
  if (!cleaned) throw new Error('Paste a public Spotify playlist, album, or track link first.')
  return invoke<SpotifyPublicLinkResult>('fetch_spotify_public_link', { url: cleaned })
}
