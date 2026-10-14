/* vod/category.js — every title in one category, as a grid.
 *
 * Reached from the "···" tile that ends a truncated rail. Reads the same cache
 * the rail filled, so opening it is instant and costs no extra request.
 */
'use strict';

/* ── Category browser ─────────────────────────────────────────────────
   Everything in one category, as a grid. Reached from the "···" tile that
   ends a truncated rail.

   It reads from the same cache the rail filled, so opening it is instant
   and costs no extra request — the full list was already fetched to decide
   the rail needed truncating in the first place. */
var catItems = [], catFocus = 0, catReturn = 'rails';

function openCategory(title, type, catId) {
    var ck = 'vod_content_' + Config.scope(cfg) + '_' + type + '_' + catId;
    var cached = cacheGet(ck);
    catReturn = zone;

    elCategory.hidden = false;
    document.getElementById('vod-category-title').textContent = title || 'Category';
    focusZone('category');

    if (cached && cached.length) { renderCategory(cached, type); return; }

    /* Cache miss (expired between painting the rail and opening it) —
       refetch rather than showing an empty grid. */
    elCategoryGrid.innerHTML = '<div class="vod-cat-loading">Loading…</div>';
    var action = type === 'series' ? 'get_series' : 'get_vod_streams';
    fetchCachedList(ck, apiUrl('action=' + action + '&category_id=' + encodeURIComponent(catId)))
        .then(function (data) {
            if (elCategory.hidden) return;                  // user left already
            renderCategory(Array.isArray(data) ? data : [], type);
        })
        .catch(function () {
            elCategoryGrid.innerHTML = '<div class="vod-cat-loading">Could not load this category.</div>';
        });
}

function renderCategory(items, type) {
    catItems = items;
    elCategoryGrid.innerHTML = '';
    document.getElementById('vod-category-count').textContent =
        items.length + (items.length === 1 ? ' title' : ' titles');

    var frag = document.createDocumentFragment();
    items.forEach(function (m) { frag.appendChild(makeCard(m, type)); });
    elCategoryGrid.appendChild(frag);
    catFocus = 0;
    paintCategoryFocus();
}

function closeCategory() {
    elCategory.hidden = true;
    elCategoryGrid.innerHTML = '';
    catItems = [];
    focusZone(catReturn === 'category' ? 'rails' : catReturn);
    if (zone === 'rails') paintRailFocus(); else paintSidebarFocus();
}

function categoryCards() { return Array.prototype.slice.call(elCategoryGrid.querySelectorAll('.vod-card')); }

/* Column count is measured from the rendered grid rather than assumed, so
   the same code works at every interface scale — the grid is responsive and
   a hardcoded column count would send the D-pad to the wrong row.

   Measured with offsetTop, NOT getBoundingClientRect(): the focused card is
   scaled up by its focus style, which moves its client rect a dozen pixels
   off its neighbours' and made the very first comparison fail — so this
   always returned 1 and every DOWN press moved a single card sideways
   instead of a row down. offsetTop is layout position and ignores
   transforms. */
function gridCols(cards) {
    if (cards.length < 2) return 1;
    var top = cards[0].offsetTop, n = 0;
    for (var i = 0; i < cards.length; i++) {
        if (cards[i].offsetTop !== top) break;
        n++;
    }
    return n || 1;
}

function categoryCols() { return gridCols(categoryCards()); }

function paintCategoryFocus() {
    clearRings();
    var cards = categoryCards();
    if (!cards.length) { document.getElementById('vod-category-back').classList.add('tv-focus-visible'); return; }
    catFocus = Math.max(0, Math.min(cards.length - 1, catFocus));
    cards[catFocus].classList.add('tv-focus-visible');
    cards[catFocus].scrollIntoView({ block: 'nearest' });
}

function categoryKey(kc) {
    var cards = categoryCards(), cols = categoryCols();
    if (kc === KEY.BACK) { closeCategory(); return; }
    if (kc === KEY.UP) {
        /* Off the top row lands on Back, which is the only other control up
           there — so UP always goes somewhere rather than dead-ending. */
        if (catFocus < cols) {
            clearRings();
            document.getElementById('vod-category-back').classList.add('tv-focus-visible');
            catFocus = -1;
        } else { catFocus -= cols; paintCategoryFocus(); }
    } else if (kc === KEY.DOWN) {
        if (catFocus < 0) { catFocus = 0; paintCategoryFocus(); }
        else { catFocus = Math.min(cards.length - 1, catFocus + cols); paintCategoryFocus(); }
    } else if (kc === KEY.LEFT) {
        if (catFocus > 0 && catFocus % cols !== 0) { catFocus--; paintCategoryFocus(); }
    } else if (kc === KEY.RIGHT) {
        if (catFocus >= 0 && catFocus < cards.length - 1) { catFocus++; paintCategoryFocus(); }
    } else if (kc === KEY.ENTER) {
        if (catFocus < 0) { closeCategory(); return; }   // Back is focused
        if (cards[catFocus]) cards[catFocus].click();
    }
}
