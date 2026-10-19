import { AnimatePresence, motion } from 'framer-motion'
import { DownloadSection } from './components/DownloadSection'
import { useEffect, useRef, useState } from 'react'
import './App.css'
import { SearchFilled } from './components/icons'
import {
  AddToPlaylistModal,
  DeletePlaylistModal,
  EditTrackModal,
  FirstRunSetupModal,
  HeroPlayer,
  NotificationToast,
  PlayerBar,
  PlaylistActionMenu,
  RenamePlaylistModal,
  SettingsModal,
  Sidebar,
  TrackList,
} from './components'
import {
  useAudioPlayback,
  useHeroTheme,
  useKeyboardShortcuts,
  useLibraryImport,
  usePlaylistManager,
  useTrackFilter,
} from './hooks'
import { favoritesId, useMusicStore } from './store/useMusicStore'
import { showToast } from './store/useToastStore'
import { cleanDisplayTitle, formatTime } from './utils/library'
import type { Playlist, Track } from './types'

function App() {
  const [editingTrack, setEditingTrack] = useState<Track | null>(null)
  const [playlistToAddSongs, setPlaylistToAddSongs] = useState<Playlist | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [activeSection, setActiveSection] = useState<'library' | 'downloads'>('library')
  const [isSidebarRevealed, setIsSidebarRevealed] = useState(false)
  const [isFirstRunSetupInProgress, setIsFirstRunSetupInProgress] = useState(false)
  const [firstRunSetupStep, setFirstRunSetupStep] = useState<'music' | 'covers'>('music')
  const [firstRunBusyAction, setFirstRunBusyAction] = useState<'music' | 'covers' | null>(null)

  // Narrow subscriptions prevent unrelated store updates (for example volume or
  // repeat changes) from forcing the whole application shell to rerender.
  const tracks = useMusicStore((state) => state.tracks)
  const playlists = useMusicStore((state) => state.playlists)
  const activePlaylistId = useMusicStore((state) => state.activePlaylistId)
  const isPlaying = useMusicStore((state) => state.isPlaying)
  const shuffle = useMusicStore((state) => state.shuffle)
  const repeat = useMusicStore((state) => state.repeat)
  const volume = useMusicStore((state) => state.volume)
  const keyboardShortcuts = useMusicStore((state) => state.keyboardShortcuts)
  const playerBarHoverMode = useMusicStore((state) => state.playerBarHoverMode)
  const autoHideSidebar = useMusicStore((state) => state.autoHideSidebar)
  const isInitialized = useMusicStore((state) => state.isInitialized)
  const configuredMusicFolderPath = useMusicStore((state) => state.musicFolderPath)
  const firstRunSetupCompleted = useMusicStore((state) => state.firstRunSetupCompleted)
  const setFirstRunSetupCompleted = useMusicStore((state) => state.setFirstRunSetupCompleted)
  const initDesktopStorage = useMusicStore((state) => state.initDesktopStorage)
  const setActivePlaylist = useMusicStore((state) => state.setActivePlaylist)
  const addTrackToPlaylist = useMusicStore((state) => state.addTrackToPlaylist)
  const removeTrackFromPlaylist = useMusicStore((state) => state.removeTrackFromPlaylist)
  const toggleShuffle = useMusicStore((state) => state.toggleShuffle)
  const cycleRepeat = useMusicStore((state) => state.cycleRepeat)
  const setVolume = useMusicStore((state) => state.setVolume)
  const updateTrack = useMusicStore((state) => state.updateTrack)
  const deleteTrackFromLibrary = useMusicStore((state) => state.deleteTrackFromLibrary)

  // Initialize desktop local database storage on launch
  useEffect(() => {
    initDesktopStorage()
  }, [initDesktopStorage])

  // 1. Playlist and queue management
  const {
    queueRef,
    activePlaylist,
    newPlaylistName,
    setNewPlaylistName,
    handleCreatePlaylist,
    playlistToDelete,
    setPlaylistToDelete,
    handleConfirmDelete,
    playlistToRename,
    setPlaylistToRename,
    handleConfirmRename,
  } = usePlaylistManager()

  // 2. Search and track filtering
  const { query, setQuery, visibleTracks, totalDuration, trackCount } =
    useTrackFilter(tracks, activePlaylistId, activePlaylist)

  // 3. Audio playback lifecycle & synchronization
  const {
    audioRef,
    seek,
    currentTrack,
    handleSeek,
    playPrevious,
    playNext,
    handleTrackPlay,
    togglePlay,
  } = useAudioPlayback(queueRef)

  // 4. File importing & drag/drop (supporting both native dialogs & web drag/drop)
  const {
    isDesktop,
    musicFolderName,
    coverFolderName,
    isScanningMusic,
    isScanningCovers,
    scanNotice,
    handleNativeAddSongs,
    handleNativeMusicFolder,
    handleNativeCoverFolder,
    handleRescanMusicFolder,
    handleRescanCoverFolder,
    handleMusicFiles,
    handleMusicFolder,
    handleCoverFolder,
    handleDrop,
  } = useLibraryImport()

  // Always ask for a Music folder if none is configured, even when a library was
  // imported manually or an older saved setup flag says onboarding was completed.
  // For existing libraries that already have a Music folder, keep the optional cover-art
  // step limited to genuinely unfinished first-run setup so users who skipped it aren't nagged.
  const shouldShowFirstRunSetup =
    isDesktop &&
    isInitialized &&
    !firstRunSetupCompleted &&
    (!configuredMusicFolderPath || tracks.length === 0 || isFirstRunSetupInProgress)
  const visibleFirstRunStep =
    configuredMusicFolderPath && !isFirstRunSetupInProgress && firstRunSetupStep === 'music'
      ? 'covers'
      : firstRunSetupStep

  const finishFirstRunSetup = () => {
    setFirstRunSetupCompleted(true)
    setIsFirstRunSetupInProgress(false)
  }

  const handleFirstRunChooseMusic = async () => {
    setIsFirstRunSetupInProgress(true)
    setFirstRunBusyAction('music')
    try {
      await handleNativeMusicFolder()
      if (useMusicStore.getState().musicFolderPath) {
        setFirstRunSetupStep('covers')
      }
    } finally {
      setFirstRunBusyAction(null)
    }
  }

  const handleFirstRunChooseCovers = async () => {
    setIsFirstRunSetupInProgress(true)
    setFirstRunBusyAction('covers')
    try {
      await handleNativeCoverFolder()
      if (useMusicStore.getState().coverFolderPath) {
        finishFirstRunSetup()
      }
    } finally {
      setFirstRunBusyAction(null)
    }
  }

  // 5. Global keyboard shortcuts
  const previousVolumeRef = useRef<number>(0.82)
  useKeyboardShortcuts({
    shortcuts: keyboardShortcuts,
    onTogglePlay: () => togglePlay(visibleTracks[0]?.id, visibleTracks.map((t) => t.id)),
    onPrevious: playPrevious,
    onNext: playNext,
    onSeekBackward: () => {
      const nextSeek = Math.max(0, seek - 5)
      handleSeek(nextSeek)
    },
    onSeekForward: () => {
      const duration = currentTrack?.duration || audioRef.current?.duration() || 0
      const nextSeek = Math.min(duration, seek + 5)
      handleSeek(nextSeek)
    },
    onVolumeUp: () => {
      setVolume(Math.min(1, Math.round((volume + 0.05) * 100) / 100))
    },
    onVolumeDown: () => {
      setVolume(Math.max(0, Math.round((volume - 0.05) * 100) / 100))
    },
    onToggleMute: () => {
      if (volume > 0) {
        previousVolumeRef.current = volume
        setVolume(0)
      } else {
        setVolume(previousVolumeRef.current || 0.82)
      }
    },
    onToggleShuffle: toggleShuffle,
    onCycleRepeat: cycleRepeat,
  })

  // 6. Dynamic cover color accent theme
  const heroTheme = useHeroTheme(currentTrack?.coverUrl, currentTrack?.accent)

  // 7. Favorites toggle handler
  const favoritesPlaylist = playlists.find((p) => p.id === favoritesId)
  const favoriteTrackIds = new Set(favoritesPlaylist?.trackIds ?? [])

  const handleToggleFavorite = (trackId: string) => {
    const trk = tracks.find((t) => t.id === trackId)
    const title = trk ? cleanDisplayTitle(trk.title) : 'Song'
    if (favoriteTrackIds.has(trackId)) {
      removeTrackFromPlaylist(favoritesId, trackId)
      showToast(`Removed "${title}" from Favorites`, {
        title: 'Favorites',
        type: 'info',
      })
    } else {
      addTrackToPlaylist(favoritesId, trackId)
      showToast(`Added "${title}" to Favorites`, {
        title: 'Favorites',
        type: 'success',
      })
    }
  }

  return (
    <main
      className={[
        'app-shell', 'theme-normal',
        autoHideSidebar ? 'auto-hide-sidebar' : '',
        autoHideSidebar && isSidebarRevealed ? 'sidebar-revealed' : '',
        playerBarHoverMode ? 'player-bar-hover-mode' : 'player-bar-docked',
      ].filter(Boolean).join(' ')}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        if (autoHideSidebar && event.clientX - bounds.left <= 14) setIsSidebarRevealed(true)
      }}
      onMouseLeave={() => {
        if (autoHideSidebar) setIsSidebarRevealed(false)
      }}
      onContextMenu={(event) => event.preventDefault()}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <Sidebar
        activePlaylistId={activePlaylistId}
        playlists={playlists}
        tracks={tracks}
        onSelect={(playlistId) => { setActiveSection('library'); setActivePlaylist(playlistId) }}
        isDownloadsActive={activeSection === 'downloads'}
        onOpenDownloads={() => setActiveSection('downloads')}
        onCreate={handleCreatePlaylist}
        onRenamePlaylist={setPlaylistToRename}
        onDeletePlaylist={setPlaylistToDelete}
        onOpenAddToPlaylist={setPlaylistToAddSongs}
        playlistName={newPlaylistName}
        setPlaylistName={setNewPlaylistName}
        onOpenSettings={() => setIsSettingsOpen(true)}
        autoHideEnabled={autoHideSidebar}
        onAutoHideEnter={() => setIsSidebarRevealed(true)}
        onAutoHideLeave={() => setIsSidebarRevealed(false)}
      />

      <section className="content">
        <AnimatePresence mode="wait" initial={false}>
          {activeSection === 'downloads' ? (
            <motion.div
              key="downloads-section"
              className="content-section-transition"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <DownloadSection
                musicFolderPath={configuredMusicFolderPath}
                isDesktop={isDesktop}
                onChooseMusicFolder={handleNativeMusicFolder}
                onRefreshLibrary={handleRescanMusicFolder}
              />
            </motion.div>
          ) : (
            <motion.div
              key="library-section"
              className="content-section-transition"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
        <header className="topbar">
          <div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activePlaylistId}
                className="topbar-title-row"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
              >
                <h1>{activePlaylist?.name ?? 'Your Library'}</h1>
                {activePlaylist && (
                  <PlaylistActionMenu
                    playlist={activePlaylist}
                    onAddToPlaylist={setPlaylistToAddSongs}
                    onRenamePlaylist={setPlaylistToRename}
                    onDeletePlaylist={setPlaylistToDelete}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </header>

        <HeroPlayer
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          heroTheme={heroTheme}
          onTogglePlay={() => togglePlay(visibleTracks[0]?.id, visibleTracks.map((t) => t.id))}
        />

        <section className="library-tools">
          <label className="search-box">
            <SearchFilled size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search songs, artists, albums"
            />
          </label>
          <div className="library-stats">
            <span>
              {trackCount} {trackCount === 1 ? 'song' : 'songs'} · {formatTime(totalDuration)}
            </span>
          </div>
        </section>

        <AnimatePresence mode="sync" initial={false}>
          <motion.div
            key="track-list-results"
            className="track-list-transition"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <TrackList
          tracks={visibleTracks}
          filterQuery={query}
          playlists={playlists}
          activePlaylistId={activePlaylistId}
          activePlaylist={activePlaylist}
          currentTrackId={currentTrack?.id}
          isPlaying={isPlaying}
          onPlay={(trackId) => handleTrackPlay(trackId, visibleTracks.map((t) => t.id))}
          onToggleFavorite={handleToggleFavorite}
          onOpenAddToPlaylist={setPlaylistToAddSongs}
          onRemoveFromPlaylist={(playlistId, trackId) => {
            removeTrackFromPlaylist(playlistId, trackId)
            const pl = playlists.find((p) => p.id === playlistId)
            const trk = tracks.find((t) => t.id === trackId)
            showToast(
              trk
                ? `Removed "${cleanDisplayTitle(trk.title)}" from ${pl?.name ?? 'playlist'}`
                : `Removed from ${pl?.name ?? 'playlist'}`,
              { title: 'Playlist Updated', type: 'info' },
            )
          }}
          onEditTrack={setEditingTrack}
          onDeleteTrack={(track) => {
            deleteTrackFromLibrary(track.id)
            showToast(`Removed "${cleanDisplayTitle(track.title)}" from your library`, {
              title: 'Song Deleted',
              type: 'info',
            })
          }}
          onAddSongs={handleMusicFiles}
          onAddMusicFolder={handleMusicFolder}
          onAddCoverFolder={handleCoverFolder}
          isDesktop={isDesktop}
          onNativeAddSongs={handleNativeAddSongs}
          onNativeMusicFolder={handleNativeMusicFolder}
          onNativeCoverFolder={handleNativeCoverFolder}
            />
          </motion.div>
        </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <PlayerBar
        currentTrack={currentTrack}
        isPlaying={isPlaying}
        audioRef={audioRef}
        seek={seek}
        shuffle={shuffle}
        repeat={repeat}
        volume={volume}
        onTogglePlay={() => togglePlay(visibleTracks[0]?.id, visibleTracks.map((t) => t.id))}
        onPrevious={playPrevious}
        onNext={playNext}
        onSeek={handleSeek}
        onShuffle={toggleShuffle}
        onRepeat={cycleRepeat}
        onVolume={setVolume}
      />

      <AnimatePresence>
        {playlistToAddSongs && (
          <AddToPlaylistModal
            key="add-to-playlist-modal"
            playlist={
              playlists.find((p) => p.id === playlistToAddSongs.id) ?? playlistToAddSongs
            }
            allTracks={tracks}
            onClose={() => setPlaylistToAddSongs(null)}
            onAddTrack={(playlistId, trackId) => {
              addTrackToPlaylist(playlistId, trackId)
              const pl = playlists.find((p) => p.id === playlistId)
              const trk = tracks.find((t) => t.id === trackId)
              showToast(
                trk
                  ? `Added "${cleanDisplayTitle(trk.title)}" to ${pl?.name ?? 'playlist'}`
                  : 'Added to playlist',
                { title: 'Playlist Updated', type: 'success' },
              )
            }}
            onRemoveTrack={(playlistId, trackId) => {
              removeTrackFromPlaylist(playlistId, trackId)
              const pl = playlists.find((p) => p.id === playlistId)
              const trk = tracks.find((t) => t.id === trackId)
              showToast(
                trk
                  ? `Removed "${cleanDisplayTitle(trk.title)}" from ${pl?.name ?? 'playlist'}`
                  : 'Removed from playlist',
                { title: 'Playlist Updated', type: 'info' },
              )
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editingTrack && (
          <EditTrackModal
            key="edit-track-modal"
            track={editingTrack}
            isPlaying={isPlaying}
            onClose={() => setEditingTrack(null)}
            onSave={(updates) => {
              updateTrack(editingTrack.id, updates)
              showToast('Track details saved successfully', { title: 'Track Updated', type: 'success' })
              setEditingTrack(null)
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {playlistToRename && (
          <RenamePlaylistModal
            key="rename-playlist-modal"
            playlist={playlistToRename}
            onClose={() => setPlaylistToRename(null)}
            onSave={handleConfirmRename}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {playlistToDelete && (
          <DeletePlaylistModal
            key="delete-playlist-modal"
            playlist={playlistToDelete}
            onClose={() => setPlaylistToDelete(null)}
            onConfirm={handleConfirmDelete}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isSettingsOpen && (
          <SettingsModal
            key="settings-modal"
            onClose={() => setIsSettingsOpen(false)}
            isDesktop={isDesktop}
            onAddMusicFolder={handleMusicFolder}
            onAddCoverFolder={handleCoverFolder}
            onNativeMusicFolder={handleNativeMusicFolder}
            onNativeCoverFolder={handleNativeCoverFolder}
            onRescanMusicFolder={handleRescanMusicFolder}
            onRescanCoverFolder={handleRescanCoverFolder}
            isScanningMusic={isScanningMusic}
            isScanningCovers={isScanningCovers}
            musicFolderName={musicFolderName}
            coverFolderName={coverFolderName}
            scanNotice={scanNotice}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {shouldShowFirstRunSetup && (
          <FirstRunSetupModal
            key="first-run-setup-modal"
            step={visibleFirstRunStep}
            musicFolderName={musicFolderName || (configuredMusicFolderPath ? 'Your music folder' : undefined)}
            coverFolderName={coverFolderName}
            busyAction={firstRunBusyAction}
            onChooseMusicFolder={handleFirstRunChooseMusic}
            onChooseCoverFolder={handleFirstRunChooseCovers}
            onSkipMusic={() => {
              setFirstRunSetupStep('covers')
              setIsFirstRunSetupInProgress(false)
            }}
            onSkipCoverArt={finishFirstRunSetup}
            onSetUpLater={finishFirstRunSetup}
          />
        )}
      </AnimatePresence>

      <NotificationToast />
    </main>
  )
}

export default App
