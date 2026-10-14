/* player/preferences.js — which playback engine to try first.
 *
 * The player has three tiers (native / hls.js / native-on-TS) and normally
 * walks them in order. Two things reorder that walk, and both are ordering
 * HINTS only — every other tier is still tried if the preferred one fails, so a
 * stale preference can never dead-end playback on the error banner:
 *
 *   the global default   Settings -> Player. A blunt instrument for a TV where
 *                        one engine is reliably better.
 *   per-content memory   whatever actually reached 'playing' for THIS channel
 *                        or title last time. Beats the global default, because
 *                        a 4K/HEVC channel that only works on one tier
 *                        shouldn't cost two failed attempts every single time
 *                        it's opened.
 *
 * Kept as module-level values rather than static class fields, which are ES2022
 * and would need another Babel plugin on top of the Chrome 38 target.
 */

/* ── Engine preference (Settings → Player) ───────────────────────────────────
   Kept as plain module-level values rather than static class fields, which are
   ES2022 and would need an extra Babel plugin on top of the Chrome 38 target. */
var PLAYER_PREF_KEY  = "iptv_default_player";   // 'auto'|'native'|'hls'|'ts'|'last'
var PLAYER_LAST_KEY  = "iptv_last_player";      // kind RED last landed on
var PLAYER_MEM_KEY   = "iptv_engine_memory";    // { contentKey: kind }
// "vlc" / "vlc-sw": VLC with hardware / software decoding, in the Xbox / Windows app.
var PLAYER_ENGINES   = ["native", "hls", "ts", "vlc", "vlc-sw"];
var PLAYER_MEM_MAX   = 200;                     // entries before pruning oldest

/* ── Per-content engine memory ───────────────────────────────────────────────
   A channel that only plays on HLS shouldn't cost two failed tiers every single
   time it's opened. Whenever playback actually reaches 'playing', the engine
   that worked is recorded against the content key, and the next play of that
   same content starts there. Purely an ordering hint — every other tier is
   still tried if the remembered one stops working. */
function _engineMemory() {
    try { return JSON.parse(localStorage.getItem(PLAYER_MEM_KEY) || "{}") || {}; }
    catch (_) { return {}; }
}

function _rememberEngine(key, kind) {
    if (!key || PLAYER_ENGINES.indexOf(kind) === -1) return;
    try {
        var mem = _engineMemory();
        if (mem[key] === kind) return;                  // no write, no churn
        delete mem[key];                                // re-insert so it's newest
        mem[key] = kind;
        var keys = Object.keys(mem);
        // String keys enumerate in insertion order, so the front is the oldest.
        for (var i = 0; keys.length - i > PLAYER_MEM_MAX; i++) delete mem[keys[i]];
        localStorage.setItem(PLAYER_MEM_KEY, JSON.stringify(mem));
    } catch (_) {}
}

function _recalledEngine(key) {
    if (!key) return "";
    var kind = _engineMemory()[key];
    return PLAYER_ENGINES.indexOf(kind) !== -1 ? kind : "";
}

/* ── Per-title audio & subtitle memory ───────────────────────────────────────
   Track choices used to be remembered once, globally: one "preferred subtitle"
   and one "preferred audio language" for the whole app. That is the wrong shape
   for a library. A dubbed film and a subtitled one want opposite settings, and
   an anime episode with a Japanese track and English signs has nothing in
   common with the English-language film watched before it — so every title
   silently inherited the last one's choice, and turning subtitles off for one
   film turned them off for everything.

   So the choice is now keyed by TITLE (`m:<id>` / `e:<id>` — the same key
   Continue Watching uses), which is what makes "this series always in Japanese
   with subs" stick per series while leaving everything else alone.

   The old global keys are kept as a FALLBACK rather than dropped, and are still
   written on every pick. That is deliberate and not just migration cover: a
   title played for the first time has no memory of its own, and starting it
   from what the user reaches for everywhere else is a much better guess than
   starting it from the stream default. Per-title memory wins whenever it
   exists; the global is only consulted when it doesn't.

   ES5, and read defensively — a corrupt or full localStorage must degrade to
   "no memory", never to a player that won't start. */
var TRACK_MEM_KEY   = "vod_track_prefs";        // { contentKey: { sub, audio } }
var TRACK_SUB_KEY   = "vod_subs_pref";          // global fallback — subtitle label
var TRACK_AUDIO_KEY = "vod_audio_pref";         // global fallback — audio language
var TRACK_MEM_MAX   = 200;

function _trackMemory() {
    try { return JSON.parse(localStorage.getItem(TRACK_MEM_KEY) || "{}") || {}; }
    catch (_) { return {}; }
}

/* `what` is "sub" or "audio". Returns "" when nothing is remembered, which
   callers must treat as "leave the stream's own default alone" — never as a
   reason to guess. */
function _recalledTrack(key, what) {
    if (key) {
        var rec = _trackMemory()[key];
        if (rec && rec[what]) return String(rec[what]);
    }
    try {
        return localStorage.getItem(what === "sub" ? TRACK_SUB_KEY : TRACK_AUDIO_KEY) || "";
    } catch (_) { return ""; }
}

function _rememberTrack(key, what, value) {
    value = String(value === undefined || value === null ? "" : value);
    try {
        localStorage.setItem(what === "sub" ? TRACK_SUB_KEY : TRACK_AUDIO_KEY, value);
    } catch (_) {}
    if (!key) return;
    try {
        var mem = _trackMemory();
        var rec = mem[key] || {};
        if (rec[what] === value) return;                // no write, no churn
        rec[what] = value;
        delete mem[key];                                // re-insert so it's newest
        mem[key] = rec;
        var keys = Object.keys(mem);
        // String keys enumerate in insertion order, so the front is the oldest.
        for (var i = 0; keys.length - i > TRACK_MEM_MAX; i++) delete mem[keys[i]];
        localStorage.setItem(TRACK_MEM_KEY, JSON.stringify(mem));
    } catch (_) {}
}

// Resolves the stored preference to a `kind`, or "" meaning "use the automatic
// order" (native → hls → ts, the historical behaviour).
function _preferredEngine() {
    var pref, last;
    try {
        pref = localStorage.getItem(PLAYER_PREF_KEY) || "auto";
        last = localStorage.getItem(PLAYER_LAST_KEY) || "";
    } catch (_) { return ""; }
    if (pref === "last") return PLAYER_ENGINES.indexOf(last) !== -1 ? last : "";
    return PLAYER_ENGINES.indexOf(pref) !== -1 ? pref : "";
}
