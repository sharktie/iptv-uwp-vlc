/* vod/detail.js — the title overlay: artwork, plot, My List, and for a series
 * the season picker and episode list. Also owns starting playback.
 *
 * Subtitles are resolved here rather than in the player, because only this side
 * knows the panel payload the episode came from. The whole season travels with
 * a played episode so the player can offer Next episode without calling back.
 */
'use strict';

/* ── Detail overlay ──────────────────────────────────────────────── */
var detailItem = null, detailIsSeries = false, seasonsData = null, activeSeason = null;

function setText(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt || ''; }

function openDetail(item) {
    detailItem = item;
    detailIsSeries = item.__type ? (item.__type === 'series') : (activeType === 'series' || !!item.series_id);
    prevZone = zone;

    var icon = posterOf(item);
    document.getElementById('vod-detail-poster').src = icon || '';
    var bd = document.getElementById('vod-detail-backdrop');
    bd.style.backgroundImage = icon ? 'url("' + icon + '")' : 'none';

    setText('vod-detail-title', titleOf(item));
    setText('vod-detail-plot', item.plot || item.description || '');
    setText('vod-detail-cast', item.cast || '');
    setText('vod-detail-director', item.director || '');
    document.getElementById('vod-detail-cast-row').style.display = item.cast ? '' : 'none';
    document.getElementById('vod-detail-director-row').style.display = item.director ? '' : 'none';

    var meta = [];
    if (yearOf(item))   meta.push('<span class="vod-meta-badge">' + escHtml(yearOf(item)) + '</span>');
    if (ratingOf(item)) meta.push('<span class="vod-meta-badge gold">★ ' + ratingOf(item).toFixed(1) + '</span>');
    if (item.genre)     meta.push('<span class="vod-meta-badge">' + escHtml(item.genre) + '</span>');
    if (item.duration)  meta.push('<span class="vod-meta-badge">' + escHtml(item.duration) + '</span>');
    document.getElementById('vod-detail-meta').innerHTML = meta.join('');

    var seasonsBox = document.getElementById('vod-seasons');
    var playBtn = document.getElementById('vod-play-btn');

    updateListBtn();              // My List / In My List label

    elDetail.hidden = false;
    detailFocus = 0;

    if (detailIsSeries) {
        playBtn.style.display = 'none';
        seasonsBox.hidden = false;
        loadSeries(item);
    } else {
        playBtn.style.display = '';
        seasonsBox.hidden = true;
        // resume label
        var prog = loadProgress()['m:' + item.stream_id];
        setText('vod-play-label', (prog && prog.pos > 30) ? 'Resume' : 'Play');
        lazyFetchVodInfo(item);
    }
    focusZone('detail');
    paintDetailFocus();
}

function updateListBtn() {
    if (!detailItem) return;
    var saved = inWatchlist(detailItem);
    setText('vod-list-label', saved ? 'In My List' : 'My List');
    var icon = document.getElementById('vod-list-icon');
    if (icon) icon.innerHTML = saved
        ? '<path d="M3.5 9.5L7 13l7.5-8" />'          // check
        : '<path d="M9 3v12M3 9h12" />';              // plus
}

/* Closing a title returns you to whatever you opened it from — the rails,
   the search results, or a category grid. Landing back on the rails after
   browsing 200 titles in a category would throw away the user's place. */
function closeDetail() {
    elDetail.hidden = true;
    document.getElementById('vod-detail-backdrop').style.backgroundImage = 'none';
    detailItem = null; seasonsData = null;
    var back = (prevZone === 'search' || prevZone === 'category') ? prevZone : 'rails';
    focusZone(back);
    if (back === 'search')        paintSearchFocus();
    else if (back === 'category') paintCategoryFocus();
    else                          paintRailFocus();
}

/* Subtitle extraction lives in data/subtitles.js — every panel shape, the
   embedded-vs-downloadable split, and the sidecar probe are all there. */
var EMPTY_SUBS = { files: [], embedded: [], unknown: 0 };

/* Lazy-fetch richer movie info (plot/cast) + subtitles, once per item.
   Returns the in-flight promise so callers that need `_subs` (i.e. Play)
   can wait for it instead of racing it — previously Play read `_subs`
   synchronously and got undefined whenever the user was quicker than the
   request, which was most of the time. */
