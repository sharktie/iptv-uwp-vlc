/* player/codecs.js — naming things the stream only half-describes.
 *
 * Pure functions, no state, no DOM. They exist because the same three questions
 * come up all over the player and the answers must not drift:
 *
 *   • Is this codec one the TV is likely to refuse or play silently? (Dolby,
 *     HEVC — the two that produce "it plays but there's no sound/picture")
 *   • What should this track be CALLED in a menu, given the stream may supply a
 *     name, an ISO code, or nothing at all?
 *   • What does this MediaError actually mean, in words a person can act on?
 *
 * Language-code naming lives in data/subtitles.js and is delegated to, so the
 * audio menu and the subtitle menu can never disagree about what "nld" is.
 */

/* Helpers for human-readable playback diagnostics. */
function _esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function _mediaErrText(err) {
    if (!err) return "playback error";
    var map = { 1: "aborted", 2: "network error", 3: "decode error — codec not supported", 4: "format/codec not supported" };
    var t = map[err.code] || ("error " + err.code);
    if (err.message) t += " — " + err.message;
    return t;
}
function _isDolby(c) {
    c = (c || "").toLowerCase();
    return c.indexOf("ec-3") !== -1 || c.indexOf("ac-3") !== -1 ||
           c.indexOf("eac3") !== -1 || c.indexOf("ac3") !== -1 ||
           c.indexOf("mp4a.a5") !== -1 || c.indexOf("mp4a.a6") !== -1;
}
/* ── Track labelling ─────────────────────────────────────────────────────────
   Streams label tracks inconsistently: some give a name ("English Commentary"),
   some only an ISO code ("eng"), some nothing at all. The code→name table lives
   in data/subtitles.js, which needs the same mapping for the panel's subtitle
   list — one table, so the audio menu and the subtitle menu can never disagree
   about what "nld" is called. */
function _langName(code) {
    return (typeof Subs !== "undefined") ? Subs.langName(code)
                                         : (code ? String(code).toUpperCase() : "");
}

// Builds a human label, appending a Dolby hint when the codec suggests one so
// the user can spot the track that's likely to be silent on their TV.
function _trackLabel(name, lang, index, codec) {
    var base = (name && String(name).trim()) || _langName(lang) || ("Track " + (index + 1));
    if (codec && _isDolby(codec) && !/dolby|ac-?3/i.test(base)) base += " (Dolby)";
    return base;
}

function _isHevc(s) {
    s = (s || "").toLowerCase();
    return s.indexOf("hvc") !== -1 || s.indexOf("hev") !== -1 ||
           s.indexOf("h265") !== -1 || s.indexOf("hevc") !== -1 || s.indexOf("h.265") !== -1;
}
