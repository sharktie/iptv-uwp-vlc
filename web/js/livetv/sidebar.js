/* livetv/sidebar.js — the left rail: favourites, groups, categories, and the
 * dialogs they open (rename, delete, assign-to-group).
 *
 * Two kinds of favourite live here and they behave differently on purpose. A
 * GROUP is a hand-curated set of channels. A starred CATEGORY is a standing
 * instruction — "everything in here" — resolved fresh on every filter, so
 * channels the provider adds later appear on their own. See data/favourites.js.
 *
 * Requires: livetv/state.js, data/favourites.js, livetv/channels.js.
 */

// ── Favourites ────────────────────────────────────────────────────────────────
// State and persistence live in data/favourites.js. These are the names the
// rest of the page (and dpad.js) call, kept as one-liners so there is exactly
// one copy of the list rather than a module's copy and a page's copy drifting
// apart — which is what happened when a category was starred from the sidebar
// and the channel list carried on filtering against a stale array.

function isFav(sid)     { return Favourites.isChannel(sid); }
function toggleFav(sid) { return Favourites.toggleChannel(sid); }
function favGroupsList() { return Favourites.groups(); }

function _reorderAndRefocus(sid, dir, subzone) {
    if (!Favourites.moveChannel(sid, dir)) return;   // already at an end
    _keepScrollOnApply = true;
    const channels = getFilteredChannels();
    const newIdx = channels.findIndex(ch => String(ch.stream_id) === sid);
    if (newIdx >= 0) tvRowIndex = newIdx;
    _vsSetChannels(channels, true);
    loadEPGForCurrentCategory();
    tvRowSubZone = subzone;
    tvFocusRowButtons();
}

function isInGroup(gid, sid)          { return Favourites.isInGroup(gid, sid); }
function toggleChannelInGroup(gid, sid) { return Favourites.toggleInGroup(gid, sid); }
function createFavGroup(name)         { return Favourites.createGroup(name); }
function renameFavGroup(id, name)     { return Favourites.renameGroup(id, name); }
function deleteFavGroup(id) {
    Favourites.deleteGroup(id);
    if (activeFavGroup === id) activeFavGroup = "all";
}

// ── Favourite categories ──────────────────────────────────────────────────────
// Starring a category is a standing instruction ("everything in here"), not a
// snapshot: it is resolved against the live channel list on every filter, so
// channels the provider adds later show up on their own.

let _categoryNames = new Map();   // category_id → name, for the sidebar labels

function toggleFavCategory(catId) {
    const nowFav = Favourites.toggleCategory("live", catId);
    renderFavSectionList();
    updateSidebarActive();
    // The category rows carry their own star, and the favourites view may have
    // just gained or lost a hundred channels.
    refreshCategoryStars();
    if (activeCategory === "favs") applyFilters();
    return nowFav;
}

function refreshCategoryStars() {
    document.querySelectorAll(".cat-star-btn[data-cat-id]").forEach(btn => {
        btn.classList.toggle("active", Favourites.isCategory("live", btn.dataset.catId));
    });
}


// ── Categories / sidebar ──────────────────────────────────────────────────────