function lazyFetchVodInfo(item) {
    if (item._infoPromise) return item._infoPromise;
    if (!item.stream_id) return Promise.resolve(item);
    item._infoPromise = fetchJSON(apiUrl('action=get_vod_info&vod_id=' + encodeURIComponent(item.stream_id)))
        .then(function (data) {
            item._subs = Subs.fromVodInfo(data, cfg);
            /* Record the reply HERE, at the request that actually made it. The
               player retries get_vod_info later and records there, but only for
               movies and only when it comes up empty — so for every other route
               (an episode, a title played straight from the detail view, a
               resume from Continue Watching) Diagnostics could show "0
               subtitles" with nothing to say why. This is the one place that
               sees every movie lookup. */
            try {
                Subs.recordDiag(titleOf(item) || item.name || '', item._subs, {
                    source:     'detail · get_vod_info',
                    panelShape: Subs.describePayload(data),
                    panelRaw:   Subs.rawSample(data)
                });
            } catch (e) {}
            var info = (data && (data.info || data.movie_data)) || data || {};
            item.container_extension = item.container_extension || info.container_extension;
            /* Kept for OpenSubtitles: an id matches far more reliably than a
               title string, which breaks on renames and release tags. */
            item._tmdb = info.tmdb_id || info.tmdb || '';
            item._imdb = info.imdb_id || info.imdb || '';
            item._year = yearOf(info) || yearOf(item) || '';
            if (detailItem !== item) return item;
            if (info.plot || info.description) setText('vod-detail-plot', info.plot || info.description);
            if (info.cast)     { setText('vod-detail-cast', info.cast); document.getElementById('vod-detail-cast-row').style.display = ''; }
            if (info.director) { setText('vod-detail-director', info.director); document.getElementById('vod-detail-director-row').style.display = ''; }
            return item;
        }).catch(function () { item._subs = item._subs || EMPTY_SUBS; return item; });
    return item._infoPromise;
}

/* When the panel named no downloadable files, one speculative look for a
   sidecar file next to the stream. Several panels serve `<stream>.srt`
   without ever mentioning it in the API, and it is the last place a real
   file can come from. Guarded inside Subs.probeSidecars so it can never
   pull down a movie by mistake, and raced against playback below so a
   silent panel can't hold up Play. */
function withSidecars(subs, streamUrl) {
    if (subs.files.length || !streamUrl) return Promise.resolve(subs);
    return Subs.probeSidecars(streamUrl).then(function (found) {
        if (!found.length) return subs;
        return { files: found, embedded: subs.embedded, unknown: subs.unknown };
    })['catch'](function () { return subs; });
}

/* Play once subtitles are known, but never let a slow or dead panel block
   playback — whichever of the two fires first wins. `build(subs)` receives
   the full { files, embedded, unknown } result. */
function playWhenSubsReady(item, build, streamUrl) {
    var done = false;
    function go(subs) { if (done) return; done = true; playItem(build(subs || EMPTY_SUBS)); }

    if (item && item._subs) {
        withSidecars(item._subs, streamUrl).then(go);
        setTimeout(function () { go(item._subs); }, 2500);
        return;
    }
    if (!item || !item.stream_id) { go(EMPTY_SUBS); return; }
    lazyFetchVodInfo(item)
        .then(function () { return withSidecars(item._subs || EMPTY_SUBS, streamUrl); })
        .then(go);
    setTimeout(function () { go(item._subs); }, 2500);
}

