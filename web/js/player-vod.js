/* player-vod.js — VOD player glue: reads ?url=, starts playback, drives the
 * OSD and the D-pad. Pairs with player.js (the IPTVPlayer instance `player`).
 * Previously missing, which left pages/player.html unable to play anything. */
(function () {
    'use strict';

    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
        BACK: 461, ESC: 27,
        PLAY: 415, PAUSE: 19, PLAYPAUSE: 463, STOP: 413,
        FF: 417, RW: 412
    };

    var video = document.getElementById('player');
    var osd    = document.getElementById('osd');

    /* ── Params ──────────────────────────────────────────────────────────── */
    function param(name) {
        var m = window.location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
        if (!m) return '';
        /* A stray % in a title (or a launcher that re-encodes the address)
           makes decodeURIComponent throw — which used to stop this whole
           script, so the player page sat black with nothing playing. */
        try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); }
        catch (e) { return m[1]; }
    }
    function lsGet(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }

    var url   = param('url')   || lsGet('iptv_play_url');
    var title = param('title') || lsGet('iptv_play_title');

    /* ── Accepting the play metadata ──────────────────────────────────────────
       vod.js / catchup.js hand the player everything it can't work out for
       itself — subtitles, resume position, the season for Next episode — through
       localStorage. The player has to be sure that handover is for THIS
       navigation and not left over from the last thing that played.

       That used to be decided by comparing the stored url against the one in the
       query string. It was too strict: the two strings travel different routes
       (one stored verbatim, the other encoded into a query and decoded back), and
       any difference at all — an encoding subtlety, a launcher that rewrites the
       address, a write that silently failed leaving the previous entry in place —
       threw away the whole handover. The symptom was a player with no subtitles,
       no resume and no next-episode button, and no indication why.

       So the pairing is now explicit: playItem stamps a one-shot token into both
       the metadata and the url. Matching tokens means the metadata belongs to
       this navigation, whatever the urls look like. The url comparison stays as
       a fallback for entries written before tokens existed. */
    var meta = null;
    var metaNote = '';
    var wantToken = param('t');

    var rawMeta = lsGet('iptv_play_meta');
    if (!rawMeta) {
        metaNote = 'nothing was stored for this play';
    } else {
        try { meta = JSON.parse(rawMeta); }
        catch (e) { meta = null; metaNote = 'stored play info was corrupt'; }
    }

    if (meta) {
        if (wantToken && meta.token) {
            if (meta.token !== wantToken) {
                metaNote = 'stored play info belongs to a different play (token ' +
                           meta.token + ' vs ' + wantToken + ')';
                meta = null;
            }
        } else if (meta.url !== url) {
            /* No token on either side — fall back to the old comparison, but say
               what differed rather than just dropping it. */
            metaNote = 'stored url does not match the one opened' +
                       '  stored=' + _tail(meta.url) + '  opened=' + _tail(url);
            meta = null;
        }
    }

    /* Last few characters are the identifying part of a stream url and the part
       that differs; the host prefix is the same for everything. */
    function _tail(u) {
        u = String(u || '');
        return u.length > 34 ? '…' + u.slice(-34) : u;
    }

    var resumeAt = (meta && meta.resume > 0) ? meta.resume : 0;
    var _resumed = false;

    var titleEl = document.getElementById('player-title');
    if (titleEl) titleEl.textContent = title || '';

    /* ── Start playback ──────────────────────────────────────────────────── */
    /* Catch-up passes an array of candidate timeshift URLs in meta.urls so the
       player can fall back across endpoint formats; VOD passes a single url. */
    var playArg = (meta && meta.urls && meta.urls.length) ? meta.urls : url;
    if ((url || (meta && meta.urls && meta.urls.length)) && window.player && typeof player.play === 'function') {
        player.play(playArg, { key: (meta && meta.key) || '' });
    } else {
        var msg = document.getElementById('player-msg');
        if (msg) { msg.textContent = 'Nothing to play.'; msg.style.display = 'flex'; }
    }

    /* ══════════════════════════════════════════════════════════════════════
       Skip intro · Next episode
       ══════════════════════════════════════════════════════════════════════
       Two pills over the bottom-right of the video. They are shown by playback
       POSITION, not by the OSD — the whole point is to skip something without
       having to wake the controls first, and requiring a keypress to reveal the
       button that saves you a keypress would be self-defeating.

       Only one can ever be up: intros are at the start, outros at the end. */
    var pillEl = null, pillAction = null, pillTimer = null;
    var autoNextAt = 0;          // timestamp the auto-advance fires, 0 = off

    /* One-shot id pairing a stored metadata blob with the navigation that wrote
       it. Time plus randomness — it only has to be different from the last one. */
    function _playToken() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    /* One navigation per page load — same reasoning as vod/detail.js. This path
       is the more exposed of the two: the auto-advance timer and a manual press
       of Next episode can both fire, and a second call's metadata write lands
       even though its navigation is ignored, leaving the next episode to reject
       a handover that pointed at the right stream all along. */
    var _navigating = false;

    function startEpisode(pl, idx, base) {
        if (_navigating) return;
        var e = pl[idx];
        if (!e) return;
        var cfg = Config.resolve();
        if (!cfg) return;
        var nextUrl = Config.episodeUrl(cfg, e.id, e.ext);
        var name = (base.series_name ? base.series_name + ' · ' : '') + e.title;

        var token = _playToken();
        var payload = {
            url: nextUrl, token: token,
            key: 'e:' + e.id, type: 'episode', id: e.id, ext: e.ext,
            name: name, icon: base.icon || '',
            series_id: base.series_id || '', season: base.season || '', episode: e.num,
            resume: 0,
            subs: (e.subs && e.subs.files) || [],
            subs_embedded: (e.subs && e.subs.embedded) || [],
            subs_unknown: (e.subs && e.subs.unknown) || 0,
            series_name: base.series_name || '',
            playlist: pl, playlist_index: idx,
            search_name: base.series_name || '',
            tmdb_id: base.tmdb_id || '', imdb_id: base.imdb_id || ''
        };
        /* Set only now that every early return is behind us — a call that bailed
           out above navigated nowhere and must not block a later, valid one. */
        _navigating = true;

        Store.setRaw('iptv_play_url', nextUrl);
        Store.setRaw('iptv_play_title', name);
        /* Same reasoning as vod/detail.js: this write has to land, and the
           playlist is the expendable part if it doesn't. */
        if (!Store.set('iptv_play_meta', payload)) {
            payload.playlist = null;
            payload.playlist_index = -1;
            Store.set('iptv_play_meta', payload);
        }

        /* Reload rather than swapping the source in place: every bit of setup
           on this page — resume, subtitles, track preferences, engine memory —
           keys off the metadata read at load. Re-running it is what guarantees
           episode two behaves exactly like episode one.

           replace(), not href: BACK goes to history.back(), and with href each
           episode stacked another player entry — so after binge-watching four
           episodes BACK replayed episode three instead of leaving the player. */
        window.location.replace('player.html?t=' + encodeURIComponent(token) +
                                '&url=' + encodeURIComponent(nextUrl) +
                                '&title=' + encodeURIComponent(name));
    }

    if (typeof Episodes !== 'undefined') {
        Episodes.init({
            meta: meta, video: video, onPlay: startEpisode, metaNote: metaNote,
            /* Fires only when the season had to be fetched here. The button is
               revealed at that point rather than being decided once at load,
               which is what used to leave it missing for good. */
            onReady: function () {
                syncNextButton();
                refreshPill();
                if (typeof PlayerSubs !== 'undefined') PlayerSubs.refresh();
            }
        });
    }

    function pill() {
        if (pillEl && pillEl.parentNode) return pillEl;
        pillEl = document.createElement('button');
        pillEl.id = 'skip-pill';
        pillEl.addEventListener('click', function () { firePill(); });
        document.body.appendChild(pillEl);
        return pillEl;
    }

    function showPill(text, action) {
        var el = pill();
        el.textContent = text;
        el.className = 'pill-visible';
        pillAction = action;
    }

    function hidePill() {
        if (pillEl) pillEl.className = '';
        pillAction = null;
    }

    function firePill() {
        var a = pillAction;
        if (!a) return;
        cancelAutoNext();
        hidePill();
        if (a === 'intro')      Episodes.skipIntro();
        else if (a === 'next')  Episodes.playNext();
    }

    function cancelAutoNext() { autoNextAt = 0; }

    /* Re-evaluated on timeupdate, which fires several times a second — cheap
       because everything it calls is arithmetic on currentTime. */
    function refreshPill() {
        if (typeof Episodes === 'undefined') return;

        if (autoNextAt) {
            var left = Math.max(0, Math.ceil((autoNextAt - Date.now()) / 1000));
            showPill('Next episode in ' + left + '  ·  OK to start now', 'next');
            if (left <= 0) { cancelAutoNext(); hidePill(); Episodes.playNext(); }
            return;
        }
        if (Episodes.introVisible())      { showPill('Skip intro  ·  OK', 'intro'); return; }
        if (Episodes.outroVisible())      { showPill('Next episode  ·  OK', 'next');  return; }
        hidePill();
    }

    /* An episode that has finished should not sit on a black screen. Give a
       few seconds to object — any key cancels — then move on. */
    video.addEventListener('ended', function () {
        if (typeof Episodes === 'undefined' || !Episodes.hasNext()) return;
        autoNextAt = Date.now() + (Episodes.AUTONEXT_SEC * 1000);
        refreshPill();
        clearInterval(pillTimer);
        pillTimer = setInterval(refreshPill, 250);
    });

    function pillVisible() { return !!(pillEl && pillEl.className === 'pill-visible' && pillAction); }

    /* ── Resume position + save progress (Continue Watching) ─────────────── */
    function seekToResume() {
        if (_resumed || resumeAt <= 0) return;
        if (!isFinite(video.duration) || video.duration <= 0) return;
        if (resumeAt < video.duration - 5) {
            try { video.currentTime = resumeAt; } catch (e) {}
        }
        _resumed = true;
    }
    video.addEventListener('loadedmetadata', seekToResume);
    video.addEventListener('canplay', seekToResume);

    var _lastSave = 0;
    /* Titles started and abandoned used to stay in here for ever — only a
       FINISHED title was ever removed — so the map grew with everything ever
       sampled. Continue Watching shows the newest 20; keeping a few times that
       is plenty, and the oldest go first. */
    var PROGRESS_MAX = 80;
    function saveProgress(finished) {
        if (!meta || !meta.key) return;
        var dur = video.duration, pos = video.currentTime;
        if (!isFinite(dur) || dur <= 0) return;
        var all = Store.get('vod_progress', {}) || {};
        if (finished || pos / dur > 0.95) {
            delete all[meta.key];                 // drop finished titles
        } else if (pos > 30) {
            all[meta.key] = {
                key: meta.key, type: meta.type, id: meta.id, ext: meta.ext,
                name: meta.name, icon: meta.icon,
                series_id: meta.series_id, season: meta.season, episode: meta.episode,
                pos: pos, dur: dur, ts: Date.now()
            };
            var keys = Object.keys(all);
            if (keys.length > PROGRESS_MAX) {
                keys.sort(function (a, b) { return ((all[a] && all[a].ts) || 0) - ((all[b] && all[b].ts) || 0); });
                for (var i = 0; i < keys.length - PROGRESS_MAX; i++) delete all[keys[i]];
            }
        } else {
            return;
        }
        /* Through Store so a full storage quota makes room by dropping a cache
           instead of silently losing the resume point. */
        Store.set('vod_progress', all);
    }
    video.addEventListener('timeupdate', function () {
        var now = Date.now();
        if (now - _lastSave > 5000) { _lastSave = now; saveProgress(false); }
    });
    video.addEventListener('ended', function () { saveProgress(true); });
    window.addEventListener('pagehide', function () { saveProgress(false); });

    /* ── OSD show / auto-hide ────────────────────────────────────────────── */
    var osdTimer = null;
    function showOsd() {
        if (!osd) return;
        osd.classList.remove('osd-hidden');
        clearTimeout(osdTimer);
        osdTimer = setTimeout(hideOsd, 4000);
    }
    function hideOsd() {
        if (osd && !video.paused) osd.classList.add('osd-hidden');
    }
    function osdVisible() { return osd && !osd.classList.contains('osd-hidden'); }

    /* ── Controls ────────────────────────────────────────────────────────── */
    /* No mute button: TV remotes all have a dedicated mute key, and the volume
       is the TV's, not the app's. */
    var controls = ['ctrl-rewind', 'ctrl-play', 'ctrl-forward', 'ctrl-next', 'ctrl-audio', 'ctrl-subs', 'ctrl-speed', 'ctrl-fullscreen']
        .map(function (id) { return document.getElementById(id); })
        .filter(Boolean);

    /* Next episode is only a control when there IS one — a movie, or the last
       episode of a season, gets no dead button on the bar.

       Shown or hidden in place rather than removed from the row: the season may
       arrive after this runs (see Episodes.resolveSeason), and a button spliced
       out of the focus array can't come back. Navigation skips hidden controls,
       so an invisible entry costs nothing. */
    function syncNextButton() {
        var nextBtn = document.getElementById('ctrl-next');
        if (!nextBtn) return;
        var has = (typeof Episodes !== 'undefined') && Episodes.hasNext();
        nextBtn.style.display = has ? '' : 'none';
        if (has) nextBtn.title = 'Next episode — ' + Episodes.nextLabel();
    }
    syncNextButton();
    /* webOS apps already run fullscreen, and the native Fullscreen API
       mis-renders on some versions (e.g. 5.40) — hide the toggle on TV.
       It stays available for desktop-browser testing. */
    if (/Web0S/i.test(navigator.userAgent || '')) {
        var fsBtn = document.getElementById('ctrl-fullscreen');
        if (fsBtn) {
            fsBtn.style.display = 'none';
            controls = controls.filter(function (el) { return el !== fsBtn; });
        }
    }
    var backBtn  = document.getElementById('player-back-btn');
    var focusRow = backBtn ? [backBtn].concat(controls) : controls.slice();
    var focusIdx = focusRow.indexOf(document.getElementById('ctrl-play'));
    if (focusIdx < 0) focusIdx = 0;

    function paintFocus() {
        focusRow.forEach(function (el, i) {
            el.classList.toggle('tv-focus-visible', i === focusIdx);
        });
    }

    /* Move along the control row, skipping anything currently hidden — the
       Next-episode button comes and goes, and fullscreen is hidden on webOS.
       Without the skip the ring would land on an invisible control and the row
       would appear to have a gap in it. */
    function stepFocus(dir) {
        var i = focusIdx;
        do { i += dir; }
        while (i >= 0 && i < focusRow.length && focusRow[i].style.display === 'none');
        if (i >= 0 && i < focusRow.length) { focusIdx = i; paintFocus(); }
    }

    /* play() returns nothing before Chromium 50, so `.play().catch` threw on
       webOS 3 and the play button did nothing at all. */
    function togglePlay() {
        if (!video.paused) { video.pause(); return; }
        var p;
        try { p = video.play(); } catch (e) { return; }
        if (p && typeof p.then === 'function') p.then(null, function () {});
    }
    function seek(delta) {
        if (!isFinite(video.duration)) return;
        video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta));
    }
    function toggleFullscreen() {
        var el = document.documentElement;
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
        } else {
            (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
        }
    }

    function activate(el) {
        if (!el) return;
        switch (el.id) {
            case 'player-back-btn':  goBack();          break;
            case 'ctrl-rewind':      seek(-10);         break;
            case 'ctrl-play':        togglePlay();      break;
            case 'ctrl-forward':     seek(30);          break;
            case 'ctrl-next':        cancelAutoNext(); Episodes.playNext(); break;
            case 'ctrl-audio':       openAudioMenu();   break;
            case 'ctrl-subs':        openSubsMenu();    break;
            case 'ctrl-speed':       openSpeedMenu();   break;
            case 'ctrl-fullscreen':  toggleFullscreen();break;
        }
    }

    /* ── Track menu (audio + subtitles + text size) ───────────────────────────
       One flat list with section headers rather than tabs: the D-pad only has to
       walk UP/DOWN, and headers/notes are skipped during navigation so they can
       never be "selected" into a dead end. */
    var subsMenu  = document.getElementById('subs-menu');
    var subsList  = document.getElementById('subs-menu-list');
    var subsTitle = document.getElementById('subs-menu-title');
    var subsOpen = false, subsIdx = 0, subsOptions = [];
    var activeSubLabel = 'off';

    /* Track choices are remembered per TITLE, keyed the same way Continue
       Watching keys its progress, with the app-wide choice as the fallback for a
       title never played before. See player/preferences.js for why both. A
       missing meta.key (a rejected handover) degrades to the global memory
       rather than to none. */
    var TRACK_KEY = (meta && meta.key) || '';
    function recallTrack(what)        { return _recalledTrack(TRACK_KEY, what); }
    function rememberTrack(what, val) { _rememberTrack(TRACK_KEY, what, val); }

    var menuMode = 'subs';   // 'audio' | 'subs' | 'os' — drives BACK behaviour

    function isSelectable(opt) {
        return opt && (opt.kind === 'track' || opt.kind === 'audio' ||
                       opt.kind === 'action' || opt.kind === 'os' || opt.kind === 'stepper');
    }

    /* ── Stepper rows ─────────────────────────────────────────────────────────
       A row whose value is changed in place with LEFT/RIGHT rather than being
       picked from a list — the natural shape for continuous settings like
       subtitle delay, and it keeps long menus short. ENTER resets to default.
       Mirrors how the dropdowns in Settings behave, so the remote does the same
       thing everywhere in the app. */
    function stepper(label, read, write, opts) {
        opts = opts || {};
        return {
            kind: 'stepper', label: label,
            read: read, write: write,
            reset: opts.reset,
            hint: opts.hint || ''
        };
    }

    var SUB_POS_NAMES  = ['Default', 'Raised', 'Higher', 'Upper', 'Middle'];
    var SUB_SIZES      = [['md', 'Normal'], ['lg', 'Large'], ['xl', 'Larger']];
    var SUB_STYLES     = [['shadow', 'Shadow'], ['box', 'Boxed'], ['plain', 'Plain']];
    var SUB_COLOURS    = [['white', 'White'], ['yellow', 'Yellow'], ['cyan', 'Cyan']];
    var SPEEDS         = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

    function cycleIndex(list, current, dir) {
        var i = 0;
        for (var n = 0; n < list.length; n++) if (list[n][0] === current) { i = n; break; }
        i += dir;
        if (i < 0) i = 0;
        if (i > list.length - 1) i = list.length - 1;
        return i;
    }

    function fmtDelay(sec) {
        var s = (sec > 0 ? '+' : sec < 0 ? '−' : '') + Math.abs(sec).toFixed(2) + 's';
        return sec === 0 ? '0.00s' : s;
    }

    /* Audio and subtitles are separate menus — one button, one job. They share
       the same popup element and the same D-pad handling; only the contents and
       the title differ. */
    function buildAudioOptions() {
        subsOptions = [];
        var audio = (window.player && player.listAudioTracks) ? player.listAudioTracks() : [];
        var activeAudio = (window.player && player.activeAudioTrack) ? player.activeAudioTrack() : -1;
        if (audio.length) {
            audio.forEach(function (t) {
                subsOptions.push({ kind: 'audio', label: t.label, track: t, current: t.id === activeAudio });
            });
        } else {
            subsOptions.push({
                kind: 'note',
                label: (window.player && player.audioUnavailableReason)
                    ? player.audioUnavailableReason() : 'No alternative audio tracks.'
            });
        }
    }

    function buildSubsOptions() {
        subsOptions = [];
        var subs = (window.player && player.listSubtitles) ? player.listSubtitles() : [];
        if (!subs.length) {
            /* Say why instead of showing a lone "Off" that looks broken. The
               reason comes from the player, which knows both what the decoder
               exposed and what the provider CLAIMED was in the file — the two
               are frequently different, and only saying the first is how this
               ended up reporting "no subtitles" for a file with two of them. */
            subsOptions.push({
                kind: 'note',
                label: (window.player && player.subsUnavailableReason)
                    ? player.subsUnavailableReason() : 'No subtitles found for this title.'
            });
        }
        subsOptions.push({ kind: 'track', label: 'Off', track: 'off' });
        subs.forEach(function (t) { subsOptions.push({ kind: 'track', label: t.label, track: t }); });

        /* Online search is now offered on EVERY title, because at least one
           provider (Assrt) needs no signup. That matters more than it sounds:
           on a panel that ships no subtitle data and no sidecars — which
           diagnostics showed is the common case, not an edge one — this row is
           the only thing on the menu that can actually produce a subtitle, and
           it used to be hidden behind a key the user had not registered for. */
        if (searchProviders().length) {
            subsOptions.push({ kind: 'action', label: '🔍  Search online…', action: 'os', sep: true });
            /* Assrt indexes Chinese subtitles densely and English ones sparsely,
               so on an English title the free provider alone often disappoints.
               Say so HERE rather than letting the user conclude search is
               broken after two empty result lists. */
            if (typeof OpenSubtitles === 'undefined' || !OpenSubtitles.configured()) {
                subsOptions.push({
                    kind: 'note',
                    label: 'Searching Assrt, which is strongest on Chinese subtitles. ' +
                           'For English, add a free OpenSubtitles API key in Settings → Subtitles ' +
                           'and both are searched together.'
                });
            }
        }

        subsOptions.push({ kind: 'header', label: 'Timing', sep: true });
        subsOptions.push(stepper('Delay',
            function () { return fmtDelay(player.getSubDelay()); },
            function (dir) { player.setSubDelay(player.getSubDelay() + dir * 0.25); },
            { reset: function () { player.setSubDelay(0); },
              hint: 'Subtitles too early? Increase. Too late? Decrease.' }));

        subsOptions.push({ kind: 'header', label: 'Appearance', sep: true });
        subsOptions.push(stepper('Position',
            function () { return SUB_POS_NAMES[player.getSubPosition()] || 'Default'; },
            function (dir) { player.setSubPosition(player.getSubPosition() + dir); },
            { reset: function () { player.setSubPosition(0); } }));

        subsOptions.push(stepper('Text size',
            function () {
                var v = player.getSubSize();
                for (var i = 0; i < SUB_SIZES.length; i++) if (SUB_SIZES[i][0] === v) return SUB_SIZES[i][1];
                return 'Normal';
            },
            function (dir) { player.applySubSize(SUB_SIZES[cycleIndex(SUB_SIZES, player.getSubSize(), dir)][0]); }));

        subsOptions.push(stepper('Style',
            function () {
                var v = player.getSubStyle();
                for (var i = 0; i < SUB_STYLES.length; i++) if (SUB_STYLES[i][0] === v) return SUB_STYLES[i][1];
                return 'Shadow';
            },
            function (dir) { player.applySubStyle(SUB_STYLES[cycleIndex(SUB_STYLES, player.getSubStyle(), dir)][0]); }));

        subsOptions.push(stepper('Colour',
            function () {
                var v = player.getSubColour();
                for (var i = 0; i < SUB_COLOURS.length; i++) if (SUB_COLOURS[i][0] === v) return SUB_COLOURS[i][1];
                return 'White';
            },
            function (dir) { player.applySubColour(SUB_COLOURS[cycleIndex(SUB_COLOURS, player.getSubColour(), dir)][0]); }));
    }

    /* Playback speed lives on its own button rather than being bolted onto the
       audio or subtitle menus — one button, one job, as with the other two. */
    function buildSpeedOptions() {
        subsOptions = [];

        /* The intro skip learns where you jumped to and reuses it for every
           later episode of the series. That is the right behaviour when the
           press was deliberate and the wrong one when it was a mis-press, so
           there has to be a way back — otherwise one bad jump follows you
           through a whole season. Only offered once something is remembered. */
        if (typeof Episodes !== 'undefined' && Episodes.hasLearnedIntro()) {
            subsOptions.push({ kind: 'header', label: 'Intro skip' });
            subsOptions.push({ kind: 'action', label: '↺  Forget this series’ intro skip', action: 'forget-intro' });
            subsOptions.push({ kind: 'note', label:
                'Skip intro currently jumps to a point you chose earlier. Forget it to go back to the default jump.' });
            subsOptions.push({ kind: 'header', label: 'Speed', sep: true });
        }

        if (window.player && player.speedSupported && !player.speedSupported()) {
            subsOptions.push({ kind: 'note', label: "This TV's player doesn't support changing playback speed." });
            return;
        }
        subsOptions.push(stepper('Speed',
            function () {
                var r = player.getSpeed();
                return (r === 1 ? '1' : String(r)) + '×';
            },
            function (dir) {
                var r = player.getSpeed(), i = 0;
                for (var n = 0; n < SPEEDS.length; n++) if (Math.abs(SPEEDS[n] - r) < 0.01) { i = n; break; }
                i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir));
                player.setSpeed(SPEEDS[i]);
            },
            { reset: function () { player.setSpeed(1); }, hint: 'OK resets to normal speed.' }));
    }

    function isCurrentOpt(opt) {
        if (opt.kind === 'audio') return !!opt.current;
        if (opt.kind === 'track') return (opt.label || '').toLowerCase() === activeSubLabel;
        return false;
    }

    function openAudioMenu() { menuMode = 'audio'; buildAudioOptions();  renderMenu('Audio'); }
    function openSubsMenu()  { menuMode = 'subs';  buildSubsOptions();   renderMenu('Subtitles'); }
    function openSpeedMenu() { menuMode = 'speed'; buildSpeedOptions();  renderMenu('Playback'); }

    /* ── OpenSubtitles search ─────────────────────────────────────────────────
       Runs inside the same popup as a third mode. Search is cheap; downloading
       is quota-limited, so only the entry the user picks is ever downloaded. */
    /* Every provider that can be searched right now. Order is the tie-breaker
       when two results rank equally, so the one needing a key — and therefore
       deliberately chosen by the user — comes first. */
    function searchProviders() {
        var out = [];
        if (typeof OpenSubtitles !== 'undefined' && OpenSubtitles.configured()) {
            out.push({ id: 'os', label: 'OpenSubtitles', api: OpenSubtitles });
        }
        if (typeof Assrt !== 'undefined' && Assrt.configured()) {
            out.push({ id: 'assrt', label: 'Assrt', api: Assrt });
        }
        return out;
    }

    /* Run every provider in parallel and merge. One that throws is dropped
       rather than failing the search — a dead provider must not take a working
       one down with it, which is the whole reason for running them together. */
    function searchAll(q) {
        var providers = searchProviders();
        var jobs = providers.map(function (p) {
            return p.api.search(q).then(function (rows) {
                return (rows || []).map(function (r) {
                    r.provider = r.provider || p.id;
                    r.providerLabel = p.label;
                    return r;
                });
            })['catch'](function (err) {
                _searchErrors.push(p.label + ': ' + ((err && err.message) || 'failed'));
                return null;   // null = this provider never answered; [] = it answered with nothing
            });
        });
        return Promise.all(jobs).then(function (lists) {
            var merged = [];
            _searchOk = 0;
            for (var i = 0; i < lists.length; i++) {
                if (lists[i] === null) continue;
                _searchOk++;
                merged = merged.concat(lists[i]);
            }
            return rankResults(merged, providers);
        });
    }

    /* Preferred language first, then download count, then provider order. The
       language preference is the OpenSubtitles one — it is the only such setting
       the app has, and having two would be worse than sharing one. */
    function rankResults(rows, providers) {
        var want = '';
        try {
            want = (typeof OpenSubtitles !== 'undefined' ? OpenSubtitles.language() : 'en') || 'en';
        } catch (e) { want = 'en'; }
        want = want.toLowerCase();
        var order = {};
        for (var p = 0; p < providers.length; p++) order[providers[p].id] = p;

        function langRank(r) {
            var l = String(r.lang || '').toLowerCase();
            if (l === want) return 0;
            if (l.split('-')[0] === want.split('-')[0]) return 1;   // en vs en-GB
            return 2;
        }
        return rows.sort(function (a, b) {
            var la = langRank(a), lb = langRank(b);
            if (la !== lb) return la - lb;
            var da = Number(a.downloads) || 0, db = Number(b.downloads) || 0;
            if (da !== db) return db - da;
            return (order[a.provider] || 0) - (order[b.provider] || 0);
        });
    }

    var _searchErrors = [];
    var _searchOk = 0;          // providers that actually answered, however emptily

    function openOsSearch() {
        menuMode = 'os';
        _searchErrors = [];
        subsOptions = [{ kind: 'note', label: 'Searching…' }];
        renderMenu('Online subtitles');

        var q = {
            title:   meta && (meta.search_name || meta.name) ? (meta.search_name || meta.name) : (title || ''),
            year:    (meta && meta.year) || '',
            imdbId:  (meta && meta.imdb_id) || '',
            tmdbId:  (meta && meta.tmdb_id) || '',
            season:  (meta && meta.season) || '',
            episode: (meta && meta.episode) || ''
        };
        if (!q.title && !q.imdbId && !q.tmdbId) {
            subsOptions = [{ kind: 'note', label: 'Nothing to search for — this title has no name.' }];
            renderMenu('Online subtitles');
            return;
        }

        searchAll(q).then(function (results) {
            if (menuMode !== 'os') return;                  // user moved on
            if (!results.length) {
                /* "No subtitles found" is a claim about the TITLE, and it is
                   only true if something actually searched. When every provider
                   failed, saying it repeats the exact mistake this whole area
                   had — reporting a refusal as an absence — so the error leads
                   instead and the claim is dropped entirely. */
                var why;
                if (!_searchOk && _searchErrors.length) {
                    why = 'Could not search: ' + _searchErrors.join('  ·  ');
                } else {
                    why = 'No subtitles found for "' + q.title + '".';
                    if (_searchErrors.length) why += '  ' + _searchErrors.join('  ·  ');
                }
                subsOptions = [{ kind: 'note', label: why }];
            } else {
                subsOptions = results.slice(0, 20).map(function (r) {
                    var extra = [];
                    if (r.lang) extra.push(String(r.lang).toUpperCase());
                    if (r.hearingImpaired) extra.push('HI');
                    if (r.downloads) extra.push(r.downloads + '↓');
                    /* Lead with the film the provider matched, not the release
                       name — a wrong match is then obvious before downloading,
                       which is the whole accuracy problem in practice. Assrt has
                       no verified title, so its rows lead with the release. */
                    var matched = r.featureTitle || '';
                    if (matched && r.featureYear) matched += ' (' + r.featureYear + ')';
                    if (r.season != null && r.episode != null) matched += '  S' + r.season + 'E' + r.episode;
                    return {
                        kind: 'os', fileId: r.fileId, lang: r.lang,
                        provider: r.provider, providerLabel: r.providerLabel || '',
                        label: matched || r.release,
                        /* The provider is named on every row: with two of them
                           merged, "why is this result in Chinese" and "which
                           quota does this spend" both hinge on it. */
                        sub: (r.providerLabel ? r.providerLabel + '  ·  ' : '') +
                             (matched ? r.release + '  ·  ' : '') +
                             extra.join(' · ')
                    };
                });
            }
            renderMenu('Online subtitles');
        })['catch'](function (err) {
            if (menuMode !== 'os') return;
            subsOptions = [{ kind: 'note', label: (err && err.message) ? err.message : 'Search failed.' }];
            renderMenu('Online subtitles');
        });
    }

    function downloadOsSubtitle(opt) {
        subsOptions = [{ kind: 'note', label: 'Downloading subtitle…' }];
        renderMenu('Online subtitles');

        var api = (opt.provider === 'assrt' && typeof Assrt !== 'undefined') ? Assrt : OpenSubtitles;
        api.download(opt.fileId, opt.lang).then(function (res) {
            if (menuMode !== 'os') return;
            /* Providers hand back different things: OpenSubtitles a URL to
               fetch, Assrt the decoded text (it has to decode — its files are
               frequently GB18030). addExternalSubs accepts either, and `format`
               is passed so a downloaded .ass is routed to the ASS renderer
               rather than through the VTT converter. */
            player.addExternalSubs([{
                url:    res.url || '',
                text:   res.text || '',
                /* OpenSubtitles reports no format, and its download links are
                   signed CDN URLs that usually carry no extension — so without
                   the filename an .ass from there was sniffed as "not ASS" and
                   pushed through the VTT converter, the exact breakage the ASS
                   split exists to prevent. The filename it DOES return carries
                   the real extension. */
                format: res.format || formatOfName(res.fileName || res.url || ''),
                lang:   opt.lang,
                label:  _osLabel(opt)
            }]);
            /* addExternalSubs fetches and converts before the track appears, so
               poll briefly for it rather than assuming it's there. */
            waitForTrack(_osLabel(opt), function (found) {
                if (found && player.setSubtitle) {
                    var subs = player.listSubtitles();
                    for (var i = 0; i < subs.length; i++) {
                        if (subs[i].label === _osLabel(opt)) {
                            player.setSubtitle(subs[i]);
                            activeSubLabel = (subs[i].label || '').toLowerCase();
                            rememberTrack('sub', activeSubLabel);
                            break;
                        }
                    }
                    closeSubs();
                } else {
                    subsOptions = [{ kind: 'note', label: 'Downloaded, but the subtitle file could not be read.' }];
                    renderMenu('Online subtitles');
                }
            });
        })['catch'](function (err) {
            if (menuMode !== 'os') return;
            subsOptions = [{ kind: 'note', label: (err && err.message) ? err.message : 'Download failed.' }];
            renderMenu('Online subtitles');
        });
    }

    /* Subtitle format from a filename or URL. Defers to Assrt's copy when that
       module is present so there is one implementation, but keeps a local
       fallback — this runs on the OpenSubtitles path too, which must not start
       depending on a provider it has nothing to do with. */
    function formatOfName(name) {
        if (typeof Assrt !== 'undefined' && Assrt.formatOf) return Assrt.formatOf(name);
        var m = /\.([a-z0-9]+)$/i.exec(String(name || '').split('?')[0].split('#')[0]);
        var ext = m ? m[1].toLowerCase() : '';
        return (ext === 'ass' || ext === 'ssa' || ext === 'vtt') ? ext : 'srt';
    }

    /* The label the downloaded track carries. It names the provider because it
       is also the key the pick is remembered under, and two providers can
       supply the same language for one title. */
    function _osLabel(opt) {
        var who = opt.providerLabel || (opt.provider === 'assrt' ? 'Assrt' : 'OpenSubtitles');
        return who + ' (' + String(opt.lang || '').toUpperCase() + ')';
    }

    function waitForTrack(label, done) {
        var tries = 0;
        (function poll() {
            var subs = (window.player && player.listSubtitles) ? player.listSubtitles() : [];
            for (var i = 0; i < subs.length; i++) if (subs[i].label === label) { done(true); return; }
            if (++tries > 30) { done(false); return; }       // ~6s
            setTimeout(poll, 200);
        }());
    }

    function renderMenu(title) {
        subsList.innerHTML = '';
        subsOptions.forEach(function (opt, i) {
            var el;
            if (opt.kind === 'header' || opt.kind === 'note') {
                el = document.createElement('div');
                el.className = opt.kind === 'header' ? 'subs-head' : 'subs-note';
                el.textContent = opt.label;
            } else if (opt.kind === 'stepper') {
                el = document.createElement('button');
                el.className = 'subs-opt subs-stepper';
                var name = document.createElement('span');
                name.className = 'subs-step-label';
                name.textContent = opt.label;
                var val = document.createElement('span');
                val.className = 'subs-step-value';
                val.textContent = opt.read();
                el.appendChild(name);
                el.appendChild(val);
                opt._valueEl = val;                       // updated in place on step
                el.addEventListener('click', function () { subsIdx = i; stepOption(1); });
            } else {
                el = document.createElement('button');
                el.className = 'subs-opt' + (isCurrentOpt(opt) ? ' current' : '');
                el.textContent = opt.label;
                if (opt.sub) {
                    el.className += ' subs-two-line';
                    var sub = document.createElement('span');
                    sub.className = 'subs-opt-sub';
                    sub.textContent = opt.sub;
                    el.appendChild(sub);
                }
                el.addEventListener('click', function () { subsIdx = i; applyTrackChoice(); });
            }
            if (opt.sep) el.className += ' subs-sep';
            subsList.appendChild(el);
        });

        /* Start on the current selection, so opening the menu and pressing OK
           straight away is a no-op rather than a surprise. */
        subsIdx = firstSelectableIndex();
        if (subsTitle) subsTitle.textContent = title;
        if (osd) osd.classList.remove('osd-hidden');   // keep OSD visible behind the menu
        subsMenu.hidden = false; subsOpen = true; paintSubs();
        clearTimeout(osdTimer);   // keep OSD up while choosing
    }

    /* -1 when the menu is all notes/headers (e.g. a file with one audio track):
       paintSubs() then draws no ring at all, rather than ringing a line of
       explanatory text that can't be actioned. */
    function firstSelectableIndex() {
        var firstAny = -1;
        for (var i = 0; i < subsOptions.length; i++) {
            var o = subsOptions[i];
            if (!isSelectable(o)) continue;
            if (firstAny < 0) firstAny = i;
            if (isCurrentOpt(o)) return i;
        }
        return firstAny;
    }

    function closeSubs() { subsMenu.hidden = true; subsOpen = false; paintFocus(); showOsd(); }

    /* Transient message over the video — used when an action silently fails and
       there's no menu left open to report into. */
    var _noteTimer = null;
    function flashNote(text) {
        var el = document.getElementById('player-note');
        if (!el) {
            el = document.createElement('div');
            el.id = 'player-note';
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.className = 'note-visible';
        clearTimeout(_noteTimer);
        _noteTimer = setTimeout(function () { el.className = ''; }, 6000);
    }

    function paintSubs() {
        var nodes = subsList.childNodes;
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].classList) nodes[i].classList.toggle('tv-focus-visible', i === subsIdx);
        }
        if (subsIdx >= 0 && nodes[subsIdx] && nodes[subsIdx].scrollIntoView) {
            nodes[subsIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    /* Step over headers and notes so they're never focusable. */
    function moveSubs(dir) {
        if (subsIdx < 0) return;                 // nothing selectable in this menu
        var i = subsIdx + dir;
        while (i >= 0 && i < subsOptions.length && !isSelectable(subsOptions[i])) i += dir;
        if (i >= 0 && i < subsOptions.length) { subsIdx = i; paintSubs(); }
    }

    /* LEFT/RIGHT on a stepper row. Only the value text is rewritten, so the menu
       doesn't rebuild and the focus ring stays put while the user holds a
       direction — the whole point of adjusting in place. */
    function stepOption(dir) {
        var opt = subsOptions[subsIdx];
        if (!opt || opt.kind !== 'stepper') return;
        opt.write(dir);
        if (opt._valueEl) opt._valueEl.textContent = opt.read();
        showStepHint(opt);
    }

    function showStepHint(opt) {
        if (!subsTitle) return;
        subsTitle.textContent = opt.hint || menuTitleFor(menuMode);
    }
    function menuTitleFor(mode) {
        return mode === 'audio' ? 'Audio' : mode === 'speed' ? 'Playback'
             : mode === 'os'    ? 'Online subtitles' : 'Subtitles';
    }

    function applyTrackChoice() {
        var opt = subsOptions[subsIdx];
        if (!opt) { closeSubs(); return; }
        /* These stay inside the menu instead of closing it. */
        if (opt.kind === 'action' && opt.action === 'os') { openOsSearch(); return; }
        if (opt.kind === 'action' && opt.action === 'forget-intro') {
            Episodes.forgetIntro();
            refreshPill();
            buildSpeedOptions();
            renderMenu('Playback');
            return;
        }
        if (opt.kind === 'os') { downloadOsSubtitle(opt); return; }
        if (opt.kind === 'stepper') {
            if (opt.reset) opt.reset(); else opt.write(1);
            if (opt._valueEl) opt._valueEl.textContent = opt.read();
            return;
        }
        if (opt.kind === 'audio') {
            /* Remember the language rather than the index: track order differs
               between titles, so index 1 is not the same language next time. */
            rememberTrack('audio', opt.track.lang || opt.label || '');
            if (window.player && player.setAudioTrack) {
                player.setAudioTrack(opt.track, function (ok, note) {
                    /* The switch can silently fail on webOS; say so rather than
                       leaving the user staring at unchanged audio. */
                    if (!ok && note) flashNote(note);
                });
            }
        } else if (opt.kind === 'track') {
            if (window.player && player.setSubtitle) player.setSubtitle(opt.track);
            activeSubLabel = (opt.label || 'off').toLowerCase();
            rememberTrack('sub', activeSubLabel);
        }
        closeSubs();
    }

    /* Re-apply the remembered audio language once tracks exist. Matches on
       language/label, and does nothing when there's no match — never guesses. */
    function restoreAudioPreference() {
        var want = recallTrack('audio');
        if (!want || !window.player || !player.listAudioTracks) return;
        var tracks = player.listAudioTracks();
        if (tracks.length < 2) return;
        var active = player.activeAudioTrack ? player.activeAudioTrack() : -1;
        var lc = want.toLowerCase();
        for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i];
            if ((t.lang || '').toLowerCase() === lc || (t.label || '').toLowerCase() === lc) {
                /* Already playing — say nothing and do nothing. This guard is
                   what makes the function safe to call repeatedly, and it has to
                   be here rather than at the call site: setAudioTrack's native
                   path SEEKS the video back 0.25s when it cannot verify a switch
                   took, so re-asserting an already-correct track once per
                   arriving text track made the picture jump backwards several
                   times during playback. */
                if (t.id === active) return;
                player.setAudioTrack(t);
                return;
            }
        }
    }

    function goBack() {
        try { player.destroyHls(); } catch (e) {}
        try { video.pause(); } catch (e) {}
        if (window.history.length > 1) window.history.back();
        else window.location.href = '../pages/vod.html';
    }

    /* ── Icon state ──────────────────────────────────────────────────────── */
    function updatePlayIcon() {
        var btn = document.getElementById('ctrl-play');
        if (!btn) return;
        var pl = btn.querySelector('.icon-play'), pa = btn.querySelector('.icon-pause');
        if (pl && pa) { pl.style.display = video.paused ? '' : 'none'; pa.style.display = video.paused ? 'none' : ''; }
    }

    /* ── Scrubber ────────────────────────────────────────────────────────── */
    function fmt(t) {
        if (!isFinite(t) || t < 0) t = 0;
        var s = Math.floor(t % 60), m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
        var mm = (h && m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
        return (h ? h + ':' : '') + mm + ':' + ss;
    }
    var fill = document.getElementById('osd-seek-fill');
    var buf  = document.getElementById('osd-seek-buf');
    var thumb = document.getElementById('osd-seek-thumb');
    var curEl = document.getElementById('osd-time-cur');
    var durEl = document.getElementById('osd-time-dur');

    function updateProgress() {
        var d = video.duration;
        if (!isFinite(d) || d <= 0) return;
        var pct = (video.currentTime / d) * 100;
        if (fill)  fill.style.width = pct + '%';
        if (thumb) thumb.style.left = pct + '%';
        if (curEl) curEl.textContent = fmt(video.currentTime);
        if (durEl) durEl.textContent = fmt(d);
        if (buf && video.buffered && video.buffered.length) {
            buf.style.width = ((video.buffered.end(video.buffered.length - 1) / d) * 100) + '%';
        }
    }

    video.addEventListener('timeupdate', updateProgress);
    video.addEventListener('timeupdate', refreshPill);
    video.addEventListener('seeked', refreshPill);
    video.addEventListener('loadedmetadata', refreshPill);
    video.addEventListener('durationchange', updateProgress);
    video.addEventListener('play',  function () { updatePlayIcon(); showOsd(); });
    video.addEventListener('pause', function () { updatePlayIcon(); showOsd(); });
    video.addEventListener('ended', function () { showOsd(); osd && osd.classList.remove('osd-hidden'); });

    /* ── Click support (touch / pointer TVs) ─────────────────────────────── */
    focusRow.forEach(function (el, i) {
        el.addEventListener('click', function () { focusIdx = i; paintFocus(); activate(el); showOsd(); });
    });

    /* ── D-pad ───────────────────────────────────────────────────────────── */
    window.addEventListener('keydown', function (e) {
        /* Dom.keyCode also maps remotes that send only a named key. */
        var kc = (typeof Dom !== 'undefined') ? Dom.keyCode(e) : (e.keyCode || e.which);

        // Track menu captures input while open
        if (subsOpen) {
            e.preventDefault();
            if (kc === KEY.UP)         { moveSubs(-1); }
            else if (kc === KEY.DOWN)  { moveSubs(1); }
            else if (kc === KEY.ENTER) { applyTrackChoice(); }
            else if (kc === KEY.LEFT)  { stepOption(-1); }
            else if (kc === KEY.RIGHT) { stepOption(1); }
            else if (kc === KEY.BACK || kc === KEY.ESC) {
                /* From the OpenSubtitles results, BACK steps back to the
                   subtitle menu rather than dropping out to the video. */
                if (menuMode === 'os') openSubsMenu(); else closeSubs();
            }
            return;
        }

        /* A pending auto-advance is cancelled by ANY key — pressing something
           at the end of an episode means you have plans, and being thrown into
           the next one anyway is the annoying part of autoplay. */
        if (autoNextAt && kc !== KEY.ENTER) { cancelAutoNext(); hidePill(); }

        /* While a pill is up and the controls are hidden, OK belongs to the
           pill — that is the whole interaction: see "Skip intro", press OK.
           With the OSD open the control row owns OK instead, so the pill can
           never steal a press meant for play/pause. */
        if (kc === KEY.ENTER && pillVisible() && !osdVisible()) {
            e.preventDefault();
            firePill();
            return;
        }

        if (kc === KEY.BACK || kc === KEY.ESC) { e.preventDefault(); goBack(); return; }

        // Dedicated media keys work regardless of OSD state
        if (kc === KEY.PLAY || kc === KEY.PAUSE || kc === KEY.PLAYPAUSE) { e.preventDefault(); togglePlay(); showOsd(); return; }
        if (kc === KEY.FF) { e.preventDefault(); seek(30);  showOsd(); return; }
        if (kc === KEY.RW) { e.preventDefault(); seek(-10); showOsd(); return; }
        if (kc === KEY.STOP) { e.preventDefault(); goBack(); return; }

        var isNav = kc === KEY.LEFT || kc === KEY.RIGHT || kc === KEY.UP || kc === KEY.DOWN || kc === KEY.ENTER;
        if (!isNav) return;
        e.preventDefault();

        // First press while hidden just reveals the OSD
        if (!osdVisible()) { showOsd(); paintFocus(); return; }
        showOsd();

        if (kc === KEY.LEFT) {
            stepFocus(-1);
        } else if (kc === KEY.RIGHT) {
            stepFocus(1);
        } else if (kc === KEY.UP) {
            if (backBtn) { focusIdx = 0; paintFocus(); }
        } else if (kc === KEY.DOWN) {
            var playI = focusRow.indexOf(document.getElementById('ctrl-play'));
            if (playI >= 0) { focusIdx = playI; paintFocus(); }
        } else if (kc === KEY.ENTER) {
            activate(focusRow[focusIdx]);
        }
    }, true);

    /* ── Init ────────────────────────────────────────────────────────────── */
    updatePlayIcon();
    paintFocus();
    showOsd();

    /* Subtitles arrive in two halves:
         meta.subs           downloadable files → attached as <track>s
         meta.subs_embedded  tracks the provider says are muxed into the video
       The second half never becomes a playable track, but it is what lets the
       menu explain an empty list truthfully instead of claiming the title has
       no subtitles at all.

       Whatever the handover carried is attached immediately, and anything it
       missed is chased down in the background against the stream that is
       already playing. See player/subtitles.js — the VOD page races its own
       lookup against a 2s cap, so "no subtitles" from there means "not within
       two seconds", not "none exist". `url` and `metaNote` are passed
       separately because they stay meaningful when meta itself was rejected. */
    if (window.player && typeof PlayerSubs !== 'undefined') {
        PlayerSubs.init({ meta: meta, player: player, url: url, metaNote: metaNote });
    } else if (window.player) {
        if (player.setEmbeddedSubInfo) {
            player.setEmbeddedSubInfo((meta && meta.subs_embedded) || [], (meta && meta.subs_unknown) || 0);
        }
        if (meta && meta.subs && meta.subs.length && player.addExternalSubs) {
            player.addExternalSubs(meta.subs);
        }
    }
    /* Re-apply the user's remembered track choices once the stream has had time
       to expose them. Tracks appear asynchronously (hls.js parses the manifest,
       native decoding populates textTracks), so this runs on a delay AND again
       on `loadeddata` — whichever finds tracks first wins, and re-running is
       harmless because both restores are idempotent. */
    activeSubLabel = recallTrack('sub') || 'off';

    function restoreTrackPreferences() {
        restoreAudioPreference();
        if (!activeSubLabel || activeSubLabel === 'off') return;
        var subs = (window.player && player.listSubtitles) ? player.listSubtitles() : [];
        for (var i = 0; i < subs.length; i++) {
            if ((subs[i].label || '').toLowerCase() === activeSubLabel) {
                if (player.setSubtitle) player.setSubtitle(subs[i]);
                return;
            }
        }
    }
    video.addEventListener('loadeddata', function () { setTimeout(restoreTrackPreferences, 400); });
    setTimeout(restoreTrackPreferences, 2500);

    /* Embedded tracks can appear after the menu was built. Rebuild it in place
       so a track that shows up late is selectable without reopening. */
    if (window.player) {
        player.onTracksChanged = function () {
            /* A track that turns up late is also a track the remembered choice
               never had a chance to match against. The two fixed delays below
               are a guess at when everything has arrived; this is the signal
               that it actually has — and it is the only one that fires for the
               subtitles PlayerSubs chases down after playback starts, which on a
               slow panel is well past both of them. Idempotent, so running it
               again here costs nothing. */
            restoreTrackPreferences();
            if (subsOpen && menuMode === 'subs') { buildSubsOptions(); renderMenu('Subtitles'); }
            else if (subsOpen && menuMode === 'audio') { buildAudioOptions(); renderMenu('Audio'); }
        };
    }
}());
