/* player/ass.js — renders .ass / .ssa subtitles as HTML over the video.
 * Exposes window.AssSubs.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Xtream panels list sidecar subtitles under `info.subtitles[]`, and a good
 * share of them are .ass/.ssa rather than .srt — anime and Asian-language
 * releases almost exclusively. Until now those files went down the same path as
 * SRT: fetched, pushed through Subs.toVtt(), and handed to a <track>. That
 * cannot work. ASS is not a timing-and-text format with different punctuation —
 * it has a style table, absolute positioning, and inline override tags. Fed to
 * the VTT converter it produced a track whose every cue was a wall of
 * "Dialogue: 0,0:00:12.30,0:00:14.10,Default,,0,0,0,," markup, or (more often)
 * nothing at all. Either way the user saw a subtitle entry in the menu that
 * did nothing useful.
 *
 * So ASS gets its own renderer, drawn into a positioned <div> over the video
 * rather than through the text-track machinery.
 *
 * ── Why not the usual library ───────────────────────────────────────────────
 * The obvious answer is assjs or libass-wasm. Neither fits this app:
 *
 *   assjs        ES2015+ ESM, and leans on CSS custom properties and
 *                registerProperty. This app has no bundler — plain <script>
 *                tags, Babel transpiling SYNTAX ONLY to a Chrome 38 target. A
 *                library's modern runtime and CSS calls survive Babel untouched
 *                and fail on the TV, which is exactly the class of bug that is
 *                hardest to diagnose on a device with no console.
 *   libass-wasm  needs WebAssembly (not on webOS 3/4) and ships megabytes of
 *                fonts, against an app whose whole payload is a few hundred KB.
 *
 * The practical subset is small enough to own: the style table, dialogue
 * timing, the nine-way alignment grid, \pos, and the inline tags that actually
 * appear in released subtitle files. Everything beyond that degrades to plain
 * positioned text rather than breaking — an un-animated sign is a far better
 * outcome than no subtitles, and it is the outcome on old hardware anyway.
 *
 * Drawing as HTML/CSS also means the BROWSER does font fallback, so CJK and
 * Cyrillic come out of the TV's own system fonts with nothing bundled.
 *
 * ── One instance, on purpose ────────────────────────────────────────────────
 * A module singleton rather than a per-player object, because ASS only ever
 * arrives as a VOD sidecar and the VOD page runs exactly one player. The other
 * case — Multiview's four simultaneous IPTVPlayers — is Live TV, which has no
 * sidecar subtitles at all. If ASS ever needs to reach Live TV this has to
 * become an instance owned by the player, or four tiles will share one overlay.
 *
 * ES5 — Babel target is Chrome 38.                                            */
