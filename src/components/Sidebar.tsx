import { Check, ChevronDown, Download, X } from 'lucide-react'
import { useState } from 'react'
import {
  DiscFilled,
  HeartFilled,
  PlaylistFilled,
  PlusFilled,
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
  onOpenSettings?: () => void
  isDownloadsActive?: boolean
  onOpenDownloads?: () => void
  autoHideEnabled?: boolean
  onAutoHideEnter?: () => void
  onAutoHideLeave?: () => void
}

const playlistAccentColors = [
  '#a8b0bc',
  '#bba2d1',
  '#92bdb0',
  '#cfb08a',
  '#8daed6',
  '#d4a3b2',
]

type SidebarPlaylistItemProps = {
  playlist: Playlist
  active: boolean
  favorite?: boolean
  color?: string
  showCount?: boolean
  onSelect: (playlistId: string) => void
  onRenamePlaylist: (playlist: Playlist) => void
  onDeletePlaylist: (playlist: Playlist) => void
  onOpenAddToPlaylist?: (playlist: Playlist) => void
}

function SidebarPlaylistItem({
  playlist,
  active,
  favorite = false,
  color,
  showCount = false,
  onSelect,
  onRenamePlaylist,
  onDeletePlaylist,
  onOpenAddToPlaylist,
}: SidebarPlaylistItemProps) {
  return (
    <div className="nav-playlist-entry">
      <button
        type="button"
        className={`nav-item nav-playlist-item ${favorite ? 'nav-favorites-item' : ''} ${active ? 'active' : ''}`}
        onClick={() => onSelect(playlist.id)}
        aria-current={active ? 'page' : undefined}
      >
        {color ? (
          <span
            className="nav-playlist-color"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          />
        ) : (
          <HeartFilled size={16} />
        )}
        <span className="nav-playlist-name">{playlist.name}</span>
        {showCount && <em className="nav-playlist-count">{playlist.trackIds.length}</em>}
      </button>

      <div className="nav-item-actions">
        <PlaylistActionMenu
          playlist={playlist}
          onAddToPlaylist={onOpenAddToPlaylist}
          onRenamePlaylist={onRenamePlaylist}
          onDeletePlaylist={onDeletePlaylist}
        />
      </div>
    </div>
  )
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
  onOpenSettings,
  isDownloadsActive = false,
  onOpenDownloads,
  autoHideEnabled = false,
  onAutoHideEnter,
  onAutoHideLeave,
}: SidebarProps) {
  const [isPlaylistsExpanded, setIsPlaylistsExpanded] = useState(true)
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState(false)
  const favoritesPlaylist = playlists.find((playlist) => playlist.id === favoritesId)
  const userPlaylists = playlists.filter((playlist) => playlist.id !== favoritesId)

  const playlistActions = {
    onSelect,
    onRenamePlaylist,
    onDeletePlaylist,
    onOpenAddToPlaylist,
  }

  const handleCreatePlaylist = () => {
    if (!playlistName.trim()) return
    onCreate()
    setIsCreatingPlaylist(false)
  }

  const handleTogglePlaylistCreation = () => {
    if (isCreatingPlaylist) {
      setIsCreatingPlaylist(false)
      setPlaylistName('')
      return
    }

    setIsPlaylistsExpanded(true)
    setIsCreatingPlaylist(true)
  }

  return (
    <aside
      className="sidebar"
      onMouseEnter={autoHideEnabled ? onAutoHideEnter : undefined}
      onMouseLeave={autoHideEnabled ? onAutoHideLeave : undefined}
    >
      <nav className="nav-stack" aria-label="Music sections">
        <button
          type="button"
          className={`nav-item nav-library-item ${activePlaylistId === libraryId ? 'active' : ''}`}
          onClick={() => onSelect(libraryId)}
          aria-current={activePlaylistId === libraryId ? 'page' : undefined}
        >
          <DiscFilled size={16} />
          <span>All Songs</span>
          <em>{tracks.length}</em>
        </button>

        {favoritesPlaylist && (
          <SidebarPlaylistItem
            playlist={favoritesPlaylist}
            active={activePlaylistId === favoritesId}
            favorite
            showCount
            {...playlistActions}
          />
        )}

        <section
          className={`nav-playlists-section ${isPlaylistsExpanded ? '' : 'is-collapsed'}`}
          aria-label="Playlists"
        >
          <h2 className="nav-section-header">
            <button
              type="button"
              className="nav-section-heading"
              aria-expanded={isPlaylistsExpanded}
              aria-controls="sidebar-playlists-list"
              onClick={() => setIsPlaylistsExpanded((expanded) => !expanded)}
            >
              <ChevronDown
                size={14}
                className="nav-section-chevron"
                aria-hidden="true"
              />
              <span>Playlists</span>
            </button>
            <button
              type="button"
              className="playlist-add-btn nav-playlist-create-btn"
              aria-label={isCreatingPlaylist ? 'Cancel playlist creation' : 'Create playlist'}
              title={isCreatingPlaylist ? 'Cancel playlist creation' : 'Create playlist'}
              onClick={handleTogglePlaylistCreation}
            >
              {isCreatingPlaylist ? <X size={16} /> : <PlusFilled size={16} />}
            </button>
          </h2>

          <div
            id="sidebar-playlists-list"
            className="nav-playlists-list"
            hidden={!isPlaylistsExpanded}
          >
            {userPlaylists.map((playlist) => (
              <SidebarPlaylistItem
                key={playlist.id}
                playlist={playlist}
                active={activePlaylistId === playlist.id}
                color={playlistAccentColors[Math.abs(playlist.createdAt) % playlistAccentColors.length]}
                {...playlistActions}
              />
            ))}

            {isCreatingPlaylist && (
              <form
                className="nav-item playlist-form"
                autoComplete="off"
                onSubmit={(event) => {
                  event.preventDefault()
                  handleCreatePlaylist()
                }}
              >
                <PlaylistFilled size={16} className="playlist-form-icon" aria-hidden="true" />
                <input
                  value={playlistName}
                  onChange={(event) => setPlaylistName(event.target.value)}
                  placeholder="Playlist name"
                  aria-label="New playlist name"
                  autoFocus
                />
                <button
                  type="submit"
                  aria-label="Save playlist"
                  className="playlist-add-btn playlist-save-btn"
                  title="Save playlist"
                  disabled={!playlistName.trim()}
                >
                  <Check size={15} />
                </button>
              </form>
            )}
          </div>
        </section>

        <div className="sidebar-divider" role="separator" />

        <div className="nav-secondary">
          <button
            type="button"
            className={`nav-item nav-downloads-btn ${isDownloadsActive ? 'active' : ''}`}
            title="Download audio with yt-dlp"
            aria-current={isDownloadsActive ? 'page' : undefined}
            onClick={onOpenDownloads}
          >
            <Download size={16} />
            <span>Downloads</span>
          </button>

          <button
            type="button"
            className="nav-item nav-settings-btn"
            title="Open settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <SettingsFilled size={16} />
            <span>Settings</span>
          </button>
        </div>
      </nav>
    </aside>
  )
}

export default Sidebar
