import { invoke } from '@tauri-apps/api/core'

const REDIRECT_URI = 'http://127.0.0.1:43821/callback'
const TOKEN_STORAGE_KEY = 'resonance.spotify.session.v1'
const CLIENT_ID_STORAGE_KEY = 'resonance.spotify.client-id'

type StoredSession = {
  clientId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

type TokenPayload = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

type OAuthCallback = { code?: string | null; state?: string | null; error?: string | null }

export type SpotifyTrackSummary = {
  name: string
  artists: string[]
  externalUrl?: string
}

export type SpotifyPlaylistImport = {
  id: string
  name: string
  externalUrl: string
  totalTracks: number
  tracks: SpotifyTrackSummary[]
}

export type SpotifyLibraryImport = {
  likedTracks: SpotifyTrackSummary[]
  likedTotal: number
  playlists: SpotifyPlaylistImport[]
  totalPlaylists: number
  skippedPlaylists: number
}

type SpotifyPage<T> = {
  items?: T[]
  next?: string | null
  total?: number
}

class SpotifyApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SpotifyApiError'
    this.status = status
  }
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (!raw) return null
    const session = JSON.parse(raw) as Partial<StoredSession>
    if (!session.clientId || !session.accessToken || !session.refreshToken || !session.expiresAt) return null
    return session as StoredSession
  } catch {
    return null
  }
}

function persistSession(session: StoredSession): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(session))
  } catch {
    throw new Error('Resonance could not store the Spotify session locally. Check whether app storage is available.')
  }
}

export function getSavedSpotifyClientId(): string {
  try {
    const saved = localStorage.getItem(CLIENT_ID_STORAGE_KEY)
    if (saved?.trim()) return saved.trim()
  } catch {
    // Continue with the build-time default when browser storage is unavailable.
  }
  return (import.meta.env.VITE_SPOTIFY_CLIENT_ID ?? '').trim()
}

export function saveSpotifyClientId(clientId: string): void {
  try {
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId.trim())
  } catch {
    throw new Error('Resonance could not save the Spotify Client ID locally.')
  }
}

export function hasSpotifySession(): boolean {
  return Boolean(readStoredSession())
}

export function disconnectSpotify(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // A cleared in-memory connection is still safe; storage cleanup can be retried next launch.
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function exchangeAuthorizationCode(clientId: string, code: string, verifier: string): Promise<StoredSession> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  })
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const payload = await response.json() as TokenPayload
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(payload.error_description || payload.error || 'Spotify could not complete sign-in. Check the Client ID and redirect URI.')
  }
  return {
    clientId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  }
}

export async function connectSpotify(clientId: string): Promise<void> {
  const normalizedClientId = clientId.trim()
  if (!normalizedClientId) throw new Error('Enter your Spotify Client ID first.')
  saveSpotifyClientId(normalizedClientId)

  const verifier = randomBase64Url(64)
  const challengeBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const challenge = base64Url(challengeBytes)
  const state = randomBase64Url(32)
  const authorizeUrl = new URL('https://accounts.spotify.com/authorize')
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: normalizedClientId,
    redirect_uri: REDIRECT_URI,
    scope: 'user-library-read playlist-read-private playlist-read-collaborative',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  }).toString()

  const callback = await invoke<OAuthCallback>('spotify_authorize', {
    authorizationUrl: authorizeUrl.toString(),
    expectedState: state,
  })
  if (callback.state !== state) throw new Error('Spotify sign-in could not be verified. Please try connecting again.')
  if (callback.error) throw new Error(callback.error === 'access_denied' ? 'Spotify access was cancelled.' : `Spotify sign-in failed: ${callback.error}`)
  if (!callback.code) throw new Error('Spotify did not return an authorization code. Please try again.')

  const session = await exchangeAuthorizationCode(normalizedClientId, callback.code, verifier)
  persistSession(session)
}

async function refreshSession(session: StoredSession): Promise<StoredSession> {
  const body = new URLSearchParams({
    client_id: session.clientId,
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
  })
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const payload = await response.json() as TokenPayload
  if (!response.ok || !payload.access_token) {
    if (response.status === 401 || response.status === 400) disconnectSpotify()
    throw new Error(payload.error_description || payload.error || 'Spotify sign-in expired. Disconnect and connect your account again.')
  }
  const next: StoredSession = {
    clientId: session.clientId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  }
  persistSession(next)
  return next
}

async function validSession(): Promise<StoredSession> {
  const session = readStoredSession()
  if (!session) throw new Error('Connect your Spotify account before syncing.')
  if (session.expiresAt > Date.now() + 60_000) return session
  return refreshSession(session)
}

