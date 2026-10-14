/* core/store.js — every localStorage read and write in the app goes through
 * here. Exposes window.Store.
 *
 * Two reasons this exists rather than calling localStorage directly:
 *   • On webOS, localStorage throws rather than returning null in a handful of
 *     situations (quota exceeded, storage disabled by the platform, private
 *     contexts). An unguarded getItem is enough to kill a whole page, which is
 *     how Settings used to break on webOS 3. Everything here is try/catch'd and
 *     falls back to a caller-supplied default.
 *   • Half the keys hold JSON and half hold bare strings, and mixing the two up
 *     is a real bug we have hit: player.js reads `iptv_default_player` with a
 *     raw getItem, so settings.js writing it via JSON.stringify silently stored
 *     `"native"` (with quotes) and no engine ever matched. get/set are for JSON,
 *     getRaw/setRaw are for bare strings, and the distinction is now explicit at
 *     every call site.
 *
 * ES5 — Babel target is Chrome 38.                                            */
window.Store = (function () {
    'use strict';

    /* ── Making room ───────────────────────────────────────────────────────────
       The platform gives an app roughly 5 MB, and a large provider's channel
       list, guide and VOD category lists can each take a good share of it.
       Nothing used to free that space: a cache entry was only deleted when its
       OWN key was read after expiry, so VOD lists for categories nobody
       reopened sat there for good. Once the store was full every write failed
       silently — the channel list stopped caching (Live TV fetched it from
       scratch on every launch), and the play handover, resume positions and
       profile edits started being dropped too.

       Now a write that hits the quota evicts cache entries and retries. Caches
       go in order of how cheap they are to rebuild — guide data first, the
       live channel list last — and oldest first within each family. User data
       (profiles, favourites, progress) is never a candidate. */
    var CACHE_FAMILIES = [
        ['iptv_epg_v2', 'iptv_xmltv_cache'],                     // refetches in seconds
        ['vod_content_', 'cu_channels_', 'cu_cats_'],            // one category / one page
        ['vod_cats_'],
        ['iptv_m3u_v', 'iptv_ch_v2', 'iptv_cat_v2']              // the whole channel list
    ];
    /* Longer than any TTL in the app (XMLTV, at 24h, is the longest), so an
       entry older than this is dead weight whatever it is. */
    var STALE_MS = 26 * 60 * 60 * 1000;

    function familyOf(key) {
        for (var f = 0; f < CACHE_FAMILIES.length; f++) {
            for (var p = 0; p < CACHE_FAMILIES[f].length; p++) {
                if (key.indexOf(CACHE_FAMILIES[f][p]) === 0) return f;
            }
        }
        return -1;
    }

    /* Every cache entry starts {"ts":<ms>, … — JSON.stringify keeps key order —
       so the age is read off the front without parsing a multi-megabyte value. */
    function entryTs(key) {
        try {
            var m = /^\{"ts":(\d+)/.exec(String(localStorage.getItem(key) || '').slice(0, 32));
            return m ? +m[1] : 0;
        } catch (e) { return 0; }
    }

    /* A cache write may only displace caches that are as cheap or cheaper to
       rebuild than itself (plus anything stale) — otherwise one oversized guide
       that could never fit would wipe the channel list on its way to failing.
       User data may displace any cache. */
    function evictionOrder(except) {
        var all = keys(), list = [];
        var own = familyOf(except);
        var stale = Date.now() - STALE_MS;
        for (var i = 0; i < all.length; i++) {
            var k = all[i];
            if (!k || k === except) continue;
            var fam = familyOf(k);
            if (fam === -1) continue;
            var ts = entryTs(k);
            if (own !== -1 && fam > own && ts >= stale) continue;
            list.push({ key: k, fam: fam, ts: ts });
        }
        list.sort(function (a, b) {
            var sa = a.ts < stale ? 0 : 1, sb = b.ts < stale ? 0 : 1;   // stale first
            if (sa !== sb) return sa - sb;
            if (a.fam !== b.fam) return a.fam - b.fam;
            return a.ts - b.ts;
        });
        return list;
    }

    function write(key, str) {
        try { localStorage.setItem(key, str); return true; } catch (e) {}
        var victims = evictionOrder(key);
        for (var i = 0; i < victims.length; i++) {
            remove(victims[i].key);
            try { localStorage.setItem(key, str); return true; } catch (e2) {}
        }
        return false;
    }

    /* Drops cache entries past any TTL. Run once per launch from the homepage
       (prewarm.js), so space is reclaimed before anything needs it rather than
       only when a write has already failed. */
    function sweep() {
        var stale = Date.now() - STALE_MS, n = 0, all = keys();
        for (var i = 0; i < all.length; i++) {
            if (!all[i] || familyOf(all[i]) === -1) continue;
            if (entryTs(all[i]) < stale) { remove(all[i]); n++; }
        }
        return n;
    }

    /* Every cache the app keeps, for Settings → "Clear cache". */
    function clearCaches() {
        var all = keys(), n = 0;
        for (var i = 0; i < all.length; i++) {
            if (all[i] && familyOf(all[i]) !== -1) { remove(all[i]); n++; }
        }
        return n;
    }

    /* ── Bare strings ─────────────────────────────────────────────────────── */
    function getRaw(key, fallback) {
        try {
            var v = localStorage.getItem(key);
            return v === null || v === undefined ? (fallback || '') : v;
        } catch (e) { return fallback || ''; }
    }
    function setRaw(key, value) {
        return write(key, String(value));
    }

    /* ── JSON values ──────────────────────────────────────────────────────── */
    function get(key, fallback) {
        try {
            var v = localStorage.getItem(key);
            return v !== null && v !== undefined ? JSON.parse(v) : fallback;
        } catch (e) { return fallback; }
    }
    function set(key, value) {
        var str;
        try { str = JSON.stringify(value); } catch (e) { return false; }
        return write(key, str);
    }
    function remove(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    }
    function removeAll(keys) {
        for (var i = 0; i < keys.length; i++) remove(keys[i]);
    }

    /* ── Time-bounded cache ───────────────────────────────────────────────────
       A cache entry is { ts, data }. Reading an expired entry deletes it, so a
       stale blob can never sit in a nearly-full store keeping a fresh write
       out. TTLs are per-call because they differ wildly: channel lists are good
       for hours, EPG for half an hour. */
    var DEFAULT_TTL = 5 * 60 * 60 * 1000;   // 5h

    function cacheGet(key, ttl) {
        var entry = get(key, null);
        if (!entry || typeof entry.ts !== 'number') return null;
        if (Date.now() - entry.ts > (ttl || DEFAULT_TTL)) { remove(key); return null; }
        return entry.data;
    }
    function cacheSet(key, data) {
        return set(key, { ts: Date.now(), data: data });
    }
    /* Age of a cache entry in ms, or -1 when there isn't one. Used by the
       diagnostics panel, which wants to report staleness without evicting. */
    function cacheAge(key) {
        var entry = get(key, null);
        return (entry && typeof entry.ts === 'number') ? Date.now() - entry.ts : -1;
    }

    /* ── Housekeeping ─────────────────────────────────────────────────────── */
    function keys() {
        var out = [];
        try {
            for (var i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
        } catch (e) {}
        return out;
    }

    /* Approximate bytes used. Reported in Settings → Diagnostics: when a TV
       starts dropping caches it is almost always because this is near the
       platform's ~5 MB ceiling. */
    function bytesUsed() {
        var total = 0, all = keys();
        for (var i = 0; i < all.length; i++) {
            total += all[i].length + getRaw(all[i], '').length;
        }
        return total;
    }

    /* Drop every key matching a prefix — used when switching profiles, where
       leaving another server's channel and VOD caches behind shows one
       account's content under another's credentials. */
    function removeByPrefix(prefix) {
        var all = keys(), n = 0;
        for (var i = 0; i < all.length; i++) {
            if (all[i] && all[i].indexOf(prefix) === 0) { remove(all[i]); n++; }
        }
        return n;
    }

    return {
        get: get, set: set, remove: remove, removeAll: removeAll,
        getRaw: getRaw, setRaw: setRaw,
        cacheGet: cacheGet, cacheSet: cacheSet, cacheAge: cacheAge,
        DEFAULT_TTL: DEFAULT_TTL,
        keys: keys, bytesUsed: bytesUsed, removeByPrefix: removeByPrefix,
        sweep: sweep, clearCaches: clearCaches
    };
}());
