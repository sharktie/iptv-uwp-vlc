/* player/episodes.js — Next episode, Skip intro, and the end-of-episode
 * hand-off. Exposes window.Episodes.
 *
 * ── What the provider gives us, and what it doesn't ─────────────────────────
 * Xtream panels return an episode list and nothing else. There are no chapter
 * markers, no intro/outro timestamps, no "credits start here" — none of the
 * metadata a streaming service uses to place a Skip Intro button. So this file
 * cannot detect an intro, and does not pretend to:
 *
 *   Next episode  is exact. The whole season travels in the play metadata, so
 *                 moving on is just picking the next entry — no guesswork, and
 *                 no request to a panel that may be slow or down by the time an
 *                 episode ends. This doubles as the outro skip: the useful
 *                 thing to do over the closing credits is start the next one.
 *
 *   Skip intro    is a default that LEARNS. The first time you use it on a
 *                 series it jumps a typical intro length. Where you land is
 *                 remembered for that series, and from the next episode on the
 *                 button jumps straight to that point — which is right, because
 *                 a series uses the same intro every episode. Press it again
 *                 and it moves further on and remembers the new spot.
 *
 * The honest summary: episode 1 of a series gets an approximate skip, and every
 * episode after it gets the one you chose.
 *
 * ES5 — Babel target is Chrome 38.                                            */