window.AssSubs = (function () {
    'use strict';

    var OVERLAY_ID = 'ass-overlay';

    var _video   = null;
    var _host    = null;    // where the overlay is appended (#pip-wrap)
    var _overlay = null;
    var _zones   = null;    // the nine alignment containers, indexed 1..9
    var _subs    = [];      // { url, text, lang, label, script, failed }
    var _active  = -1;      // index into _subs currently drawn, -1 = none
    var _timer   = null;
    var _offset  = 0;       // seconds, positive = subtitles appear later
    var _gen     = 0;       // bumped on every show/hide/destroy; stale fetches bail
    var _sig     = '';      // what is on screen now, so an unchanged frame is skipped
    var _geom    = null;    // last applied { w, h, sx, sy }
    var _note    = '';      // last outcome, for the GREEN diagnostics overlay

    /* Redraw rate. `timeupdate` alone fires about four times a second, which
       puts up to 250ms of slop on every cue's in and out point — visible, and
       the sort of thing that reads as "the subtitles are out of sync". A timer
       is cheap here because a frame whose visible-cue set hasn't changed does
       no DOM work at all (see the signature check in draw()). */
    var TICK_MS = 80;

    /* ── Format detection ─────────────────────────────────────────────────── */
    function isAss(url) {
        var clean = String(url || '').split('?')[0].split('#')[0];
        var m = /\.([a-z0-9]+)$/i.exec(clean);
        var ext = m ? m[1].toLowerCase() : '';
        return ext === 'ass' || ext === 'ssa';
    }

    function trim(s) { return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, ''); }

    /* ── Colours ──────────────────────────────────────────────────────────────
       ASS writes colours as &HAABBGGRR — byte-reversed against CSS, and with
       ALPHA inverted (00 is opaque, FF is invisible). SSA files sometimes carry
       a plain decimal instead. Getting either wrong is not subtle: red and blue
       swap, or every line renders fully transparent. */
    function colour(raw) {
        var s = trim(raw);
        if (!s) return '';
        var hex;
        if (/^&h/i.test(s)) {
            hex = s.replace(/^&h/i, '').replace(/&$/, '');
        } else if (/^-?\d+$/.test(s)) {
            hex = (parseInt(s, 10) >>> 0).toString(16);
        } else {
            hex = s.replace(/[^0-9a-f]/gi, '');
        }
        if (!hex) return '';
        while (hex.length < 6) hex = '0' + hex;

        var a = 0, rgb = hex;
        if (hex.length > 6) {
            a   = parseInt(hex.slice(0, hex.length - 6), 16) || 0;
            rgb = hex.slice(hex.length - 6);
        }
        var b = parseInt(rgb.slice(0, 2), 16) || 0;
        var g = parseInt(rgb.slice(2, 4), 16) || 0;
        var r = parseInt(rgb.slice(4, 6), 16) || 0;
        var alpha = Math.max(0, Math.min(1, 1 - (a / 255)));
        return 'rgba(' + r + ',' + g + ',' + b + ',' + (Math.round(alpha * 1000) / 1000) + ')';
    }

    /* ── Alignment ────────────────────────────────────────────────────────────
       V4+ uses the numeric keypad (1 = bottom-left … 9 = top-right). The older
       SSA V4 scheme is a bitfield, and a file written in it will otherwise put
       every line in the wrong third of the screen. */
    function ssaAlign(a) {
        var h = a & 3;                       // 1 left, 2 centre, 3 right
        if (!h) h = 2;
        if (a & 8) return 3 + h;             // middle row → 4,5,6
        if (a & 4) return 6 + h;             // top row    → 7,8,9
        return h;                            // bottom row → 1,2,3
    }

    /* ── Timecodes ────────────────────────────────────────────────────────── */
    function seconds(v) {
        var m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(trim(v));
        if (!m) return NaN;
        var frac = m[4] ? parseFloat('0.' + m[4]) : 0;
        /* ASS writes hundredths, so "0:00:12.30" is 12.30s not 12.030s — which
           parseFloat('0.30') gives correctly. Three digits are milliseconds and
           also come out right, so no per-length special case is needed. */
        return (parseInt(m[1] || '0', 10) * 3600) +
               (parseInt(m[2], 10) * 60) +
               parseInt(m[3], 10) + frac;
    }

    /* Split on commas but stop after n-1 of them: the last field of a Dialogue
       line is the text, which routinely contains commas of its own (and always
       does inside override tags like \pos(640,700)). */
    function splitLimited(s, n) {
        var out = [], start = 0;
        while (out.length < n - 1) {
            var c = s.indexOf(',', start);
            if (c < 0) break;
            out.push(s.slice(start, c));
            start = c + 1;
        }
        out.push(s.slice(start));
        return out;
    }

    /* ── Script parsing ───────────────────────────────────────────────────────
       Tolerant by design. Real files in the wild carry a BOM, CRLF endings,
       comment lines, sections in any order, and either the V4 or V4+ style
       table. Fields are read by NAME off the section's own `Format:` line
       rather than by position, because the order genuinely varies and a
       positional read silently mislabels every column when it doesn't. */
    function parseScript(text) {
        var out = {
            w: 384, h: 288,           // ASS's own default PlayRes
            styles: {}, events: [],
            scaledBorder: true
        };
        var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
        var section = '', styleFmt = null, eventFmt = null, sawPlayRes = false;

        for (var i = 0; i < lines.length; i++) {
            var line = trim(lines[i]);
            if (!line || line.charAt(0) === ';' || line.charAt(0) === '!') continue;
            if (line.charAt(0) === '[') {
                section = line.toLowerCase().replace(/[\[\]]/g, '');
                continue;
            }
            var colon = line.indexOf(':');
            if (colon < 0) continue;
            var key = trim(line.slice(0, colon)).toLowerCase();
            var val = trim(line.slice(colon + 1));

            if (section === 'script info') {
                if (key === 'playresx') { out.w = parseInt(val, 10) || out.w; sawPlayRes = true; }
                else if (key === 'playresy') { out.h = parseInt(val, 10) || out.h; sawPlayRes = true; }
                else if (key === 'scaledborderandshadow') out.scaledBorder = !/^no$/i.test(val);
                continue;
            }

            if (section === 'v4+ styles' || section === 'v4 styles' || section === 'v4++ styles') {
                if (key === 'format') { styleFmt = fields(val); continue; }
                if (key !== 'style' || !styleFmt) continue;
                var sv = splitLimited(val, styleFmt.length);
                var st = {};
                for (var f = 0; f < styleFmt.length; f++) st[styleFmt[f]] = trim(sv[f]);
                var style = {
                    name:      st.name || 'Default',
                    font:      st.fontname || '',
                    size:      parseFloat(st.fontsize) || 40,
                    primary:   colour(st.primarycolour) || 'rgba(255,255,255,1)',
                    outlineC:  colour(st.outlinecolour || st.tertiarycolour) || 'rgba(0,0,0,1)',
                    backC:     colour(st.backcolour) || 'rgba(0,0,0,0.6)',
                    bold:      /^-?1$/.test(st.bold || '') ? 700 : 400,
                    italic:    /^-?1$/.test(st.italic || ''),
                    underline: /^-?1$/.test(st.underline || ''),
                    strike:    /^-?1$/.test(st.strikeout || ''),
                    border:    parseInt(st.borderstyle, 10) || 1,
                    outline:   parseFloat(st.outline),
                    shadow:    parseFloat(st.shadow),
                    marginL:   parseInt(st.marginl, 10) || 0,
                    marginR:   parseInt(st.marginr, 10) || 0,
                    marginV:   parseInt(st.marginv, 10) || 0,
                    align:     parseInt(st.alignment, 10) || 2
                };
                if (!isFinite(style.outline)) style.outline = 2;
                if (!isFinite(style.shadow))  style.shadow  = 0;
                if (section === 'v4 styles') style.align = ssaAlign(style.align);
                if (style.align < 1 || style.align > 9) style.align = 2;
                out.styles[style.name] = style;
                continue;
            }

            if (section === 'events') {
                if (key === 'format') { eventFmt = fields(val); continue; }
                /* `Comment:` lines share the Dialogue layout and are deliberately
                   NOT rendered — they are the file's own scratch notes, and
                   translators leave working drafts in them. */
                if (key !== 'dialogue' || !eventFmt) continue;
                var ev = splitLimited(val, eventFmt.length);
                var e = {};
                for (var g = 0; g < eventFmt.length; g++) e[eventFmt[g]] = ev[g];
                var start = seconds(e.start), end = seconds(e.end);
                if (!isFinite(start) || !isFinite(end) || end <= start) continue;
                out.events.push({
                    start: start, end: end,
                    style: trim(e.style) || 'Default',
                    marginL: parseInt(e.marginl, 10) || 0,
                    marginR: parseInt(e.marginr, 10) || 0,
                    marginV: parseInt(e.marginv, 10) || 0,
                    text: e.text === undefined ? '' : e.text
                });
            }
        }

        /* A file with a style table but no PlayRes is claiming ASS's 384x288
           default, which essentially never matches what it was authored
           against. 640x480 is the near-universal convention for such files and
           keeps font sizes sane; without this, text comes out roughly double
           size on a 16:9 screen. */
        if (!sawPlayRes) { out.w = 640; out.h = 480; }
        if (!out.styles.Default) {
            out.styles.Default = {
                name: 'Default', font: '', size: 40,
                primary: 'rgba(255,255,255,1)', outlineC: 'rgba(0,0,0,1)',
                backC: 'rgba(0,0,0,0.6)',
                bold: 400, italic: false, underline: false, strike: false,
                border: 1, outline: 2, shadow: 0,
                marginL: 10, marginR: 10, marginV: 20, align: 2
            };
        }
        out.events.sort(function (a, b) { return a.start - b.start; });
        return out;
    }

    function fields(val) {
        var raw = val.split(',');
        var out = [];
        for (var i = 0; i < raw.length; i++) out.push(trim(raw[i]).toLowerCase());
        return out;
    }

    /* ── Inline override tags ─────────────────────────────────────────────────
       A Dialogue line's text is plain text interrupted by {\tag\tag} blocks.
       Only the tags that change what a static renderer can show are read; the
       animation ones (\t, \fad, \move's motion, \clip) are ignored on purpose
       rather than approximated, because a wrong approximation is more
       distracting than a line that simply sits still.

       Each tag is matched with its own expression rather than by tokenising the
       block. That is safe here because the patterns all anchor on a digit or
       `&H` immediately after the tag name, which is what keeps \fscx from
       matching \fs, \shad from matching \s, and \be from matching \b — the
       three collisions that a naive scan gets wrong. */
    function applyTags(block, st, base, styles) {
        var m;

        /* \r first: it resets to a style, and any other tag in the same block
           is meant to apply on top of that reset, not before it. */
        if (/\\r/.test(block)) {
            m = /\\r([^\\}]*)/.exec(block);
            var named = m ? trim(m[1]) : '';
            copyStyle(st, (named && styles[named]) || base);
        }

        m = /\\an([1-9])/.exec(block);
        if (m) st.align = parseInt(m[1], 10);
        else {
            m = /\\a(\d+)/.exec(block);
            if (m) st.align = ssaAlign(parseInt(m[1], 10));
        }

        m = /\\pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(block);
        if (m) st.pos = [parseFloat(m[1]), parseFloat(m[2])];
        else {
            /* \move animates between two points. Freezing at the start point is
               the honest static answer — the text lands where the author put it
               and simply doesn't travel. */
            m = /\\move\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(block);
            if (m && !st.pos) st.pos = [parseFloat(m[1]), parseFloat(m[2])];
        }

        m = /\\b(\d+)/.exec(block);
        if (m) {
            var bw = parseInt(m[1], 10);
            st.bold = bw > 1 ? bw : (bw === 1 ? 700 : 400);
        }
        m = /\\i([01])/.exec(block); if (m) st.italic    = m[1] === '1';
        m = /\\u([01])/.exec(block); if (m) st.underline = m[1] === '1';
        m = /\\s([01])/.exec(block); if (m) st.strike    = m[1] === '1';

        m = /\\fs([\d.]+)/.exec(block);      if (m) st.size = parseFloat(m[1]) || st.size;
        m = /\\fn([^\\}]*)/.exec(block);     if (m && trim(m[1])) st.font = trim(m[1]);
        m = /\\bord([\d.]+)/.exec(block);    if (m) st.outline = parseFloat(m[1]);
        m = /\\shad([\d.]+)/.exec(block);    if (m) st.shadow  = parseFloat(m[1]);

        m = /\\1?c&H([0-9a-fA-F]+)&?/.exec(block);  if (m) st.primary  = colour('&H' + m[1]);
        m = /\\3c&H([0-9a-fA-F]+)&?/.exec(block);   if (m) st.outlineC = colour('&H' + m[1]);

        /* \p1 and above switch into vector DRAWING mode: what follows is a path
           ("m 0 0 l 100 0 …"), not words. Rendering it as text is how ASS files
           end up spraying strings of coordinates across the screen, so those
           runs are dropped entirely. */
        m = /\\p(\d+)/.exec(block);
        if (m) st.draw = parseInt(m[1], 10) > 0;
    }

    function copyStyle(dst, src) {
        dst.font = src.font; dst.size = src.size;
        dst.primary = src.primary; dst.outlineC = src.outlineC; dst.backC = src.backC;
        dst.bold = src.bold; dst.italic = src.italic;
        dst.underline = src.underline; dst.strike = src.strike;
        dst.border = src.border; dst.outline = src.outline; dst.shadow = src.shadow;
        dst.align = src.align;
        return dst;
    }

    function newState(base) {
        var st = copyStyle({}, base);
        st.pos = null;
        st.draw = false;
        return st;
    }

    function esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* ── One dialogue line → HTML ─────────────────────────────────────────── */
    function renderText(raw, base, styles, sy) {
        var st = newState(base);
        var html = '';
        var i = 0, n = raw.length;

        while (i < n) {
            var open = raw.indexOf('{', i);
            if (open < 0) { html += runHtml(raw.slice(i), st, sy); break; }
            if (open > i) html += runHtml(raw.slice(i, open), st, sy);
            var close = raw.indexOf('}', open);
            if (close < 0) break;                       // unterminated block: drop the rest
            applyTags(raw.slice(open + 1, close), st, base, styles);
            i = close + 1;
        }
        return { html: html, state: st };
    }

    function runHtml(run, st, sy) {
        if (!run || st.draw) return '';                 // drawing commands are not text
        var text = esc(run)
            .replace(/\\N/g, '\u0000BR\u0000')          // hard break
            .replace(/\\n/g, ' ')                       // soft break — wrapping is the browser's
            .replace(/\\h/g, '\u00a0');                 // non-breaking space
        if (!trim(text.replace(/\u0000BR\u0000/g, ''))) {
            /* A run that is nothing but breaks still has to emit them, or a
               deliberately blank line collapses and the following text moves. */
            if (text.indexOf('\u0000BR\u0000') < 0) return '';
        }

        var css = [];
        css.push('color:' + st.primary);
        css.push('font-size:' + (Math.round(st.size * sy * 100) / 100) + 'px');
        if (st.font) css.push('font-family:' + cssFont(st.font));
        if (st.bold !== 400)  css.push('font-weight:' + st.bold);
        if (st.italic)        css.push('font-style:italic');
        var deco = [];
        if (st.underline) deco.push('underline');
        if (st.strike)    deco.push('line-through');
        if (deco.length)  css.push('text-decoration:' + deco.join(' '));

        /* BorderStyle 3 is an opaque box behind the text instead of an outline —
           used for the karaoke/credit blocks that would be unreadable outlined. */
        if (st.border === 3) {
            css.push('background:' + st.backC);
            css.push('padding:0 0.2em');
        } else {
            var shadow = outlineShadow(st, sy);
            if (shadow) css.push('text-shadow:' + shadow);
        }

        return '<span style="' + css.join(';') + '">' +
               text.replace(/\u0000BR\u0000/g, '<br>') + '</span>';
    }

    /* A font name straight out of the file goes into an inline style, so it is
       quoted and stripped of anything that could close the attribute or the
       declaration. The generic fallback is what makes CJK and Cyrillic work
       without bundling a thing: the TV's own font stack resolves them.

       SINGLE quotes, and that is not cosmetic. These declarations are written
       into a style="..." attribute via innerHTML, so a double-quoted family name
       closes the attribute early — the browser then reads the rest of the
       declaration list as stray HTML attributes and silently drops every
       property after font-family. Weight, slant, the outline shadow and the
       opaque-box background all live after it, so the text still appeared and
       looked almost right, which is exactly why this is worth a comment. */
    function cssFont(name) {
        return "'" + String(name).replace(/["'\\;:<>{}]/g, '') + "', sans-serif";
    }

    /* CSS has no text outline that works on this vintage of Blink
       (-webkit-text-stroke draws INSIDE the glyph and thins the letterform), so
       the outline is built from text-shadows at eight compass points. Capped at
       three pixels because the cost is eight shadows per pixel of width and a TV
       redrawing a dozen spans will drop frames long before the outline looks
       any better. */
    function outlineShadow(st, sy) {
        var parts = [];
        var w = Math.min(3, Math.round((st.outline || 0) * sy));
        if (w > 0) {
            var offs = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
            for (var i = 0; i < offs.length; i++) {
                parts.push((offs[i][0] * w) + 'px ' + (offs[i][1] * w) + 'px 0 ' + st.outlineC);
            }
        }
        var sh = Math.round((st.shadow || 0) * sy);
        if (sh > 0) parts.push(sh + 'px ' + sh + 'px ' + Math.max(1, sh) + 'px rgba(0,0,0,0.85)');
        if (!parts.length && !w) parts.push('0 2px 3px rgba(0,0,0,0.9)');
        return parts.join(',');
    }

    /* ── Overlay geometry ─────────────────────────────────────────────────────
       The overlay has to cover the PICTURE, not the <video> box. Those differ
       whenever the two aspect ratios do, because #player is object-fit:contain —
       a 2.39:1 film in a 16:9 box has black bars top and bottom, and an overlay
       stretched over the whole element puts every bottom-aligned line inside the
       lower bar, where the TV's own overscan can clip it off entirely.

       Everything inside is then scaled from the script's PlayRes to those
       pixels, which is what makes \pos land where the author put it. */
    function geometry() {
        if (!_video) return null;
        var bw = _video.clientWidth, bh = _video.clientHeight;
        if (!bw || !bh) return null;
        var vw = _video.videoWidth, vh = _video.videoHeight;
        var w = bw, h = bh, left = 0, top = 0;
        if (vw && vh) {
            var scale = Math.min(bw / vw, bh / vh);
            w = vw * scale; h = vh * scale;
            left = (bw - w) / 2; top = (bh - h) / 2;
        }
        return { left: left, top: top, w: w, h: h };
    }

    function ensureOverlay() {
        if (_overlay && _overlay.parentNode) return _overlay;
        if (!_host) return null;
        var el = document.createElement('div');
        el.id = OVERLAY_ID;
        _host.appendChild(el);
        _overlay = el;
        _zones = null;
        return el;
    }

    /* Nine absolutely-positioned containers, one per alignment cell. Letting
       normal flow stack the lines inside each cell is what gives simultaneous
       dialogue its correct vertical order for free — no measuring, no second
       layout pass, and it stays right when a line wraps to two rows.

       Index 0 is the layer for \pos lines, which set their own coordinates and
       so belong to no cell. It exists purely so they are CLEARED like everything
       else: appending them straight to the overlay meant a redraw emptied the
       nine cells and left every positioned sign behind, so they piled up and
       stayed on screen for the rest of the film. */
    function ensureZones() {
        var overlay = ensureOverlay();
        if (!overlay) return null;
        if (_zones) return _zones;
        overlay.innerHTML = '';
        _zones = [];
        var free = document.createElement('div');
        free.className = 'ass-free';
        overlay.appendChild(free);
        _zones[0] = free;
        for (var a = 1; a <= 9; a++) {
            var z = document.createElement('div');
            z.className = 'ass-zone ass-zone-' + a;
            overlay.appendChild(z);
            _zones[a] = z;
        }
        return _zones;
    }

    /* ── Drawing ──────────────────────────────────────────────────────────── */
    function draw() {
        if (_active < 0 || !_video) return;
        var sub = _subs[_active];
        if (!sub || !sub.script) return;

        var geo = geometry();
        if (!geo) return;
        var script = sub.script;
        var sx = geo.w / script.w;
        var sy = geo.h / script.h;

        var now = _video.currentTime - _offset;
        var events = script.events;
        var visible = [];
        for (var i = 0; i < events.length; i++) {
            if (events[i].start <= now && now < events[i].end) visible.push(i);
        }

        /* Redraw only when something actually changed. Without this the timer
           would rebuild identical DOM ten times a second for the whole runtime
           of a film, which on a TV is the difference between smooth playback and
           a stutter every time a line is on screen. */
        var sig = visible.join(',') + '|' + Math.round(geo.w) + 'x' + Math.round(geo.h);
        if (sig === _sig) return;

        var zones = ensureZones();
        if (!zones) return;
        /* Recorded only once the frame can actually be built. Claiming it before
           ensureZones() meant that if the overlay host was momentarily missing,
           the frame counted as drawn and every later tick short-circuited on the
           equality check above — so a line stayed invisible for its whole
           duration instead of appearing on the next tick. */
        _sig = sig;

        _overlay.style.left   = geo.left + 'px';
        _overlay.style.top    = geo.top + 'px';
        _overlay.style.width  = geo.w + 'px';
        _overlay.style.height = geo.h + 'px';
        _geom = { w: geo.w, h: geo.h, sx: sx, sy: sy };

        for (var z = 0; z <= 9; z++) zones[z].innerHTML = '';
        var positioned = [];

        for (var v = 0; v < visible.length; v++) {
            var ev = events[visible[v]];
            var base = script.styles[ev.style] || script.styles.Default;
            var out = renderText(ev.text, base, script.styles, sy);
            if (!out.html) continue;

            var st = out.state;
            var line = document.createElement('div');
            line.className = 'ass-line';
            line.innerHTML = out.html;

            if (st.pos) {
                /* \pos gives the anchor point named by the alignment, so the box
                   is shifted off that point rather than hung from its top-left —
                   otherwise every centred sign sits half a line low and to the
                   right of where it belongs. */
                var align = st.align || base.align;
                var col = ((align - 1) % 3);          // 0 left, 1 centre, 2 right
                var row = Math.floor((align - 1) / 3); // 0 bottom, 1 middle, 2 top
                line.style.position = 'absolute';
                line.style.left = (st.pos[0] * sx) + 'px';
                line.style.top  = (st.pos[1] * sy) + 'px';
                line.style.textAlign = col === 0 ? 'left' : col === 1 ? 'center' : 'right';
                line.style.whiteSpace = 'nowrap';
                var tx = col === 0 ? '0' : col === 1 ? '-50%' : '-100%';
                var ty = row === 2 ? '0' : row === 1 ? '-50%' : '-100%';
                line.style.webkitTransform = 'translate(' + tx + ',' + ty + ')';
                line.style.transform       = 'translate(' + tx + ',' + ty + ')';
                positioned.push(line);
                continue;
            }

            /* Per-event margins override the style's when non-zero — that is
               exactly what the zero means in the format. */
            var mL = (ev.marginL || base.marginL) * sx;
            var mR = (ev.marginR || base.marginR) * sx;
            var mV = (ev.marginV || base.marginV) * sy;
            line.style.paddingLeft  = mL + 'px';
            line.style.paddingRight = mR + 'px';

            var a2 = st.align || base.align;
            var zone = zones[a2] || zones[2];
            if (a2 <= 3) {
                line.style.marginBottom = mV + 'px';
                /* Bottom cells stack UPWARD: the first simultaneous line sits
                   lowest. Normal flow puts the first child highest, so they go
                   in reversed. */
                zone.insertBefore(line, zone.firstChild);
            } else {
                if (a2 >= 7) line.style.marginTop = mV + 'px';
                zone.appendChild(line);
            }
        }

        for (var p = 0; p < positioned.length; p++) zones[0].appendChild(positioned[p]);
    }

    function startTimer() {
        if (_timer) return;
        _timer = setInterval(draw, TICK_MS);
    }

    function stopTimer() {
        if (_timer) { clearInterval(_timer); _timer = null; }
    }

    function clearOverlay() {
        _sig = '';
        if (!_overlay) return;
        _overlay.innerHTML = '';
        _zones = null;
    }

    /* ── Public surface ───────────────────────────────────────────────────── */

    /* `host` is where the overlay lives — #pip-wrap, the video's own parent, so
       the overlay shares its coordinate space and its fate when the page tears
       the player down. It sits below the OSD because pip-wrap comes first in
       document order and the OSD carries a z-index.

       Deliberately idempotent for the same video: subtitles arrive in waves —
       the play handover, then the panel lookup a moment later, then an
       OpenSubtitles download minutes in — and each wave calls this before
       adding. Resetting unconditionally would drop the earlier tracks (and the
       one currently on screen) every time a later one showed up. */
    function attach(video, host) {
        var target = video || null;
        if (_video && target === _video) {
            if (host && host !== _host) _host = host;
            return;
        }
        destroy();
        _video = target;
        _host  = host || (target && target.parentNode) || null;
    }

    /* Sidecars are registered without being fetched. A title can list half a
       dozen and the user will watch at most one, so the body is pulled the
       first time a track is actually selected — see show(). */
    function add(list) {
        if (!list || !list.length) return 0;
        var added = 0;
        for (var i = 0; i < list.length; i++) {
            var s = list[i];
            var url = s && (s.url || s.src || (typeof s === 'string' ? s : ''));
            if (!url && !(s && s.text)) continue;
            if (url) {
                var dup = false;
                for (var d = 0; d < _subs.length; d++) if (_subs[d].url === url) { dup = true; break; }
                if (dup) continue;
            }
            var lang = (s && (s.lang || s.language)) || '';
            _subs.push({
                url:   url || '',
                text:  (s && s.text) || '',
                lang:  lang,
                label: (s && s.label) ||
                       ((typeof Subs !== 'undefined' && Subs.langName(lang)) || '') ||
                       'Subtitles',
                script: null, failed: false
            });
            added++;
        }
        return added;
    }

    function list() {
        var out = [];
        for (var i = 0; i < _subs.length; i++) {
            out.push({ id: i, lang: _subs[i].lang, label: _subs[i].label });
        }
        return out;
    }

    function count() { return _subs.length; }

    function show(id) {
        var sub = _subs[id];
        if (!_video || !sub) return;
        var gen = ++_gen;
        _active = id;
        clearOverlay();
        startTimer();

        if (sub.script) { draw(); return; }
        if (sub.text) {
            sub.script = parseScript(sub.text);
            _note = 'ass: ' + sub.script.events.length + ' lines';
            draw();
            return;
        }
        if (typeof Net === 'undefined') { _note = 'ass: no network module'; return; }

        _note = 'ass: loading…';
        Net.text(sub.url, { timeout: 15000 }).then(function (text) {
            /* A newer pick (or a stop) landed while this was in flight. Applying
               it now would draw the wrong track over the right one. */
            if (gen !== _gen) return;
            if (!text) throw new Error('empty file');
            sub.script = parseScript(text);
            _note = 'ass: ' + sub.script.events.length + ' lines';
            if (!sub.script.events.length) _note = 'ass: file had no dialogue lines';
            draw();
        })['catch'](function (err) {
            if (gen !== _gen) return;
            sub.failed = true;
            _note = 'ass: load failed (' + ((err && err.message) || 'network error') + ')';
        });
    }

    function hide() {
        _gen++;                      // cancel anything still fetching
        _active = -1;
        stopTimer();
        clearOverlay();
    }

    function active() { return _active; }

    /* Same sign convention as the player's subtitle delay: positive means the
       subtitles appear later, so the script's clock is read behind the video's. */
    function setOffset(seconds) {
        _offset = isFinite(seconds) ? seconds : 0;
        _sig = '';                   // force a redraw at the new timing
        draw();
    }

    function destroy() {
        _gen++;
        _active = -1;
        stopTimer();
        if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
        _overlay = null;
        _zones = null;
        _subs = [];
        _sig = '';
        _geom = null;
    }

    /* One line for the GREEN diagnostics overlay — the same job data/subtitles.js
       does for the panel's reply. Without it, "the ASS track is selected and
       nothing is on screen" has three indistinguishable causes: the fetch
       failed, the file parsed to nothing, or it parsed fine and the geometry is
       wrong. */
    function describe() {
        if (!_subs.length) return 'none';
        var s = _subs.length + ' file' + (_subs.length === 1 ? '' : 's') +
                (_active >= 0 ? ', showing #' + (_active + 1) : ', none showing');
        if (_note)  s += '  |  ' + _note;
        if (_geom)  s += '  |  ' + Math.round(_geom.w) + 'x' + Math.round(_geom.h);
        return s;
    }

    return {
        isAss: isAss,
        attach: attach, add: add, list: list, count: count,
        show: show, hide: hide, active: active,
        setOffset: setOffset, destroy: destroy, describe: describe,
        /* Exported for the format work the player does before handing a file
           over — and so the parser can be exercised directly. */
        parse: parseScript
    };
}());
