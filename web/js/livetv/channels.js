/* livetv/channels.js — the channel list: cache, filtering, and the virtual
 * scroller that renders it.
 *
 * The list can be 20 000 rows. Rendering all of them is not an option on a TV,
 * so only the visible window plus a small overscan exists in the DOM at any
 * moment, positioned absolutely by index. Rows are also cached by stream id and
 * reused as they scroll back in, because rebuilding a row means re-decoding its
 * logo.
 *
 * Requires: livetv/state.js, data/favourites.js, livetv/epg.js (for the strips).
 */

// ── Channel cache ─────────────────────────────────────────────────────────────

const CHANNEL_CACHE_KEY = "iptv_ch_v2";
const CAT_CACHE_KEY     = "iptv_cat_v2";
const CACHE_TTL_MS      = 4 * 60 * 60 * 1000;

function loadChannelCache() { return Store.cacheGet(CHANNEL_CACHE_KEY, CACHE_TTL_MS); }
function loadCatCache()     { return Store.cacheGet(CAT_CACHE_KEY, CACHE_TTL_MS); }

// A provider's channel object carries a dozen fields nothing here reads. With
// 20 000 channels that difference is the whole storage quota, so only what the
// list and the guide actually use is kept.
function _slimChannels(channels, withEpgId) {
    return channels.map(ch => {
        const slim = { stream_id: ch.stream_id, name: ch.name, category_id: ch.category_id, stream_icon: ch.stream_icon || "" };
        if (withEpgId) slim.epg_channel_id = ch.epg_channel_id || "";
        return slim;
    });
}

function saveChannelCache(channels, categories) {
    if (Store.cacheSet(CHANNEL_CACHE_KEY, _slimChannels(channels, true))) {
        Store.cacheSet(CAT_CACHE_KEY, categories);
        return;
    }
    // Over quota. The guide is the cheapest thing to lose — it refetches in
    // seconds — so drop it and retry without the EPG ids, which are only used
    // for XMLTV matching and are dead weight for anyone not using XMLTV.
    Store.remove(epgCacheKey());
    Store.cacheSet(CHANNEL_CACHE_KEY, _slimChannels(channels, false));
    Store.cacheSet(CAT_CACHE_KEY, categories);
}


// ── Virtual scroll ────────────────────────────────────────────────────────────

// Row height drives every virtual-scroll offset here and the scroll maths in
// dpad.js, so it must equal the rendered height of a .tl-row. --row-h is in rem
// and therefore changes with the user's interface scale, so measure it rather
// than hardcoding: getComputedStyle on a custom property returns the raw "6rem"
// token (custom properties aren't resolved), so use a throwaway probe element
// and let the engine do the unit conversion. Falls back to the 100%-scale value.
let VS_ROW_H      = 96;
const VS_OVERSCAN = 5;

function measureRowHeight() {
    try {
        const probe = document.createElement("div");
        /* The plain 6rem first: an engine without custom properties (webOS 3)
           drops the var() declaration and keeps it, so the probe still
           measures the row at the current interface scale instead of 0 —
           which left VS_ROW_H at the 100%-scale 96px while every row was
           drawn 120px tall, and the list drifted further off with each row. */
        probe.style.cssText = "position:absolute;visibility:hidden;height:6rem;height:var(--row-h)";
        document.body.appendChild(probe);
        const h = probe.offsetHeight;
        document.body.removeChild(probe);
        if (h > 0) VS_ROW_H = h;
    } catch (_) {}
    return VS_ROW_H;
}

let _vsChannels   = [];
let _vsScrollTop  = 0;
let _vsHeight     = 0;
let _vsRafPending = false;

function initVirtualScroll() {
    const wrap = document.getElementById("channel-list-wrap");
    wrap.addEventListener("scroll", () => {
        _vsScrollTop = wrap.scrollTop;
        if (!_vsRafPending) {
            _vsRafPending = true;
            requestAnimationFrame(() => { _vsRafPending = false; _vsRender(); });
        }
        // The guide is fetched for the rows around the viewport only, so a
        // scroll is what asks for the next stretch of it. Debounced: holding
        // DOWN through a long list must not fire a request per row.
        scheduleEpgWindowLoad();
    }, { passive: true });
    _vsHeight = wrap.clientHeight || window.innerHeight * 0.55;
}

