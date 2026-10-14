/* vod/nav.js — the remote: focus model, sidebar, and the key dispatcher.
 *
 * Focus is a zone plus an index within it ("rails" + rail/card, "category" +
 * cell, and so on). Every screen that can be on top registers here rather than
 * binding its own key listener, so exactly one thing owns the remote at a time
 * and the overlay order in the dispatcher is the visual stacking order.
 */
'use strict';

/* ── D-pad navigation ────────────────────────────────────────────── */
var KEY = { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39, ENTER: 13, BACK: 461 };
var zone = 'rails', prevZone = 'rails';
var sidebarIndex = 1;                // 0 search, 1 movies, 2 series, 3 settings
var sidebarSub   = 'item';           // 'item' | 'star' — see sidebarStarFor()
var railIndex = 0, cardIndex = 0;
var detailFocus = 0;
var searchFocus = 0;
var _focusRailsAfterRender = false;

function focusZone(z) { zone = z; clearRings(); }
function clearRings() {
    document.querySelectorAll('.tv-focus-visible').forEach(function (el) { el.classList.remove('tv-focus-visible'); });
}

/* ── Sidebar (collapsible left nav + categories) ─────────────────── */
function sidebarEl() { return document.getElementById('vod-sidebar'); }
function navItems()  { return Array.prototype.slice.call(document.querySelectorAll('#vod-sidebar .vod-nav-item')); }
/* Focusable sidebar items = top sections + (when expanded) categories. */
function sidebarItems() {
    return Array.prototype.slice.call(document.querySelectorAll('#vod-sidebar .vod-nav-item, #vod-sidebar .vod-cat-item'))
        .filter(function (el) { return el.offsetParent !== null; });
}

/* Build the category list for the active section. Each row is a name plus a
   ★ that pins the whole category to the top of the rails — the same
   two-control shape as Live TV's sidebar, so the D-pad behaves identically
   on both screens. */
function renderSidebarCats() {
    var wrap = document.getElementById('vod-nav-cats');
    wrap.innerHTML = '';
    var list = (cats[activeType] || []).filter(function (c) {
        return !hidden[activeType].has(String(c.category_id));
    });
    if (!list.length) return;
    var head = document.createElement('div');
    head.className = 'vod-cat-header';
    head.textContent = 'Categories';
    wrap.appendChild(head);

    var favIds = Favourites.categories(activeType);
    list.sort(function (a, b) {
        var ia = favIds.indexOf(String(a.category_id));
        var ib = favIds.indexOf(String(b.category_id));
        if (ia === ib) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
    });

    list.forEach(function (c) {
        var id = String(c.category_id);
        var row = document.createElement('div');
        row.className = 'vod-cat-row';

        var b = document.createElement('button');
        b.className = 'vod-cat-item';
        b.dataset.catId = c.category_id;
        b.textContent = c.category_name || 'Unnamed';
        b.addEventListener('click', function () { jumpToCategory(c.category_id); });

        var star = document.createElement('button');
        star.className = 'vod-cat-star' + (Favourites.isCategory(activeType, id) ? ' active' : '');
        star.dataset.catId = id;
        star.textContent = '★';
        star.title = 'Pin this category to the top';
        star.addEventListener('click', function (e) {
            e.stopPropagation();
            Favourites.toggleCategory(activeType, id);
            /* Re-order both the rails and this list. renderRails() calls
               renderSidebarCats(), so the row this click came from is
               replaced — the caller re-paints the ring. */
            renderRails();
            if (zone === 'sidebar') paintSidebarFocus();
        });

        row.appendChild(b);
        row.appendChild(star);
        wrap.appendChild(row);
    });
}

/* Jump the rails to a given category and focus it. */
function jumpToCategory(catId) {
    collapseSidebar();
    focusZone('rails');
    var rails = railEls(), target = null, idx = 0;
    for (var i = 0; i < rails.length; i++) {
        if (rails[i].dataset.catId === String(catId)) { target = rails[i]; idx = i; break; }
    }
    if (target) {
        railIndex = idx; cardIndex = 0;
        ensureRailLoaded(target);
    }
    paintRailFocus();
    if (target) { try { target.scrollIntoView({ block: 'start' }); } catch (e) {} }
}

function openSidebar() {
    focusZone('sidebar');
    sidebarEl().classList.add('expanded');
    sidebarIndex = (activeType === 'series') ? 2 : 1;   // land on current section
    sidebarSub = 'item';
    paintSidebarFocus();
}
function collapseSidebar() { sidebarEl().classList.remove('expanded'); }
/* The ★ belonging to a sidebar row, or null for the top-level nav items
   (Search / Movies / Series / Settings) which have none. */
