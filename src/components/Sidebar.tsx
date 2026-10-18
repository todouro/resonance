import { useRef } from 'react'
import type { ChangeEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Download, ExternalLink, Music2 } from 'lucide-react'
import {
  AudioLinesFilled,
  CheckFilled,
  DiscFilled,
  FolderImageFilled,
  FolderMusicFilled,
  HeartFilled,
  PlaylistFilled,
  PlusFilled,
  RefreshFilled,
  SettingsFilled,
} from './icons'
import { favoritesId, libraryId } from '../store/useMusicStore'
import type { Playlist, Track } from '../types'
import { PlaylistActionMenu } from './PlaylistActionMenu'

export type SidebarProps = {
  activePlaylistId: string
  playlists: Playlist[]
  tracks: Track[]
  playlistName: string
  setPlaylistName: (name: string) => void
  onSelect: (playlistId: string) => void
  onCreate: () => void
  onRenamePlaylist: (playlist: Playlist) => void
  onDeletePlaylist: (playlist: Playlist) => void
  onOpenAddToPlaylist?: (playlist: Playlist) => void
  onAddMusicFolder: (e: ChangeEvent<HTMLInputElement>) => void
  onAddCoverFolder: (e: ChangeEvent<HTMLInputElement>) => void
  isDesktop?: boolean
  onNativeMusicFolder?: () => void
  onNativeCoverFolder?: () => void
  onRescanMusicFolder?: () => void
  onRescanCoverFolder?: () => void
  isScanningMusic?: boolean
  isScanningCovers?: boolean
  musicFolderName?: string
  coverFolderName?: string
  scanNotice?: string | null
  onOpenSettings?: () => void
  isDownloadsActive?: boolean
  onOpenDownloads?: () => void
  onOpenSpotify?: () => void
}

