# Changelog

A release's notes come from its section here (the heading must match the tag).

## v1.0.3
- HDR channels (often the 4K ones) that looked grey in fullscreen on TVs without HDR, but right in the Live TV preview: fullscreen video is now drawn the same way as the preview, so the console converts it for the TV there too.
- Playback info (View during playback) shows how VLC sends the picture to the screen: SDR or HDR10.

## v1.0.2
- Search boxes open the console keyboard when you press A on them (Live TV, Movies & Series, Catch-up and Settings).
- The sticks move one step per flick: a stick springing back no longer moves twice or back the other way, and the right stick works like the left.
- Grey 4K channels: see the Troubleshooting section of the README (they are HDR, and the Xbox needs HDR10 turned on). The app's log now says how VLC handles a channel's colours.

## v1.0.1
- Fixed the picture's position on Xbox: the Live TV preview showed only part of the channel, off to one side; fullscreen was zoomed in and cropped; and films sat too low, with their bottom cut off. The picture now fits the preview box, and fills and centres in fullscreen and the player.

## v1.0.0
- First release: the LG IPTV player's Live TV, guide, catch-up, movies and series on Xbox, with every stream played by VLC.
- Raw MPEG-TS, AC3 / E-AC3 / MP2 audio, interlaced channels, MPEG-2 and HEVC play, and films can switch audio language and show their built-in subtitles.
- Settings → Player: hardware or software decoding, and how much live channels and films buffer. X during playback switches decoding for that channel.
- Settings → Updates: check for a newer release and view the app's log.
