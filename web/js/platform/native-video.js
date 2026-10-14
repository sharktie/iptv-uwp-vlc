/* platform/native-video.js — plays the page's <video> with VLC in the app.
 *
 * Inside the Xbox / Windows app (Native.available) the <video> element never
 * receives a stream. attach() puts the element's media API in front of the
 * app's VLC player instead: setting src and calling play() opens the stream in
 * VLC, and VLC's progress comes back as the usual media events
 * (loadedmetadata, playing, timeupdate, pause, ended, error...). Whatever
 * drives the element — player/engine.js, player-vod.js, episodes.js, the ASS
 * renderer — carries on unchanged.
 *
 * VLC draws underneath the web page. The element's box is reported to the app
 * (player.layout), which moves the picture there, and the page is see-through
 * at exactly that box: html.native-video makes the backgrounds between the
 * video and the window transparent and #native-hole paints the page colour
 * everywhere else (assets/native.css).
 *
 * Subtitle files (<track> elements) are drawn here, over the picture: the
 * browser only draws cues for media it plays itself. Subtitles inside the
 * stream (DVB, teletext, MKV text tracks) are drawn by VLC.
 *
 * One VLC player, so one attached element per page — Multiview is off in the
 * app (see livetv/multiview.js).                                              */
window.NativeVideo = (function () {
    'use strict';

    var available = typeof Native !== 'undefined' && Native.available;
    var LAYOUT_POLL_MS = 500;
    /* A stream VLC can't say the length of within this long after it starts is
       treated as live (duration Infinity), as the browser does. */
    var METADATA_WAIT_MS = 1500;
    var nextLoad = 1;

    function attach(el, hooks) {
        if (!available || !el || el._native) return el && el._native;
        hooks = hooks || {};
        var proto = HTMLMediaElement.prototype;
        var nativeRemoveAttribute = el.removeAttribute;
        var nativeSetAttribute = el.setAttribute;

        var S = {
            id: null, src: '', opened: '', needsOpen: false,
            paused: true, ended: false, seeking: false,
            readyState: 0, networkState: 0, started: false, metadataSent: false,
            time: 0, timeAt: 0, duration: NaN, rate: 1, muted: false, volume: 1,
            width: 0, height: 0, error: null,
            hw: true, caching: 0, lowQuality: false, live: false, videoCodec: '',
            audioCodec: '',
            audio: [], audioId: -1, subs: [], subId: -1, metaTimer: 0
        };

        function fire(type) {
            try { el.dispatchEvent(new Event(type)); } catch (e) {}
        }

        function now() { return performance.now(); }

        function currentTime() {
            var t = S.time;
            if (!S.paused && !S.seeking && S.readyState >= 3 && S.timeAt) {
                t += (now() - S.timeAt) / 1000 * S.rate;
            }
            if (isFinite(S.duration) && S.duration > 0) t = Math.min(t, S.duration);
            return Math.max(0, t);
        }

        function stop() {
            clearTimeout(S.metaTimer);
            if (S.id) Native.send('player.stop', {});
            S.id = null;
            S.opened = '';
            S.paused = true;
            S.started = false;
            S.metadataSent = false;
            S.readyState = 0;
            S.networkState = 0;
            S.time = 0;
            S.timeAt = 0;
            S.duration = NaN;
            S.width = S.height = 0;
            S.audio = []; S.audioId = -1;
            S.subs = []; S.subId = -1;
            cues.render();
        }

        function open() {
            stop();
            S.id = 'v' + (nextLoad++) + '-' + Date.now();
            S.opened = S.src;
            S.needsOpen = false;
            S.paused = false;
            S.ended = false;
            S.error = null;
            S.networkState = 2;
            Native.send('player.open', {
                id: S.id, url: S.src, hwdec: S.hw,
                caching: S.caching, lowQuality: S.lowQuality
            });
            if (S.muted) Native.send('player.mute', { muted: true });
            if (S.rate !== 1) Native.send('player.rate', { rate: S.rate });
            fire('loadstart');
            fire('play');
            layout.update();
        }

        /* The order the browser uses: metadata, then data, then playing. */
        function sendMetadata() {
            if (S.metadataSent) return;
            clearTimeout(S.metaTimer);
            S.metadataSent = true;
            if (!(S.duration > 0)) S.duration = Infinity;
            S.readyState = 4;
            fire('durationchange');
            fire('loadedmetadata');
            fire('loadeddata');
            fire('canplay');
            fire('canplaythrough');
            if (!S.paused) fire('playing');
        }

        // ── Events from VLC ─────────────────────────────────────────────────
        function mine(msg) { return msg && S.id && msg.id === S.id; }

        Native.on('player.state', function (msg) {
            if (!mine(msg)) return;
            if (msg.state === 'playing') {
                var wasPaused = S.paused;
                S.paused = false;
                S.timeAt = now();
                if (!S.started) {
                    S.started = true;
                    // A live channel has no length to wait for.
                    if (S.duration > 0 || S.live) sendMetadata();
                    else S.metaTimer = setTimeout(sendMetadata, METADATA_WAIT_MS);
                } else {
                    S.readyState = 4;
                    if (wasPaused) fire('play');
                    fire('playing');
                }
            } else if (msg.state === 'paused') {
                S.time = currentTime();
                if (!S.paused) { S.paused = true; fire('pause'); }
            } else if (msg.state === 'buffering') {
                S.readyState = 2;
                fire('waiting');
            }
        });

        Native.on('player.duration', function (msg) {
            if (!mine(msg) || !(msg.duration > 0)) return;
            S.duration = msg.duration;
            if (S.started && !S.metadataSent) sendMetadata();
            else if (S.metadataSent) fire('durationchange');
        });

        Native.on('player.time', function (msg) {
            if (!mine(msg)) return;
            S.time = msg.time;
            S.timeAt = now();
            if (S.readyState < 3 && S.metadataSent) S.readyState = 4;
            if (S.seeking) { S.seeking = false; fire('seeked'); }
            fire('timeupdate');
        });

        Native.on('player.video', function (msg) {
            if (!mine(msg)) return;
            S.width = msg.width | 0;
            S.height = msg.height | 0;
            fire('resize');
        });

        Native.on('player.tracks', function (msg) {
            if (!mine(msg)) return;
            S.audio = msg.audio || [];
            S.audioId = msg.audioId;
            S.subs = msg.subtitles || [];
            S.subId = msg.subtitleId;
            S.videoCodec = msg.videoCodec || '';
            var active = S.audio.filter(function (t) { return t.id === S.audioId; })[0];
            S.audioCodec = (active && active.codec) || '';
            if (msg.width > 0 && (msg.width !== S.width || msg.height !== S.height)) {
                S.width = msg.width;
                S.height = msg.height;
                fire('resize');
            }
            if (typeof hooks.onTracks === 'function') hooks.onTracks();
        });

        Native.on('player.ended', function (msg) {
            if (!mine(msg)) return;
            clearTimeout(S.metaTimer);
            /* A live channel never finishes; VLC only reports an end once it
               has given up reconnecting, which for the player is a failure. */
            var live = !(S.duration > 0 && isFinite(S.duration));
            if (msg.reason === 'error' || live) {
                S.error = { code: S.started ? 2 : 4, message: msg.message || 'VLC could not play this stream.' };
                S.networkState = 3;
                S.paused = true;
                fire('error');
            } else {
                S.time = currentTime();
                S.paused = true;
                S.ended = true;
                fire('pause');
                fire('ended');
            }
        });

        // ── The media API ─────────────────────────────────────────────────────
        function prop(name, get, set) {
            Object.defineProperty(el, name, { configurable: true, enumerable: true, get: get, set: set });
        }

        prop('src', function () { return S.src; }, function (v) {
            S.src = v ? String(v) : '';
            S.needsOpen = !!S.src;
        });
        prop('currentSrc', function () { return S.opened; });
        prop('currentTime', currentTime, function (v) {
            v = Number(v);
            if (!isFinite(v) || v < 0) return;
            S.time = v;
            S.timeAt = now();
            S.ended = false;
            if (!S.id) return;
            S.seeking = true;
            fire('seeking');
            Native.send('player.seek', { time: v });
        });
        prop('duration', function () { return S.duration; });
        prop('paused', function () { return S.paused; });
        prop('ended', function () { return S.ended; });
        prop('seeking', function () { return S.seeking; });
        prop('readyState', function () { return S.readyState; });
        prop('networkState', function () { return S.networkState; });
        prop('error', function () { return S.error; });
        prop('videoWidth', function () { return S.width; });
        prop('videoHeight', function () { return S.height; });
        prop('muted', function () { return S.muted; }, function (v) {
            S.muted = !!v;
            if (S.id) Native.send('player.mute', { muted: S.muted });
            fire('volumechange');
        });
        prop('volume', function () { return S.volume; }, function (v) {
            S.volume = Math.max(0, Math.min(1, Number(v) || 0));
            Native.send('player.volume', { volume: Math.round(S.volume * 100) });
            fire('volumechange');
        });
        prop('playbackRate', function () { return S.rate; }, function (v) {
            v = Number(v);
            if (!isFinite(v) || v <= 0) return;
            S.rate = Math.min(4, v);
            if (S.id) Native.send('player.rate', { rate: S.rate });
            fire('ratechange');
        });
        prop('buffered', function () { return ranges(0, 0, false); });
        prop('seekable', function () {
            return ranges(0, S.duration, isFinite(S.duration) && S.duration > 0);
        });
        prop('audioTracks', function () { return audioTrackList(); });
        // Not measurable from here; the engine shows "n/a" for these.
        prop('getVideoPlaybackQuality', function () { return undefined; });
        prop('webkitDecodedFrameCount', function () { return undefined; });

        el.play = function () {
            if (S.src && (S.needsOpen || !S.id)) {
                open();
            } else if (S.id && S.paused) {
                S.paused = false;
                S.timeAt = now();
                Native.send('player.play', {});
                fire('play');
            }
            return Promise.resolve();
        };
        el.pause = function () {
            if (!S.id || S.paused) return;
            S.time = currentTime();
            S.paused = true;
            Native.send('player.pause', { paused: true });
            fire('pause');
        };
        el.load = function () {
            if (S.src) S.needsOpen = true;
            else stop();
        };
        el.canPlayType = function () { return 'probably'; };
        el.removeAttribute = function (name) {
            if (String(name).toLowerCase() === 'src') { S.src = ''; S.needsOpen = false; stop(); return; }
            return nativeRemoveAttribute.apply(el, arguments);
        };
        el.setAttribute = function (name, value) {
            if (String(name).toLowerCase() === 'src') { el.src = value; return; }
            return nativeSetAttribute.apply(el, arguments);
        };
        try { proto.pause.call(el); } catch (e) {}
        nativeRemoveAttribute.call(el, 'autoplay');

        function ranges(start, end, has) {
            return {
                length: has ? 1 : 0,
                start: function () { return start; },
                end: function () { return end; }
            };
        }

        /* The shape of the browser's AudioTrackList: enabling a track switches
           VLC to it, which is all player/engine.js does with it. */
        function audioTrackList() {
            var list = S.audio.map(function (t) {
                var track = { id: String(t.id), kind: 'main', language: t.lang || '' };
                track.label = t.title || t.name || '';
                Object.defineProperty(track, 'enabled', {
                    get: function () { return S.audioId === t.id; },
                    set: function (v) {
                        if (!v || S.audioId === t.id) return;
                        S.audioId = t.id;
                        Native.send('player.audioTrack', { trackId: t.id });
                    }
                });
                return track;
            });
            list.addEventListener = list.removeEventListener = function () {};
            list.getTrackById = function (id) {
                for (var i = 0; i < list.length; i++) if (list[i].id === String(id)) return list[i];
                return null;
            };
            return list;
        }

        // ── Where the picture goes ────────────────────────────────────────────
        var layout = (function () {
            var hole = document.createElement('div');
            hole.id = 'native-hole';
            document.body.appendChild(hole);
            document.documentElement.classList.add('native-video');
            var last = '';

            /* The video's box is cut out of the page with the corners of the
               nearest clipping ancestor (the rounded Live TV preview), so VLC's
               square picture doesn't poke out past them. */
            function cornerRadius() {
                var node = el.parentElement;
                for (var i = 0; node && i < 3; i++, node = node.parentElement) {
                    var cs = getComputedStyle(node);
                    var r = parseFloat(cs.borderTopLeftRadius) || 0;
                    if (r > 0 && cs.overflow !== 'visible') {
                        return Math.max(0, r - (parseFloat(cs.borderTopWidth) || 0));
                    }
                }
                return 0;
            }

            function update() {
                var r = el.getBoundingClientRect();
                var shown = r.width >= 2 && r.height >= 2 && el.offsetParent !== null &&
                    getComputedStyle(el).visibility !== 'hidden';
                var box = {
                    visible: shown,
                    x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10,
                    width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10
                };
                var key = JSON.stringify(box);
                if (key === last) return;
                last = key;
                Native.send('player.layout', box);
                hole.style.display = shown ? 'block' : 'none';
                hole.style.left = box.x + 'px';
                hole.style.top = box.y + 'px';
                hole.style.width = box.width + 'px';
                hole.style.height = box.height + 'px';
                hole.style.borderRadius = cornerRadius() + 'px';
                cues.render();
            }

            if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(el);
            new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
            new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
            window.addEventListener('resize', update);
            setInterval(update, LAYOUT_POLL_MS);
            return { update: update };
        }());

        // ── Subtitle files ────────────────────────────────────────────────────
        var cues = (function () {
            var box = document.createElement('div');
            box.className = 'native-cues';
            (el.parentElement || document.body).appendChild(box);
            var parsed = {};     // track src → cue list, or 'loading'
            var shown = '';
            var raf = 0;

            function activeTrackElement() {
                var tracks = el.querySelectorAll('track');
                for (var i = 0; i < tracks.length; i++) {
                    if (tracks[i].track && tracks[i].track.mode === 'showing') return tracks[i];
                }
                return null;
            }

            function cueList(trackEl) {
                var src = trackEl.src;
                if (!src) return null;
                if (parsed[src]) return parsed[src] === 'loading' ? null : parsed[src];
                parsed[src] = 'loading';
                fetch(src).then(function (r) { return r.text(); }).then(function (text) {
                    parsed[src] = parseVtt(text);
                }, function () { parsed[src] = []; });
                return null;
            }

            function setting(key, fallback) {
                try { var v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
            }

            function render() {
                var trackEl = S.id ? activeTrackElement() : null;
                var list = trackEl && cueList(trackEl);
                var html = '';
                if (list && list.length) {
                    var delay = parseFloat(setting('vod_sub_delay', '0')) || 0;
                    var t = currentTime() - delay;
                    var lines = [];
                    for (var i = 0; i < list.length; i++) {
                        if (list[i].start <= t && t < list[i].end) lines.push(list[i].html);
                    }
                    html = lines.join('<br>');
                }
                if (html !== shown) {
                    shown = html;
                    box.innerHTML = html ? '<span>' + html + '</span>' : '';
                }
                if (!html) return;
                /* Sized and styled like the browser's own cues: 5% of the
                   picture's height, and the size/style/colour classes the
                   engine puts on the <video> (Settings and the player menu). */
                var size = { md: 1, lg: 1.38, xl: 1.78 }[setting('vod_subs_size', 'md')] || 1;
                var pos = parseInt(setting('vod_sub_pos', '0'), 10) || 0;
                box.className = 'native-cues ' + (el.className.match(/\bcue-[a-z]+\b/g) || []).join(' ');
                box.style.fontSize = Math.max(10, el.clientHeight * 0.05 * size) + 'px';
                box.style.bottom = (4 + pos * 9) + '%';
            }

            function loop() {
                raf = 0;
                render();
                if (S.id && !S.paused) raf = requestAnimationFrame(loop);
            }

            ['playing', 'play', 'seeked', 'timeupdate'].forEach(function (type) {
                el.addEventListener(type, function () { if (!raf) raf = requestAnimationFrame(loop); });
            });
            el.addEventListener('pause', render);
            return { render: render };
        }());

        // Nothing of an earlier page should keep playing under this one.
        Native.send('player.stop', {});
        window.addEventListener('pagehide', function () {
            Native.send('player.stop', {});
            Native.send('player.layout', { visible: false, x: 0, y: 0, width: 0, height: 0 });
        });

        var handle = {
            /** VLC's own subtitle tracks (inside the stream), for the menu. */
            subtitleTracks: function () {
                return S.subs.map(function (t) {
                    return { id: t.id, lang: t.lang || '', label: t.title || t.name || ('Track ' + t.id) };
                });
            },
            activeSubtitleTrack: function () { return S.subId; },
            setSubtitleTrack: function (id) {
                if (S.subId === id) return;
                S.subId = id;
                if (S.id) Native.send('player.subtitleTrack', { trackId: id });
            },
            /** For the next open: hardware decoding, buffering, lowest quality. */
            configure: function (opts) {
                if ('hw' in opts) S.hw = opts.hw !== false;
                if ('caching' in opts) S.caching = opts.caching | 0;
                if ('lowQuality' in opts) S.lowQuality = !!opts.lowQuality;
                if ('live' in opts) S.live = !!opts.live;
            },
            hardware: function () { return S.hw; },
            /** Codecs VLC reports for the picture and the selected audio, e.g. "h264", "a52 ". */
            codecs: function () { return { v: S.videoCodec, a: S.audioCodec }; },
            /** VLC's counters for the stream playing (pictures and audio played and lost). */
            stats: function () {
                return S.id ? Native.request('player.stats', {}, 3000) : Promise.resolve(null);
            }
        };
        el._native = handle;
        return handle;
    }

    /* WebVTT as Subs.toVtt() writes it, and as panels serve it: cue blocks of
       "start --> end" followed by text lines. Only <b>, <i> and <u> survive;
       voice/class tags are dropped and everything else is escaped. */
    function parseVtt(text) {
        var out = [];
        var blocks = String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
        for (var i = 0; i < blocks.length; i++) {
            var lines = blocks[i].split('\n');
            for (var j = 0; j < lines.length; j++) {
                var m = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/.exec(lines[j]);
                if (!m) continue;
                var body = lines.slice(j + 1).join('\n').trim();
                if (body) out.push({ start: seconds(m[1]), end: seconds(m[2]), html: cueHtml(body) });
                break;
            }
        }
        return out;
    }

    function seconds(stamp) {
        var parts = stamp.replace(',', '.').split(':');
        var s = 0;
        for (var i = 0; i < parts.length; i++) s = s * 60 + parseFloat(parts[i]);
        return s;
    }

    function cueHtml(body) {
        var escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return escaped
            .replace(/&lt;(\/?)(b|i|u)&gt;/gi, '<$1$2>')
            .replace(/&lt;\/?(?:c|v|lang|ruby|rt)(?:[.\s][^&]*)?&gt;/gi, '')
            .replace(/&lt;\d{1,2}:\d{2}[^&]*&gt;/g, '')
            .replace(/\n/g, '<br>');
    }

    return { available: available, attach: attach, parseVtt: parseVtt };
}());