/* Adopt the wrap's real scroll position and render immediately. The scroll
   LISTENER above defers to a rAF, which is right for scrolling but a frame too
   late for a caller that just jumped the list and needs the target row to exist
   now (see scrollTVRowIntoView in dpad.js). */
function _vsSyncScroll() {
    const wrap = document.getElementById("channel-list-wrap");
    if (!wrap) return;
    /* Nothing moved — the row the caller wants is already rendered, so skip the
       work. Without this, arrow-key navigation (where the target is almost
       always already on screen) would render twice per keypress: once here and
       once from the scroll listener's rAF. */
    if (wrap.scrollTop === _vsScrollTop) return;
    _vsScrollTop = wrap.scrollTop;
    _vsRender();
}

function _vsSetChannels(channels, keepScroll) {
    _vsChannels = channels;
    const wrap = document.getElementById("channel-list-wrap");
    const list = document.getElementById("channel-list");
    if (!channels.length) { list.innerHTML = ""; list.style.height = "0px"; return; }
    list.style.height   = (channels.length * VS_ROW_H) + "px";
    list.style.position = "relative";
    if (!keepScroll) { wrap.scrollTop = _vsScrollTop = 0; }
    _vsHeight = wrap.clientHeight || _vsHeight;
    _vsRender();
}

function _vsRender() {
    const list     = document.getElementById("channel-list");
    const channels = _vsChannels;
    if (!channels.length) return;

    const first    = Math.max(0, Math.floor(_vsScrollTop / VS_ROW_H) - VS_OVERSCAN);
    const last     = Math.min(channels.length - 1, Math.ceil((_vsScrollTop + _vsHeight) / VS_ROW_H) + VS_OVERSCAN);
    const isFavView = activeCategory === "favs";
    const fragment  = document.createDocumentFragment();
    const needed    = new Set();

    for (let i = first; i <= last; i++) {
        const ch  = channels[i];
        const sid = String(ch.stream_id);
        needed.add(sid);

        let entry = rowCache.get(sid);
        if (!entry) { entry = _buildRow(ch, sid); rowCache.set(sid, entry); }

        const { row, favBtn, assignBtn, col3, col4, numCell } = entry;
        row.style.position = "absolute";
        row.style.top      = (i * VS_ROW_H) + "px";
        row.style.left = row.style.right = "0";

        /* Numbering restarts at 1 for whatever is on screen — Favourites is
           1..N, each category is 1..N. It is a position in the current list,
           not the provider's channel number, because that is what you can
           actually see and count, and what typing a number jumps to. */
        if (numCell) numCell.textContent = (i + 1);

        row.classList.toggle("selected", currentChannel !== null && String(currentChannel.stream_id) === sid);
        favBtn.classList.toggle("active", isFav(sid));
        col3.style.display = isFavView ? "flex" : "none";
        assignBtn.classList.toggle("active", Favourites.inAnyGroup(sid));
        col4.style.display = (isFavView && activeFavGroup === "all") ? "flex" : "none";

        buildEpgStrip(entry.epgStrip, sid);
        if (!list.contains(row)) fragment.appendChild(row);
    }

    if (fragment.childElementCount) list.appendChild(fragment);
    Array.from(list.children).forEach(el => { if (!needed.has(el.dataset.sid)) el.remove(); });
    _vsEvictRows(needed);
}

/* Rows leave the DOM above, but they stayed in rowCache forever — which made
   the cache, not the DOM, the thing that grew without bound. On a 20 000-channel
   provider one scroll through the list retained 20 000 detached rows, each
   holding a logo <img> the TV had already decoded (`loading="lazy"` is ignored
   at this compatibility floor), which is exactly the memory profile the virtual
   scroller exists to avoid.

   Entries are dropped oldest-first — Map preserves insertion order — and only
   ones that are neither on screen nor the playing channel, so reuse still works
   for everything within scrolling distance. The cap is generous because a row
   is cheap next to re-decoding its logo; it only has to be bounded. */
