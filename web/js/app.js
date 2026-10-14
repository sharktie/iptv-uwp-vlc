/* app.js — Live TV: startup, channel selection, and the boot sequence.
 *
 * The page is assembled from several modules, loaded in dependency order by
 * pages/livetv.html:
 *
 *   livetv/state.js      shared state every other module reads
 *   livetv/epg.js        guide data, timeline, programme strips
 *   livetv/channels.js   channel cache, filtering, virtual scroller
 *   livetv/sidebar.js    favourites, groups, categories, dialogs
 *   livetv/pip.js        preview, fullscreen, OSD, multiview entry
 *   livetv/multiview.js  the multi-channel grid
 *   dpad.js              remote control routing
 *   app.js               this file — init and boot
 *
 * Startup takes the cache-first path whenever it can: a cached channel list
 * paints immediately and the network refresh lands underneath it, because a
 * TV app that shows a spinner for four seconds on every launch feels broken
 * even when it is working perfectly.
 */

// ── App init ──────────────────────────────────────────────────────────────────

// ── Source type ───────────────────────────────────────────────────────────────

/* From the active profile — see Config.sourceType() for why not from the
   separate iptv_source_type key. */
function getSourceType() {
    return Config.sourceType();
}

async function initApp() {
    const status = document.getElementById("status");
    const setStatus = (msg, err) => {
        status.textContent = msg;
        status.style.color = err ? "#ff5555" : "";
    };

    epgCache = loadEpgDiskCache();

    if (getSourceType() === "m3u") {
        await _initAppM3U(setStatus);
    } else {
        await _initAppXtream(setStatus);
    }
}

async function _initAppM3U(setStatus) {
    let m3uCfg;
    try { m3uCfg = await m3uLoadConfig(); }
    catch (err) { setStatus("ERR: " + err.message, true); return; }

    // Try disk cache first
    const url    = m3uCfg.playlist_url;
    const cached = m3uLoadCache(url);
    if (cached) {
        allChannels = cached.channels;
        setStatus(`${allChannels.length} channels (cached)`);
        _bootUI(cached.categories, cached.epgUrl);
        // Refresh in background. An empty or failed refresh keeps the cached
        // list on screen rather than wiping it — same rule as Xtream below.
        m3uFetchPlaylist(url).then(parsed => {
            if (!parsed.channels.length) return;
            allChannels = parsed.channels;
            setStatus(`${allChannels.length} channels`);
            m3uSaveCache(url, parsed);
            renderCategories(parsed.categories);
            updateSidebarActive();
            applyFilters();
        }).catch(() => {});
        return;
    }

    try {
        setStatus("Loading playlist…");
        const parsed = await m3uGetChannelsAndCategories(m3uCfg);
        if (!parsed.channels.length) { setStatus("ERR: 0 channels in playlist", true); return; }
        allChannels = parsed.channels;
        setStatus(`${allChannels.length} channels`);
        m3uSaveCache(url, parsed);
        _bootUI(parsed.categories, parsed.epgUrl);
    } catch (err) { setStatus("ERR: " + err.message, true); }
}

async function _initAppXtream(setStatus) {
    setStatus("Loading config…");
    try { cfg = await xtreamLoadConfig(); }
    catch (err) { setStatus("ERR: " + err.message, true); return; }

    if (!cfg?.server_url) {
        setStatus("No server configured — redirecting to Settings…", false);
        setTimeout(() => { window.location.href = "../pages/settings.html"; }, 1800);
        return;
    }

    const cachedCh  = loadChannelCache();
    const cachedCat = loadCatCache();
    let categories  = cachedCat || [];

    if (cachedCh) {
        allChannels = cachedCh;
        setStatus(`${allChannels.length} channels (cached)`);
        _bootUI(categories);

        /* Background refresh. Both guards on `.length` are load-bearing:
           xtreamGet* swallow their errors and return [], so a failed refresh
           arrives as an empty array rather than a rejection. Without the guard
           the category list was wiped from the screen AND written back to the
           cache as empty on every launch where the panel was briefly
           unreachable — leaving the sidebar with no categories until a later
           launch happened to succeed. */
        xtreamGetLiveChannels(cfg).then(fresh => {
            if (!fresh.length) return;
            allChannels = fresh;
            setStatus(`${allChannels.length} channels`);
            saveChannelCache(fresh, categories);
            if (xmltvCache && xmltvCache.programmes) mergeXMLTVIntoEpgCache();
            _keepScrollOnApply = true;   // a refresh must not throw the user back to row 1
            applyFilters();
        }).catch(() => {});
        xtreamGetCategories(cfg).then(freshCat => {
            if (!freshCat.length) return;
            const sig = list => list.map(c => c.category_id + ":" + c.category_name).join("|");
            const changed = sig(freshCat) !== sig(categories);
            categories = freshCat;
            /* Only the category list is new here, so only it is written. This
               used to re-save the entire channel list as well — serialising
               several MB a second time on every launch for nothing. */
            Store.cacheSet(CAT_CACHE_KEY, freshCat);
            if (!changed) return;      // identical: leave the sidebar (and the focus ring in it) alone
            renderCategories(freshCat);
            updateSidebarActive();
            if (tvFocusZone === "sidebar-cats") tvFocusSidebarItem(tvSidebarIndex);
        }).catch(() => {});
        return;
    }

    setStatus("Logging in…");
    try {
        const login = await xtreamLogin(cfg);
        /* Three outcomes, not two: authenticated, the panel answered and said
           no (bad password / expired line), or nothing answered at all. The
           middle one used to fall through as a success and reappear later as
           "0 channels returned". */
        if (login && login.authFailed) { setStatus("ERR: " + login.message, true); return; }
        if (!login) { setStatus("ERR: Could not reach any server for this profile", true); return; }
        // Update cfg with the resolved server_url (the URL that actually worked)
        cfg = login.cfg;
    } catch (err) { setStatus("ERR: " + err.message, true); return; }

    try {
        setStatus("Fetching channels…");
        const [channels, cats] = await Promise.all([xtreamGetLiveChannels(cfg), xtreamGetCategories(cfg)]);
        if (!channels.length) { setStatus("ERR: 0 channels returned", true); return; }
        allChannels = channels; categories = cats;
        setStatus(`${allChannels.length} channels`);
        saveChannelCache(channels, categories);
        _bootUI(categories);
    } catch (err) { setStatus("ERR: " + err.message, true); }
}

