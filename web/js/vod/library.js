/* vod/library.js — the two lists the user builds themselves: Continue Watching
 * and My List.
 *
 * Continue Watching is derived, not stored: positions are written by the player
 * as it plays, and this reads them back, discarding anything barely started or
 * effectively finished. My List is explicit — a title is on it because someone
 * put it there.
 */
'use strict';

/* ── Resume / Continue Watching ──────────────────────────────────── */
var PROGRESS_KEY = 'vod_progress';
function loadProgress() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; } catch (e) { return {}; }
}
function continueWatching() {
    var p = loadProgress(), out = [];
    for (var k in p) {
        if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
        var e = p[k];
        if (!e || !e.dur || e.pos < 30) continue;            // ignore barely-started
        if (e.pos / e.dur > 0.95) continue;                  // ignore finished
        out.push(e);
    }
    out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return out.slice(0, 20);
}

/* ── My List (watchlist) ─────────────────────────────────────────── */
var WATCHLIST_KEY = 'vod_watchlist';
function loadWatchlist() { try { return JSON.parse(localStorage.getItem(WATCHLIST_KEY)) || []; } catch (e) { return []; } }
function saveWatchlist(w) { try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(w)); } catch (e) {} }
function wlKey(item) {
    var t = item.__type || (item.series_id ? 'series' : 'movie');
    return t + ':' + (t === 'series' ? item.series_id : item.stream_id);
}
function inWatchlist(item) {
    var k = wlKey(item), w = loadWatchlist();
    for (var i = 0; i < w.length; i++) if (w[i].key === k) return true;
    return false;
}
function toggleWatchlist(item) {
    var k = wlKey(item), w = loadWatchlist(), idx = -1;
    for (var i = 0; i < w.length; i++) if (w[i].key === k) { idx = i; break; }
    if (idx >= 0) { w.splice(idx, 1); }
    else {
        var t = item.__type || (item.series_id ? 'series' : 'movie');
        var entry = { key: k, __type: t, name: titleOf(item), ts: Date.now() };
        if (t === 'series') { entry.series_id = item.series_id; entry.cover = posterOf(item); }
        else { entry.stream_id = item.stream_id; entry.stream_icon = posterOf(item); }
        w.unshift(entry);
    }
    saveWatchlist(w);
    return idx < 0;   // true if it was just added
}
