/* =====================================================================
   The controls at the end of a project card: favourite, copy link, menu.

   Shared because /projects and /deployments draw the SAME card, and the
   app-card CSS already carries a comment about the last time those two
   drifted — tile colour came to mean build type on one page and a hash of
   the key on the other, so one app was two different colours depending
   which page you looked at. This is the other half of that card, and it
   was about to be copied rather than shared.

   The parts that must be identical live here: the markup, the menu shell,
   its positioning, the star and its request. The parts that genuinely
   differ stay with the page and arrive through init() — /projects can
   rename and delete a project because that is what /projects is for;
   /deployments deliberately cannot, because it already has a Delete that
   removes the DEPLOYMENT and two different deletes on one page is how
   somebody loses an app they meant to keep.
   ===================================================================== */
(function () {
  "use strict";
  if (window.CardActions) return;          // already loaded on this page

  var IC = {
    dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l-2 6 6-2"/><path d="M12 15l-3-3c1-5 5-9 10-9 0 5-4 9-9 10z"/></svg>'
  };

  function esc(t) {
    var d = document.createElement("span");
    d.textContent = t == null ? "" : t;
    return d.innerHTML;
  }

  var cfg = null;          // set by init()
  var pmenu = null;
  var menuFor = null, menuBtnEl = null;

  /* ---- markup ----
     onclick="event.preventDefault()" on each button because the card around
     them is an <a> on one page and a <button> on the other; without it,
     pressing the star also opens the project. */
  function actionsHTML(p) {
    var slug = p.slug || p.key || "";
    var on = p.favorite ? " on" : "";
    return '<span class="card-acts">' +
      '<button type="button" class="ca-star' + on + '" data-ca-slug="' + esc(slug) + '"' +
      ' data-ca-fav="' + (p.favorite ? "1" : "0") + '" aria-label="Favourite"' +
      ' title="Favourite" onclick="event.preventDefault()">' + IC.star + '</button>' +
      '<button type="button" class="ca-link" data-ca-copy="' + esc(slug) + '"' +
      ' aria-label="Copy link" title="Copy link" onclick="event.preventDefault()">' + IC.link + '</button>' +
      '<button type="button" class="ca-more" data-ca-menu="' + esc(slug) + '"' +
      ' aria-label="Project options" aria-haspopup="menu"' +
      ' onclick="event.preventDefault()">' + IC.dots + '</button></span>';
  }

  function closeMenu() {
    if (pmenu) pmenu.classList.remove("open");
    if (menuBtnEl) menuBtnEl.classList.remove("on");
    menuFor = null; menuBtnEl = null;
  }

  function openMenu(btn, p) {
    menuFor = p; menuBtnEl = btn;
    btn.classList.add("on");

    var html = "";
    if (cfg.onDetails) html += '<button type="button" data-ca-do="details">' + IC.info + "Details</button>";
    if (cfg.onOpen) html += '<button type="button" data-ca-do="open">' + IC.rocket + esc(cfg.openLabel || "Open") + "</button>";
    if (cfg.onRename) html += '<button type="button" data-ca-do="rename">' + IC.rename + "Rename</button>";
    html += '<button type="button" data-ca-do="link">' + IC.link + "Copy link</button>";
    html += '<button type="button" data-ca-do="fav">' + IC.star +
      (p.favorite ? "Remove from favourites" : "Add to favourites") + "</button>";
    if (cfg.onDelete) {
      html += '<div class="sep"></div>' +
        '<button type="button" class="danger" data-ca-do="del">' + IC.trash + "Delete</button>";
    }
    pmenu.innerHTML = html;
    pmenu.classList.add("open");

    /* Measured after it is visible, then flipped up or pulled left if the
       card it belongs to is near an edge. */
    var r = btn.getBoundingClientRect();
    var w = pmenu.offsetWidth, h = pmenu.offsetHeight;
    var left = Math.min(r.right - w, innerWidth - w - 8);
    var top = r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6;
    pmenu.style.left = Math.max(8, left) + "px";
    pmenu.style.top = Math.max(8, top) + "px";
  }

  function copyLink(slug, btn) {
    var url = cfg.linkFor ? cfg.linkFor(slug) : (location.origin + "/agent/" + slug);
    var done = function () {
      if (!btn) return;
      var was = btn.getAttribute("title");
      btn.setAttribute("title", "Copied");
      btn.classList.add("copied");
      setTimeout(function () {
        btn.setAttribute("title", was || "Copy link");
        btn.classList.remove("copied");
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { });
      return;
    }
    /* No clipboard API on an insecure origin, which is exactly where this
       runs in local development. */
    var ta = document.createElement("textarea");
    ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (err) { /* nothing to offer */ }
    document.body.removeChild(ta);
  }

  function setFavorite(slug, next) {
    return fetch("/api/codeagent/" + encodeURIComponent(slug) + "/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ favorite: next })
    }).catch(function () { });
  }

  /**
   * @param {object} o
   *   getProject(slug)  -> the page's own row for that slug, or null
   *   onChanged()       -> repaint, after a favourite toggles
   *   linkFor(slug)     -> the URL "Copy link" should copy
   *   onDetails/onRename/onDelete/onOpen(p) -> optional; each omitted
   *                        handler drops its menu item rather than showing
   *                        a control that does nothing
   *   openLabel         -> label for the onOpen item
   */
  function init(o) {
    cfg = o || {};

    /* One menu element for the whole page, moved to whichever card asked
       for it. A menu per card would be rebuilt and re-bound on every
       render, and there can be two hundred. */
    pmenu = document.createElement("div");
    pmenu.className = "pmenu";
    pmenu.setAttribute("role", "menu");
    document.body.appendChild(pmenu);

    document.addEventListener("click", function (e) {
      if (!e.target || !e.target.closest) return;

      var star = e.target.closest(".ca-star");
      if (star) {
        e.preventDefault(); e.stopPropagation();
        var next = star.dataset.caFav !== "1";
        star.classList.toggle("on", next);
        star.dataset.caFav = next ? "1" : "0";
        var sp = cfg.getProject && cfg.getProject(star.dataset.caSlug);
        if (sp) sp.favorite = next;
        setFavorite(star.dataset.caSlug, next);
        return;
      }

      var lnk = e.target.closest(".ca-link");
      if (lnk) {
        e.preventDefault(); e.stopPropagation();
        copyLink(lnk.dataset.caCopy, lnk);
        return;
      }

      var mb = e.target.closest(".ca-more");
      if (mb) {
        e.preventDefault(); e.stopPropagation();
        var p = cfg.getProject && cfg.getProject(mb.dataset.caMenu);
        if (!p) return;
        var reopen = menuBtnEl === mb;
        closeMenu();
        if (!reopen) openMenu(mb, p);
        return;
      }

      var item = e.target.closest(".pmenu button");
      if (item && menuFor) {
        e.preventDefault(); e.stopPropagation();
        var p2 = menuFor, act = item.dataset.caDo;
        closeMenu();
        if (act === "details" && cfg.onDetails) cfg.onDetails(p2);
        else if (act === "open" && cfg.onOpen) cfg.onOpen(p2);
        else if (act === "rename" && cfg.onRename) cfg.onRename(p2);
        else if (act === "del" && cfg.onDelete) cfg.onDelete(p2);
        else if (act === "link") copyLink(p2.slug || p2.key, null);
        else if (act === "fav") {
          p2.favorite = !p2.favorite;
          if (cfg.onChanged) cfg.onChanged();
          setFavorite(p2.slug || p2.key, p2.favorite);
        }
        return;
      }

      if (!e.target.closest(".pmenu")) closeMenu();
    });

    addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });
    // Anchored to a card that moves when the page does.
    addEventListener("scroll", closeMenu, { passive: true });
    addEventListener("resize", closeMenu);
  }

  window.CardActions = { init: init, html: actionsHTML, closeMenu: closeMenu, icons: IC };
})();
