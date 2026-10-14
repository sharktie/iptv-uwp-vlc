/* player/subtitles.js — makes sure the player ends up with whatever subtitles
 * actually exist, however it was reached. Exposes window.PlayerSubs.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Subtitles used to arrive one way only: the VOD page resolved them and passed
 * them through the play metadata. That handover had exactly the weakness the
 * next-episode season had — several ways to come up empty, none of them
 * visible:
 *
 *   • the VOD page races its subtitle lookup against a 2-second cap so a slow
 *     panel cannot delay playback. Win the race and you get subtitles; lose it
 *     and you get none, permanently, for a title that has them
 *   • resuming from Continue Watching, or arriving by any route that did not go
 *     through the episode list, carried nothing
 *   • a rejected metadata handover took the subtitles with it
 *
 * So the player now resolves them itself as well, AFTER playback has started.
 * That inverts the trade: the VOD side no longer has to choose between waiting
 * and losing subtitles, because anything it misses is picked up here a moment
 * later and attached to a stream that is already running.
 *
 * Order of preference, stopping at the first that yields files:
 *   1. what the handover carried                   — instant, no request
 *   2. the season already fetched for Next episode — free, no extra request
 *   3. get_vod_info / get_series_info              — one request
 *   4. a sidecar file next to the stream           — speculative, guarded
 *
 * ES5 — Babel target is Chrome 38.                                            */
