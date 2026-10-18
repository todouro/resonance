# Spotify library import

Resonance uses Spotify's Web API with Authorization Code + PKCE. No Spotify Client Secret is needed or accepted by the app.

## Set up a Spotify app

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app using the Web API.
2. In the app settings, add this Redirect URI exactly: `http://127.0.0.1:43821/callback`.
3. Copy the app's **Client ID** (not the Client Secret) into Resonance's **Spotify Import** panel.
4. Choose **Connect & import** and approve the read-only saved-library and playlist permissions.

For development or a custom build, you can provide `VITE_SPOTIFY_CLIENT_ID` at build time. Users can also enter a Client ID in the import panel; it is saved locally for that app installation.

## What sync does

- Fetches the current user's Spotify Liked Songs and playlists using `GET /me/tracks`, `GET /me/playlists`, and `GET /playlists/{id}/items`.
- Adds a local Resonance playlist for Spotify Liked Songs and each playlist whose items Spotify permits the account to read.
- Matches track title and artist against playable audio files already indexed by Resonance. Only local matches are added to Resonance's playback queue.
- Keeps Spotify playlist links with imported playlists and reports tracks that are not available locally.

Spotify's current API restricts playlist-item access for playlists the user does not own or collaborate on. Those playlists are reported as skipped rather than silently imported as empty. Spotify's service does not provide downloadable audio files through these endpoints, and Resonance does not download or rip Spotify streams. Put missing audio files into your local Music folder and rescan to make them playable.
