# IPTV UWP VLC

An IPTV player for **Xbox Developer Mode** with **VLC built in**.

It is the [LG IPTV player](https://github.com/sharktie/lg-iptv) for webOS, brought to the Xbox: the same Live TV guide, catch-up, movies and series, packaged in a UWP app that plays every stream with LibVLC. IPTV streams that a browser can't handle play here, because VLC does the decoding instead of the Edge engine: raw MPEG-TS, AC3 / E-AC3 / MP2 audio, interlaced (1080i / 576i) channels, MPEG-2, HEVC, and MKV films with several audio and subtitle tracks.

> **VLC is wrapped into the app.** The package contains LibVLC (the engine behind VLC media player). You don't need to install anything else.

No channels are included: you need your own IPTV subscription (Xtream Codes login or an M3U playlist).

## Features
- **Xtream Codes and M3U playlists**, with several profiles.
- **Live TV** with a guide timeline (from the provider or your own XMLTV), a preview while you browse, fullscreen, favourites, favourite categories, channel numbers and catch-up.
- **Movies and series** with search, resume and next episode.
- **Subtitles**: from the provider, from OpenSubtitles, or inside the stream (DVB, teletext and MKV subtitle tracks are drawn by VLC).
- **Audio tracks**: switch language on films and channels that carry several.
- **VLC player settings** (Settings → Player): hardware or software decoding, and how much each kind of stream buffers.
- If a live channel's connection drops, it reconnects and carries on.
- Full controller support, including typing with the console's keyboard.

## Install on Xbox
This app is for Xbox consoles in **Developer Mode**, which is how Xbox lets you install apps from outside the Store.

1. **Turn on Developer Mode.** Follow Microsoft's guide: [Xbox Developer Mode activation](https://learn.microsoft.com/windows/uwp/xbox-apps/devkit-activation).
2. **Download the app.** On your PC, open this repository's [Releases](../../releases/latest) page, download `IPTVUWPVLC-x64.zip` and unzip it. Inside is the app (`IPTV_…_x64.msix`) and a `Dependencies` folder with its 5 dependency packages (`.appx`). Every build in the [Actions](../../actions) tab also has the same files as its `IPTVUWPVLC-x64` artifact.
3. **Open the Device Portal.** On the Xbox, in **Dev Home**, open **Remote Access Settings**, turn on the Xbox Device Portal and set a username and password. On your PC, open the address it shows, e.g. `https://192.168.1.20:11443` (a certificate warning is expected).
4. **Install.** In the Device Portal, under **My games & apps**, choose **Add**:
   - Choose the `.msix` file and select **Next**.
   - Add the 5 files from the `Dependencies` folder and select **Next**.
   - Select **Start** and wait for the install to finish.
5. **Open it.** In Dev Home the app appears as **IPTV Player**.

**Updating:** Settings → Updates checks for a newer release. Install it the same way; it replaces the old version and keeps your playlists and settings. What changed in each release is in [CHANGELOG.md](CHANGELOG.md).

## Getting started
Open **Settings → Profiles**, add a profile, and enter either your **Xtream Codes** server, username and password, or your **M3U playlist** URL (with an optional XMLTV guide URL). Channels load as soon as you open Live TV.

Settings can also be filled in from your phone or computer: scan the QR code on the Settings screen.

## Troubleshooting
- **A channel's picture is broken or stutters:** press X during playback to switch between hardware and software decoding for it. The app remembers which one worked for each channel.
- **Playback info:** press View during playback for what VLC is doing: the engine, resolution, codecs, pictures and sound played and lost, and the network speed.
- **The log:** Settings → Updates → View log shows the end of the app's log on the TV. To copy the whole file, download it from the Device Portal: **File explorer → LocalAppData →** the IPTV package folder (`874fbd47-…`) **→ LocalState → `iptv-vlc.log`**. Include it when reporting a problem.

Known limitations:
- Multiview isn't available yet: the app has one VLC player, so one channel plays at a time.
- Streams that need browser DRM won't play.

## Building
Every push builds signed packages with GitHub Actions (`.github/workflows/build.yml`), and pushing a tag such as `v1.0.0` publishes a release.