window.PlayerSubs = (function () {
    'use strict';

    var _meta   = null;
    var _url    = '';        // the stream url, which survives even when meta doesn't
    var _note   = '';        // why the handover was rejected, if it was
    var _player = null;
    var _source = '';        // where the attached files came from, or why none
    var _shape  = '';        // what the panel's reply actually contained
    var _probe  = '';        // what the sidecar probe did, and what it found
    var _found  = null;      // last { files, embedded, unknown }
    var _busy   = false;
    var _done   = false;     // stop once files are attached
    var _probed = false;

    function cfg() {
        try { return Config.resolve(); } catch (e) { return null; }
    }

    function empty() { return { files: [], embedded: [], unknown: 0 }; }
    function hasFiles(r) { return !!(r && r.files && r.files.length); }

    /* Shown while the season lookup is in flight. Held in a constant because
       resolve() has to recognise its own placeholder to clear it — a note that
       outlives the wait it described is worse than no note. */
    var WAITING = 'waiting for the season lookup';

    /* Hand a result to the player: files become <track>s, and the embedded list
       is what lets the subtitle menu explain an empty list truthfully instead of
       claiming the title has none. Returns true once real files are attached. */
    function apply(result, source) {
        if (!result || !_player) return false;
        _found = result;
        /* Only claim a source when the result actually carried something. An
           empty handover is not "where the subtitles came from" — recording it
           as one would mask the step that really answered, or the reason
           nothing did. */
        if (source && (hasFiles(result) || (result.embedded || []).length)) _source = source;

        if (_player.setEmbeddedSubInfo) {
            _player.setEmbeddedSubInfo(result.embedded || [], result.unknown || 0);
        }
        if (hasFiles(result) && _player.addExternalSubs) {
            _player.addExternalSubs(result.files);
            _done = true;
            return true;
        }
        return false;
    }

    /* ── The chain ────────────────────────────────────────────────────────── */
    function resolve() {
        /* Deliberately NOT gated on _meta. A rejected handover still plays —
           the player falls back to the url in its own query string — so the one
           case that most needs a second lookup is exactly the case that used to
           skip it. Everything below copes with a null _meta by degrading to the
           sidecar probe, which only needs the stream url. */
        if (_done || _busy || !_player) return;
        if (_source === WAITING) _source = '';

        /* 2. The season fetched for Next episode already carries this episode's
              subtitle payload — use it before making any request of our own. */
        if (typeof Episodes !== 'undefined' && Episodes.currentSubs) {
            var fromSeason = Episodes.currentSubs();
            if (fromSeason && (hasFiles(fromSeason) || (fromSeason.embedded || []).length)) {
                if (apply(fromSeason, 'season lookup')) return;
            }
        }

        var c = cfg();
        if (!c || c.type === 'm3u' || !c.server_url) {
            if (!_source) _source = 'no Xtream profile to ask';
            return;
        }
        if (typeof Net === 'undefined' || typeof Subs === 'undefined') return;

        /* 3. Ask the panel directly. */
        if (_meta && _meta.type === 'movie' && _meta.id) {
            _busy = true;
            Net.json(Config.apiUrl(c, 'action=get_vod_info&vod_id=' + encodeURIComponent(_meta.id)),
                     { timeout: 12000 })
                .then(function (data) {
                    _busy = false;
                    var r = Subs.fromVodInfo(data, c);
                    if (apply(r, 'get_vod_info')) return;
                    /* The request worked; it simply listed nothing playable.
                       Saying "get_vod_info" here would read like a source that
                       supplied something, so say what actually happened — and
                       describe the reply, because "we found none" and "we could
                       not read what it sent" need opposite responses. */
                    _source = (r.embedded || []).length
                        ? 'panel lists only embedded tracks'
                        : 'panel lists no subtitles';
                    _shape = Subs.describePayload ? Subs.describePayload(data) : '';
                    recordReply(data, r);
                    probeSidecar(r);
                })['catch'](function (err) {
                    _busy = false;
                    _source = 'get_vod_info failed: ' + ((err && err.message) || 'network error');
                    probeSidecar(empty());
                });
            return;
        }

        /* An episode with no season resolved yet: Episodes is probably still
           fetching and its onReady calls refresh() here, so don't duplicate the
           request — just wait. Episodes signals every outcome including its
           failures, so this cannot wait forever. */
        if (_meta && _meta.type === 'episode' &&
            typeof Episodes !== 'undefined' && Episodes.resolving && Episodes.resolving()) {
            _source = WAITING;
            return;
        }

        probeSidecar(_found || empty());
    }

    /* Keep the reply somewhere it can be read after playback ends. The GREEN
       overlay is live but gone the moment you leave the player, and it can only
       show what fits on screen. Settings → Diagnostics persists and has room —
       which is what "does this provider EVER return subtitles" needs, as
       opposed to "did it for this title". */
    function recordReply(data, result) {
        if (typeof Subs === 'undefined' || !Subs.recordDiag) return;
        try {
            Subs.recordDiag((_meta && (_meta.name || _meta.title)) || '', result, {
                source:     'player · get_vod_info',
                panelShape: Subs.describePayload ? Subs.describePayload(data) : '',
                panelRaw:   Subs.rawSample ? Subs.rawSample(data) : ''
            });
        } catch (e) {}
    }

    /* 4. Last resort: a file sitting next to the stream that the panel never
          mentioned. Guarded inside Subs.probeSidecars so it cannot pull down a
          movie by mistake, and only ever attempted once. */
    function probeSidecar(base) {
        if (_probed || _done) return;
        _probed = true;
        if (!_url) {
            _probe = 'sidecar: skipped, no stream url';
            if (!_source) _source = 'no stream url to probe';
            return;
        }
        if (typeof Subs === 'undefined' || !Subs.probeSidecars) {
            _probe = 'sidecar: skipped, Subs unavailable';
            return;
        }

        _probe = 'sidecar: looking…';
        Subs.probeSidecars(_url).then(function (found) {
            /* Name every candidate and its outcome. "None next to the stream"
               on its own was indistinguishable from a probe that rejected the
               file it found — which is exactly what was happening. */
            var log = Subs.probeLog ? Subs.probeLog() : [];
            _probe = 'sidecar: ' + (found.length ? found.length + ' found' : 'none') +
                     (log.length ? ' — ' + log.join('; ') : '');
            if (!found.length) {
                if (!_source) _source = 'provider has none';
                return;
            }
            apply({
                files:    found,
                embedded: (base && base.embedded) || [],
                unknown:  (base && base.unknown) || 0
            }, 'sidecar file');
        })['catch'](function (err) {
            _probe = 'sidecar: probe failed (' + ((err && err.message) || 'network error') + ')';
        });
    }

    /* ── Entry points ─────────────────────────────────────────────────────── */
    function init(opts) {
        _meta   = opts.meta || null;
        _player = opts.player || null;
        /* The url is taken separately because it is the one thing that survives
           a rejected handover: the player is playing it from its own query
           string, so it is still the right thing to probe alongside. */
        _url    = opts.url || (_meta && _meta.url) || '';
        _note   = opts.metaNote || '';
        _source = '';
        _shape  = '';
        _probe  = '';
        _found  = null;
        _busy   = false;
        _done   = false;
        _probed = false;

        if (!_player) return;

        /* 1. Whatever the handover carried, applied immediately — the normal
              path, and it costs nothing. A null meta (rejected handover) still
              lands here so the chain below runs from scratch. */
        if (_meta) {
            var handed = {
                files:    _meta.subs || [],
                embedded: _meta.subs_embedded || [],
                unknown:  _meta.subs_unknown || 0
            };
            if (apply(handed, 'play metadata')) return;
        }

        resolve();
    }

    /* Called again once the season arrives, since that may be where this
       episode's subtitles were. */
    function refresh() { resolve(); }

    /* One line for the GREEN diagnostics overlay: where the loaded subtitles
       came from, or why there are none. The same question the episode line
       answers for Next episode. */
    function describe() {
        if (!_player) return 'not started';
        var files = (_found && _found.files) ? _found.files.length : 0;
        var emb   = (_found && _found.embedded) ? _found.embedded.length : 0;
        var langs = [];
        for (var i = 0; i < emb && i < 4; i++) {
            var n = (typeof Subs !== 'undefined' && Subs.langName(_found.embedded[i].lang)) ||
                    _found.embedded[i].label;
            if (n && langs.indexOf(n) === -1) langs.push(n);
        }
        return 'files=' + files + ' embedded=' + emb +
               (langs.length ? ' [' + langs.join(', ') + ']' : '') +
               (_busy ? '  |  looking…' : '') +
               (_source ? '  |  ' + _source : '') +
               /* A rejected handover is the difference between "this title has
                  no subtitles" and "the ones it had never reached the player",
                  so it belongs on this line rather than only on the episode one. */
               (_note  ? '  |  handover: ' + _note : '') +
               (_probe ? '  |  ' + _probe : '') +
               /* Last, and on its own line: the longest part, and the one that
                  only matters once the shorter answers have failed to explain. */
               (_shape ? '\n          panel sent: ' + _shape : '');
    }

    return { init: init, refresh: refresh, describe: describe };
}());
