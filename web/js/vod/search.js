/* vod/search.js — search across the whole library.
 *
 * The catalogue can be tens of thousands of titles, so fetching, indexing and
 * filtering it on the main thread freezes the app. All of that goes to a Web
 * Worker; where Workers are unusable the fallback is a slim pre-lower-cased
 * index with early-exit filtering. Either way what is held is an index, not the
 * full objects.
 */
'use strict';

/* ── Global search (Web Worker, main-thread fallback) ─────────────────
   The whole movie + series catalog can be tens of thousands of titles, so
   fetching + indexing + filtering it on the main thread freezes the app. We
   offload all of that to a worker; if Workers aren't usable on a given TV we
   fall back to a slim in-memory index with early-exit filtering. Either way
   the data is a pre-lower-cased index, not the full objects.                */
var SEARCH_LIMIT = 40, SEARCH_MIN = 2;
var searchTimer = null, searchReqId = 0;
var searchWorker = null, searchReady = false, searchUseWorker = false;
var searchIndex = null;        // main-thread fallback index

function openSearch() {
    prevZone = zone;
    elSearch.hidden = false;
    elSearchGrid.innerHTML = '';
    elSearchIn.value = '';
    var hint = document.getElementById('vod-search-hint');
    hint.style.display = ''; hint.textContent = 'Type to search your whole library.';
    focusZone('search');
    setTimeout(function () { elSearchIn.focus(); }, 30);
    initSearchEngine();
}
function closeSearch() {
    elSearch.hidden = true;
    elSearchIn.blur();
    focusZone('rails');
    paintRailFocus();
}

function initSearchEngine() {
    if (searchWorker || searchIndex) return;     // already initialised
    var movieUrl  = apiUrl('action=get_vod_streams');
    var seriesUrl = apiUrl('action=get_series');
    try {
        if (typeof Worker === 'undefined') throw new Error('no worker');
        searchWorker = new Worker('../js/vod-search-worker.js');
        searchUseWorker = true;
        searchWorker.onmessage = function (ev) {
            var d = ev.data || {};
            if (d.cmd === 'ready') { searchReady = true; if (!elSearch.hidden) runSearch(); }
            else if (d.cmd === 'results') {
                if (d.reqId !== searchReqId) return;   // a newer query superseded this
                renderSearchResults(d.items, d.q, d.ready);
            }
        };
        searchWorker.onerror = function () { searchWorker = null; searchUseWorker = false; initFallbackSearch(movieUrl, seriesUrl); };
        searchWorker.postMessage({ cmd: 'load', movieUrl: movieUrl, seriesUrl: seriesUrl });
    } catch (e) {
        initFallbackSearch(movieUrl, seriesUrl);
    }
}

function buildIndexInto(idx, arr, type) {
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i++) {
        var m = arr[i], id = type === 'series' ? m.series_id : m.stream_id;
        if (id === undefined || id === null) continue;
        var nm = m.name || m.title || '';
        idx.push({ id: id, type: type, name: nm, lc: nm.toLowerCase(),
                   icon: m.stream_icon || m.cover || m.cover_big || m.icon || '' });
    }
}
function initFallbackSearch(movieUrl, seriesUrl) {
    if (searchIndex) return;
    searchIndex = [];
    var pending = 2;
    function done() { pending--; if (pending === 0) { searchReady = true; if (!elSearch.hidden) runSearch(); } }
    fetchJSON(movieUrl).then(function (d) { buildIndexInto(searchIndex, d, 'movie'); done(); }).catch(done);
    fetchJSON(seriesUrl).then(function (d) { buildIndexInto(searchIndex, d, 'series'); done(); }).catch(done);
}
function mainThreadSearch(q) {
    q = q.toLowerCase();
    var out = [];
    for (var i = 0; i < searchIndex.length && out.length < SEARCH_LIMIT; i++) {
        var it = searchIndex[i];
        if (it.lc.indexOf(q) === -1) continue;
        if (it.type === 'series') out.push({ series_id: it.id, name: it.name, cover: it.icon, __type: 'series' });
        else                      out.push({ stream_id: it.id, name: it.name, stream_icon: it.icon, __type: 'movie' });
    }
    return out;
}

function runSearch() {
    var q = elSearchIn.value.trim();
    var hint = document.getElementById('vod-search-hint');
    if (q.length < SEARCH_MIN) {
        elSearchGrid.innerHTML = '';
        hint.style.display = ''; hint.textContent = 'Type at least ' + SEARCH_MIN + ' characters to search.';
        return;
    }
    searchReqId++;
    if (searchUseWorker && searchWorker) {
        searchWorker.postMessage({ cmd: 'search', q: q, limit: SEARCH_LIMIT, reqId: searchReqId });
    } else if (searchIndex) {
        renderSearchResults(mainThreadSearch(q), q.toLowerCase(), searchReady);
    } else {
        hint.style.display = ''; hint.textContent = 'Preparing search…';
    }
}

function renderSearchResults(items, q, ready) {
    var hint = document.getElementById('vod-search-hint');
    elSearchGrid.innerHTML = '';
    if (!items || !items.length) {
        hint.style.display = '';
        hint.textContent = ready ? ('No results for "' + q + '".') : 'Preparing search…';
        return;
    }
    hint.style.display = 'none';
    var frag = document.createDocumentFragment();
    items.forEach(function (m) { frag.appendChild(makeCard(m, m.__type)); });
    elSearchGrid.appendChild(frag);
    searchFocus = 0;
}

elSearchIn.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
});