function sidebarStarFor(idx) {
    var el = sidebarItems()[idx];
    var row = el && el.closest ? el.closest('.vod-cat-row') : null;
    return row ? row.querySelector('.vod-cat-star') : null;
}

function paintSidebarFocus() {
    clearRings();
    var items = sidebarItems();
    if (!items.length) return;
    sidebarIndex = Math.max(0, Math.min(items.length - 1, sidebarIndex));
    var el = items[sidebarIndex];
    var star = sidebarSub === 'star' ? sidebarStarFor(sidebarIndex) : null;
    if (!star) sidebarSub = 'item';
    (star || el).classList.add('tv-focus-visible');
    el.scrollIntoView({ block: 'nearest' });
}
function activateNav(item) {
    if (!item) return;
    var action = item.dataset.action;
    if (action === 'search') { collapseSidebar(); openSearch(); }
    else if (action === 'settings') { window.location.href = '../pages/settings.html'; }
    else {
        collapseSidebar();
        if (action !== activeType) { _focusRailsAfterRender = true; focusZone('rails'); loadType(action); }
        else { focusZone('rails'); paintRailFocus(); }
    }
}

function railEls() { return Array.prototype.slice.call(elRails.querySelectorAll('.vod-rail')); }
function railCards(rail) { return rail ? Array.prototype.slice.call(rail.querySelectorAll('.vod-card:not(.vod-skeleton)')) : []; }
function paintRailFocus() {
    clearRings();
    var rails = railEls();
    if (!rails.length) { openSidebar(); return; }
    railIndex = Math.max(0, Math.min(rails.length - 1, railIndex));
    ensureRailLoaded(rails[railIndex]);     // focused rail may have been recycled
    ensureRailLoaded(rails[railIndex + 1]); // and the one DOWN lands on next
    var cards = railCards(rails[railIndex]);
    if (!cards.length) return;              // cards arrive async → fillRail repaints
    cardIndex = Math.max(0, Math.min(cards.length - 1, cardIndex));
    var card = cards[cardIndex];
    card.classList.add('tv-focus-visible');
    card.scrollIntoView({ block: 'nearest', inline: 'center' });
    rails[railIndex].scrollIntoView({ block: 'nearest' });
}

function detailItems() {
    var arr = [];
    var playBtn = document.getElementById('vod-play-btn');
    var listBtn = document.getElementById('vod-list-btn');
    if (playBtn.style.display !== 'none') arr.push(playBtn);
    if (listBtn) arr.push(listBtn);
    arr = arr.concat(Array.prototype.slice.call(document.querySelectorAll('#vod-season-tabs .vod-season-tab')));
    arr = arr.concat(Array.prototype.slice.call(document.querySelectorAll('#vod-episode-list .vod-ep-row')));
    return arr;
}
function paintDetailFocus() {
    clearRings();
    var items = detailItems();
    if (!items.length) return;
    detailFocus = Math.max(0, Math.min(items.length - 1, detailFocus));
    items[detailFocus].classList.add('tv-focus-visible');
    items[detailFocus].scrollIntoView({ block: 'nearest' });
}

function searchCards() { return Array.prototype.slice.call(elSearchGrid.querySelectorAll('.vod-card')); }
/* Same measurement — and the same transform trap — as the category grid. */
function searchCols() { return gridCols(searchCards()); }
function paintSearchFocus() {
    clearRings();
    var cards = searchCards();
    if (!cards.length) { elSearchIn.classList.add('tv-focus-visible'); return; }
    searchFocus = Math.max(0, Math.min(cards.length - 1, searchFocus));
    cards[searchFocus].classList.add('tv-focus-visible');
    cards[searchFocus].scrollIntoView({ block: 'nearest' });
}