const ROW_CACHE_MAX = 240;

function _vsEvictRows(needed) {
    if (rowCache.size <= ROW_CACHE_MAX) return;
    const keep = currentChannel ? String(currentChannel.stream_id) : "";
    for (const sid of Array.from(rowCache.keys())) {
        if (rowCache.size <= ROW_CACHE_MAX) break;
        if (sid === keep || needed.has(sid)) continue;
        const entry = rowCache.get(sid);
        const row = entry && entry.row;
        if (row && row.parentNode) row.parentNode.removeChild(row);
        rowCache.delete(sid);
    }
}

function _buildRow(ch, sid) {
    const row = document.createElement("div");
    row.className = "tl-row"; row.dataset.sid = sid;
    row.setAttribute("tabindex", "-1");

    // ── Col 1: number + logo + name + EPG strip ──────────────────────────────
    const col1 = document.createElement("div");
    col1.className = "tl-col1";

    /* Position in the CURRENT list, not a fixed channel number. Left blank
       here and filled in by _vsRender(), which is the only place that knows
       the index — rows are cached by stream id and reused across filters, so a
       number baked in at build time would be wrong the moment you switched
       category. */
    const numCell = document.createElement("div");
    numCell.className = "tl-num";

    const logoCell = document.createElement("div");
    logoCell.className = "tl-logo-cell";
    const initial = (ch.name || "?")[0].toUpperCase();
    if (ch.stream_icon) {
        const img = new Image();
        img.className = "ch-logo-static"; img.alt = ""; img.loading = "lazy"; img.decoding = "async";
        img.onerror = function () {
            const fb = document.createElement("div");
            fb.className = "ch-logo-fallback"; fb.textContent = initial;
            if (this.parentNode) this.parentNode.replaceChild(fb, this);
        };
        img.src = ch.stream_icon;
        logoCell.appendChild(img);
    } else {
        const fb = document.createElement("div");
        fb.className = "ch-logo-fallback"; fb.textContent = initial;
        logoCell.appendChild(fb);
    }

    const nameEpgWrap = document.createElement("div");
    nameEpgWrap.className = "tl-name-epg-wrap";
    const nd = document.createElement("div");
    nd.className = "ch-name"; nd.textContent = ch.name || "Unknown";
    const epgStrip = document.createElement("div");
    epgStrip.className = "tl-epg-strip"; epgStrip.dataset.sid = sid;
    nameEpgWrap.appendChild(nd);
    nameEpgWrap.appendChild(epgStrip);

    col1.appendChild(numCell);
    col1.appendChild(logoCell);
    col1.appendChild(nameEpgWrap);

    // ── Col 2: favourite button ───────────────────────────────────────────────
    const col2 = document.createElement("div");
    col2.className = "tl-col2";
    const favBtn = document.createElement("button");
    favBtn.className = "fav-btn"; favBtn.textContent = "★";
    favBtn.setAttribute("tabindex", "-1");
    favBtn.addEventListener("click", e => {
        e.stopPropagation(); toggleFav(sid);
        if (activeCategory === "favs") { applyFilters(); return; }
        favBtn.classList.toggle("active", isFav(sid));
    });
    col2.appendChild(favBtn);

    // ── Col 3: assign (+) button — fav view only ─────────────────────────────
    const col3 = document.createElement("div");
    col3.className = "tl-col3";
    const assignBtn = document.createElement("button");
    assignBtn.className = "assign-btn"; assignBtn.textContent = "+";
    assignBtn.setAttribute("tabindex", "-1");
    assignBtn.addEventListener("click", e => showAssignPanel(e, sid, assignBtn));
    col3.appendChild(assignBtn);

    // ── Col 4: reorder buttons ────────────────────────────────────────────────
    const col4 = document.createElement("div");
    col4.className = "tl-col4";
    const reorder = document.createElement("div");
    reorder.className = "fav-reorder";
    const upBtn = document.createElement("button");
    upBtn.className = "reorder-btn reorder-up"; upBtn.setAttribute("aria-label", "Move up");
    upBtn.innerHTML = `<svg viewBox="0 0 10 6" width="10" height="6"><polyline points="1,5 5,1 9,5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    upBtn.setAttribute("tabindex", "-1");
    upBtn.addEventListener("click", e => { e.stopPropagation(); _reorderAndRefocus(sid, -1, "reorder-up"); });
    const dnBtn = document.createElement("button");
    dnBtn.className = "reorder-btn reorder-dn"; dnBtn.setAttribute("aria-label", "Move down");
    dnBtn.innerHTML = `<svg viewBox="0 0 10 6" width="10" height="6"><polyline points="1,1 5,5 9,1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    dnBtn.setAttribute("tabindex", "-1");
    dnBtn.addEventListener("click", e => { e.stopPropagation(); _reorderAndRefocus(sid, 1, "reorder-down"); });
    reorder.appendChild(upBtn);
    reorder.appendChild(dnBtn);
    col4.appendChild(reorder);

    row.appendChild(col1);
    row.appendChild(col2);
    row.appendChild(col3);
    row.appendChild(col4);

    // Magic remote pointer click selects the channel.
    // D-pad OK is handled via onTVKeyDown in dpad.js.
    col1.addEventListener("click", () => selectChannel(ch));

    return { row, epgStrip, favBtn, assignBtn, reorder, upBtn, dnBtn, numCell, col1, col2, col3, col4 };
}