function renderCategories(categories) {
    const container = document.getElementById("categories");
    container.innerHTML = "";

    const favSection = document.createElement("div");
    favSection.className = "cat-section"; favSection.id = "cat-section-favs";
    const favHdr = document.createElement("button");
    favHdr.className = "cat-section-hdr fav-section-hdr"; favHdr.id = "fav-section-hdr";
    favHdr.innerHTML = `<span class="section-star">★</span><span class="section-label">Favourites</span><span class="section-chevron">▾</span>`;
    favHdr.onclick = () => {
        const isOpen = favSection.classList.toggle("open");
        if (isOpen) { activeCategory = "favs"; activeFavGroup = "all"; updateSidebarActive(); applyFilters(); }
    };
    const favList = document.createElement("div");
    favList.className = "cat-section-list"; favList.id = "fav-section-list";
    favSection.appendChild(favHdr); favSection.appendChild(favList);
    container.appendChild(favSection);

    const allBtn = document.createElement("button");
    allBtn.className = "cat-btn"; allBtn.dataset.catId = "all"; allBtn.textContent = "All";
    allBtn.onclick = () => { activeCategory = "all"; activeFavGroup = "all"; updateSidebarActive(); applyFilters(); };
    container.appendChild(allBtn);

    const visibleCats = categories.filter(cat => !_hiddenCatsLive.has(String(cat.category_id)));
    _categoryNames = new Map(categories.map(c => [String(c.category_id), c.category_name || "Unnamed"]));

    if (visibleCats.length) {
        const catSection = document.createElement("div");
        catSection.className = "cat-section"; catSection.id = "cat-section-cats";
        const catHdr = document.createElement("button");
        catHdr.className = "cat-section-hdr";
        catHdr.innerHTML = `<span class="section-label">Categories</span><span class="section-chevron">▾</span>`;
        catHdr.onclick = () => catSection.classList.toggle("open");
        const catList = document.createElement("div");
        catList.className = "cat-section-list";
        const frag = document.createDocumentFragment();
        visibleCats.forEach(cat => {
            frag.appendChild(makeCategoryRow(cat, catSection));
        });
        catList.appendChild(frag);
        catSection.appendChild(catHdr); catSection.appendChild(catList);
        container.appendChild(catSection);
    }

    renderFavSectionList();
}

/* A category row is two controls, not one: the name jumps to the category, the
   star adds the whole category to Favourites. Same shape as a channel row
   (name + ★), so the D-pad rule is the one the user already knows — RIGHT from
   the name lands on the star. */
function makeCategoryRow(cat, catSection) {
    const id = String(cat.category_id);

    const row = document.createElement("div");
    row.className = "cat-row";
    row.dataset.catId = id;

    const btn = document.createElement("button");
    btn.className = "cat-btn cat-sub-btn"; btn.dataset.catId = id;
    btn.textContent = cat.category_name || "Unnamed";
    btn.onclick = () => {
        activeCategory = id; activeFavGroup = "all";
        catSection.classList.add("open");
        updateSidebarActive(); applyFilters();
    };

    const star = document.createElement("button");
    star.className = "cat-star-btn" + (Favourites.isCategory("live", id) ? " active" : "");
    star.dataset.catId = id;
    star.textContent = "★";
    star.title = "Add this whole category to Favourites";
    star.setAttribute("aria-label", "Favourite category " + (cat.category_name || ""));
    star.onclick = e => { e.stopPropagation(); toggleFavCategory(id); };

    row.appendChild(btn);
    row.appendChild(star);
    return row;
}

function updateSidebarActive() {
    document.querySelectorAll(".cat-btn, .cat-sub-btn, .cat-section-hdr").forEach(b => b.classList.remove("active"));
    if (activeCategory === "favs") {
        const hdr = document.getElementById("fav-section-hdr");
        if (hdr) hdr.classList.add("active");
        document.querySelectorAll("[data-fav-group]").forEach(btn => btn.classList.toggle("active", btn.dataset.favGroup === activeFavGroup));
    } else if (activeCategory === "all") {
        document.querySelector(".cat-btn[data-cat-id='all']")?.classList.add("active");
    } else {
        document.querySelectorAll(".cat-sub-btn[data-cat-id]").forEach(btn => btn.classList.toggle("active", btn.dataset.catId === String(activeCategory)));
        document.getElementById("cat-section-cats")?.classList.add("open");
    }
}

