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

  const handlePlaylistKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    playlistId: string,
  ) => {
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      onSelect(playlistId)
    }
  }

  return (
    <aside
      className="sidebar"
      onMouseEnter={autoHideEnabled ? onAutoHideEnter : undefined}
      onMouseLeave={autoHideEnabled ? onAutoHideLeave : undefined}
    >
      <nav className="nav-stack" aria-label="Music sections">
        <button
          className={activePlaylistId === libraryId ? 'nav-item nav-library-item active' : 'nav-item nav-library-item'}
          type="button"
          aria-current={activePlaylistId === libraryId ? 'page' : undefined}
          onClick={() => onSelect(libraryId)}
        >
          <DiscFilled size={14} />
          <span>All Songs</span>
          <em>{tracks.length}</em>
        </button>

        {favoritesPlaylist && (
          <div
            className={`nav-item nav-playlist-item nav-favorites-item ${activePlaylistId === favoritesPlaylist.id ? 'active' : ''}`}
            onClick={() => onSelect(favoritesPlaylist.id)}
            role="button"
            tabIndex={0}
            aria-current={activePlaylistId === favoritesPlaylist.id ? 'page' : undefined}
            onKeyDown={(event) => handlePlaylistKeyDown(event, favoritesPlaylist.id)}
          >
            <HeartFilled size={14} />
            <span className="nav-playlist-name">Favorites</span>
            <em>{favoritesPlaylist.trackIds.length}</em>
            <div className="nav-item-actions">
              <PlaylistActionMenu
                playlist={favoritesPlaylist}
                onAddToPlaylist={onOpenAddToPlaylist}
                onRenamePlaylist={onRenamePlaylist}
                onDeletePlaylist={onDeletePlaylist}
              />
            </div>
          </div>
        )}

        <section className="nav-playlists-section" aria-label="Your playlists">
          <div className="nav-section-heading">Your Playlists</div>

          {userPlaylists.map((playlist, index) => (
            <div
              key={playlist.id}
              className={`nav-item nav-playlist-item ${activePlaylistId === playlist.id ? 'active' : ''}`}
              onClick={() => onSelect(playlist.id)}
              role="button"
              tabIndex={0}
              aria-current={activePlaylistId === playlist.id ? 'page' : undefined}
              onKeyDown={(event) => handlePlaylistKeyDown(event, playlist.id)}
            >
              <span
                className="nav-playlist-color"
                style={{ backgroundColor: playlistAccentColors[index % playlistAccentColors.length] }}
                aria-hidden="true"
              />
              <span className="nav-playlist-name">{playlist.name}</span>
              <div className="nav-item-actions">
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