/* ── Series: seasons + episodes ──────────────────────────────────── */
function loadSeries(item) {
    var tabs = document.getElementById('vod-season-tabs');
    var list = document.getElementById('vod-episode-list');
    tabs.innerHTML = ''; list.innerHTML = '<div class="vod-ep-loading">Loading episodes…</div>';
    seasonsData = null;
    fetchJSON(apiUrl('action=get_series_info&series_id=' + encodeURIComponent(item.series_id)))
        .then(function (data) {
            /* Same reasoning as the movie lookup: this is the only request that
               sees the series reply, and an episode's subtitles live inside it.
               Recorded before the detailItem guard so a user who has already
               moved on still leaves the evidence behind. The sample is of one
               episode rather than the whole series — a full season's JSON is
               far past what the diagnostics pane can show, and every episode
               carries the same subtitle shape. */
            try {
                var firstEp = null, byS = (data && data.episodes) || {};
                for (var sk in byS) {
                    if (Object.prototype.hasOwnProperty.call(byS, sk) && byS[sk] && byS[sk].length) {
                        firstEp = byS[sk][0]; break;
                    }
                }
                if (firstEp) {
                    Subs.recordDiag(titleOf(item) || '', Subs.fromEpisode(firstEp, cfg), {
                        source:     'detail · get_series_info',
                        panelShape: Subs.describePayload(firstEp),
                        panelRaw:   Subs.rawSample(firstEp)
                    });
                }
            } catch (e) {}
            if (detailItem !== item) return;
            var eps = data && data.episodes;
            if (!eps) { list.innerHTML = '<div class="vod-ep-loading">No episodes found.</div>'; return; }
            seasonsData = eps;
            var seasons = Object.keys(eps).sort(function (a, b) { return (+a) - (+b); });
            tabs.innerHTML = '';
            seasons.forEach(function (sn, i) {
                var t = document.createElement('button');
                t.className = 'vod-season-tab' + (i === 0 ? ' active' : '');
                t.textContent = 'S' + sn;
                t.dataset.season = sn;
                t.addEventListener('click', function () { selectSeason(sn); });
                tabs.appendChild(t);
            });
            if (seasons.length) selectSeason(seasons[0]);
        }).catch(function () {
            list.innerHTML = '<div class="vod-ep-loading">Could not load episodes.</div>';
        });
}

/* The season's episodes in a form the PLAYER can use, so "Next episode"
   there needs no API call and works even if the panel is slow or down by
   the time an episode ends. Kept slim — this rides in localStorage. */
var PLAYLIST_CAP = 120;

function buildPlaylist(eps) {
    return eps.slice(0, PLAYLIST_CAP).map(function (ep) {
        var num = ep.episode_num != null ? ep.episode_num : '';
        return {
            id:    ep.id,
            ext:   ep.container_extension || (ep.info && ep.info.container_extension) || 'mp4',
            num:   num,
            title: ep.title || ('Episode ' + num),
            subs:  Subs.fromEpisode(ep, cfg)
        };
    });
}

function selectSeason(sn) {
    activeSeason = sn;
    document.querySelectorAll('#vod-season-tabs .vod-season-tab').forEach(function (t) {
        t.classList.toggle('active', t.dataset.season === String(sn));
    });
    var list = document.getElementById('vod-episode-list');
    list.innerHTML = '';
    var eps = (seasonsData && seasonsData[sn]) || [];
    var playlist = buildPlaylist(eps);
    var seriesName = detailItem ? titleOf(detailItem) : '';

    playlist.forEach(function (item, idx) {
        var row = document.createElement('button');
        row.className = 'vod-ep-row';
        row.innerHTML =
            '<span class="vod-ep-num">' + escHtml(item.num) + '</span>' +
            '<span class="vod-ep-name">' + escHtml(item.title) + '</span>' +
            '<span class="vod-ep-play">▶</span>';
        row.addEventListener('click', function () { playEpisode(playlist, idx, sn, seriesName); });
        list.appendChild(row);
    });
    paintDetailFocus();
}

/* Start one episode of a season. The whole season travels with it so the
   player can move to the next one on its own. */
function playEpisode(playlist, idx, season, seriesName) {
    var item = playlist[idx];
    if (!item) return;
    var meta = {
        type: 'episode', id: item.id, ext: item.ext,
        name: (seriesName ? seriesName + ' · ' : '') + item.title,
        icon: posterOf(detailItem || {}),
        series_id: detailItem && detailItem.series_id,
        season: season, episode: item.num,
        subs: item.subs,
        series_name: seriesName,
        playlist: playlist, playlist_index: idx,
        search_name: seriesName,
        tmdb_id: (detailItem && detailItem._tmdb) || '',
        imdb_id: (detailItem && detailItem._imdb) || ''
    };
    /* Same sidecar look as movies, raced against a 2s cap so a silent panel
       never delays starting the episode. */
    if (item.subs.files.length) { playItem(meta); return; }
    var started = false;
    function go(subs) { if (started) return; started = true; meta.subs = subs; playItem(meta); }
    withSidecars(item.subs, buildEpisodeUrl(item.id, item.ext)).then(go);
    setTimeout(function () { go(item.subs); }, 2000);
}

