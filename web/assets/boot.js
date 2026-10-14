/* boot.js — the only script that runs on EVERY page, blocking, in <head>.
 *
 * It lives in assets/ (not js/) on purpose: it must not depend on the Babel
 * build, and it must execute BEFORE first paint. Two jobs, both of which are
 * wrong if they happen a frame late:
 *
 *   1. Platform detection  — stamps capability classes on <html> so the
 *      stylesheets can branch on the TV's rendering pipeline. Deferring this
 *      would paint the PiP with the wrong compositing for one frame, which on
 *      old webOS is enough to lose the video plane for the whole session.
 *   2. Interface scale     — sets the root font-size. Every length in the app
 *      is rem, so this scales the whole UI in one shot. Deferring it flashes
 *      the entire interface at the wrong size on every navigation.
 *
 * Plain ES5, no dependencies — this runs ahead of polyfills.js.
 * Replaces the older ui-scale.js; window.UIScale is unchanged.
 */
(function () {
    'use strict';

    var docEl = document.documentElement;

    /* ══════════════════════════════════════════════════════════════════════
       Platform capabilities
       ══════════════════════════════════════════════════════════════════════
       webOS does not expose its own version to JavaScript, but the bundled
       Chromium does, and Chromium is what actually decides feature support:

           Chromium 38 → webOS 3.x      Chromium 79 → webOS 6.x
           Chromium 53 → webOS 4.x      Chromium 87 → webOS 22
           Chromium 68 → webOS 5.x      Chromium 94 → webOS 23

       Everything at Chromium 68 and below ("legacy") renders <video> on a
       hardware overlay plane punched through the page rather than compositing
       decoded frames into the page texture. That single fact drives most of
       the branching below — see VIDEO PLANE. */
    function chromiumVersion() {
        var m = /Chrome\/(\d+)/.exec(navigator.userAgent || '');
        return m ? parseInt(m[1], 10) : 0;
    }

    var WEBOS_BY_CHROMIUM = {
        38: '3.x', 53: '4.x', 68: '5.x', 79: '6.x', 87: '22', 94: '23', 108: '24', 120: '25'
    };

    var chromium = chromiumVersion();
    var isWebOS  = /Web0S|webOS/i.test(navigator.userAgent || '');
    /* Inside the Xbox / Windows app (WebView2). Video goes to VLC there, so
       none of the TV's video-plane limits apply; see js/platform/. */
    var isNative = !!(window.chrome && window.chrome.webview);

    /* webOS 1.x and 2.x predate Chromium entirely — their browser is WebKit
       (537/538) and the user agent carries no Chrome/ token at all. Those are
       the OLDEST sets, so "no Chromium version" on webOS means legacy, not
       modern; it used to fall through to the modern tier and get the rounded,
       clipped PiP that the hardware video plane can't display. */
    var preChromiumWebOS = isWebOS && !chromium;

    /* Off webOS, a missing/unparseable Chromium version means a desktop
       browser used for development, not an ancient TV — treat unknown as
       modern so testing isn't silently done against the legacy code paths. */
    var isLegacy = (chromium > 0 && chromium <= 68) || preChromiumWebOS;

    /* ── VIDEO PLANE ──────────────────────────────────────────────────────────
       On legacy webOS the decoder writes straight to a hardware overlay plane
       and the browser only punches a transparent hole in the page where the
       <video> box is. That hole is a plain axis-aligned rectangle: the plane
       cannot be rounded, cannot be clipped by an ancestor's overflow, and
       cannot be pulled into an ancestor's composited layer. When any of those
       is attempted the plane is simply not shown — the page paints its own
       (empty) black video box while the audio keeps playing, which is exactly
       the Live TV PiP symptom on webOS 5.40 and below.

       Modern webOS composites video like any other content and has none of
       these limits, so the constraint is scoped to the legacy tier only. */
    var videoPlaneOnly = isLegacy;

    /* How many <video> elements may decode at once. Legacy TVs have a single
       hardware decode pipeline plus, at best, one software fallback; asking
       for four kills every stream including the one that was already playing.
       Used by Multiview to size its grid. */
    var maxDecoders = isLegacy ? 2 : 4;

    /* ── PiP rendering override ───────────────────────────────────────────────
       Detection above is a rule of thumb about a closed platform, and there is
       no console on a retail TV to check it with. So the user can force it
       either way from Settings → Player:

         auto      trust the Chromium version (default)
         compat    always draw the PiP square and unclipped — fixes a black PiP
                   on a set the detection missed
         standard  always use the rounded, composited PiP — restores the nicer
                   look on an old set that turns out not to need compat

       Stored as a bare string, read here rather than through Store because this
       runs before the build output loads. */
    var PIP_MODE_KEY = 'iptv_pip_mode';
    var pipMode;
    try { pipMode = localStorage.getItem(PIP_MODE_KEY) || 'auto'; } catch (e) { pipMode = 'auto'; }
    if (pipMode !== 'compat' && pipMode !== 'standard') pipMode = 'auto';

    /* ── Flex gap ─────────────────────────────────────────────────────────────
       `gap` on a flex container only works from Chromium 84 — so not on webOS
       3, 4, 5 or 6 — and an unsupported gap is silently zero. The generated
       stylesheets (tools/build-css.js) carry margin equivalents scoped to
       html.no-flex-gap. Measured rather than inferred from the version: a
       two-child column with a 1px row-gap is 1px tall exactly when gap works. */
    function supportsFlexGap() {
        try {
            var probe = document.createElement('div');
            probe.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;' +
                                  'position:absolute;visibility:hidden';
            probe.appendChild(document.createElement('div'));
            probe.appendChild(document.createElement('div'));
            docEl.appendChild(probe);
            var ok = probe.scrollHeight === 1;
            docEl.removeChild(probe);
            return ok;
        } catch (e) {
            return chromium >= 84;
        }
    }
    var flexGap = supportsFlexGap();

    var classes = ['plat-chromium-' + (chromium || 'unknown')];
    if (isWebOS)        classes.push('plat-webos');
    if (isNative)       classes.push('plat-native');
    if (isLegacy)       classes.push('plat-legacy');
    else                classes.push('plat-modern');
    if (videoPlaneOnly) classes.push('plat-video-plane');
    if (!flexGap)       classes.push('no-flex-gap');
    if (pipMode !== 'auto') classes.push('pip-' + pipMode);

    docEl.className = (docEl.className ? docEl.className + ' ' : '') + classes.join(' ');

    /* What the stylesheet will actually do, after the override — this is the
       line Diagnostics shows, so it has to answer the real question ("is my PiP
       being drawn in compatibility mode?") and not just repeat the detection. */
    var pipCompatActive = pipMode === 'compat' || (pipMode === 'auto' && videoPlaneOnly);

    window.Platform = {
        chromium:       chromium,
        isWebOS:        isWebOS,
        isNative:       isNative,
        isLegacy:       isLegacy,
        videoPlaneOnly: videoPlaneOnly,
        maxDecoders:    maxDecoders,
        flexGap:        flexGap,
        webosVersion:   WEBOS_BY_CHROMIUM[chromium] || (preChromiumWebOS ? '1.x/2.x' : ''),
        PIP_MODE_KEY:   PIP_MODE_KEY,
        pipMode:        pipMode,
        pipCompatActive: pipCompatActive,
        /* Human-readable one-liner for Settings → Diagnostics. */
        describe: function () {
            if (preChromiumWebOS) return 'WebKit  ·  webOS 1.x/2.x';
            var s = chromium ? 'Chromium ' + chromium : 'Chromium unknown';
            if (WEBOS_BY_CHROMIUM[chromium]) s += '  ·  webOS ' + WEBOS_BY_CHROMIUM[chromium];
            else if (isWebOS) s += '  ·  webOS (unrecognised build)';
            return s;
        }
    };

    /* ══════════════════════════════════════════════════════════════════════
       Interface scale
       ══════════════════════════════════════════════════════════════════════
       Deliberately does NOT touch the video: the fullscreen overlay sizes
       #pip-wrap with 100%/100%, which is immune to the root font-size, so
       changing scale can never move or resize the video surface (and so can
       never disturb the decoder). */
    var KEY  = 'iptv_ui_scale';
    var BASE = 16;          // px — the reference every rem value was authored against
    var MIN  = 0.8;
    var MAX  = 2;
    var DEFAULT = 1.25;     // TVs are viewed from across the room; 100% reads small

    /* Ordered list for the Settings picker. `v` is the multiplier. */
    var SCALES = [
        { v: 1.00, label: 'Small',   note: '100%' },
        { v: 1.15, label: 'Medium',  note: '115%' },
        { v: 1.25, label: 'Large',   note: '125% (recommended)' },
        { v: 1.40, label: 'Larger',  note: '140%' },
        { v: 1.55, label: 'Largest', note: '155%' }
    ];

    function clean(v) {
        v = parseFloat(v);
        if (!(v >= MIN && v <= MAX)) return DEFAULT;
        return v;
    }

    function get() {
        var raw;
        try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
        return clean(raw);
    }

    /* The layout is authored for a TV browser's 1920×1080 page. Anywhere else
       — the Xbox app's page is 960×540, a desktop window is whatever it is —
       every rem is scaled by how much smaller the page is, so the screen looks
       the same as on the TV at the same Interface size. */
    function viewportFactor() {
        if (isWebOS) return 1;
        var w = window.innerWidth || 1920, h = window.innerHeight || 1080;
        var f = Math.min(w / 1920, h / 1080);
        return f > 0 ? f : 1;
    }

    function apply(v) {
        if (docEl && docEl.style) docEl.style.fontSize = (BASE * clean(v) * viewportFactor()) + 'px';
    }

    if (!isWebOS && window.addEventListener) {
        window.addEventListener('resize', function () { apply(get()); });
    }

    function set(v) {
        v = clean(v);
        try { localStorage.setItem(KEY, String(v)); } catch (e) {}
        apply(v);
        return v;
    }

    apply(get());

    /* ══════════════════════════════════════════════════════════════════════
       Page load timing
       ══════════════════════════════════════════════════════════════════════
       A retail TV has no developer console, so anything worth measuring has to
       be measured by the app and shown inside it. These numbers surface in
       Settings → Diagnostics and are what decides whether collapsing the app
       into a single page would pay off. */
    var TIMING_KEY = 'iptv_page_timings';

    function recordTiming() {
        try {
            var t = window.performance && window.performance.timing;
            if (!t || !t.navigationStart) return;
            var ready = t.domContentLoadedEventEnd - t.navigationStart;
            var full  = t.loadEventEnd - t.navigationStart;
            if (!(ready > 0)) return;

            var page = (window.location.pathname.split('/').pop() || 'index.html');
            var all;
            try { all = JSON.parse(localStorage.getItem(TIMING_KEY) || '{}') || {}; }
            catch (e) { all = {}; }
            all[page] = { ready: ready, full: full > 0 ? full : null, ts: Date.now() };
            localStorage.setItem(TIMING_KEY, JSON.stringify(all));
        } catch (e) {}
    }

    /* loadEventEnd is only final once load has actually finished, so defer a
       tick past it rather than reading a zero. */
    if (window.addEventListener) {
        window.addEventListener('load', function () { setTimeout(recordTiming, 0); }, false);
    }

    window.UIScale = {
        KEY: KEY, BASE: BASE, DEFAULT: DEFAULT, SCALES: SCALES, TIMING_KEY: TIMING_KEY,
        get: get, set: set, apply: apply
    };
}());
