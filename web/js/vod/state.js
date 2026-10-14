/* vod/state.js — the VOD page's shared state and the aliases every other
 * module uses.
 *
 * VOD is one screen assembled from several cooperating modules, and they
 * genuinely share state: which section is active decides what the rails render,
 * what the sidebar lists, and what a typed search looks through. Rather than
 * thread that through every call it lives here, the same arrangement Live TV
 * uses.
 *
 * Loaded FIRST of the vod modules — the DOM refs and the resolved config below
 * are read at load time by the modules that follow.
 */
'use strict';

/* ── Config + helpers ─────────────────────────────────────────────────
   Local aliases for the core modules. They read better at the density this
   file uses them, and they keep the call sites short enough to stay on one
   line, which most of the rendering code depends on for legibility. */
var cfg = Config.resolve();

/* The VOD caches used to be keyed by the server URL, which two accounts on one
   provider host share — so a second line saw the first one's category and
   content lists even though their packages differ. They are keyed by
   Config.scope() (host + username) now; this drops the entries left under the
   old URL-based names, which are unreachable dead weight in a store with a
   ~5 MB ceiling. The legacy names are the ones whose suffix starts with the
   URL scheme, so the new keys can never match these prefixes. */
(function purgeLegacyVodCaches() {
    try {
        var prefixes = ['vod_cats_movie_http', 'vod_cats_series_http', 'vod_content_http'];
        for (var i = 0; i < prefixes.length; i++) Store.removeByPrefix(prefixes[i]);
    } catch (e) {}
}());

function apiUrl(params)          { return Config.apiUrl(cfg, params); }
function buildMovieUrl(id, ext)  { return Config.movieUrl(cfg, id, ext); }
function buildEpisodeUrl(id, ext){ return Config.episodeUrl(cfg, id, ext); }
function cacheGet(key)           { return Store.cacheGet(key); }
function cacheSet(key, data)     { return Store.cacheSet(key, data); }
function fetchJSON(url)          { return Net.json(url); }
function fetchCached(key, url)   { return Net.cachedJSON(key, url); }

/* ── Category lists, slimmed before caching ──────────────────────────────
   Every rail caches its category's full list, and a panel's VOD objects
   carry two dozen fields — trailers, TMDB ids, backdrops, timestamps, flags —
   of which the cards and the detail view read a handful. Cached whole, a few
   dozen categories filled the ~5 MB store on their own, and from then on
   nothing else could be written: not the channel list, not the play
   handover, not resume positions. Only what is read is kept now, and the
   long free-text fields are capped. */
var VOD_KEEP = ['name', 'title', 'stream_id', 'series_id', 'stream_icon', 'cover', 'cover_big', 'icon',
                'container_extension', 'category_id', 'rating', 'rating_5based', 'year',
                'releaseDate', 'releasedate', 'genre', 'duration', 'director'];

function slimVodItem(m) {
    var out = {};
    if (!m || typeof m !== 'object') return out;
    for (var i = 0; i < VOD_KEEP.length; i++) {
        var v = m[VOD_KEEP[i]];
        if (v !== undefined && v !== null && v !== '') out[VOD_KEEP[i]] = v;
    }
    var plot = m.plot || m.description;
    if (plot) out.plot = String(plot).slice(0, 600);
    if (m.cast) out.cast = String(m.cast).slice(0, 300);
    if (!out.stream_icon && !out.cover && !out.cover_big) {
        var bd = Array.isArray(m.backdrop_path) ? m.backdrop_path[0] : m.backdrop_path;
        if (bd) out.cover = bd;
    }
    return out;
}

function fetchCachedList(key, url) {
    var hit = Store.cacheGet(key);
    if (hit) return Promise.resolve(hit);
    return fetchJSON(url).then(function (data) {
        var list = Array.isArray(data) ? data.map(slimVodItem) : [];
        Store.cacheSet(key, list);
        return list;
    });
}

function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


/* ── State ───────────────────────────────────────────────────────── */
var activeType = 'movie';
var hidden = {
    movie:  new Set((Store.get('iptv_hidden_cats_vod_m', []) || []).map(String)),
    series: new Set((Store.get('iptv_hidden_cats_vod_s', []) || []).map(String))
};
var cats = { movie: null, series: null };     // category arrays per type
/* Cards per rail before the "···" tile takes over. A rail is a preview, not
   a browser: past a dozen the D-pad journey to the end costs more than
   opening the category outright, and every extra card is a poster the TV
   decodes for a row nobody scrolls to the end of. */
var RAIL_CAP = 12;

/* ── DOM refs ────────────────────────────────────────────────────── */
var elRails    = document.getElementById('vod-rails');
var elStatus   = document.getElementById('vod-status');
var elStatusTx = document.getElementById('vod-status-text');
var elDetail   = document.getElementById('vod-detail');
var elSearch   = document.getElementById('vod-search-overlay');
var elSearchIn = document.getElementById('vod-search-input');
var elSearchGrid = document.getElementById('vod-search-grid');
var elCategory = document.getElementById('vod-category');
var elCategoryGrid = document.getElementById('vod-category-grid');


/* ── Status helpers ──────────────────────────────────────────────── */
function showStatus(text, spinner) {
    elStatus.style.display = 'flex';
    elStatusTx.textContent = text;
    elStatus.querySelector('.vod-spinner').style.display = spinner ? '' : 'none';
    elRails.style.display = 'none';
}
function hideStatus() { elStatus.style.display = 'none'; elRails.style.display = ''; }
