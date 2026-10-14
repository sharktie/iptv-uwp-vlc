/* prewarm.js — refreshes the channel cache in the background while the user is
 * still on the homepage, so Live TV opens on a painted list instead of a
 * spinner. Loaded only by index.html, after the core modules.
 *
 * Only Xtream sources are prewarmed. An M3U playlist is a single large download
 * that the Live TV page handles on demand with its own cache, and starting it
 * here would compete with whatever the user is about to open.
 *
 * Everything is best-effort and silent: this is an optimisation, and a failure
 * must not produce a visible error on a screen the user did not ask anything of.
 */
(function () {
    'use strict';

    var CHANNEL_CACHE_KEY = 'iptv_ch_v2';
    var CAT_CACHE_KEY     = 'iptv_cat_v2';
    var CACHE_TTL_MS      = 4 * 60 * 60 * 1000;   // 4 hours — matches livetv/channels.js

    function run() {
        if (Config.sourceType() !== 'xtream') return;
        /* Already warm — cacheGet returns null once past the TTL. Reading it
           here (rather than a bespoke freshness check) means this file and the
           Live TV page can never disagree about what "still valid" means. */
        if (Store.cacheGet(CHANNEL_CACHE_KEY, CACHE_TTL_MS)) return;

        var cfg = Config.resolve();
        if (!cfg || cfg.type === 'm3u' || !cfg.server_url) return;

        Promise.all([
            Net.json(Config.apiUrl(cfg, 'action=get_live_streams'),    { timeout: 20000 }),
            Net.json(Config.apiUrl(cfg, 'action=get_live_categories'), { timeout: 20000 })
        ]).then(function (results) {
            var channels   = results[0];
            var categories = results[1];
            if (!Array.isArray(channels) || !channels.length) return;
            if (!Array.isArray(categories)) categories = [];

            /* Store the same slimmed shape livetv/channels.js writes. A full
               channel object carries a dozen fields nothing reads, and 20 000
               of them do not fit in the platform's storage quota. */
            var slim = channels.map(function (ch) {
                return {
                    stream_id:      ch.stream_id,
                    name:           ch.name,
                    category_id:    ch.category_id,
                    stream_icon:    ch.stream_icon    || '',
                    epg_channel_id: ch.epg_channel_id || ''
                };
            });

            Store.cacheSet(CHANNEL_CACHE_KEY, slim);
            Store.cacheSet(CAT_CACHE_KEY, categories);
        })['catch'](function () {});
    }

    /* Delayed so the homepage paints and the update check finishes first — a
       20 000-channel download starting during first paint is exactly the stall
       this file exists to prevent. The sweep goes first: it frees whatever
       yesterday's caches are still holding, so the refresh below has room. */
    setTimeout(function () {
        try { Store.sweep(); } catch (e) {}
        run();
    }, 4000);
}());