// ── Filtering ─────────────────────────────────────────────────────────────────

function getFilteredChannels() {
    const q = document.getElementById("search").value.toLowerCase();
    let list;
    if (activeCategory === "favs") {
        if (activeFavGroup === "all") {
            list = Favourites.resolveChannels(allChannels);
        } else if (activeFavGroup.indexOf("cat:") === 0) {
            list = Favourites.resolveCategory(activeFavGroup.slice(4), allChannels);
        } else {
            list = Favourites.resolveGroup(activeFavGroup, allChannels);
        }
    } else if (activeCategory === "all") {
        list = _hiddenCatsLive.size
            ? allChannels.filter(ch => !_hiddenCatsLive.has(String(ch.category_id)))
            : allChannels;
    } else {
        list = allChannels.filter(ch => String(ch.category_id) === String(activeCategory));
    }
    return q ? list.filter(ch => (ch.name || "").toLowerCase().includes(q)) : list;
}

let _applyTimer = null;
function applyFilters(immediate) {
    clearTimeout(_applyTimer);
    if (immediate) { _doApply(); return; }
    _applyTimer = setTimeout(_doApply, 80);
}

function _doApply() {
    const channels  = getFilteredChannels();
    const container = document.getElementById("channel-list");

    if (!channels.length) {
        _vsChannels = [];
        _keepScrollOnApply = false;
        container.style.height = "auto"; container.style.position = "static";
        const isFavView = activeCategory === "favs";
        let empty;
        if (!isFavView) {
            empty = "No channels found";
        } else if (activeFavGroup.indexOf("cat:") === 0) {
            // A starred category resolves live, so an empty one means the
            // provider's category is empty right now — not a user mistake.
            empty = "This category has no channels at the moment";
        } else if (activeFavGroup !== "all") {
            empty = "No channels in this group — assign channels using the + button";
        } else {
            empty = "No favourites yet — press ★ on any channel, or on a whole category in the sidebar";
        }
        container.innerHTML = `<div class="no-results">${empty}</div>`;
        renderTimelineHeader(); return;
    }

    renderTimelineHeader();
    _vsSetChannels(channels, _keepScrollOnApply);
    _keepScrollOnApply = false;
    loadEPGForCurrentCategory();
}

function setupSearch() {
    document.getElementById("search").addEventListener("input", () => applyFilters(), { passive: true });
}
