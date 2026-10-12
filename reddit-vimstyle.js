// ==UserScript==
// @name         Reddit h/l/;/p/y/. keyboard helpers
// @namespace    local.reddit-hl-keys
// @description  h/l: gallery prev/next or video -/+5s. ; open post. p back. y refresh. . collapse comment. Only while Reddit j/k navigation is on.
// @match        https://www.reddit.com/*
// @match        https://reddit.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  // Guard against being injected twice.
  if (window.__redditHLKeys) return;
  window.__redditHLKeys = true;

  // ---- Config -------------------------------------------------------------

  // Keep the arrow keys working like h / l.
  const KEEP_ARROWS = true;
  // Seconds to jump when h / l is used over a video.
  const SEEK_SECONDS = 5;
  // When the real lightbox overlay is open, h / l work even if no post is
  // highlighted (focus usually moves into the overlay). Set to true to require
  // Reddit navigation to be on there too.
  const REQUIRE_NAV_IN_LIGHTBOX = false;
  // Console logging of what the script is doing (off = silent).
  const DEBUG = false;

  const KEYS = {
    prev: KEEP_ARROWS ? ["h", "ArrowLeft"] : ["h"],
    next: KEEP_ARROWS ? ["l", "ArrowRight"] : ["l"],
    enter: ";",
    back: "p",
    refresh: "y",
    collapse: ".",
  };

  const POST_SELECTOR = "shreddit-post";
  const COMMENT_SELECTOR = "shreddit-comment";
  const LIGHTBOX_SELECTOR = "shreddit-media-lightbox";
  // Guesses for how Reddit might mark the j/k-highlighted item if it isn't
  // using DOM focus. Harmless if nothing matches.
  const SELECTED_SELECTOR =
    '[selected], [focused], [data-selected="true"], [aria-selected="true"], .selected, .focused';
  const CLICKABLE = "button, summary, [role='button']";

  const PREV_REGEX =
    /\bprevious\b|\bprev\b|föregående|anterior|précédent|vorherige|forrige|vorige|edellinen|önceki|前へ|이전|предыдущ/i;
  const NEXT_REGEX =
    /\bnext\b|nästa|siguiente|suivant|nächste|próxim|prossim|successivo|volgende|seuraava|sonraki|次へ|다음|следующ/i;
  const COLLAPSE_REGEX = /collapse|expand|fold|toggle|minimi[sz]e|maximi[sz]e/i;

  const dlog = DEBUG ? (...a) => console.log("[reddit-hl-keys]", ...a) : () => {};

  // ---- Per-keypress caches ------------------------------------------------
  // The page can change between keypresses, but within one keypress the
  // expensive lookups (walking shadow roots, finding the highlighted item)
  // only need to happen once.

  let scopesCache = null;
  const highlightCache = new Map();
  const resetCaches = () => {
    scopesCache = null;
    highlightCache.clear();
  };

  // Set when we opened a post with ";" so "p" / "y" still work if the
  // highlight is lost after the page changes (navigation was evidently on).
  // Only valid while we're still inside a post page.
  let enteredViaNav = false;

  // ---- DOM helpers --------------------------------------------------------

  // Every query scope under `start`: itself plus all nested shadow roots
  // (breadth-first, so light-DOM matches come before shadow ones).
  function collectScopes(start) {
    const scopes = [start];
    for (let i = 0; i < scopes.length; i++) {
      const scope = scopes[i];
      if (scope.shadowRoot) scopes.push(scope.shadowRoot);
      for (const el of scope.querySelectorAll("*")) {
        if (el.shadowRoot) scopes.push(el.shadowRoot);
      }
    }
    return scopes;
  }

  function deepQueryAll(selector, root = document) {
    const scopes =
      root === document
        ? (scopesCache ||= collectScopes(document))
        : collectScopes(root);
    const out = [];
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll(selector)) out.push(el);
    }
    return out;
  }

  // Posts, comments and the lightbox normally live in the light DOM, so try
  // the cheap query first and only fall back to walking shadow roots.
  function queryItems(selector) {
    const light = document.querySelectorAll(selector);
    return light.length ? Array.from(light) : deepQueryAll(selector);
  }

  const isVisible = (el) => {
    if (el.checkVisibility) {
      return el.checkVisibility({
        checkVisibilityCSS: true,
        checkOpacity: true,
      });
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) {
      a = a.shadowRoot.activeElement;
    }
    return a;
  }

  // closest() that climbs out of shadow roots.
  function closestDeep(el, selector) {
    while (el) {
      const m = el.closest?.(selector);
      if (m) return m;
      const root = el.getRootNode?.();
      el = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  }

  // The real lightbox overlay is open when the URL says so, or when a
  // lightbox element actually has visible buttons (the element may exist in
  // the DOM even while closed).
  function isLightboxOpen() {
    if (location.hash.toLowerCase().includes("lightbox")) return true;
    return queryItems(LIGHTBOX_SELECTOR).some((lb) =>
      deepQueryAll("button", lb).some(isVisible),
    );
  }

  // ---- Reddit navigation state -------------------------------------------
  // "Navigation is on" = Reddit's j/k has an item highlighted. We detect that
  // by DOM focus, a selected-style marker, or a visible outline. There is
  // deliberately NO viewport fallback: with nothing highlighted, none of our
  // keys do anything.

  // Does this element (or its first inner layers) draw a focus-style outline?
  function hasOutline(el) {
    const check = (n) => {
      const cs = getComputedStyle(n);
      return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    };
    try {
      if (el.matches(":focus-visible") || check(el)) return true;
      for (const a of el.shadowRoot ? el.shadowRoot.children : []) {
        if (check(a)) return true;
        for (const b of a.children || []) if (check(b)) return true;
      }
    } catch (_) {}
    return false;
  }

  function computeHighlighted(selector) {
    // Cheapest and by far the most common: keyboard focus is inside one.
    const active = closestDeep(deepActiveElement(), selector);
    if (active) return { el: active, how: "focused element" };

    const items = queryItems(selector);
    if (!items.length) return null;

    const focusWithin = items.find((p) => p.matches(":focus-within"));
    if (focusWithin) return { el: focusWithin, how: ":focus-within" };

    const marked = items.find((p) => p.matches(SELECTED_SELECTOR));
    if (marked) return { el: marked, how: "selected marker" };

    // Only the on-screen items get the (slower) outline check.
    const outlined = items.find((p) => {
      const r = p.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight && hasOutline(p);
    });
    if (outlined) return { el: outlined, how: "outline style" };

    dlog(`no highlighted <${selector}> found. activeElement:`, deepActiveElement());
    return null;
  }

  function getHighlighted(selector) {
    if (!highlightCache.has(selector)) {
      highlightCache.set(selector, computeHighlighted(selector));
    }
    return highlightCache.get(selector);
  }

  const inPostPage = () => /\/comments\//.test(location.pathname);

  function isNavOn() {
    if (enteredViaNav && !inPostPage()) enteredViaNav = false;
    return (
      enteredViaNav ||
      !!getHighlighted(POST_SELECTOR) ||
      !!getHighlighted(COMMENT_SELECTOR)
    );
  }

  // ---- Gallery buttons ----------------------------------------------------

  // scoped = looking inside one post, where carousel arrows may be hidden
  // until hover, so we don't insist on visibility.
  function pickSlotButton(slotEls, name, scoped) {
    const all = slotEls
      .filter((s) => s.getAttribute("slot") === name)
      .map((s) => (s.tagName === "BUTTON" ? s : s.querySelector("button")))
      .filter(Boolean);
    const visible = all.filter(isVisible);
    const pool = scoped ? (visible.length ? visible : all) : visible;
    if (pool.length <= 1) return pool[0] || null;
    if (scoped) return pool[0];

    // Multiple visible candidates means the feed is rendered behind the
    // lightbox overlay. The lightbox chevrons sit at the viewport edges;
    // feed-card chevrons are inset. Pick the one closest to the edge.
    const isPrev = name === "prevButton";
    pool.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return isPrev ? ar.left - br.left : br.right - ar.right;
    });
    return pool[0];
  }

  function findSlotButtons(root, scoped) {
    const slotEls = deepQueryAll(
      '[slot="prevButton"], [slot="nextButton"]',
      root,
    );
    return {
      prev: pickSlotButton(slotEls, "prevButton", scoped),
      next: pickSlotButton(slotEls, "nextButton", scoped),
    };
  }

  // Fallback for other languages / markup changes: match by aria-label.
  function findLabeledButtons(root, scoped) {
    const btns = deepQueryAll("button, [role='button']", root);
    const vis = btns.map((b) => [b, isVisible(b)]);
    const ordered = scoped
      ? [...vis.filter((v) => v[1]), ...vis.filter((v) => !v[1])]
      : vis.filter((v) => v[1]);
    let prev = null;
    let next = null;
    for (const [btn] of ordered) {
      if (prev && next) break;
      const label = (btn.getAttribute("aria-label") || "").trim();
      if (!prev && PREV_REGEX.test(label)) prev = btn;
      if (!next && NEXT_REGEX.test(label)) next = btn;
    }
    return { prev, next };
  }

  // ---- Video --------------------------------------------------------------

  function findVideo(post) {
    const videos = deepQueryAll("video", post);
    return videos.find(isVisible) || videos[0] || null;
  }

  function seekVideo(video, delta) {
    const dur = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.max(0, Math.min(dur, video.currentTime + delta));
  }

  // ---- Actions ------------------------------------------------------------

  function stop(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // ; -> open the highlighted post
  function enterPost(e) {
    if (inPostPage()) return; // already in a post
    const found = getHighlighted(POST_SELECTOR);
    if (!found) return; // navigation off: leave the key alone
    const post = found.el;
    const link =
      deepQueryAll('a[slot="full-post-link"]', post)[0] ||
      deepQueryAll('a[href*="/comments/"]', post)[0];
    const permalink = post.getAttribute("permalink");
    if (!link && !permalink) {
      dlog("no link found on post", post);
      return;
    }
    dlog("entering post (", found.how, ")");
    enteredViaNav = true;
    stop(e);
    if (link) link.click();
    else location.assign(new URL(permalink, location.origin).href);
  }

  // p -> leave the post (go back), only while navigation is on
  function leavePost(e) {
    if (!inPostPage()) return; // not inside a post
    if (!isNavOn()) return; // navigation off: leave the key alone
    stop(e);
    enteredViaNav = false;
    if (history.length > 1) {
      dlog("leaving post (back)");
      history.back();
      return;
    }
    // Opened directly (no history): go to the subreddit instead.
    const sub = location.pathname.match(/^\/r\/[^/]+\//);
    if (sub) {
      dlog("leaving post (no history) -> subreddit");
      location.assign(sub[0]);
    }
  }

  // y -> refresh the page, only while navigation is on
  function refreshPage(e) {
    if (!isNavOn()) return; // navigation off: leave the key alone
    stop(e);
    dlog("refreshing page");
    location.reload();
  }

  // The collapse/expand controls that belong to this comment itself, not to
  // its nested replies (which would make this scan much bigger than needed).
  function ownButtons(comment) {
    const out = [];
    if (comment.shadowRoot) out.push(...deepQueryAll(CLICKABLE, comment.shadowRoot));
    for (const child of comment.children) {
      if (child.slot === "children" || child.matches(COMMENT_SELECTOR)) continue;
      if (child.matches(CLICKABLE)) out.push(child);
      out.push(...deepQueryAll(CLICKABLE, child));
    }
    return out.filter((b) => closestDeep(b, COMMENT_SELECTOR) === comment);
  }

  function findCollapseButton(comment) {
    return (
      ownButtons(comment).find((b) =>
        COLLAPSE_REGEX.test(
          `${b.getAttribute("aria-label") || ""} ${b.id || ""} ${b.getAttribute("data-testid") || ""}`,
        ),
      ) || null
    );
  }

  // . -> collapse/expand the highlighted comment (same as Reddit's f)
  function toggleComment(e) {
    const found = getHighlighted(COMMENT_SELECTOR);
    if (!found) return; // navigation off or no comment highlighted
    const btn = findCollapseButton(found.el);
    stop(e);
    if (btn) {
      dlog("toggling comment via button (", found.how, ")");
      btn.click();
      return;
    }
    // Fallback: hand Reddit its own "f" shortcut.
    dlog("no collapse button found; sending f to Reddit (", found.how, ")");
    const target = deepActiveElement() || document.body;
    const init = {
      key: "f",
      code: "KeyF",
      keyCode: 70,
      which: 70,
      bubbles: true,
      composed: true,
      cancelable: true,
    };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // h / l -> gallery prev/next, or video -/+ SEEK_SECONDS, on the highlighted
  // post (or inside the open lightbox).
  function handleHL(e, isNext) {
    let root = document;
    let scoped = false;
    let how = "lightbox";

    if (REQUIRE_NAV_IN_LIGHTBOX || !isLightboxOpen()) {
      const found = getHighlighted(POST_SELECTOR);
      if (!found) return; // navigation off: leave the key alone
      root = found.el;
      scoped = true;
      how = found.how;
    }

    // Gallery arrows. A held key shouldn't flip through a whole gallery:
    // repeats are swallowed but don't click again.
    const click = (btn) => {
      stop(e);
      if (!e.repeat) btn.click();
    };

    // 1. Strict slot match.
    const slots = findSlotButtons(root, scoped);
    const slotBtn = isNext ? slots.next : slots.prev;
    if (slotBtn) return click(slotBtn);

    // 2. Video on the highlighted post: seek (repeat = keep seeking).
    if (scoped) {
      const video = findVideo(root);
      if (video) {
        stop(e);
        seekVideo(video, isNext ? SEEK_SECONDS : -SEEK_SECONDS);
        return;
      }
    }

    // 3. Gallery arrows by aria-label.
    const labeled = findLabeledButtons(root, scoped);
    const labelBtn = isNext ? labeled.next : labeled.prev;
    if (labelBtn) return click(labelBtn);

    // Not a gallery or video: let Reddit handle the key.
    dlog("nothing to control for", e.key, "| post picked via:", how);
  }

  // ---- Keyboard handling --------------------------------------------------

  function isTyping(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    return path.some(
      (el) =>
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable),
    );
  }

  // key -> { run, holdable }. holdable keys keep working while held down.
  const ACTIONS = new Map();
  for (const k of KEYS.prev) {
    ACTIONS.set(k, { run: (e) => handleHL(e, false), holdable: true });
  }
  for (const k of KEYS.next) {
    ACTIONS.set(k, { run: (e) => handleHL(e, true), holdable: true });
  }
  ACTIONS.set(KEYS.enter, { run: enterPost });
  ACTIONS.set(KEYS.back, { run: leavePost });
  ACTIONS.set(KEYS.refresh, { run: refreshPage });
  ACTIONS.set(KEYS.collapse, { run: toggleComment });

  function handleKey(e) {
    if (!e.key) return; // some synthetic events (autofill) have no key
    // Normalize so Caps Lock doesn't break the letters (Shift is still
    // rejected below).
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const action = ACTIONS.get(key);
    if (!action) return; // everything else costs nothing
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    if (e.repeat && !action.holdable) return;
    if (isTyping(e)) return;

    resetCaches();
    action.run(e);
  }

  window.addEventListener("keydown", handleKey, true);
  console.log(
    "[reddit-hl-keys] loaded (h/l = prev/next image or -/+" +
      SEEK_SECONDS +
      "s video, ; = open post, p = back, y = refresh, . = collapse comment)",
  );
})();