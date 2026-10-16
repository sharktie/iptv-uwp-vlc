# Web app ↔ app messages

The IPTV web app (`web/`) runs in a WebView2 inside the UWP app. They talk with JSON objects:
the page sends with `window.chrome.webview.postMessage(object)` (`web/js/platform/native.js`), and
the app answers with `PostWebMessageAsJson`, which the page receives as `message` events
(`IPTV/Bridge/AppBridge.cs`). Every message has a `type`. Messages are only accepted from the
web app's own origin.

In a normal browser there is no `window.chrome.webview`; the web app then plays with the
browser as it does on webOS. Inside the app, `web/js/platform/native-video.js` gives the page's
`<video>` element the media API in front of VLC, so the player code drives VLC through the usual
`src`, `play()`, `currentTime` and media events. VLC draws under the page, at the box the page
reports with `player.layout`.

## Page → app

### App
| type | fields | |
| --- | --- | --- |
| `app.hello` | | Asks for `app.hello` back. Sent at startup. |
| `app.log` | `message` | Writes a line to the app's log (`LocalState/iptv-vlc.log`). |
| `app.textInput` | `requestId`, `label`, `value`, `kind` (`text`, `password`, `email`, `url`, `search`, `number`) | Shows the on-screen keyboard dialog. Answered with `response`: `result` is `{ text, submitted }`, or null if cancelled. `submitted` is true when the user finished with the keyboard's Enter. |
| `app.openExternal` | `url` | Opens an http(s) link in the system browser. |
| `app.pointer` | `enabled` | Turns the console's mouse-mode cursor on or off (off by default). |
| `app.setWebAppUrl` | `url` (or null) | Loads the web app from that address from now on (development), or the built-in copy for null. Reloads. |
| `app.exit` | | Closes the app. |
| `app.getLog` | `requestId` | Answered with `response`: `result` is `{ current, previous }`, the end of this session's log and the last session's (empty strings if there's none). |
| `net.fetch` | `requestId`, `url`, `method`, `headers`, `body` | HTTP request made by the app instead of the browser (the page itself already ignores CORS in the app; see IPTV/App.xaml.cs). Answered with `response`: `result` is `{ status, url, headers, bodyBase64 }`, or `error`. Responses over 16 MB are refused. |

### Player
| type | fields | |
| --- | --- | --- |
| `player.open` | `id`, `url`, `start` (seconds), `headers` (object), `hwdec` (bool), `caching` (ms), `lowQuality` (bool) | Plays a stream. `id` is chosen by the page; every event about this stream carries it. `caching` is how much VLC buffers (default 3000; live channels use less so they start quickly). `lowQuality` keeps adaptive streams (HLS, DASH) on their lowest quality. |
| `player.stop` | | Stops and hides the video. |
| `player.play` / `player.pause` / `player.toggle` | `paused` (pause only) | |
| `player.seek` | `time` (seconds) | |
| `player.rate` | `rate` | Playback speed, up to 4. |
| `player.volume` | `volume` (0–200) | |
| `player.mute` | `muted` | |
| `player.audioTrack` | `trackId` | A track id from `player.tracks`, or -1 for none. |
| `player.subtitleTrack` | `trackId` | A subtitle track from `player.tracks` (drawn by VLC), or -1 for none. |
| `player.subtitleDelay` / `player.audioDelay` | `ms` | |
| `player.aspect` | `mode` | `fit`, `fill` (crop to the screen), `stretch`, or a ratio such as `16:9`. |
| `player.layout` | `visible`, `x`, `y`, `width`, `height`, `viewWidth`, `viewHeight` (page pixels) | Where the page's video box is, and the page's size (`innerWidth`, `innerHeight`): VLC's picture is drawn there (the Live TV preview, or the whole screen). The app scales the box by its web view's size over the page's, since page pixels aren't the app's on every device (on Xbox the page is 1280×720 and the app 960×540). A box covering the whole page fills the window. Hidden when `visible` is false. Until the page sends one, the picture fills the window. |
| `player.stats` | `requestId` | Answered with `response`: `result` is VLC's counters for the stream playing — `displayedPictures`, `lostPictures`, `decodedVideo`, `playedAudioBuffers`, `lostAudioBuffers`, `decodedAudio`, `inputKbps`, `demuxCorrupted`, `demuxDiscontinuity`, `hardwareDecoding`, `outputColorspace` (how VLC encodes the picture for the screen, e.g. `RGB Rec.2020 gamma:2084 range:FULL` for HDR10) — or null. |

## App → page

| type | fields | |
| --- | --- | --- |
| `app.hello` | `platform` (`xbox` or `desktop`), `appVersion`, `vlcVersion` (null until VLC has started), `webAppUrl`, `bundled` | |
| `input` | `action`, `repeat` | A controller button: `up`, `down`, `left`, `right` (D-pad or left stick, repeated while held), `select` (A), `back` (B), `x`, `y`, `menu`, `view`, `lb`, `rb`, `lt`, `rt`. |
| `app.visibility` | `visible` | The app went to or came back from the background. |
| `response` | `requestId`, `result`, `error` | Answer to `app.textInput`, `app.getLog`, `net.fetch` and `player.stats`. |
| `player.state` | `id`, `state` (`opening`, `buffering`, `playing`, `paused`), `message` | `buffering` here means reconnecting after a dropped connection. |
| `player.buffering` | `id`, `percent` | VLC's cache filling (100 = playing smoothly). |
| `player.time` | `id`, `time`, `duration` (seconds) | About four times a second while playing. |
| `player.duration` | `id`, `duration` | Once, when VLC knows the length. |
| `player.tracks` | `id`, `audio`, `subtitles` (arrays of `{ id, name, lang, title, codec, selected }`), `audioId`, `subtitleId`, `width`, `height`, `videoCodec` | Whenever the tracks change. `width`/`height` are 0 while VLC doesn't know them yet. |
| `player.video` | `id`, `width`, `height` | |
| `player.ready` | `id` | The first frame is showing (or, for audio, playback started); the page turns transparent. |
| `player.ended` | `id`, `reason` (`eof` or `error`), `message` | A stream that ends before it ever played is reported as an error. Dropped connections are retried (up to 5 times within two minutes) before anything is reported; a live stream, which has no end, is always picked up again at the live edge. |
