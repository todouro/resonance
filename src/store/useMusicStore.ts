import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Playlist, RepeatMode, ThemeMode, Track } from '../types.ts'
import { assignCoversToTracks, syncTracksWithCovers, uniqueTracks } from '../utils/library.ts'
import { loadDesktopLibrary, saveDesktopLibrary } from '../utils/desktopDatabase.ts'
import { hydrateTracksArtwork, sanitizeTracksForPersistence } from '../utils/artworkStorage.ts'
import { isDesktopApp } from '../utils/platform.ts'

type MusicState = {
  tracks: Track[]
  playlists: Playlist[]
  coverPool: string[]
  coverLookup: Map<string, string>
  activePlaylistId: string
  currentTrackId?: string
  isPlaying: boolean
  shuffle: boolean
  repeat: RepeatMode
  themeMode: ThemeMode
  volume: number
  musicFolderPath?: string
  coverFolderPath?: string
  musicFolderName?: string
  coverFolderName?: string
  isInitialized: boolean
  firstRunSetupCompleted: boolean
  setFirstRunSetupCompleted: (completed: boolean) => void
  setMusicFolder: (path?: string, name?: string) => void
  setCoverFolder: (path?: string, name?: string) => void
  initDesktopStorage: () => Promise<void>
  addTracks: (tracks: Track[]) => void
  deleteTrackFromLibrary: (trackId: string) => void
  removeTracksFromLibrary: (trackIds: string[]) => void
  addCovers: (covers: Map<string, string>, extraUrls?: string[], coverPaths?: Map<string, string>) => void
  createPlaylist: (name: string) => void
  deletePlaylist: (playlistId: string) => void
  renamePlaylist: (playlistId: string, name: string) => void
  addTrackToPlaylist: (playlistId: string, trackId: string) => void
  removeTrackFromPlaylist: (playlistId: string, trackId: string) => void
  syncSpotifyPlaylists: (incoming: Array<{ id: string; name: string; trackIds: string[]; externalUrl: string; totalTracks: number; matchedTracks: number; unmatchedTracks: number }>, spotifyTracks: Track[], likedTrackIds: string[], likedTotal: number, likedUnmatched: number) => void
  setActivePlaylist: (playlistId: string) => void
  setCurrentTrack: (trackId: string) => void
  setIsPlaying: (isPlaying: boolean) => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  setThemeMode: (themeMode: ThemeMode) => void
  setVolume: (volume: number) => void
  updateTrack: (trackId: string, updates: Partial<Track>) => void
}

export const libraryId = 'library'
export const favoritesId = 'favorites'

function ensureFavoritesPlaylist(playlists: Playlist[]): Playlist[] {
  const userPlaylists = playlists.filter((playlist) => playlist.id !== 'night-drive')
  const firstFavoriteIndex = userPlaylists.findIndex((playlist) => playlist.id === favoritesId)

  if (firstFavoriteIndex === -1) {
    return [
      { id: favoritesId, name: 'Favorites', trackIds: [], createdAt: Date.now() },
      ...userPlaylists,
    ]
  }

  const existing = userPlaylists[firstFavoriteIndex]
  const favorite: Playlist = {
    ...existing,
    name: 'Favorites',
    trackIds: Array.isArray(existing.trackIds) ? existing.trackIds : [],
  }

  return userPlaylists.flatMap((playlist, index) =>
    playlist.id !== favoritesId
      ? [playlist]
      : index === firstFavoriteIndex
        ? [favorite]
        : [],
  )
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let initPromise: Promise<void> | null = null

function queueSave(state: MusicState) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveDesktopLibrary({
      tracks: state.tracks.filter((t) => Boolean(t.filePath)),
      playlists: state.playlists,
      activePlaylistId: state.activePlaylistId,
      currentTrackId: state.currentTrackId,
      volume: state.volume,
      shuffle: state.shuffle,
      repeat: state.repeat,
      themeMode: state.themeMode,
      musicFolderPath: state.musicFolderPath,
      coverFolderPath: state.coverFolderPath,
      musicFolderName: state.musicFolderName,
      coverFolderName: state.coverFolderName,
      firstRunSetupCompleted: state.firstRunSetupCompleted,
    })
  }, 400)
}