window.addEventListener('keydown', function (e) {
    var kc = Dom.keyCode(e);   // also maps remotes that send only a named key

    /* When typing in the search box */
    if (document.activeElement === elSearchIn) {
        if (kc === KEY.DOWN) { e.preventDefault(); elSearchIn.blur(); paintSearchFocus(); }
        else if (kc === KEY.BACK) { e.preventDefault(); elSearchIn.blur(); closeSearch(); }
        return;
    }

    e.preventDefault();

    /* Detail overlay */
    if (!elDetail.hidden) {
        if (kc === KEY.BACK) { closeDetail(); return; }
        var di = detailItems();
        if (kc === KEY.DOWN) { detailFocus = Math.min(di.length - 1, detailFocus + 1); paintDetailFocus(); }
        else if (kc === KEY.UP) { if (detailFocus === 0) { closeDetail(); } else { detailFocus--; paintDetailFocus(); } }
        else if (kc === KEY.LEFT || kc === KEY.RIGHT) {
            // move between season tabs if focused on one
            var cur = di[detailFocus];
            if (cur && cur.classList.contains('vod-season-tab')) {
                var tabs = Array.prototype.slice.call(document.querySelectorAll('#vod-season-tabs .vod-season-tab'));
                var ti = tabs.indexOf(cur) + (kc === KEY.RIGHT ? 1 : -1);
                if (ti >= 0 && ti < tabs.length) { detailFocus = di.indexOf(tabs[ti]); paintDetailFocus(); }
            }
        } else if (kc === KEY.ENTER) { if (di[detailFocus]) di[detailFocus].click(); }
        return;
    }

    /* Category browser — below the detail overlay, since a title opened
       from the grid stacks on top of it. */
    if (!elCategory.hidden) { categoryKey(kc); return; }

    /* Search overlay */
    if (!elSearch.hidden) {
        if (kc === KEY.BACK) { closeSearch(); return; }
        var cards = searchCards(), cols = searchCols();
        if (kc === KEY.UP) {
            if (searchFocus < cols) { elSearchIn.classList.remove('tv-focus-visible'); elSearchIn.focus(); }
            else { searchFocus -= cols; paintSearchFocus(); }
        } else if (kc === KEY.DOWN) { searchFocus = Math.min(cards.length - 1, searchFocus + cols); paintSearchFocus(); }
        else if (kc === KEY.LEFT)  { if (searchFocus % cols !== 0) { searchFocus--; paintSearchFocus(); } }
        else if (kc === KEY.RIGHT) { searchFocus = Math.min(cards.length - 1, searchFocus + 1); paintSearchFocus(); }
        else if (kc === KEY.ENTER) { if (cards[searchFocus]) cards[searchFocus].click(); }
        return;
    }

    /* Sidebar */
    if (zone === 'sidebar') {
        if (kc === KEY.BACK)  { collapseSidebar(); history.back(); return; }
        var si = sidebarItems();
        if (kc === KEY.UP)        { sidebarIndex = Math.max(0, sidebarIndex - 1); paintSidebarFocus(); }
        else if (kc === KEY.DOWN) { sidebarIndex = Math.min(si.length - 1, sidebarIndex + 1); paintSidebarFocus(); }
        else if (kc === KEY.LEFT) {
            if (sidebarSub === 'star') { sidebarSub = 'item'; paintSidebarFocus(); }
        }
        else if (kc === KEY.RIGHT){
            /* Step onto the row's ★ before leaving for the rails — same
               rule as Live TV's sidebar. */
            if (sidebarSub !== 'star' && sidebarStarFor(sidebarIndex)) {
                sidebarSub = 'star'; paintSidebarFocus();
            } else {
                sidebarSub = 'item'; collapseSidebar(); focusZone('rails'); paintRailFocus();
            }
        }
        else if (kc === KEY.ENTER){
            if (sidebarSub === 'star') {
                var st = sidebarStarFor(sidebarIndex);
                if (st) st.click();       // re-renders and re-paints the ring
                return;
            }
            var it = si[sidebarIndex];
            if (it && it.className.indexOf('vod-cat-item') !== -1) jumpToCategory(it.dataset.catId);
            else activateNav(it);
        }
        return;
    }

    /* Rails */
    if (zone === 'rails') {
        if (kc === KEY.BACK) { openSidebar(); return; }
        var rails = railEls();
        if (kc === KEY.UP) {
            if (railIndex > 0) { railIndex--; ensureRailLoaded(rails[railIndex]); paintRailFocus(); }
        } else if (kc === KEY.DOWN) {
            if (railIndex < rails.length - 1) { railIndex++; ensureRailLoaded(rails[railIndex]); paintRailFocus(); }
        } else if (kc === KEY.LEFT) {
            if (cardIndex > 0) { cardIndex--; paintRailFocus(); }
            else { openSidebar(); }                 // LEFT at the first card opens the sidebar
        } else if (kc === KEY.RIGHT) { cardIndex++; paintRailFocus(); }
        else if (kc === KEY.ENTER) {
            var cards2 = railCards(rails[railIndex]);
            if (cards2[cardIndex]) cards2[cardIndex].click();
        }
        return;
    }
});

function ensureRailLoaded(rail) {
    if (rail && rail.dataset.loaded === '0') fillRail(rail);
}

/* ── Wire sidebar + overlays ─────────────────────────────────────── */
navItems().forEach(function (it) {
    it.addEventListener('click', function () {
        // a click also implies focus on that item
        sidebarIndex = navItems().indexOf(it);
        activateNav(it);
    });
});
document.getElementById('vod-detail-close').addEventListener('click', closeDetail);
document.getElementById('vod-search-close').addEventListener('click', closeSearch);
document.getElementById('vod-category-back').addEventListener('click', closeCategory);
