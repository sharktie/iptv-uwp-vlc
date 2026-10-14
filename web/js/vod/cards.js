/* vod/cards.js — the poster card, and the "see all" tile that ends a truncated
 * rail.
 *
 * Images load lazily through an IntersectionObserver and are UNobserved once
 * loaded; a rail that scrolls out of view has its cards destroyed entirely
 * (see rails.js), so a library of 20 000 posters never becomes 20 000 decoded
 * images in memory.
 */
'use strict';

/* ── Lazy image loader ───────────────────────────────────────────── */
var imgObserver = ('IntersectionObserver' in window)
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
            if (en.isIntersecting) {
                var img = en.target;
                if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
                imgObserver.unobserve(img);
            }
        });
    }, { rootMargin: '300px' })
    : null;

function lazyImg(img, src) {
    if (!src) return;
    if (imgObserver) { img.dataset.src = src; imgObserver.observe(img); }
    else { img.src = src; }
}

/* ── Card factory ────────────────────────────────────────────────── */
/* backdrop_path is an ARRAY of URLs on most panels' series entries; used as
   an image source directly it became "url1,url2" and never loaded. */
function posterOf(m) {
    var p = m.stream_icon || m.cover || m.cover_big || m.icon || m.backdrop_path || '';
    if (Array.isArray(p)) p = p[0] || '';
    return String(p);
}
function titleOf(m)  { return m.name || m.title || 'Untitled'; }
function yearOf(m)   { return String(m.year || m.releaseDate || m.releasedate || '').slice(0, 4); }
function ratingOf(m) { return parseFloat(m.rating || m.rating_5based || 0) || 0; }

function makeCard(item, kind) {
    var card = document.createElement('div');
    card.className = 'vod-card';
    card.tabIndex = -1;

    var poster = document.createElement('div');
    poster.className = 'vod-card-poster';
    var icon = posterOf(item);
    if (icon) {
        var img = document.createElement('img');
        img.alt = ''; img.decoding = 'async';
        img.onerror = function () { poster.classList.add('no-img'); poster.setAttribute('data-letter', titleOf(item).charAt(0)); if (img.parentNode) img.parentNode.removeChild(img); };
        lazyImg(img, icon);
        poster.appendChild(img);
    } else {
        poster.classList.add('no-img');
        poster.setAttribute('data-letter', titleOf(item).charAt(0));
    }

    // progress bar for continue-watching cards
    if (kind === 'progress' && item.dur) {
        var pb = document.createElement('div'); pb.className = 'vod-card-progress';
        var pf = document.createElement('div'); pf.className = 'vod-card-progress-fill';
        pf.style.width = Math.max(2, Math.min(100, (item.pos / item.dur) * 100)) + '%';
        pb.appendChild(pf); poster.appendChild(pb);
    }
    card.appendChild(poster);

    var label = document.createElement('div');
    label.className = 'vod-card-label';
    label.textContent = titleOf(item);
    card.appendChild(label);

    card.addEventListener('click', function () {
        if (kind === 'progress') resumePlay(item);
        else openDetail(item);
    });
    return card;
}

/* The tile that ends a truncated rail. Deliberately card-shaped and in the
   card flow rather than a link in the heading: the D-pad is already walking
   right along the row, so the way out of the row should be the next thing
   to the right — not something that needs a different key to reach. */
function makeMoreCard(title, type, catId, total) {
    var card = document.createElement('div');
    card.className = 'vod-card vod-card-more';
    card.tabIndex = -1;

    var poster = document.createElement('div');
    poster.className = 'vod-card-poster vod-more-poster';
    poster.appendChild(Dom.el('div.vod-more-dots', { text: '•••' }));
    poster.appendChild(Dom.el('div.vod-more-count', { text: 'All ' + total }));
    card.appendChild(poster);

    var label = document.createElement('div');
    label.className = 'vod-card-label';
    label.textContent = 'See all';
    card.appendChild(label);

    card.addEventListener('click', function () { openCategory(title, type, catId); });
    return card;
}

