# Spotify public-link import

Resonance can import track metadata from publicly accessible Spotify playlist, album, and track links without asking the user to create a Spotify Developer app or sign in.

## Usage

1. Open the Spotify Import section in Resonance.
2. Copy a public playlist, album, or track link from Spotify. Use the canonical `https://open.spotify.com/...` URL or a Spotify URI.
3. Paste the link and choose **Fetch tracks**.
4. Review the visible tracks and choose **Add to Resonance**.

No Spotify Client ID or Client Secret is required. The importer reads metadata that Spotify exposes through its public pages and oEmbed data; it does not access private user-library endpoints.

## Limitations

- This is a **public-link import**, not a private account-library sync. It cannot fetch your personal Liked Songs or private playlists automatically.
- Spotify may expose only part of a large playlist or hide its track list from public page markup. Resonance limits the import to 250 discovered tracks and reports a clear error if no track IDs are exposed.
- Public page markup is not a stable API and Spotify can change it, so some links may stop working or return incomplete metadata.
- Tracks that match audio files already in Resonance can play locally. Other entries are metadata placeholders until the user adds their own audio files to the Music folder and rescans.
- Resonance does not stream, download, or rip Spotify audio.

The separate Spotify Web API requires an app registered by a developer; Spotify's current development-mode rules require the app owner to have Premium and limit the app to five authorized users. Public-link import avoids those developer credentials but cannot replace authenticated personal-library access.