window.Episodes = (function () {
    'use strict';

    var INTRO_KEY = 'vod_intro_end';        // { seriesId: secondsIntoEpisode }

    /* A typical television intro. Only ever used before a series has learned
       its own value. */
    var DEFAULT_INTRO_SKIP = 85;

    /* Offer an unlearned skip only over the stretch where intros actually live.
       Without this the button would sit on screen for the first six minutes of
       every episode, which is clutter rather than a feature. */
    var INTRO_OFFER_FROM = 4;
    var INTRO_OFFER_TO   = 150;

    /* A learned intro is trusted further into the episode — some series run a
       cold open first, so the intro can legitimately start several minutes in. */
    var INTRO_LEARNED_MAX = 600;

    /* Too short to have an intro worth skipping, or to be an episode at all. */
    var MIN_DURATION = 600;

    /* How much of the end counts as "the outro". */
    var OUTRO_TAIL_SEC = 90;
    var OUTRO_TAIL_PCT = 0.97;

    /* Seconds to wait before moving on by itself once an episode ends. Long
       enough to say no, short enough not to feel stuck. */
    var AUTONEXT_SEC = 8;

    var _meta = null;
    var _metaNote = '';    // why the handover was rejected, if it was
    var _video = null;
    var _onPlay = null;          // caller-supplied: start this playlist entry

    function introMap() { return Store.get(INTRO_KEY, {}) || {}; }

    function seriesKey() {
        if (!_meta || _meta.type !== 'episode') return '';
        return String(_meta.series_id || _meta.search_name || '');
    }

    function learnedIntroEnd() {
        var k = seriesKey();
        if (!k) return 0;
        var v = introMap()[k];
        return (typeof v === 'number' && v > 0) ? v : 0;
    }

    function rememberIntroEnd(seconds) {
        var k = seriesKey();
        if (!k || !(seconds > 0)) return;
        var map = introMap();
        map[k] = Math.round(seconds);
        Store.set(INTRO_KEY, map);
    }

    /* ── Playlist ─────────────────────────────────────────────────────────────
       Two ways to get one, and the second is what makes the Next button
       dependable.

       The fast path is the season the VOD page sent along in the play metadata:
       no request, available the instant the page loads.

       The fallback is fetching it here from series_id. That path exists because
       the fast one has too many ways to come up empty — resuming from Continue
       Watching, a localStorage write that hit quota, returning to a title by
       any route that didn't come through the episode list. Every one of those
       used to silently produce a player with no Next button on a series that
       obviously has a next episode. Now the worst case is that the button
       appears a moment late instead of not at all. */
    var _resolved = null;        // playlist fetched here, when meta had none
    var _resolvedIndex = -1;
    var _onReady = null;
    var _fetching = false;
    var _why = '';        // why there is (or isn't) a next episode

    function playlist() {
        if (_meta && _meta.playlist && _meta.playlist.length) return _meta.playlist;
        return _resolved;
    }
    function index() {
        if (_meta && _meta.playlist && _meta.playlist.length) {
            return (typeof _meta.playlist_index === 'number') ? _meta.playlist_index : -1;
        }
        return _resolvedIndex;
    }

    /* Build the same slim entries vod/detail.js builds, from a raw episode
       list, so both paths produce identical playlists. */
    function slimEpisodes(list) {
        var out = [];
        for (var i = 0; i < list.length && i < 120; i++) {
            var ep = list[i];
            var num = ep.episode_num != null ? ep.episode_num : '';
            out.push({
                id:    ep.id,
                ext:   ep.container_extension || (ep.info && ep.info.container_extension) || 'mp4',
                num:   num,
                title: ep.title || ('Episode ' + num),
                subs:  (typeof Subs !== 'undefined') ? Subs.fromEpisode(ep, _cfg()) : { files: [], embedded: [], unknown: 0 }
            });
        }
        return out;
    }

    function _cfg() {
        try { return Config.resolve(); } catch (e) { return null; }
    }

    /* Fetch the season this episode belongs to. Silent and best-effort: this is
       an enhancement to a player that is already playing, so a failure must
       leave everything exactly as it was. */
    /* Every way the lookup can END has to reach the caller, not just the one
       that succeeds. player/subtitles.js holds off on its own lookup while this
       one is in flight, so a failure that returned quietly used to leave it
       waiting for a signal that never came — an episode whose season lookup
       failed got no subtitles AND no fallback, permanently. */
    function settle() {
        _fetching = false;
        if (typeof _onReady === 'function') _onReady();
    }

    function resolveSeason() {
        if (_fetching) return;
        if (playlist()) { _why = 'season came with the metadata'; return; }

        if (!_meta) {
            _why = _metaNote || 'no play metadata was stored for this play';
            return;
        }
        if (_meta.type !== 'episode') { _why = 'not an episode (type=' + (_meta.type || '?') + ')'; return; }
        if (!_meta.series_id) { _why = 'metadata has no series_id, so the season cannot be looked up'; return; }
        if (typeof Net === 'undefined' || typeof Config === 'undefined') { _why = 'core modules missing'; return; }

        var cfg = _cfg();
        if (!cfg) { _why = 'no profile configured'; return; }
        if (cfg.type === 'm3u') { _why = 'M3U source has no series API'; return; }
        if (!cfg.server_url) { _why = 'profile has no server url'; return; }

        _fetching = true;
        _why = 'looking up season ' + _meta.season + ' of series ' + _meta.series_id;

        Net.json(Config.apiUrl(cfg, 'action=get_series_info&series_id=' +
                 encodeURIComponent(_meta.series_id)), { timeout: 12000 })
            .then(function (data) {
                var eps = (data && data.episodes) || {};
                var season = String(_meta.season);
                var list = eps[season] || eps[Number(season)] || null;

                /* Panels disagree about the season key's type, and some report a
                   different season than the one the episode is actually in — so
                   fall back to finding the episode by id. */
                if (!list) {
                    for (var k in eps) {
                        if (!Object.prototype.hasOwnProperty.call(eps, k)) continue;
                        for (var i = 0; i < eps[k].length; i++) {
                            if (String(eps[k][i].id) === String(_meta.id)) { list = eps[k]; break; }
                        }
                        if (list) break;
                    }
                }
                if (!list) {
                    var names = [];
                    for (var kk in eps) if (Object.prototype.hasOwnProperty.call(eps, kk)) names.push(kk);
                    _why = 'panel returned seasons [' + names.join(',') + '] — episode ' +
                           _meta.id + ' is in none of them';
                    settle();
                    return;
                }

                var pl = slimEpisodes(list);
                var idx = -1;
                for (var j = 0; j < pl.length; j++) {
                    if (String(pl[j].id) === String(_meta.id)) { idx = j; break; }
                }
                if (idx < 0) {
                    _why = 'season has ' + pl.length + ' episodes but none with id ' + _meta.id;
                    settle();
                    return;
                }

                _resolved = pl;
                _resolvedIndex = idx;
                _why = 'season fetched: ' + pl.length + ' episodes, this is #' + (idx + 1);
                settle();
            })
            ['catch'](function (err) {
                _why = 'season lookup failed: ' + ((err && err.message) || 'network error');
                settle();
            });
    }

    function nextEntry() {
        var pl = playlist(), i = index();
        if (!pl || i < 0 || i + 1 >= pl.length) return null;
        return pl[i + 1];
    }

    function hasNext() { return !!nextEntry(); }

    /* The subtitle result for the episode currently playing, when the season was
       resolved here. get_series_info carries each episode's subtitle payload, so
       looking up the season for Next episode also answers "what subtitles does
       this episode have" — player/subtitles.js reuses it rather than making the
       same request twice. Null when there is no resolved season. */
    function currentSubs() {
        var pl = playlist(), i = index();
        if (!pl || i < 0 || !pl[i]) return null;
        return pl[i].subs || null;
    }

    function nextLabel() {
        var e = nextEntry();
        if (!e) return '';
        return e.num !== '' && e.num != null ? 'Episode ' + e.num : (e.title || 'Next episode');
    }

    function playNext() {
        var pl = playlist(), i = index();
        if (!pl || i < 0 || i + 1 >= pl.length) return false;
        if (typeof _onPlay === 'function') { _onPlay(pl, i + 1, _meta); return true; }
        return false;
    }

    /* ── Skip intro ───────────────────────────────────────────────────────── */
    function introVisible() {
        if (!_video || !_meta || _meta.type !== 'episode') return false;
        var dur = _video.duration;
        if (!isFinite(dur) || dur < MIN_DURATION) return false;

        var t = _video.currentTime;
        var learned = learnedIntroEnd();
        if (learned > 0) return t < learned - 2 && t < INTRO_LEARNED_MAX;
        return t >= INTRO_OFFER_FROM && t <= INTRO_OFFER_TO;
    }

    /* Jump past the intro and remember where that was, so every later episode
       of the same series lands in exactly the same place. */
    function skipIntro() {
        if (!_video) return;
        var learned = learnedIntroEnd();
        var target  = learned > 0 ? learned : _video.currentTime + DEFAULT_INTRO_SKIP;
        var dur = _video.duration;
        if (isFinite(dur) && dur > 0) target = Math.min(target, dur - 5);
        if (!(target > 0)) return;
        try { _video.currentTime = target; } catch (e) {}
        rememberIntroEnd(target);
    }

    /* Forget a series' learned intro — offered in the player menu, because a
       skip learned from a mis-press otherwise sticks for every episode. */
    function forgetIntro() {
        var k = seriesKey();
        if (!k) return false;
        var map = introMap();
        if (!(k in map)) return false;
        delete map[k];
        Store.set(INTRO_KEY, map);
        return true;
    }

    function hasLearnedIntro() { return learnedIntroEnd() > 0; }

    /* ── Outro / end of episode ───────────────────────────────────────────── */
    function outroVisible() {
        if (!_video || !hasNext()) return false;
        var dur = _video.duration, t = _video.currentTime;
        if (!isFinite(dur) || dur <= 0) return false;
        return (dur - t <= OUTRO_TAIL_SEC) || (t / dur >= OUTRO_TAIL_PCT);
    }

    function init(opts) {
        _meta    = opts.meta || null;
        _metaNote = opts.metaNote || '';
        _video   = opts.video || null;
        _onPlay  = opts.onPlay || null;
        _onReady = opts.onReady || null;
        _resolved = null;
        _resolvedIndex = -1;
        _fetching = false;
        _why = '';
        /* Only reaches the network when the metadata didn't already carry the
           season, so the normal path costs nothing. */
        resolveSeason();
    }

    /* True while the season is still being fetched — the UI uses this to avoid
       declaring "no next episode" before the answer is in. */
    function resolving() { return _fetching; }

    /* The full picture, for the GREEN diagnostics overlay. "No next episode" is
       true for a dozen different reasons and useless on its own; this reports
       the facts the answer actually depends on. */
    function describe() {
        var pl = playlist(), i = index();
        var facts = 'meta=' + (_meta ? 'yes' : 'NO') +
                    ' type=' + ((_meta && _meta.type) || '-') +
                    ' sid=' + ((_meta && _meta.series_id) || '-') +
                    ' season=' + ((_meta && _meta.season) || '-') +
                    ' eps=' + (pl ? pl.length : 0) +
                    ' idx=' + i;
        var verdict = hasNext() ? ('next=' + nextLabel())
                    : _fetching ? 'looking up season...'
                    : 'no next episode';
        return verdict + '  |  ' + facts + (_why ? '  |  ' + _why : '');
    }

    return {
        INTRO_KEY: INTRO_KEY,
        AUTONEXT_SEC: AUTONEXT_SEC,
        DEFAULT_INTRO_SKIP: DEFAULT_INTRO_SKIP,
        init: init, resolving: resolving, describe: describe,
        hasNext: hasNext, nextEntry: nextEntry, currentSubs: currentSubs, nextLabel: nextLabel, playNext: playNext,
        introVisible: introVisible, skipIntro: skipIntro,
        forgetIntro: forgetIntro, hasLearnedIntro: hasLearnedIntro,
        outroVisible: outroVisible
    };
}());
