/* vod/rails.js — the horizontal category rows, and the section switch between
 * Movies and Series.
 *
 * Rails recycle. An IntersectionObserver fills the ones near the viewport and
 * empties the ones far from it, keeping their height so nothing jumps. Each
 * shows the first dozen titles and then hands off to the category browser,
 * because past a dozen the D-pad journey costs more than opening the category.
 */
'use strict';

/* ── Rails ───────────────────────────────────────────────────────── */
/* Recycling observer: loads rails near the viewport and UNLOADS rails that
   scroll far away (clears their cards + images but keeps the row height) so
   the DOM/memory stay bounded no matter how many categories exist. */
var railObserver = ('IntersectionObserver' in window)
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
            if (en.isIntersecting) ensureRailLoaded(en.target);
            else                   unloadRail(en.target);
        });
    }, { root: elRails, rootMargin: '900px 0px' })
    : null;

/* The IntersectionObserver stand-in for webOS 3/4: fill any rail within a
   screen of the visible area. Called on scroll and after the focus moves, so
   the D-pad (which scrolls by focusing) and the pointer both reach it. */
var RAIL_NEAR_PX = 900;
function loadRailsNearView() {
    if (railObserver) return;
    var box = elRails.getBoundingClientRect();
    var top = box.top - RAIL_NEAR_PX, bottom = box.bottom + RAIL_NEAR_PX;
    var rails = railEls();
    for (var i = 0; i < rails.length; i++) {
        var r = rails[i].getBoundingClientRect();
        if (r.bottom < top) continue;
        if (r.top > bottom) break;
        if (rails[i].dataset.loaded === '0') fillRail(rails[i]);
    }
}
if (!railObserver) {
    var _railScrollTimer = null;
    elRails.addEventListener('scroll', function () {
        clearTimeout(_railScrollTimer);
        _railScrollTimer = setTimeout(loadRailsNearView, 150);
    });
}

function unloadRail(rail) {
    if (!rail || rail.dataset.loaded !== '1' || rail.dataset.keep === '1') return;
    var rails = railEls();
    if (rails[railIndex] === rail) return;          // never unload the focused rail
    var track = rail.querySelector('.vod-rail-track');
    if (track) {
        if (imgObserver) track.querySelectorAll('img[data-src]').forEach(function (img) { imgObserver.unobserve(img); });
        track.innerHTML = '';
    }
    rail.dataset.loaded = '0';
}

function makeRail(titleText, type, catId) {
    var rail = document.createElement('section');
    rail.className = 'vod-rail';
    rail.dataset.type = type || '';
    rail.dataset.catId = catId == null ? '' : catId;
    rail.dataset.loaded = '0';

    var h = document.createElement('h2');
    h.className = 'vod-rail-title';
    h.textContent = titleText;
    rail.appendChild(h);

    var track = document.createElement('div');
    track.className = 'vod-rail-track';
    rail.appendChild(track);
    return rail;
}

function fillRail(rail) {
    if (rail.dataset.loaded !== '0') return;
    rail.dataset.loaded = '1';
    var type = rail.dataset.type, catId = rail.dataset.catId;
    var track = rail.querySelector('.vod-rail-track');
    var action = type === 'series' ? 'get_series' : 'get_vod_streams';
    var ck = 'vod_content_' + Config.scope(cfg) + '_' + type + '_' + catId;
    var url = apiUrl('action=' + action + '&category_id=' + encodeURIComponent(catId));

    // skeleton shimmer while loading
    for (var s = 0; s < 6; s++) { var sk = document.createElement('div'); sk.className = 'vod-card vod-skeleton'; track.appendChild(sk); }

    fetchCachedList(ck, url).then(function (data) {
        track.innerHTML = '';
        var items = Array.isArray(data) ? data : [];
        if (!items.length) { rail.parentNode && rail.parentNode.removeChild(rail); return; }
        var n = Math.min(items.length, RAIL_CAP);
        var frag = document.createDocumentFragment();
        for (var i = 0; i < n; i++) frag.appendChild(makeCard(items[i], type));
        /* Only worth offering when it leads somewhere new — a category of
           exactly 12 would give a "see all" that shows the same 12. */
        if (items.length > n) {
            frag.appendChild(makeMoreCard(rail.querySelector('.vod-rail-title').textContent,
                                          type, catId, items.length));
        }
        track.appendChild(frag);
        /* If the user is already sitting on this rail, paint focus now that
           cards exist (lazy load may finish after they navigated here). */
        if (zone === 'rails' && railEls()[railIndex] === rail) paintRailFocus();
    }).catch(function () {
        rail.parentNode && rail.parentNode.removeChild(rail);
    });
}