function _bootUI(categories, playlistEpgUrl) {
    renderCategories(categories);
    setupSearch();
    setupPip();
    setupTimelineNav();

    activeCategory = Favourites.isEmpty() ? "all" : "favs";
    activeFavGroup = "all";
    if (activeCategory === "favs") {
        const sec = document.getElementById("cat-section-favs");
        if (sec) sec.classList.add("open");
    }
    renderFavSectionList();
    updateSidebarActive();
    applyFilters();

    tvRowIndex = 0;
    setTVZone("channel-list");

    // After the list is painted: a user-supplied guide is a large download
    // and must not hold up the first frame of channels.
    setTimeout(() => loadXMLTV(playlistEpgUrl), 500);
}


// ── Channel selection ─────────────────────────────────────────────────────────

async function selectChannel(ch) {
    currentChannel = ch;
    const _selSid = String(ch.stream_id);
    rowCache.forEach((entry, sid) => entry.row.classList.toggle("selected", sid === _selSid));
    document.getElementById("preview-channel-name").textContent = ch.name || "Unknown";
    document.getElementById("pip-channel-name").textContent     = ch.name || "Unknown";
    const playUrl = ch._source === "m3u" ? m3uBuildLiveURL(ch) : xtreamBuildLiveURL(cfg, ch.stream_id);
    // The key lets the player remember which engine actually worked for THIS
    // channel, so a 4K/HEVC channel that only plays on HLS starts there.
    player.play(playUrl, { key: "ch:" + ch.stream_id });
    setEPG("now", "Loading…", "", ""); setEPG("next", "—", "", "");
    document.getElementById("epg-bar-fill").style.width = "0%";
    showPreviewInfo();
    showOSD();  // immediate banner on channel switch — EPG data populated below

    let listings = epgCache[ch.stream_id];
    if (!listings && !epgBlocked) {
        epgCache[ch.stream_id] = null;
        try {
            listings = ch._source === "m3u"
                ? await m3uGetEPG(ch.stream_id)
                : await xtreamGetEPG(cfg, ch.stream_id);
        } catch (err) {
            if (Net.isHttpError(err, 403) || Net.isHttpError(err, 401)) epgBlocked = true;
            listings = [];
        }
        epgCache[ch.stream_id] = listings;
        patchEpgStrip(ch.stream_id); scheduleEpgSave();
    }
    if (!listings?.length) { setEPG("now", "No EPG data", "", ""); showOSD(); return; }

    // The user may have moved on while the guide was loading; painting this
    // channel's programme over the next one's would put the wrong title up.
    if (currentChannel !== ch) return;

    const { cur, next } = _findNowNext(listings);
    setEPG("now", epgTitle(cur), formatTimeRange(cur), epgDesc(cur));
    document.getElementById("epg-bar-fill").style.width = calcProgress(cur) + "%";
    if (next) setEPG("next", epgTitle(next), formatTimeRange(next), "");
    showOSD();
}

function updateOSDIfFullscreen() {
    if (isFullscreen()) showOSD();
}

function setEPG(slot, title, time, desc) {
    document.getElementById(`epg-${slot}-title`).textContent = title || "—";
    document.getElementById(`epg-${slot}-time`).textContent  = time  || "";
    const el = document.getElementById(`epg-${slot}-desc`);
    if (el) el.textContent = desc || "";
}

function showPreviewInfo() {
    document.getElementById("preview-info")?.classList.add("preview-visible");
}

function channelStep(delta) {
    if (!_vsChannels.length) return;
    let idx = currentChannel
        ? _vsChannels.findIndex(ch => String(ch.stream_id) === String(currentChannel.stream_id))
        : -1;
    if (idx < 0) idx = delta > 0 ? -1 : _vsChannels.length;
    idx = Math.max(0, Math.min(_vsChannels.length - 1, idx + delta));
    tvRowIndex = idx;
    const ch = _vsChannels[idx];
    if (ch) { selectChannel(ch); tvFocusRow(idx); }
}


// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Run immediately: this script is loaded with `defer`, so the DOM is already
// parsed here. Waiting for window.onload (all CSS/images fetched) only delayed
// the first paint of the channel list on slow TVs.
(function boot() {
    // Publish the active Xtream profile as IPTV_CONFIG, which is what
    // data/xtream.js reads. M3U profiles take their own path via
    // m3uLoadConfig(), which reads the active profile too.
    try {
        const active = Config.resolve();
        if (active && active.type !== "m3u" && active.server_url) window.IPTV_CONFIG = active;
    } catch (_) {}

    // XMLTV loads from _bootUI once the channel list exists — matching a
    // guide against no channels does nothing.
    measureRowHeight();
    initVirtualScroll();
    initTVNavigation();
    if (typeof tvSetBackUrl === "function") tvSetBackUrl("../index.html");
    initApp();
}());
