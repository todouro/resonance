import { Download } from 'lucide-react'
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
        className={`nav-item nav-playlist-item ${active ? 'active' : ''}`}
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
          <HeartFilled size={14} />
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
  const favoritesPlaylist = playlists.find((playlist) => playlist.id === favoritesId)
  const userPlaylists = playlists.filter((playlist) => playlist.id !== favoritesId)

  const playlistActions = {
    onSelect,
    onRenamePlaylist,
    onDeletePlaylist,
    onOpenAddToPlaylist,
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
          <DiscFilled size={14} />
          <span>All Songs</span>
          <em>{tracks.length}</em>
        </button>

        {favoritesPlaylist && (
          <SidebarPlaylistItem
            playlist={favoritesPlaylist}
            active={activePlaylistId === favoritesId}
            showCount
            {...playlistActions}
          />
        )}

        <section className="nav-playlists-section" aria-label="Your playlists">
          <h2 className="nav-section-heading">Your Playlists</h2>

          {userPlaylists.map((playlist) => (
            <SidebarPlaylistItem
              key={playlist.id}
              playlist={playlist}
              active={activePlaylistId === playlist.id}
              color={playlistAccentColors[Math.abs(playlist.createdAt) % playlistAccentColors.length]}
              {...playlistActions}
            />
          ))}

          <form
            className="nav-item playlist-form"
            onSubmit={(event) => {
              event.preventDefault()
              onCreate()
            }}
          >
            <PlaylistFilled size={14} className="playlist-form-icon" />
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
        </section>

        <div className="sidebar-divider" role="separator" />

        <div className="nav-secondary">
          <button
            type="button"
            className={`nav-item ${isDownloadsActive ? 'active' : ''}`}
            title="Download audio with yt-dlp"
            aria-current={isDownloadsActive ? 'page' : undefined}
            onClick={onOpenDownloads}
          >
            <Download size={14} />
            <span>Downloads</span>
          </button>

          <button
            type="button"
            className="nav-item nav-settings-btn"
            title="Open settings"
            aria-label="Settings"
            onClick={onOpenSettings}
          >
            <SettingsFilled size={14} />
            <span>Settings</span>
          </button>
        </div>
      </nav>
    </aside>
  )
}

export default Sidebar
