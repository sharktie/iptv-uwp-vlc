/* vod.js — VOD startup.
 *
 * The page is assembled from the modules below, loaded in dependency order by
 * pages/vod.html:
 *
 *   vod/state.js     shared state, config aliases, DOM refs
 *   vod/library.js   Continue Watching + My List
 *   vod/cards.js     poster card and "see all" tile
 *   vod/rails.js     category rails, section switch
 *   vod/detail.js    title overlay, seasons/episodes, playback
 *   vod/category.js  full-category grid
 *   vod/search.js    library-wide search
 *   vod/nav.js       focus model, sidebar, key dispatcher
 *   vod.js           this file — boot
 *
 * Wrapped in a function purely so the guard clauses below can `return` out of
 * startup without a chain of else branches.
 */
'use strict';

(function boot() {
    /* ── Boot ────────────────────────────────────────────────────────── */
    if (!cfg) { showStatus('No server configured — open Settings first.', false); return; }
    if (cfg.type === 'm3u') { showStatus('VOD isn’t available for M3U playlists. Switch to an Xtream profile in Settings to browse movies & series.', false); return; }
    if (!cfg.server_url) { showStatus('No server configured — open Settings first.', false); return; }
    cardIndex = 0; railIndex = 0;
    zone = 'rails';
    _focusRailsAfterRender = true;   // land in the rails once content first renders
    loadType('movie');
}());