/* ── Playback navigation ─────────────────────────────────────────── */
/* `meta.subs` is a { files, embedded, unknown } result from data/subtitles.js.
   Both halves cross to the player: the files become <track>s, and the
   embedded list is what lets the player say "your provider lists 2 tracks
   inside this video" instead of "no subtitles found". */
/* One navigation per page load, enforced here rather than at each call site.

   Every path into playItem already guards itself, but each guard is local: if
   the play path is entered TWICE — which a TV remote makes easy, since OK
   commonly fires both a click and a keydown — there are two independent guards
   and playItem runs twice, milliseconds apart.

   The second call cannot win the navigation; the browser has already committed
   to the first href. But its localStorage write DOES land, replacing the
   metadata the in-flight navigation is about to read. The player then finds a
   token that doesn't match its url and correctly discards the whole handover —
   losing subtitles, resume position and the Next-episode button together, for
   what the user experienced as a single button press.

   Observed in the wild as two tokens minted 9ms apart, the stored one later
   than the one in the url. */
var _navigating = false;

function playItem(meta) {
    if (_navigating) return;
    _navigating = true;

    var url = meta.type === 'episode' ? buildEpisodeUrl(meta.id, meta.ext) : buildMovieUrl(meta.id, meta.ext);
    var key = (meta.type === 'episode' ? 'e:' : 'm:') + meta.id;
    var subs = meta.subs || EMPTY_SUBS;

    Subs.recordDiag(meta.name || '', subs, { source: meta.type });

    /* Pairs this metadata with the navigation below, so the player can accept it
       without having to compare url strings that took different routes. */
    var token = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    var payload = {
        url: url, token: token,
        key: key, type: meta.type, id: meta.id, ext: meta.ext,
        name: meta.name || '', icon: meta.icon || '',
        series_id: meta.series_id || '', season: meta.season || '', episode: meta.episode || '',
        resume: meta.resume || 0,
        subs: subs.files || [],
        subs_embedded: subs.embedded || [],
        subs_unknown: subs.unknown || 0,
        /* The rest of the season, so the player can offer Next episode without
           going back to the panel. Optional — the player refetches it from
           series_id if it isn't here. */
        series_name: meta.series_name || '',
        playlist: meta.playlist || null,
        playlist_index: (typeof meta.playlist_index === 'number') ? meta.playlist_index : -1,
        /* Search hints for OpenSubtitles in the player. `search_name` is the
           title to look up — for an episode that's the SERIES name, not
           "Series · Episode", which matches nothing. */
        search_name: meta.search_name || meta.name || '',
        year: meta.year || '', tmdb_id: meta.tmdb_id || '', imdb_id: meta.imdb_id || ''
    };

    Store.setRaw('iptv_play_url', url);
    Store.setRaw('iptv_play_title', meta.name || '');

    /* This write MUST land. The player reads it to know what it is playing, and
       discards it wholesale if the url inside doesn't match the one it was
       given — so a rejected write doesn't degrade one feature, it silently
       costs subtitles, resume position AND the next-episode button, while
       leaving the previous title's metadata in place to be rejected.

       The playlist is by far the largest part and the only optional one, so a
       quota failure drops it and retries rather than losing everything. */
    if (!Store.set('iptv_play_meta', payload)) {
        payload.playlist = null;
        payload.playlist_index = -1;
        Store.set('iptv_play_meta', payload);
    }

    window.location.href = '../pages/player.html?t=' + encodeURIComponent(token) +
                           '&url=' + encodeURIComponent(url) +
                           '&title=' + encodeURIComponent(meta.name || '');
}

