/* livetv/multiview.js — watch several live channels at once. Exposes
 * window.Multiview.
 *
 * ── The shape of the feature ────────────────────────────────────────────────
 * A grid of independent players over the whole screen. Exactly one tile is
 * "active": it has the focus ring and it is the only one with sound. That
 * single rule is what makes the mode usable — four channels of simultaneous
 * audio is noise, and muting everything makes it useless for the thing people
 * actually want it for, which is watching several matches and following the one
 * that matters at that moment.
 *
 *   arrows      move the active tile
 *   OK          zoom the active tile to full screen / back to the grid
 *   CH +/-      change the active tile's channel
 *   BACK/BLUE   leave (unzoom first if zoomed)
 *
 * ── Why it is not always 2×2 ────────────────────────────────────────────────
 * A TV has a fixed number of video decode pipelines. On webOS 5 and below there
 * is essentially one hardware decoder plus a software fallback, so a third and
 * fourth stream do not merely stutter — they take down the ones already
 * playing. Platform.maxDecoders caps the grid accordingly (2 there, 4 on modern
 * sets) and the tiles that could not start say so on themselves rather than
 * sitting black.
 *
 * The main player is stopped on the way in and its channel restored on the way
 * out, because leaving it running would spend one of those pipelines on a
 * stream nobody can see.
 *
 * ── Starts are staggered, never simultaneous ────────────────────────────────
 * See the START QUEUE section. Four streams asked for at the same instant is
 * the worst possible request pattern for both ends of the connection, and it
 * produces failures that look like "multiview doesn't work" rather than "we
 * asked for too much at once".
 */