export const useMusicStore = create<MusicState>()(
  persist(
    (set, get) => ({
      tracks: [],
      playlists: [
        {
          id: favoritesId,
          name: 'Favorites',
          trackIds: [],
          createdAt: Date.now(),
        },
      ],
      coverPool: [],
      coverLookup: new Map<string, string>(),
      activePlaylistId: libraryId,
      isPlaying: false,
      shuffle: false,
      repeat: 'off',
      themeMode: 'normal',
      volume: 0.82,
      musicFolderPath: undefined,
      coverFolderPath: undefined,
      musicFolderName: undefined,
      coverFolderName: undefined,
      isInitialized: false,
      firstRunSetupCompleted: false,

      setMusicFolder: (path, name) =>
        set((state) => {
          const next = {
            musicFolderPath: path !== undefined ? path : state.musicFolderPath,
            musicFolderName: name !== undefined ? name : state.musicFolderName,
          }
          queueSave({ ...state, ...next })
          return next
        }),

      setCoverFolder: (path, name) =>
        set((state) => {
          const next = {
            coverFolderPath: path !== undefined ? path : state.coverFolderPath,
            coverFolderName: name !== undefined ? name : state.coverFolderName,
          }
          queueSave({ ...state, ...next })
          return next
        }),

      setFirstRunSetupCompleted: (firstRunSetupCompleted) => {
        set({ firstRunSetupCompleted })
        queueSave(get())
      },

      initDesktopStorage: async () => {
        if (get().isInitialized) return
        if (initPromise) return initPromise

        initPromise = (async () => {
          try {
            const loaded = await loadDesktopLibrary()
            if (loaded) {
              set((state) => {
                // 1. Safely merge tracks: loaded tracks + any tracks concurrently added to state
                const trackMap = new Map<string, Track>()
                for (const t of loaded.tracks) {
                  trackMap.set(t.id, t)
                }
                for (const t of state.tracks) {
                  const existing = trackMap.get(t.id)
                  if (existing) {
                    trackMap.set(t.id, { ...existing, ...t })
                  } else {
                    trackMap.set(t.id, t)
                  }
                }
                const mergedTracks = Array.from(trackMap.values())

                // 2. Safely merge playlists: loaded playlists + any playlists concurrently created/updated
                const playlistMap = new Map<string, Playlist>()
                for (const p of loaded.playlists) {
                  playlistMap.set(p.id, p)
                }
                for (const p of state.playlists) {
                  const existing = playlistMap.get(p.id)
                  if (existing) {
                    const mergedTrackIds = Array.from(new Set([...existing.trackIds, ...p.trackIds]))
                    playlistMap.set(p.id, { ...existing, ...p, trackIds: mergedTrackIds })
                  } else {
                    playlistMap.set(p.id, p)
                  }
                }
                const mergedPlaylists = ensureFavoritesPlaylist(Array.from(playlistMap.values()))

                const requestedActivePlaylistId =
                  state.activePlaylistId !== libraryId && state.activePlaylistId
                    ? state.activePlaylistId
                    : loaded.activePlaylistId || state.activePlaylistId
                const activePlaylistId =
                  requestedActivePlaylistId === 'night-drive' ||
                  (requestedActivePlaylistId !== libraryId &&
                    !mergedPlaylists.some((playlist) => playlist.id === requestedActivePlaylistId))
                    ? libraryId
                    : requestedActivePlaylistId

                const currentTrackId =
                  state.currentTrackId || loaded.currentTrackId || mergedTracks[0]?.id

                const nextState = {
                  tracks: mergedTracks,
                  playlists: mergedPlaylists,
                  activePlaylistId,
                  currentTrackId,
                  volume: typeof loaded.volume === 'number' ? loaded.volume : state.volume,
                  shuffle: typeof loaded.shuffle === 'boolean' ? loaded.shuffle : state.shuffle,
                  repeat: loaded.repeat || state.repeat,
                  themeMode: loaded.themeMode || state.themeMode,
                  musicFolderPath: state.musicFolderPath || loaded.musicFolderPath,
                  coverFolderPath: state.coverFolderPath || loaded.coverFolderPath,
                  musicFolderName: state.musicFolderName || loaded.musicFolderName,
                  coverFolderName: state.coverFolderName || loaded.coverFolderName,
                  firstRunSetupCompleted: loaded.firstRunSetupCompleted ?? state.firstRunSetupCompleted,
                  isInitialized: true,
                }

                // If tracks or playlists were added concurrently while loading from disk,
                // queue a save so disk storage reflects the merged state.
                if (
                  state.tracks.length > 0 ||
                  mergedPlaylists.length !== playlistMap.size ||
                  state.playlists.length > loaded.playlists.length ||
                  !state.playlists.some((playlist) => playlist.id === favoritesId) ||
                  !loaded.playlists.some((playlist) => playlist.id === favoritesId)
                ) {
                  queueSave({ ...state, ...nextState })
                }

                return nextState
              })
              return
            }
          } catch (err) {
            console.warn('Could not initialize desktop storage:', err)
          } finally {
            initPromise = null
          }

          set((state) => {
            const playlists = ensureFavoritesPlaylist(state.playlists)
            const nextState = {
              tracks: hydrateTracksArtwork(state.tracks),
              playlists,
              themeMode: 'normal' as const,
              firstRunSetupCompleted: state.firstRunSetupCompleted || state.tracks.length > 0,
              isInitialized: true,
            }
            if (playlists !== state.playlists) queueSave({ ...state, ...nextState })
            return nextState
          })
        })()

        return initPromise
      },

      addTracks: (incoming) =>
        set((state) => {
          const processedIncoming = assignCoversToTracks(
            state.tracks,
            uniqueTracks(state.tracks, incoming),
            state.coverPool,
            state.coverLookup,
          )
          const tracks = [...state.tracks, ...processedIncoming]
          const next = {
            tracks,
            currentTrackId: state.currentTrackId ?? tracks[0]?.id,
          }
          queueSave({ ...state, ...next })
          return next
        }),

      deleteTrackFromLibrary: (trackId) =>
        set((state) => {
          if (!state.tracks.some((track) => track.id === trackId)) return {}

          const tracks = state.tracks.filter((track) => track.id !== trackId)
          const playlists = state.playlists.map((playlist) => ({
            ...playlist,
            trackIds: playlist.trackIds.filter((id) => id !== trackId),
          }))
          const deletingCurrentTrack = state.currentTrackId === trackId
          const nextState: Partial<MusicState> = {
            tracks,
            playlists,
            currentTrackId: deletingCurrentTrack ? undefined : state.currentTrackId,
            isPlaying: deletingCurrentTrack ? false : state.isPlaying,
          }

          // Remove the library entry only; the user's audio file stays on disk.
          queueSave({ ...state, ...nextState })
          return nextState
        }),

      removeTracksFromLibrary: (trackIds) =>
        set((state) => {
          const removing = new Set(trackIds)
          if (!state.tracks.some((track) => removing.has(track.id))) return {}

          const tracks = state.tracks.filter((track) => !removing.has(track.id))
          const playlists = state.playlists.map((playlist) => ({
            ...playlist,
            trackIds: playlist.trackIds.filter((id) => !removing.has(id)),
          }))
          const removingCurrentTrack = state.currentTrackId ? removing.has(state.currentTrackId) : false
          const nextState: Partial<MusicState> = {
            tracks,
            playlists,
            currentTrackId: removingCurrentTrack ? undefined : state.currentTrackId,
            isPlaying: removingCurrentTrack ? false : state.isPlaying,
          }

          // Library entries only; the audio files themselves are never touched.
          queueSave({ ...state, ...nextState })
          return nextState
        }),

      addCovers: (covers, extraUrls = [], coverPaths = new Map()) =>
        set((state) => {
          const mergedLookup = new Map(state.coverLookup)
          for (const [key, value] of covers.entries()) {
            mergedLookup.set(key, value)
          }
          const incomingCovers = Array.from(new Set([...Array.from(covers.values()), ...extraUrls]))
          const updatedPool = Array.from(new Set([...state.coverPool, ...incomingCovers]))
          const tracksWithCovers = syncTracksWithCovers(state.tracks, mergedLookup, updatedPool)

          // Keep the original file path beside the asset URL. Asset URLs alone are not
          // enough to rebuild artwork reliably after a desktop restart or scope refresh.
          const pathsByUrl = new Map<string, string>()
          for (const [key, path] of coverPaths.entries()) {
            const url = covers.get(key)
            if (url) pathsByUrl.set(url, path)
          }

          const tracks = tracksWithCovers.map((track) => {
            if (!track.coverUrl || track.coverSource === 'embedded' || track.coverSource === 'custom') {
              return track
            }
            const path = pathsByUrl.get(track.coverUrl)
            return path && path !== track.coverPath ? { ...track, coverPath: path } : track
          })
          const next = {
            coverLookup: mergedLookup,
            coverPool: updatedPool,
            tracks,
          }
          queueSave({ ...state, ...next })
          return next
        }),

      createPlaylist: (name) =>
        set((state) => {
          const playlists = [
            ...state.playlists,
            {
              id: crypto.randomUUID(),
              name,
              trackIds: [],
              createdAt: Date.now(),
            },
          ]
          queueSave({ ...state, playlists })
          return { playlists }
        }),

      deletePlaylist: (playlistId) =>
        set((state) => {
          if (playlistId === favoritesId) return {}

          const playlists = state.playlists.filter((playlist) => playlist.id !== playlistId)
          const activePlaylistId =
            state.activePlaylistId === playlistId ? libraryId : state.activePlaylistId
          queueSave({ ...state, playlists, activePlaylistId })
          return { playlists, activePlaylistId }
        }),

      renamePlaylist: (playlistId, name) =>
        set((state) => {
          if (playlistId === favoritesId) return {}

          const playlists = state.playlists.map((playlist) =>
            playlist.id === playlistId
              ? { ...playlist, name: name.trim() || playlist.name }
              : playlist,
          )
          queueSave({ ...state, playlists })
          return { playlists }
        }),

      addTrackToPlaylist: (playlistId, trackId) =>
        set((state) => {
          const basePlaylists =
            playlistId === favoritesId
              ? ensureFavoritesPlaylist(state.playlists)
              : state.playlists
          const playlists = basePlaylists.map((playlist) =>
            playlist.id === playlistId && !playlist.trackIds.includes(trackId)
              ? { ...playlist, trackIds: [...playlist.trackIds, trackId] }
              : playlist,
          )
          queueSave({ ...state, playlists })
          return { playlists }
        }),

      removeTrackFromPlaylist: (playlistId, trackId) =>
        set((state) => {
          const basePlaylists =
            playlistId === favoritesId
              ? ensureFavoritesPlaylist(state.playlists)
              : state.playlists
          const playlists = basePlaylists.map((playlist) =>
            playlist.id === playlistId
              ? { ...playlist, trackIds: playlist.trackIds.filter((id) => id !== trackId) }
              : playlist,
          )
          queueSave({ ...state, playlists })
          return { playlists }
        }),

      syncSpotifyPlaylists: (incoming, spotifyTracks, likedTrackIds, likedTotal, likedUnmatched) =>
        set((state) => {
          const importedById = new Map<string, Playlist>()
          for (const playlist of state.playlists) {
            if (playlist.source === 'spotify') importedById.set(playlist.id, playlist)
          }

          const likedId = 'spotify:liked-songs'
          const existingLiked = importedById.get(likedId)
          importedById.set(likedId, {
            id: likedId,
            name: 'Spotify Liked Songs',
            trackIds: Array.from(new Set(likedTrackIds)),
            createdAt: existingLiked?.createdAt ?? Date.now(),
            source: 'spotify',
            externalUrl: 'https://open.spotify.com/collection/tracks',
            totalTracks: likedTotal,
            unmatchedTracks: likedUnmatched,
          })

          for (const item of incoming) {
            const id = `spotify:${item.id}`
            const existing = importedById.get(id)
            importedById.set(id, {
              id,
              name: item.name,
              trackIds: Array.from(new Set(item.trackIds)),
              createdAt: existing?.createdAt ?? Date.now(),
              source: 'spotify',
              externalUrl: item.externalUrl,
              totalTracks: item.totalTracks,
              unmatchedTracks: item.unmatchedTracks,
            })
          }

          // Persist Spotify metadata rows alongside the local audio library. They are
          // excluded from the playback queue until matching local audio becomes available.
          const spotifyTrackMap = new Map<string, Track>(
            state.tracks
              .filter((track) => track.source === 'spotify')
              .map((track) => [track.id, track]),
          )
          const localTrackIds = new Set(state.tracks.filter((track) => track.source !== 'spotify').map((track) => track.id))
          for (const track of spotifyTracks) {
            if (!localTrackIds.has(track.id)) spotifyTrackMap.set(track.id, track)
          }
          const tracks = [
            ...state.tracks.filter((track) => track.source !== 'spotify'),
            ...spotifyTrackMap.values(),
          ]

          // Preserve prior imports for playlists Spotify temporarily hides or rate-limits.
          const playlists = ensureFavoritesPlaylist([
            ...state.playlists.filter((playlist) => playlist.source !== 'spotify'),
            ...importedById.values(),
          ])
          queueSave({ ...state, tracks, playlists })
          return { tracks, playlists }
        }),

      setActivePlaylist: (activePlaylistId) => {
        set({ activePlaylistId })
        queueSave(get())
      },

      setCurrentTrack: (currentTrackId) => {
        set({ currentTrackId })
        queueSave(get())
      },

      setIsPlaying: (isPlaying) => set({ isPlaying }),

      toggleShuffle: () =>
        set((state) => {
          const shuffle = !state.shuffle
          queueSave({ ...state, shuffle })
          return { shuffle }
        }),

      cycleRepeat: () =>
        set((state) => {
          const repeat =
            state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off'
          queueSave({ ...state, repeat })
          return { repeat }
        }),

      setThemeMode: (themeMode) => {
        set({ themeMode })
        queueSave(get())
      },

      setVolume: (volume) => {
        set({ volume })
        queueSave(get())
      },

      updateTrack: (trackId, updates) =>
        set((state) => {
          const tracks = state.tracks.map((track) =>
            track.id === trackId
              ? {
                  ...track,
                  ...updates,
                  coverPath:
                    updates.coverUrl === undefined && 'coverUrl' in updates
                      ? undefined
                      : updates.coverPath !== undefined
                        ? updates.coverPath
                        : track.coverPath,
                  coverSource:
                    updates.coverUrl !== undefined
                      ? updates.coverSource || (updates.coverUrl ? 'custom' : undefined)
                      : track.coverSource,
                }
              : track,
          )
          queueSave({ ...state, tracks })
          return { tracks }
        }),
    }),
    {
      name: 'resonance-playlists-v1',
      // Desktop libraries are persisted by desktopDatabase.ts. Keeping the full
      // library out of Zustand's synchronous localStorage write avoids serializing
      // thousands of tracks and artwork metadata on every store update.
      // The browser build still persists its library for compatibility.
      version: 2,
      migrate: (persistedState) => {
        const persisted = persistedState as Partial<MusicState>
        const preferences = {
          volume: typeof persisted.volume === 'number' ? persisted.volume : 0.82,
          shuffle: typeof persisted.shuffle === 'boolean' ? persisted.shuffle : false,
          repeat: persisted.repeat ?? 'off',
          themeMode: persisted.themeMode ?? 'normal',
          musicFolderPath: persisted.musicFolderPath,
          coverFolderPath: persisted.coverFolderPath,
          musicFolderName: persisted.musicFolderName,
          coverFolderName: persisted.coverFolderName,
          firstRunSetupCompleted: persisted.firstRunSetupCompleted ?? false,
        }

        if (Array.isArray(persisted.tracks)) {
          const playlists = ensureFavoritesPlaylist(
            Array.isArray(persisted.playlists) ? persisted.playlists : [],
          )
          const requestedActivePlaylistId =
            typeof persisted.activePlaylistId === 'string' ? persisted.activePlaylistId : libraryId
          const activePlaylistId =
            requestedActivePlaylistId === 'night-drive' ||
            (requestedActivePlaylistId !== libraryId &&
              !playlists.some((playlist) => playlist.id === requestedActivePlaylistId))
              ? libraryId
              : requestedActivePlaylistId
          return {
            ...preferences,
            tracks: persisted.tracks,
            playlists,
            activePlaylistId,
          }
        }

        return preferences
      },
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<MusicState>
        const playlists = ensureFavoritesPlaylist(
          Array.isArray(persisted.playlists) ? persisted.playlists : currentState.playlists,
        )
        const requestedActivePlaylistId = persisted.activePlaylistId ?? currentState.activePlaylistId
        const activePlaylistId =
          requestedActivePlaylistId === 'night-drive' ||
          (requestedActivePlaylistId !== libraryId &&
            !playlists.some((playlist) => playlist.id === requestedActivePlaylistId))
            ? libraryId
            : requestedActivePlaylistId

        return {
          ...currentState,
          ...persisted,
          playlists,
          activePlaylistId,
        }
      },
      partialize: (state) => {
        const preferences = {
          volume: state.volume,
          shuffle: state.shuffle,
          repeat: state.repeat,
          themeMode: state.themeMode,
          musicFolderPath: state.musicFolderPath,
          coverFolderPath: state.coverFolderPath,
          musicFolderName: state.musicFolderName,
          coverFolderName: state.coverFolderName,
          firstRunSetupCompleted: state.firstRunSetupCompleted,
        }
        if (isDesktopApp()) return preferences
        return {
          ...preferences,
          tracks: sanitizeTracksForPersistence(
            state.tracks.filter((track) => Boolean(track.filePath)),
          ),
          playlists: state.playlists,
          activePlaylistId: state.activePlaylistId,
        }
      },
    },
  ),
)
