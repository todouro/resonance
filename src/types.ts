export type RepeatMode = 'off' | 'one' | 'all'
export type ThemeMode = 'normal'

export type Track = {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  fileName: string
  audioUrl?: string
  filePath?: string
  coverUrl?: string
  coverPath?: string
  coverSource?: 'direct' | 'embedded' | 'custom' | 'pool'
  accent: string
}

export type Playlist = {
  id: string
  name: string
  trackIds: string[]
  createdAt: number
  source?: 'spotify'
  externalUrl?: string
  totalTracks?: number
  unmatchedTracks?: number
}

export type CoverLookup = Map<string, string>