function playCurrentMovie() {
    if (!detailItem) return;
    var item = detailItem;
    var prog = loadProgress()['m:' + item.stream_id];
    var ext  = item.container_extension || 'mp4';
    playWhenSubsReady(item, function (subs) {
        return {
            type: 'movie', id: item.stream_id, ext: item.container_extension || 'mp4',
            name: titleOf(item), icon: posterOf(item),
            resume: (prog && prog.pos > 30) ? prog.pos : 0,
            subs: subs,
            search_name: titleOf(item),
            year: item._year || yearOf(item) || '',
            tmdb_id: item._tmdb || '', imdb_id: item._imdb || ''
        };
    }, buildMovieUrl(item.stream_id, ext));
}

/* Continue Watching stores no subtitle list (it predates one), so re-resolve
   it for movies rather than resuming without subtitles. Episodes would need
   the whole series payload again — not worth the wait, so they resume with
   only a sidecar look. */
function resumePlay(entry) {
    var isEpisode = entry.type === 'episode';
    var build = function (subs, extra) {
        var m = {
            type: isEpisode ? 'episode' : 'movie',
            id: entry.id, ext: entry.ext,
            name: entry.name, icon: entry.icon,
            series_id: entry.series_id, season: entry.season, episode: entry.episode,
            resume: entry.pos || 0,
            subs: subs
        };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) m[k] = extra[k];
        return m;
    };

    if (isEpisode) {
        resumeEpisode(entry, build);
        return;
    }
    playWhenSubsReady({ stream_id: entry.id }, build, buildMovieUrl(entry.id, entry.ext));
}

/* Resuming an episode has to rebuild the season alongside it. Continue Watching
   stores one episode, not the series — so without this, picking up a show from
   the home rails gave no Next episode button, which is precisely where someone
   binge-watching would expect one. One request to get_series_info is enough,
   and it is raced against a cap so a slow panel delays nothing: worst case you
   resume without the button, exactly as before. */
function resumeEpisode(entry, build) {
    var epUrl = buildEpisodeUrl(entry.id, entry.ext);
    var started = false;
    function go(subs, extra) {
        if (started) return;
        started = true;
        playItem(build(subs || EMPTY_SUBS, extra));
    }

    if (!entry.series_id) {
        withSidecars(EMPTY_SUBS, epUrl).then(function (s) { go(s); });
        setTimeout(function () { go(EMPTY_SUBS); }, 2000);
        return;
    }

    fetchJSON(apiUrl('action=get_series_info&series_id=' + encodeURIComponent(entry.series_id)))
        .then(function (data) {
            var eps = (data && data.episodes) || {};
            /* The stored season is the reliable key, but panels are inconsistent
               about its type, so fall back to hunting for the episode id. */
            var season = String(entry.season);
            var list = eps[season] || eps[Number(season)] || null;
            if (!list) {
                for (var k in eps) {
                    if (!Object.prototype.hasOwnProperty.call(eps, k)) continue;
                    for (var i = 0; i < eps[k].length; i++) {
                        if (String(eps[k][i].id) === String(entry.id)) { list = eps[k]; season = k; break; }
                    }
                    if (list) break;
                }
            }
            if (!list) { go(EMPTY_SUBS); return; }

            var playlist = buildPlaylist(list);
            var idx = -1;
            for (var j = 0; j < playlist.length; j++) {
                if (String(playlist[j].id) === String(entry.id)) { idx = j; break; }
            }
            if (idx < 0) { go(EMPTY_SUBS); return; }

            var seriesName = (entry.name || '').split(' · ')[0] || '';
            go(playlist[idx].subs, {
                series_name: seriesName,
                playlist: playlist,
                playlist_index: idx,
                search_name: seriesName,
                season: season
            });
        })
        .catch(function () { go(EMPTY_SUBS); });

    /* Never let the series lookup hold up playback. */
    setTimeout(function () { go(EMPTY_SUBS); }, 2500);
}

document.getElementById('vod-play-btn').addEventListener('click', playCurrentMovie);
document.getElementById('vod-list-btn').addEventListener('click', function () {
    if (!detailItem) return;
    toggleWatchlist(detailItem);
    updateListBtn();
});