window.Multiview = (function () {
    'use strict';

    var MAX_TILES_KEY = 'iptv_multiview_tiles';   // user override, 0 = automatic

    /* ── Stagger timing ───────────────────────────────────────────────────────
       MIN is the floor between two starts even when the first connects
       instantly — without it a fast panel still gets four near-simultaneous
       requests, which is the thing being avoided.
       MAX is how long to wait on a tile that never reports anything before
       starting the next one anyway, so one dead channel cannot stall the grid. */
    var STAGGER_MIN_MS = 600;
    var STAGGER_MAX_MS = 3500;

    /* How long the key help and the active tile's channel name stay up. One
       constant for both: a single keypress raises them together, and two
       fade-outs a second apart reads as a glitch rather than as two controls. */
    var OSD_MS = 4000;
    var LABEL_MS = OSD_MS;

    var _open     = false;
    var _zoomed   = false;
    var _tiles    = [];       // { el, video, msg, label, player, channel, ... }
    var _active   = 0;
    var _channels = [];       // the list the page was showing when we opened
    var _opts     = null;
    var _root     = null;
    var _hintTimer = null;
    var _labelTimer = null;

    /* Start queue state — see START QUEUE below. */
    var _queue        = [];
    var _starting     = false;
    var _staggerTimer = null;

    function isOpen() { return _open; }

    /* How many tiles this TV should attempt. The user can force a number in
       Settings → Player when the automatic choice is wrong for their set —
       either because it is more capable than its Chromium version suggests, or
       because four streams saturate their network rather than their decoder. */
    function tileCount() {
        var forced = parseInt(Store.getRaw(MAX_TILES_KEY, '0'), 10);
        if (forced === 2 || forced === 3 || forced === 4) return forced;
        return (typeof Platform !== 'undefined' && Platform.maxDecoders) || 4;
    }

    /* ── Layouts ──────────────────────────────────────────────────────────────
       Written out per tile count rather than derived from a rows×cols grid,
       because the 3-tile layout is an L (one full-height tile on the left, two
       stacked on the right) and uniform-grid arithmetic gets it wrong: it
       places index 2 bottom-LEFT, so DOWN from the big tile jumped to the
       bottom-right pane and index 1 had no way down at all.

       Each entry maps a tile index to its neighbour in each direction, -1 for
       "nothing that way". Must stay in step with the percentages in
       assets/multiview.css. */
    var LAYOUTS = {
        2: [
            { l: -1, r:  1, u: -1, d: -1 },
            { l:  0, r: -1, u: -1, d: -1 }
        ],
        3: [
            { l: -1, r:  1, u: -1, d: -1 },   // 0 — full height, left
            { l:  0, r: -1, u: -1, d:  2 },   // 1 — top right
            { l:  0, r: -1, u:  1, d: -1 }    // 2 — bottom right
        ],
        4: [
            { l: -1, r:  1, u: -1, d:  2 },
            { l:  0, r: -1, u: -1, d:  3 },
            { l: -1, r:  3, u:  0, d: -1 },
            { l:  2, r: -1, u:  1, d: -1 }
        ]
    };

    function layout() { return LAYOUTS[_tiles.length] || LAYOUTS[4]; }

    /* ── Open / close ─────────────────────────────────────────────────────────
       `channels` is whatever list the page is showing, so multiview inherits
       the current category or favourites filter rather than always starting
       from the top of everything. */
    function open(channels, startIndex, opts) {
        if (_open) return false;
        if (typeof IPTVPlayer === 'undefined') return false;
        _channels = channels || [];
        if (!_channels.length) return false;
        _opts = opts || {};

        var n = Math.min(tileCount(), _channels.length);
        var start = Math.max(0, Math.min(_channels.length - 1, startIndex || 0));

        buildDom(n);
        _open = true;
        _zoomed = false;
        _active = 0;
        _queue = [];
        _starting = false;
        document.body.classList.add('multiview-open');

        for (var i = 0; i < n; i++) {
            /* Consecutive channels from the start point, wrapping, so opening
               multiview on the channel you were watching puts it top-left and
               fills the rest with its neighbours. */
            enqueueStart(i, _channels[(start + i) % _channels.length]);
        }
        paintFocus();
        showHint();
        return true;
    }

    function close() {
        if (!_open) return;
        var active = _tiles[_active] && _tiles[_active].channel;

        /* Order matters: stop the queue before destroying the players, so a
           pending start can't fire against a torn-down tile. */
        _queue = [];
        _starting = false;
        clearTimeout(_staggerTimer);
        _staggerTimer = null;

        for (var i = 0; i < _tiles.length; i++) {
            clearTimeout(_tiles[i].startTimeout);
            try { _tiles[i].player.destroy(); } catch (e) {}
        }
        _tiles = [];
        if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
        _root = null;
        _open = false;
        _zoomed = false;
        clearTimeout(_hintTimer);
        clearTimeout(_labelTimer);
        if (typeof ChannelNumbers !== 'undefined') ChannelNumbers.cancel();
        document.body.classList.remove('multiview-open');

        /* Hand the tile the user was on back to the page, so leaving multiview
           on a channel you found there keeps you on it. */
        if (_opts && typeof _opts.onExit === 'function') _opts.onExit(active);
        _opts = null;
    }

    /* ── DOM ──────────────────────────────────────────────────────────────── */
    function buildDom(n) {
        _root = Dom.el('div', { id: 'mv-root', 'data-tiles': String(n) });

        /* #mv-grid is the tiles' containing block — it is given an explicit
           full-size position in the stylesheet. Without that the percentages on
           .mv-tile would resolve against #mv-root instead, which happens to be
           the same rectangle today and would stop being so the moment anything
           is added around the grid. */
        var grid = Dom.el('div', { id: 'mv-grid' });
        _tiles = [];
        for (var i = 0; i < n; i++) _tiles.push(buildTile(i, grid));
        _root.appendChild(grid);

        /* The hint element is rebuilt with the overlay, so any saved copy of its
           key help belongs to a previous session and must not be restored over
           this one. */
        KEY_HINT = null;

        _root.appendChild(Dom.el('div', { id: 'mv-hint' }, [
            Dom.el('span.mv-key', { text: '◀ ▲ ▼ ▶' }), ' switch tile   ',
            Dom.el('span.mv-key', { text: 'OK' }), ' zoom   ',
            Dom.el('span.mv-key', { text: 'CH +/−' }), ' change channel   ',
            Dom.el('span.mv-key', { text: 'BACK' }), ' exit'
        ]));

        document.body.appendChild(_root);
    }

    function buildTile(i, grid) {
        var video = Dom.el('video', { className: 'mv-video' });
        video.muted = true;                   // the active tile is unmuted below
        video.setAttribute('playsinline', '');

        var msg   = Dom.el('div.mv-msg', { text: 'Waiting…' });
        var label = Dom.el('div.mv-label');
        var el    = Dom.el('div.mv-tile', { 'data-index': String(i) }, [video, msg, label]);

        el.addEventListener('click', function () {
            if (_active === i) toggleZoom(); else { _active = i; paintFocus(); }
        });
        grid.appendChild(el);

        var player = new IPTVPlayer({
            video: video, wrap: el, msgEl: msg,
            keys: false,          // one RED press must not cycle four engines
            lightBuffer: true
        });
        var tile = {
            el: el, video: video, msg: msg, label: label,
            player: player, channel: null,
            settle: null,         // set per start job; see startTile()
            startTimeout: null
        };

        player.onPlaying = function () { tileStarted(tile); };
        /* If the TV refused to start a tile with sound, the engine starts it
           muted and hands the decision back here on the next key press —
           which tile is audible is the grid's call, not the tile's. */
        player.onAutoplayUnblocked = function () { applyAudio(); };

        /* A tile that cannot start is the normal outcome when the TV runs out
           of decoders, and "Can't play this channel" is a misleading way to say
           that — the channel is fine, the fourth pipeline isn't there. */
        player.onError = function () {
            tileStarted(tile);
            if (!_open) return;
            msg.innerHTML = '';
            msg.appendChild(Dom.el('div.mv-msg-title', { text: 'No picture' }));
            msg.appendChild(Dom.el('div.mv-msg-detail', {
                text: 'This TV may not be able to decode ' + _tiles.length +
                      ' streams at once. Press CH +/− to try another channel, or ' +
                      'lower the tile count in Settings → Player.'
            }));
            msg.style.display = 'flex';
        };
        return tile;
    }

    function setMsg(tile, text) {
        tile.msg.textContent = text;
        tile.msg.style.display = 'flex';
    }

    /* ══════════════════════════════════════════════════════════════════════════
       START QUEUE
       ══════════════════════════════════════════════════════════════════════════
       Tiles are started one at a time, never together.

       Four simultaneous starts is the worst request pattern available here. Each
       one is a manifest fetch followed immediately by segment fetches, so the
       burst is far larger than four requests; IPTV panels commonly rate-limit or
       cap concurrent connections per account and answer the extra ones with 403
       or by dropping them; and on the TV side four decoder allocations landing
       in the same instant is exactly when the platform hands back failures. All
       of that surfaces as "tiles 3 and 4 are black", which reads as a broken
       feature rather than as asking for too much at once.

       The gap is adaptive rather than a fixed sleep: the next tile starts as
       soon as the previous one actually reports 'playing' (or fails), subject to
       a MIN floor so a fast panel still gets spaced requests, and a MAX ceiling
       so one dead channel cannot stall the rest of the grid behind it. In
       practice a healthy set of four is fully up in about two seconds, and an
       unhealthy one degrades tile by tile instead of all at once.               */

    function enqueueStart(i, ch) {
        if (!_open || !ch) return;
        /* A tile can only have one pending start — pressing CH+ twice quickly
           should load the second channel, not both in sequence. */
        _queue = _queue.filter(function (job) { return job.index !== i; });
        _queue.push({ index: i, channel: ch });

        var tile = _tiles[i];
        if (tile) {
            tile.channel = ch;
            tile.label.textContent = ch.name || '';
            setMsg(tile, _starting ? 'Waiting…' : 'Loading…');
            /* Retuning the tile you are on is the other moment the name is
               worth seeing — CH +/- otherwise changes the picture with nothing
               saying what to. */
            if (i === _active) flashLabel();
        }
        pumpQueue();
    }

    function pumpQueue() {
        if (_starting || !_queue.length || !_open) return;
        var job = _queue.shift();
        startTile(job.index, job.channel);
    }

    /* Called when a tile reports its outcome — success or failure, both mean
       "this one is done occupying the connection". Idempotent per start job:
       onPlaying fires again on every later reconnect, and those must not
       advance a queue that has long since drained. */
    function tileStarted(tile) {
        if (typeof tile.settle === 'function') {
            var settle = tile.settle;
            tile.settle = null;
            settle();
        }
    }

    function startTile(i, ch) {
        var tile = _tiles[i];
        if (!tile || !ch) { releaseAfter(0); return; }

        _starting = true;
        tile.channel = ch;
        tile.label.textContent = ch.name || 'Unknown';
        setMsg(tile, 'Loading…');

        var url = _opts && _opts.buildUrl ? _opts.buildUrl(ch) : '';
        if (!url) { setMsg(tile, 'No stream URL.'); releaseAfter(0); return; }

        var startedAt = Date.now();
        tile.settle = function () {
            clearTimeout(tile.startTimeout);
            tile.startTimeout = null;
            /* Honour the floor measured from when THIS start began, so a stream
               that connects in 50ms still leaves a gap before the next. */
            releaseAfter(Math.max(0, STAGGER_MIN_MS - (Date.now() - startedAt)));
        };
        tile.startTimeout = setTimeout(function () { tileStarted(tile); }, STAGGER_MAX_MS);

        tile.player.play(url, { key: 'ch:' + ch.stream_id });
        applyAudio();
    }

    function releaseAfter(delay) {
        clearTimeout(_staggerTimer);
        _staggerTimer = setTimeout(function () {
            _staggerTimer = null;
            _starting = false;
            pumpQueue();
        }, delay);
    }

    /* ── Tiles ────────────────────────────────────────────────────────────── */

    /* Exactly one tile has sound. Muting is done on the element rather than by
       pausing, so every tile keeps its picture. */
    function applyAudio() {
        for (var i = 0; i < _tiles.length; i++) {
            try { _tiles[i].video.muted = (i !== _active); } catch (e) {}
        }
    }

    function paintFocus() {
        for (var i = 0; i < _tiles.length; i++) {
            _tiles[i].el.classList.toggle('mv-active', i === _active);
        }
        applyAudio();
        flashLabel();
    }

    /* Show the active tile's channel name, briefly. Only ever one at a time:
       the name answers "what am I now on?", which is a question about the tile
       you just moved to, so the other three showing theirs permanently is noise
       over the picture rather than information.

       One shared timer, and every label is cleared on each call — moving
       quickly between tiles must not leave the previous one's name behind. */
    function flashLabel() {
        clearTimeout(_labelTimer);
        for (var i = 0; i < _tiles.length; i++) {
            _tiles[i].label.classList.toggle('mv-label-visible', i === _active);
        }
        _labelTimer = setTimeout(hideLabels, LABEL_MS);
    }

    function hideLabels() {
        for (var i = 0; i < _tiles.length; i++) {
            _tiles[i].label.classList.remove('mv-label-visible');
        }
    }

    function toggleZoom() {
        _zoomed = !_zoomed;
        _root.classList.toggle('mv-zoomed', _zoomed);
        for (var i = 0; i < _tiles.length; i++) {
            _tiles[i].el.classList.toggle('mv-zoom-target', _zoomed && i === _active);
        }
        showHint();
        flashLabel();   // the grid just changed shape; say which channel this is
    }

    /* ── Navigation ───────────────────────────────────────────────────────── */
    function move(dir) {
        if (_zoomed) return;                 // zoomed: there is nowhere to move
        var cell = layout()[_active];
        if (!cell) return;
        var next = cell[dir];
        if (next >= 0 && next < _tiles.length) { _active = next; paintFocus(); }
        showHint();
    }

    /* Step the active tile's channel through the page's list. Skips a channel
       already on screen so pressing CH+ never lands you on a duplicate. */
    function stepChannel(dir) {
        var tile = _tiles[_active];
        if (!tile || !_channels.length) return;

        var idx = -1;
        for (var i = 0; i < _channels.length; i++) {
            if (tile.channel && String(_channels[i].stream_id) === String(tile.channel.stream_id)) { idx = i; break; }
        }

        for (var step = 1; step <= _channels.length; step++) {
            var next = ((idx + dir * step) % _channels.length + _channels.length) % _channels.length;
            var candidate = _channels[next];
            if (!onScreen(candidate)) { enqueueStart(_active, candidate); return; }
        }

        /* Every channel in the current list is already on screen — the list is
           no larger than the grid. Without this the search wrapped all the way
           round and "found" the tile's OWN channel, restarting a stream that
           was already playing and looking like the button had glitched. Silence
           would read as a broken button too, so say what happened. */
        flashHint('Every channel in this list is already showing.');
    }

    /* Is this channel in ANY tile, including the active one? The active tile is
       deliberately not excluded: stepping is meant to reach a channel you are
       not already watching, and its own is the one it is least useful to
       "move" to. */
    function onScreen(ch) {
        for (var i = 0; i < _tiles.length; i++) {
            var c = _tiles[i].channel;
            if (c && String(c.stream_id) === String(ch.stream_id)) return true;
        }
        return false;
    }

    /* ── Hint bar ─────────────────────────────────────────────────────────── */
    var KEY_HINT = null;

    function showHint() {
        var hint = Dom.byId('mv-hint');
        if (!hint) return;
        if (KEY_HINT) { hint.innerHTML = KEY_HINT; KEY_HINT = null; }
        hint.classList.add('mv-hint-visible');
        clearTimeout(_hintTimer);
        _hintTimer = setTimeout(function () { hint.classList.remove('mv-hint-visible'); }, OSD_MS);
    }

    /* Replace the key help with a one-off message, then restore it next time
       the bar is shown. */
    function flashHint(text) {
        var hint = Dom.byId('mv-hint');
        if (!hint) return;
        if (KEY_HINT === null) KEY_HINT = hint.innerHTML;
        hint.textContent = text;
        hint.classList.add('mv-hint-visible');
        clearTimeout(_hintTimer);
        _hintTimer = setTimeout(function () {
            hint.classList.remove('mv-hint-visible');
            if (KEY_HINT) { hint.innerHTML = KEY_HINT; KEY_HINT = null; }
        }, OSD_MS);
    }

    /* ── Key handling ─────────────────────────────────────────────────────────
       Called from dpad.js before anything else while multiview is open, so the
       page's own navigation cannot act on the same press.

       Only keys this screen actually handles are consumed. Swallowing
       everything would also swallow whatever the platform routes through the
       page — volume being the one that matters — and a multiview that mutes the
       remote is worse than one that ignores a stray press. */
    function handleKey(e) {
        var kc = Dom.keyCode(e);
        var K  = Dom.KEY;

        /* A typed number retunes the focused tile — the same thing CH +/- does,
           just direct. Offered first so digits (and the OK/BACK that finish or
           abandon one) aren't read as zoom/exit mid-entry. */
        if (typeof ChannelNumbers !== 'undefined' && ChannelNumbers.handleKey(e, {
            total:  function ()  { return _channels.length; },
            nameAt: function (i) { return (_channels[i] && _channels[i].name) || ''; },
            pick:   function (i) { if (_channels[i]) enqueueStart(_active, _channels[i]); }
        })) {
            e.preventDefault();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
            return true;
        }

        var handled = true;
        switch (kc) {
            case K.LEFT:    move('l'); break;
            case K.RIGHT:   move('r'); break;
            case K.UP:      move('u'); break;
            case K.DOWN:    move('d'); break;
            case K.ENTER:   toggleZoom(); break;
            case K.CH_UP_ALT:
            case K.CH_UP:   stepChannel(-1); break;
            case K.CH_DOWN_ALT:
            case K.CH_DOWN: stepChannel(1);  break;
            case K.BLUE:    close(); break;
            case K.BACK:
            case K.ESC:
                /* One BACK unzooms, a second leaves — so BACK never skips a
                   step the user can see. */
                if (_zoomed) toggleZoom(); else close();
                break;
            default:
                handled = false;
        }

        if (handled) {
            e.preventDefault();
            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        }
        return handled;
    }

    return {
        MAX_TILES_KEY: MAX_TILES_KEY,
        STAGGER_MIN_MS: STAGGER_MIN_MS, STAGGER_MAX_MS: STAGGER_MAX_MS,
        isOpen: isOpen, open: open, close: close,
        handleKey: handleKey, tileCount: tileCount
    };
}());
