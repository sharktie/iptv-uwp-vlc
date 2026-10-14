/* data/favourites.js — everything the user has marked as a favourite, in one
 * place. Exposes window.Favourites.
 *
 * Three kinds, deliberately kept distinct rather than flattened together:
 *
 *   channels    individual stream ids, in the order the user arranged them
 *   groups      named sets of those channels ("Sport", "Kids")
 *   categories  whole provider categories, stored by category id
 *
 * The third is the one that behaves differently, and the difference is the
 * point. A favourited CATEGORY is resolved to its channels every time it is
 * read, never expanded and stored. So when the provider adds three channels to
 * "UK | Sports" overnight, they are simply there the next morning — whereas
 * expanding the category at the moment it was starred would have frozen it, and
 * the user would have to notice and re-star it. It also survives the provider
 * renumbering its channels, which happens more often than you would like.
 *
 * The cost of resolving late is that a favourited category contributes nothing
 * until the channel list has loaded. That is fine: nothing can be displayed
 * before then anyway.
 *
 * Keys are shared across profiles, as they always have been. Two profiles from
 * the same provider genuinely do share stream ids, and silently emptying
 * someone's favourites list to namespace it would be a worse bug than the one
 * it fixes.
 *
 * ES5 — Babel target is Chrome 38.                                            */