function renderFavSectionList() {
    const list = document.getElementById("fav-section-list");
    if (!list) return;
    list.innerHTML = "";
    const mkItem = (text, groupId) => {
        const btn = document.createElement("button");
        const isActive = activeCategory === "favs" && activeFavGroup === groupId;
        btn.className = "cat-sub-btn" + (isActive ? " active" : "");
        btn.dataset.favGroup = groupId; btn.textContent = text;
        btn.onclick = () => { activeCategory = "favs"; activeFavGroup = groupId; document.getElementById("cat-section-favs")?.classList.add("open"); updateSidebarActive(); applyFilters(); };
        list.appendChild(btn); return btn;
    };
    mkItem("All", "all");

    favGroupsList().forEach(g => {
        const btn = mkItem(g.name, g.id);
        btn.ondblclick    = e => { e.stopPropagation(); promptRenameGroup(g.id, g.name); };
        btn.oncontextmenu = e => { e.preventDefault(); showGroupContextMenu(e, g.id); };
    });

    /* Starred categories sit alongside the groups, marked so they read as what
       they are — a live view of a provider category, not a set someone curated.
       Each carries its own star to unstar it from here, because hunting back
       through the Categories list to undo it is the obvious annoyance. */
    const favCats = Favourites.categories("live");
    if (favCats.length) {
        const head = document.createElement("div");
        head.className = "fav-cat-header";
        head.textContent = "Categories";
        list.appendChild(head);

        favCats.forEach(catId => {
            const row = document.createElement("div");
            row.className = "cat-row";

            const key = "cat:" + catId;
            const isActive = activeCategory === "favs" && activeFavGroup === key;
            const btn = document.createElement("button");
            btn.className = "cat-sub-btn fav-cat-item" + (isActive ? " active" : "");
            btn.dataset.favGroup = key;
            btn.textContent = _categoryNames.get(String(catId)) || ("Category " + catId);
            btn.onclick = () => {
                activeCategory = "favs"; activeFavGroup = key;
                document.getElementById("cat-section-favs")?.classList.add("open");
                updateSidebarActive(); applyFilters();
            };

            const star = document.createElement("button");
            star.className = "cat-star-btn active";
            star.dataset.catId = String(catId);
            star.textContent = "★";
            star.title = "Remove this category from Favourites";
            star.onclick = e => {
                e.stopPropagation();
                if (activeFavGroup === key) activeFavGroup = "all";
                toggleFavCategory(catId);
            };

            row.appendChild(btn);
            row.appendChild(star);
            list.appendChild(row);
        });
    }

    const addBtn = document.createElement("button");
    addBtn.className = "cat-add-grp-btn"; addBtn.textContent = "+ New Group";
    addBtn.onclick = () => promptNewGroup();
    list.appendChild(addBtn);
}


// ── Group context menu ────────────────────────────────────────────────────────

function promptNewGroup() {
    showInputModal("New Favourite Group", "Group name", "", name => { if (!name) return; createFavGroup(name); renderFavSectionList(); });
}
function promptRenameGroup(id, currentName) {
    showInputModal("Rename Group", "Group name", currentName, name => { if (!name) return; renameFavGroup(id, name); renderFavSectionList(); });
}

function showGroupContextMenu(e, gid) {
    closeContextMenus();
    const menu = document.createElement("div");
    menu.className = "ctx-menu"; menu.style.cssText = `left:${e.clientX}px;top:${e.clientY}px`;
    const mkItem = (text, danger, fn) => {
        const item = document.createElement("div");
        item.className = "ctx-item" + (danger ? " ctx-danger" : ""); item.textContent = text;
        item.onclick = () => { closeContextMenus(); fn(); }; menu.appendChild(item);
    };
    mkItem("Rename", false, () => { const g = Favourites.findGroup(gid); if (g) promptRenameGroup(gid, g.name); });
    mkItem("Delete Group", true, () => { if (confirm("Delete this group? Channels stay in Favourites.")) { deleteFavGroup(gid); renderFavSectionList(); applyFilters(); } });
    document.body.appendChild(menu);
    _ctxMenuIndex = 0;
    const items = Array.from(menu.querySelectorAll(".ctx-item"));
    _focusCtxItem(menu, items);
    // Removed by hand: `{ once: true }` is ignored before Chromium 55, which
    // left one more permanent capture-phase listener per menu opened.
    const dismiss = () => { document.removeEventListener("click", dismiss); closeContextMenus(); };
    setTimeout(() => document.addEventListener("click", dismiss), 0);
}
function closeContextMenus() { document.querySelectorAll(".ctx-menu").forEach(m => m.remove()); }