function renderRails() {
    elRails.innerHTML = '';
    railIndex = 0; cardIndex = 0;

    // Continue Watching first (never recycled)
    var cw = continueWatching();
    if (cw.length) {
        var cwRail = makeRail('Continue Watching', '', '');
        cwRail.dataset.loaded = '1';
        cwRail.dataset.keep = '1';
        var track = cwRail.querySelector('.vod-rail-track');
        cw.forEach(function (e) { track.appendChild(makeCard(e, 'progress')); });
        elRails.appendChild(cwRail);
    }

    // My List (saved titles, both types)
    var wl = loadWatchlist();
    if (wl.length) {
        var wlRail = makeRail('My List', '', '');
        wlRail.dataset.loaded = '1';
        wlRail.dataset.keep = '1';
        var wtrack = wlRail.querySelector('.vod-rail-track');
        wl.forEach(function (e) { wtrack.appendChild(makeCard(e, e.__type)); });
        elRails.appendChild(wlRail);
    }

    /* Starred categories float to the top, in the order they were starred,
       and keep their star in the title so it's obvious why they're there
       and how to undo it. Everything else follows in the provider's order.
       This is the whole payoff of favouriting a category on a TV: the two
       rails you actually watch are the first thing on screen instead of
       being 30 rails down. */
    var visible = (cats[activeType] || []).filter(function (c) {
        return !hidden[activeType].has(String(c.category_id));
    });
    var favIds = Favourites.categories(activeType);
    var list = visible.slice().sort(function (a, b) {
        var ia = favIds.indexOf(String(a.category_id));
        var ib = favIds.indexOf(String(b.category_id));
        if (ia === ib) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });

    list.forEach(function (c, i) {
        var isFavCat = Favourites.isCategory(activeType, c.category_id);
        var rail = makeRail((isFavCat ? '★  ' : '') + (c.category_name || 'Unnamed'),
                            activeType, c.category_id);
        elRails.appendChild(rail);
        if (railObserver) railObserver.observe(rail);   // observer handles load + unload
        /* Eager top rails for instant paint. Without IntersectionObserver
           (webOS 3 and 4) this used to load EVERY rail up front — one
           get_vod_streams per category, all at once: hundreds of parallel
           requests on a large panel, every list cached into a storage quota
           it could never fit. Those TVs now load rails as they come near the
           screen instead; see loadRailsNearView(). */
        if (i < 3) fillRail(rail);
    });

    if (!list.length && !cw.length) showStatus('Nothing here yet.', false);
    else hideStatus();
    loadRailsNearView();    /* no-op where IntersectionObserver does this job */
    renderSidebarCats();    /* keep the sidebar category list in sync */
    /* After a (re)render from boot or a section switch, drop focus into the
       rails. Otherwise leave focus where it is (e.g. sidebar open). */
    if (_focusRailsAfterRender) {
        _focusRailsAfterRender = false;
        focusZone('rails');
        paintRailFocus();
    }
}

/* ── Category load + section switch ──────────────────────────────── */
function loadType(type) {
    activeType = type;
    document.querySelectorAll('.vod-nav-item').forEach(function (t) {
        if (t.dataset.action === 'movie' || t.dataset.action === 'series')
            t.classList.toggle('active', t.dataset.action === type);
    });
    if (cats[type]) { renderRails(); return; }
    showStatus('Loading…', true);
    var action = type === 'series' ? 'get_series_categories' : 'get_vod_categories';
    var ck = (type === 'series' ? 'vod_cats_series_' : 'vod_cats_movie_') + Config.scope(cfg);
    fetchCached(ck, apiUrl('action=' + action)).then(function (data) {
        cats[type] = Array.isArray(data) ? data : [];
        renderRails();
    }).catch(function () {
        cats[type] = [];
        showStatus('Could not load categories.', false);
    });
}