window.Favourites = (function () {
    'use strict';

    var K_CHANNELS = 'iptv_favourites';
    var K_GROUPS   = 'iptv_fav_groups';
    var K_CATS = {
        live:   'iptv_fav_cats_live',
        movie:  'iptv_fav_cats_vod_m',
        series: 'iptv_fav_cats_vod_s'
    };

    function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

    function ids(key) {
        var v = Store.get(key, []);
        if (!v || !isArr(v)) return [];
        return v.map(String);
    }

    /* ── Channels ─────────────────────────────────────────────────────────── */
    var _channels = ids(K_CHANNELS);
    var _channelSet = toSet(_channels);

    function toSet(arr) {
        var s = {};
        for (var i = 0; i < arr.length; i++) s[arr[i]] = 1;
        return s;
    }

    function channels() { return _channels.slice(); }
    function isChannel(sid) { return _channelSet[String(sid)] === 1; }

    function toggleChannel(sid) {
        sid = String(sid);
        if (_channelSet[sid]) {
            _channels = _channels.filter(function (x) { return x !== sid; });
            delete _channelSet[sid];
        } else {
            _channels = _channels.concat([sid]);
            _channelSet[sid] = 1;
        }
        Store.set(K_CHANNELS, _channels);
        return !!_channelSet[sid];
    }

    /* Reorder within the favourites list. Returns true when something moved, so
       callers know whether to repaint. */
    function moveChannel(sid, dir) {
        sid = String(sid);
        var i = _channels.indexOf(sid), j = i + dir;
        if (i < 0 || j < 0 || j >= _channels.length) return false;
        var tmp = _channels[i];
        _channels[i] = _channels[j];
        _channels[j] = tmp;
        Store.set(K_CHANNELS, _channels);
        return true;
    }

    /* ── Groups ───────────────────────────────────────────────────────────────
       Validated on the way in, the same way ids() validates the channel and
       category lists. These keys are deliberately long-lived and shared across
       profiles, so they outlive format changes; taking the stored value on
       trust meant a non-array root turned push/filter into a TypeError, and a
       single entry missing channelIds did the same to indexOf — thrown from the
       sidebar's render path, so the whole sidebar went rather than the app
       degrading to "no groups". */
    function loadGroups() {
        var raw = Store.get(K_GROUPS, []);
        if (!isArr(raw)) return [];
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var g = raw[i];
            if (!g || typeof g !== 'object' || isArr(g)) continue;
            out.push({
                id:         String(g.id || ('fg_legacy_' + i)),
                name:       String(g.name === undefined || g.name === null ? '' : g.name),
                channelIds: isArr(g.channelIds) ? g.channelIds.map(String) : []
            });
        }
        return out;
    }

    var _groups = loadGroups();

    function groups() { return _groups; }
    function saveGroups() { Store.set(K_GROUPS, _groups); }

    function createGroup(name) {
        /* Randomised as well as timestamped: two groups created in the same
           millisecond would otherwise share an id, and findGroup returns the
           first match — so renaming or deleting one would hit the other. */
        var g = {
            id: 'fg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: String(name || '').trim(),
            channelIds: []
        };
        _groups.push(g);
        saveGroups();
        return g;
    }
    function renameGroup(id, name) {
        var g = findGroup(id);
        if (g) { g.name = String(name || '').trim(); saveGroups(); }
    }
    function deleteGroup(id) {
        _groups = _groups.filter(function (x) { return x.id !== id; });
        saveGroups();
    }
    function findGroup(id) {
        for (var i = 0; i < _groups.length; i++) if (_groups[i].id === id) return _groups[i];
        return null;
    }
    function isInGroup(gid, sid) {
        var g = findGroup(gid);
        return !!(g && g.channelIds.indexOf(String(sid)) !== -1);
    }
    function toggleInGroup(gid, sid) {
        var g = findGroup(gid);
        if (!g) return false;
        sid = String(sid);
        var i = g.channelIds.indexOf(sid);
        if (i === -1) g.channelIds.push(sid); else g.channelIds.splice(i, 1);
        saveGroups();
        return i === -1;
    }
    /* Any group at all containing this channel — drives the "+" button's lit
       state without the caller having to walk every group itself. */
    function inAnyGroup(sid) {
        sid = String(sid);
        for (var i = 0; i < _groups.length; i++) {
            if (_groups[i].channelIds.indexOf(sid) !== -1) return true;
        }
        return false;
    }

    /* ── Categories ───────────────────────────────────────────────────────────
       `kind` is 'live' | 'movie' | 'series'. Live TV and the two VOD sections
       keep separate lists because their category ids come from different
       namespaces on the panel and do collide. */
    var _cats = {
        live:   ids(K_CATS.live),
        movie:  ids(K_CATS.movie),
        series: ids(K_CATS.series)
    };

    function categories(kind) { return (_cats[kind] || []).slice(); }

    function isCategory(kind, catId) {
        var list = _cats[kind] || [];
        return list.indexOf(String(catId)) !== -1;
    }

    function toggleCategory(kind, catId) {
        if (!_cats[kind]) return false;
        catId = String(catId);
        var i = _cats[kind].indexOf(catId);
        if (i === -1) _cats[kind].push(catId); else _cats[kind].splice(i, 1);
        Store.set(K_CATS[kind], _cats[kind]);
        return i === -1;
    }

    function hasCategories(kind) { return (_cats[kind] || []).length > 0; }

    /* ── Resolution ───────────────────────────────────────────────────────────
       The favourites VIEW: individually starred channels first, in the order
       the user arranged them, then everything from starred categories that
       isn't already listed.

       Ordering matters and is not arbitrary. Hand-picked favourites are the
       ones someone reordered deliberately, so they keep their positions at the
       top; a starred category is a bulk "and also all of these", which belongs
       underneath in the provider's own order. Merging the two by provider order
       would silently destroy a favourites list the user had arranged by hand. */
    function resolveChannels(allChannels) {
        if (!allChannels || !allChannels.length) return [];

        var byId = {};
        for (var i = 0; i < allChannels.length; i++) {
            byId[String(allChannels[i].stream_id)] = allChannels[i];
        }

        var out = [], seen = {};
        for (var f = 0; f < _channels.length; f++) {
            var ch = byId[_channels[f]];
            if (ch && !seen[_channels[f]]) { seen[_channels[f]] = 1; out.push(ch); }
        }

        var favCats = _cats.live;
        if (favCats.length) {
            var catSet = toSet(favCats);
            for (var c = 0; c < allChannels.length; c++) {
                var candidate = allChannels[c];
                var sid = String(candidate.stream_id);
                if (seen[sid]) continue;
                if (!catSet[String(candidate.category_id)]) continue;
                seen[sid] = 1;
                out.push(candidate);
            }
        }
        return out;
    }

    /* Channels in one favourite group. Groups hold explicit ids only — a group
       is a hand-curated set, so pulling in whole categories would defeat it. */
    function resolveGroup(gid, allChannels) {
        var g = findGroup(gid);
        if (!g || !allChannels || !allChannels.length) return [];
        var wanted = toSet(g.channelIds.map(String));
        var out = [];
        for (var i = 0; i < allChannels.length; i++) {
            if (wanted[String(allChannels[i].stream_id)]) out.push(allChannels[i]);
        }
        /* Ordered by the group's own list, not the provider's, so reordering a
           group actually reorders it. */
        out.sort(function (a, b) {
            return g.channelIds.indexOf(String(a.stream_id)) - g.channelIds.indexOf(String(b.stream_id));
        });
        return out;
    }

    /* Every channel inside one starred category — used by the sidebar entry
       that jumps straight to a favourited category. */
    function resolveCategory(catId, allChannels) {
        catId = String(catId);
        var out = [];
        for (var i = 0; i < allChannels.length; i++) {
            if (String(allChannels[i].category_id) === catId) out.push(allChannels[i]);
        }
        return out;
    }

    /* Whether anything at all has been favourited — decides whether Live TV
       opens on Favourites or on All. */
    function isEmpty() {
        return !_channels.length && !_cats.live.length;
    }

    return {
        K_CHANNELS: K_CHANNELS, K_GROUPS: K_GROUPS, K_CATS: K_CATS,

        channels: channels, isChannel: isChannel,
        toggleChannel: toggleChannel, moveChannel: moveChannel,

        groups: groups, createGroup: createGroup, renameGroup: renameGroup,
        deleteGroup: deleteGroup, findGroup: findGroup,
        isInGroup: isInGroup, toggleInGroup: toggleInGroup, inAnyGroup: inAnyGroup,

        categories: categories, isCategory: isCategory,
        toggleCategory: toggleCategory, hasCategories: hasCategories,

        resolveChannels: resolveChannels, resolveGroup: resolveGroup,
        resolveCategory: resolveCategory, isEmpty: isEmpty
    };
}());