// ── Assign panel ──────────────────────────────────────────────────────────────

function showAssignPanel(e, sid, anchorEl) {
    e.stopPropagation(); closeAssignPanels();
    if (!favGroupsList().length) { promptNewGroup(); return; }
    history.pushState(null, "");
    _assignHistoryPushed = true;
    const panel = document.createElement("div");
    panel.className = "assign-panel";
    const title = document.createElement("div"); title.className = "assign-title"; title.textContent = "Add to group";
    panel.appendChild(title);
    favGroupsList().forEach(g => {
        const row = document.createElement("label"); row.className = "assign-row";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = isInGroup(g.id, sid);
        cb.onchange = () => { toggleChannelInGroup(g.id, sid); updateAssignBtnState(sid); };
        const span = document.createElement("span"); span.textContent = g.name;
        row.appendChild(cb); row.appendChild(span); panel.appendChild(row);
    });
    const newBtn = document.createElement("button"); newBtn.className = "assign-new-btn"; newBtn.textContent = "+ New Group";
    newBtn.onclick = () => { closeAssignPanels(true); promptNewGroup(); };
    panel.appendChild(newBtn);
    const rect = anchorEl.getBoundingClientRect();
    panel.style.cssText = `position:fixed;right:${window.innerWidth - rect.right}px;top:${rect.bottom + 4}px`;
    document.body.appendChild(panel);
    _assignPanelIndex = 0;
    const items = Array.from(panel.querySelectorAll(".assign-row, .assign-new-btn"));
    _focusAssignItem(panel, items);
}
let _assignHistoryPushed = false;

function closeAssignPanels(popHistory = false) {
    document.querySelectorAll(".assign-panel").forEach(p => p.remove());
    if (popHistory && _assignHistoryPushed) {
        _assignHistoryPushed = false;
        history.back();
    } else {
        _assignHistoryPushed = false;
    }
}
function updateAssignBtnState(sid) {
    const entry = rowCache.get(String(sid));
    if (!entry?.assignBtn) return;
    entry.assignBtn.classList.toggle("active", Favourites.inAnyGroup(sid));
}


// ── Input modal ───────────────────────────────────────────────────────────────

function showInputModal(heading, label, value, callback) {
    const overlay = document.createElement("div"); overlay.className = "modal-overlay";
    const box     = document.createElement("div"); box.className = "modal-box";
    const h       = document.createElement("div"); h.className = "modal-heading"; h.textContent = heading;
    const inp     = document.createElement("input"); inp.className = "modal-input"; inp.type = "text"; inp.value = value; inp.placeholder = label;
    const btns    = document.createElement("div"); btns.className = "modal-btns";
    const cancel  = document.createElement("button"); cancel.className = "modal-btn"; cancel.textContent = "Cancel"; cancel.onclick = () => overlay.remove();
    const ok      = document.createElement("button"); ok.className = "modal-btn modal-btn-ok"; ok.textContent = "OK"; ok.onclick = () => { overlay.remove(); callback(inp.value.trim()); };
    inp.onkeydown = e => {
        if (e.key === "Enter")  { e.preventDefault(); ok.click(); }
        if (e.key === "Escape") { e.preventDefault(); overlay.remove(); }
    };
    btns.appendChild(cancel); btns.appendChild(ok);
    box.appendChild(h); box.appendChild(inp); box.appendChild(btns);
    overlay.appendChild(box); document.body.appendChild(overlay);
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
}