export function Sidebar({
  activePlaylistId,
  playlists,
  tracks,
  playlistName,
  setPlaylistName,
  onSelect,
  onCreate,
  onRenamePlaylist,
  onDeletePlaylist,
  onOpenAddToPlaylist,
  onAddMusicFolder,
  onAddCoverFolder,
  isDesktop = false,
  onNativeMusicFolder,
  onNativeCoverFolder,
  onRescanMusicFolder,
  onRescanCoverFolder,
  isScanningMusic = false,
  isScanningCovers = false,
  musicFolderName,
  coverFolderName,
  scanNotice,
  onOpenSettings,
  isDownloadsActive = false,
  onOpenDownloads,
  onOpenSpotify,
}: SidebarProps) {
  const musicInputRef = useRef<HTMLInputElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  const handleMusicTriggerClick = () => {
    if (isDesktop && onNativeMusicFolder) {
      onNativeMusicFolder()
    } else {
      musicInputRef.current?.click()
    }
  }

  const handleCoverTriggerClick = () => {
    if (isDesktop && onNativeCoverFolder) {
      onNativeCoverFolder()
    } else {
      coverInputRef.current?.click()
    }
  }

  const handleRescanMusicClick = () => {
    if (onRescanMusicFolder) {
      onRescanMusicFolder()
    } else {
      handleMusicTriggerClick()
    }
  }

  const handleRescanCoverClick = () => {
    if (onRescanCoverFolder) {
      onRescanCoverFolder()
    } else {
      handleCoverTriggerClick()
    }
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <AudioLinesFilled size={22} />
        </div>
        <div>
          <strong>Resonance</strong>
          <span>Local library</span>
        </div>
      </div>

      <nav className="nav-stack" aria-label="Music sections">
        <button
          className={activePlaylistId === libraryId ? 'nav-item active' : 'nav-item'}
          type="button"
          onClick={() => onSelect(libraryId)}
        >
          <DiscFilled size={18} />
          <span>All Songs</span>
          <em>{tracks.length}</em>
        </button>
        {playlists.map((playlist) => (
          <div
            key={playlist.id}
            className={`nav-item nav-playlist-item ${activePlaylistId === playlist.id ? 'active' : ''}`}
            onClick={() => onSelect(playlist.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault()
                onSelect(playlist.id)
              }
            }}
          >
            {playlist.id === favoritesId ? <HeartFilled size={18} /> : playlist.source === 'spotify' ? <Music2 size={18} /> : <PlaylistFilled size={18} />}
            <span className="nav-playlist-name">{playlist.name}</span>
            <em>{playlist.trackIds.length}</em>
            <div className="nav-item-actions">
              {playlist.source === 'spotify' && playlist.externalUrl && (
                <a
                  className="spotify-playlist-link"
                  href={playlist.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Open this playlist on Spotify"
                  aria-label={`Open ${playlist.name} on Spotify`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <ExternalLink size={13} />
                </a>
              )}
              <PlaylistActionMenu
                playlist={playlist}
                onAddToPlaylist={onOpenAddToPlaylist}
                onRenamePlaylist={onRenamePlaylist}
                onDeletePlaylist={onDeletePlaylist}
              />
            </div>
          </div>
        ))}
        <form
          className="nav-item playlist-form"
          onSubmit={(event) => {
            event.preventDefault()
            onCreate()
          }}
        >
          <PlaylistFilled size={18} className="playlist-form-icon" />
          <input
            value={playlistName}
            onChange={(event) => setPlaylistName(event.target.value)}
            placeholder="New playlist"
            aria-label="New playlist name"
          />
          <button
            type="submit"
            aria-label="Create playlist"
            className="playlist-add-btn"
            title="Create playlist"
          >
            <PlusFilled size={14} />
          </button>
        </form>


        {/* Music Folder row with dedicated Rescan button */}
        <div className="nav-item nav-folder-row">
          <button
            type="button"
            className="nav-folder-trigger"
            title={
              musicFolderName
                ? `Music folder: ${musicFolderName} (click to change)`
                : 'Select or import a music folder'
            }
            onClick={handleMusicTriggerClick}
          >
            <FolderMusicFilled size={18} />
            <span className="nav-folder-label">
              {isScanningMusic ? 'Scanning...' : 'Music folder'}
            </span>
          </button>

          {!isDesktop && (
            <input
              ref={musicInputRef}
              type="file"
              multiple
              onChange={onAddMusicFolder}
              {...{ webkitdirectory: '', directory: '' }}
              style={{ display: 'none' }}
              aria-hidden="true"
            />
          )}

          <button
            type="button"
            className={`nav-rescan-btn ${isScanningMusic ? 'scanning' : ''}`}
            title={
              musicFolderName
                ? `Rescan "${musicFolderName}" for new songs`
                : 'Rescan music folder for new songs'
            }
            aria-label="Rescan music folder"
            onClick={handleRescanMusicClick}
            disabled={isScanningMusic}
          >
            <RefreshFilled size={14} className={isScanningMusic ? 'spinning' : ''} />
          </button>
        </div>

        {/* Cover Folder row with dedicated Rescan button */}
        <div className="nav-item nav-folder-row">
          <button
            type="button"
            className="nav-folder-trigger"
            title={
              coverFolderName
                ? `Cover folder: ${coverFolderName} (click to change)`
                : 'Select or import a cover artwork folder'
            }
            onClick={handleCoverTriggerClick}
          >
            <FolderImageFilled size={18} />
            <span className="nav-folder-label">
              {isScanningCovers ? 'Scanning...' : 'Cover folder'}
            </span>
          </button>

          {!isDesktop && (
            <input
              ref={coverInputRef}
              type="file"
              multiple
              onChange={onAddCoverFolder}
              {...{ webkitdirectory: '', directory: '' }}
              style={{ display: 'none' }}
              aria-hidden="true"
            />
          )}

          <button
            type="button"
            className={`nav-rescan-btn ${isScanningCovers ? 'scanning' : ''}`}
            title={
              coverFolderName
                ? `Rescan "${coverFolderName}" for new artwork`
                : 'Rescan cover folder for new artwork'
            }
            aria-label="Rescan cover folder"
            onClick={handleRescanCoverClick}
            disabled={isScanningCovers}
          >
            <RefreshFilled size={14} className={isScanningCovers ? 'spinning' : ''} />
          </button>
        </div>

        <button
          type="button"
          className="nav-item spotify-import-nav"
          title="Connect Spotify and import your playlists"
          onClick={onOpenSpotify}
        >
          <Music2 size={18} />
          <span>Spotify Import</span>
        </button>

        <button
          type="button"
          className={`nav-item ${isDownloadsActive ? 'active' : ''}`}
          title="Download audio with yt-dlp"
          aria-current={isDownloadsActive ? 'page' : undefined}
          onClick={onOpenDownloads}
        >
          <Download size={18} />
          <span>Downloads</span>
        </button>

        <div className="sidebar-divider" role="separator" />

        <button
          type="button"
          className="nav-item nav-settings-btn"
          title="Open settings"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <SettingsFilled size={18} />
          <span>Settings</span>
        </button>

        <AnimatePresence>
          {scanNotice && (
            <motion.div
              className="sidebar-scan-notice"
              role="status"
              initial={{ opacity: 0, y: 6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.96 }}
              transition={{ duration: 0.2 }}
            >
              <CheckFilled size={14} />
              <span>{scanNotice}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>
    </aside>
  )
}

export default Sidebar