async function spotifyGet<T>(pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith('https://')
    ? new URL(pathOrUrl)
    : new URL(pathOrUrl, 'https://api.spotify.com/v1/')
  if (url.hostname !== 'api.spotify.com' || url.protocol !== 'https:') {
    throw new Error('Spotify returned an unexpected API pagination URL. Sync was stopped for safety.')
  }

  let session = await validSession()
  let response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  })
  if (response.status === 401) {
    session = await refreshSession(session)
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
  }
  if (!response.ok) {
    if (response.status === 429) throw new SpotifyApiError(429, 'Spotify rate-limited the sync. Wait a little and try again.')
    if (response.status === 403) throw new SpotifyApiError(403, 'Spotify does not allow this playlist to be read by the current account.')
    throw new SpotifyApiError(response.status, `Spotify API request failed (HTTP ${response.status}).`)
  }
  return await response.json() as T
}

async function readAllItems<T>(path: string): Promise<{ items: T[]; total: number }> {
  let next: string | null = path
  const items: T[] = []
  let total = 0
  let firstPage = true
  while (next) {
    const page: SpotifyPage<T> = await spotifyGet<SpotifyPage<T>>(next)
    if (firstPage) {
      total = typeof page.total === 'number' ? page.total : 0
      firstPage = false
    }
    if (Array.isArray(page.items)) items.push(...page.items)
    next = page.next ?? null
  }
  return { items, total: total || items.length }
}

function asTrackSummary(value: unknown): SpotifyTrackSummary | null {
  if (!value || typeof value !== 'object') return null
  const wrapper = value as { item?: unknown; track?: unknown }
  const raw = (wrapper.item ?? wrapper.track ?? value) as {
    name?: unknown
    type?: unknown
    artists?: unknown
    external_urls?: { spotify?: unknown }
  } | null
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null
  if (raw.type === 'episode' || raw.type === 'show') return null
  const artists = Array.isArray(raw.artists)
    ? raw.artists.flatMap((artist) => {
        if (artist && typeof artist === 'object' && typeof (artist as { name?: unknown }).name === 'string') {
          return [(artist as { name: string }).name]
        }
        return []
      })
    : []
  return {
    name: raw.name,
    artists,
    externalUrl: typeof raw.external_urls?.spotify === 'string' ? raw.external_urls.spotify : undefined,
  }
}

async function mapLimit<T, R>(items: T[], limit: number, callback: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await callback(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

export async function fetchSpotifyLibrary(): Promise<SpotifyLibraryImport> {
  const [likedPage, playlistsPage] = await Promise.all([
    readAllItems<unknown>('/me/tracks?limit=50'),
    readAllItems<Record<string, unknown>>('/me/playlists?limit=50'),
  ])
  const likedTracks = likedPage.items.map(asTrackSummary).filter((track): track is SpotifyTrackSummary => track !== null)
  let skippedPlaylists = 0

  const playlists = (await mapLimit(playlistsPage.items, 3, async (raw) => {
    const id = typeof raw.id === 'string' ? raw.id : ''
    const name = typeof raw.name === 'string' ? raw.name : 'Spotify playlist'
    if (!id) {
      skippedPlaylists += 1
      return null
    }
    const links = raw.external_urls as { spotify?: unknown } | undefined
    const externalUrl = typeof links?.spotify === 'string'
      ? links.spotify
      : `https://open.spotify.com/playlist/${encodeURIComponent(id)}`
    const nestedItems = raw.items as { total?: unknown } | undefined
    const oldTracks = raw.tracks as { total?: unknown } | undefined
    const declaredTotal = typeof nestedItems?.total === 'number'
      ? nestedItems.total
      : typeof oldTracks?.total === 'number' ? oldTracks.total : 0
    try {
      const page = await readAllItems<unknown>(`/playlists/${encodeURIComponent(id)}/items?limit=50`)
      const tracks = page.items.map(asTrackSummary).filter((track): track is SpotifyTrackSummary => track !== null)
      return {
        id,
        name,
        externalUrl,
        totalTracks: Math.max(declaredTotal, page.total, tracks.length),
        tracks,
      } satisfies SpotifyPlaylistImport
    } catch (error) {
      if (error instanceof SpotifyApiError && (error.status === 403 || error.status === 404)) {
        skippedPlaylists += 1
        return null
      }
      throw error
    }
  })).filter((playlist): playlist is SpotifyPlaylistImport => playlist !== null)

  return {
    likedTracks,
    likedTotal: likedPage.total,
    playlists,
    totalPlaylists: playlistsPage.total,
    skippedPlaylists,
  }
}
