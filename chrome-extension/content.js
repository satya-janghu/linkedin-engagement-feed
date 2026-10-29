const API_BASES = [
  "http://127.0.0.1:38421",
  "http://127.0.0.1:38422",
  "http://127.0.0.1:38423",
  "http://127.0.0.1:38424",
  "http://127.0.0.1:38425",
];
const API_IDENTITY_HEADER = "X-LinkedIn-Engagement-Feed";
const BACKGROUND_REQUEST_TIMEOUT_MS = 2500;
const BACKGROUND_WRITE_REQUEST_TIMEOUT_MS = 10000;
const REFRESH_WRITE_REQUEST_TIMEOUT_MS = 30000;
const BACKGROUND_API_COOLDOWN_MS = 30000;
const PASSIVE_CAPTURE_SIGNATURE_TTL_MS = 5 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 10000;
const STATUS_CACHE_TTL_MS = 60000;
const STATUS_BUTTON_REFRESH_TTL_MS = 15000;
const STATUS_BUTTON_VIEWPORT_MARGIN_PX = 700;
const STATUS_BATCH_DELAY_MS = 35;
const STATUS_BATCH_SIZE = 200;
const MAX_STATUS_CACHE_ENTRIES = 300;
const MAX_PEOPLE_PER_FEED = 200;
const MAX_CAPTURE_ITEMS_PER_REQUEST = 120;
const MAX_CAPTURE_FEEDS_PER_REQUEST = 20;
const AUTHOR_CONTROL_MIN_HOST_WIDTH = 176;
const AUTHOR_CONTROL_SLOT_WIDTH = 28;
const HELPER_VERSION = "1.0.32";
const REFRESH_RESUME_POLL_MS = 5000;
const REFRESH_RESUME_DEFAULT_DELAY_MS = 3000;
const REFRESH_RESUME_MIN_DELAY_MS = 500;
const REFRESH_RESUME_MAX_DELAY_MS = 180000;
const HELPER_ACTIVE_ATTRIBUTE = "data-lef-helper-active-at";
const HELPER_VERSION_ATTRIBUTE = "data-lef-helper-version";
const CRITICAL_STYLE_ID = "lef-critical-overlay-style";
const HELPER_HEARTBEAT_MS = 4000;
const OVERLAY_SWEEP_FALLBACK_MS = 30000;
const SESSION_STORAGE_KEY = "lefRefreshSession";
const RESUME_STORAGE_KEY = "lefRefreshResume";
const API_BASE_STORAGE_KEY = "lefApiBase";
const state = {
  apiBase: readRememberedApiBase() || API_BASES[0],
  feeds: [],
  feedRequest: null,
  feedRequestBackground: false,
  feedWriteSequence: 0,
  lastFeedFetchAt: 0,
  apiUnavailableUntil: 0,
  statusCache: new Map(),
  statusRequests: new Map(),
  statusBatchQueue: new Map(),
  statusBatchTimer: 0,
  statusWriteSequence: 0,
  activePopover: null,
  activePopoverAnchor: null,
  popoverPositionFrame: 0,
  popoverOpening: false,
  popoverRequestSequence: 0,
  passiveCaptureRunning: false,
  passiveCaptureTimer: 0,
  lastPassiveCaptureSignature: "",
  lastPassiveCaptureAt: 0,
  refreshRunning: false,
  refreshTimer: 0,
  refreshPollTimer: 0,
  helperHeartbeatTimer: 0,
  overlayObserver: null,
  overlayMutationPending: true,
  lastOverlaySweepAt: 0,
  lastOverlayUrl: "",
};

let lastResortClientRequestCounter = 0;

boot();

function boot() {
  injectCriticalOverlayStyles();
  markHelperActive();
  if (!state.helperHeartbeatTimer) {
    state.helperHeartbeatTimer = window.setInterval(markHelperActive, HELPER_HEARTBEAT_MS);
  }
  startOverlayMutationObserver();
  injectOverlayLoop();
  captureVisibleActivityLoop();
  startRefreshRunnerFromPage();
}

function injectCriticalOverlayStyles() {
  if (document.getElementById(CRITICAL_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = CRITICAL_STYLE_ID;
  style.textContent = `
.lef-anchor {
  box-sizing: border-box !important;
  float: none !important;
  inset: auto !important;
  position: static !important;
  transform: none !important;
  white-space: nowrap !important;
  width: max-content !important;
}
body .lef-anchor:not(.lef-anchor-author-rail):not(.lef-anchor-author-inline):not(.lef-anchor-author-slot):not(.lef-anchor-profile-heading),
main .lef-anchor:not(.lef-anchor-author-rail):not(.lef-anchor-author-inline):not(.lef-anchor-author-slot):not(.lef-anchor-profile-heading),
.update-components-header .lef-anchor,
.feed-shared-header .lef-anchor,
.feed-shared-update-v2__description .lef-anchor,
.feed-shared-social-activity .lef-anchor,
.social-details-social-activity .lef-anchor,
.update-components-social-activity .lef-anchor,
.update-components-actor__description .lef-anchor,
.update-components-actor__sub-description .lef-anchor,
[class*="feed-shared-update-v2__description"] .lef-anchor,
[class*="update-components-header"] .lef-anchor,
[class*="feed-shared-header"] .lef-anchor,
[class*="actor__description"] .lef-anchor,
[class*="actor__sub-description"] .lef-anchor,
[class*="social-activity"] .lef-anchor,
[class*="attribution"] .lef-anchor,
.comments-comment-entity .lef-anchor,
.comments-comment-meta .lef-anchor,
.comments-post-meta .lef-anchor,
[class*="comments-comment"] .lef-anchor,
[class*="comment-"] .lef-anchor,
[class*="comments-"] .lef-anchor,
[class*="comment__"] .lef-anchor,
[class*="comments__"] .lef-anchor,
a[href*="/in/"] .lef-anchor:not(.lef-anchor-author-rail),
a[href*="/in/"] + .lef-anchor:not(.lef-anchor-author-rail):not(.lef-anchor-author-inline):not(.lef-anchor-author-slot) {
  display: none !important;
}
.update-components-header .lef-author-control-rail,
.feed-shared-header .lef-author-control-rail,
.feed-shared-update-v2__description .lef-author-control-rail,
.feed-shared-social-activity .lef-author-control-rail,
.social-details-social-activity .lef-author-control-rail,
.update-components-social-activity .lef-author-control-rail,
.update-components-actor__description .lef-author-control-rail,
.update-components-actor__sub-description .lef-author-control-rail,
[class*="feed-shared-update-v2__description"] .lef-author-control-rail,
[class*="update-components-header"] .lef-author-control-rail,
[class*="feed-shared-header"] .lef-author-control-rail,
[class*="actor__description"] .lef-author-control-rail,
[class*="actor__sub-description"] .lef-author-control-rail,
[class*="social-activity"] .lef-author-control-rail,
[class*="attribution"] .lef-author-control-rail,
.comments-comment-entity .lef-author-control-rail,
.comments-comment-meta .lef-author-control-rail,
.comments-post-meta .lef-author-control-rail,
[class*="comments-comment"] .lef-author-control-rail,
[class*="comment-"] .lef-author-control-rail,
[class*="comments-"] .lef-author-control-rail,
[class*="comment__"] .lef-author-control-rail,
[class*="comments__"] .lef-author-control-rail {
  display: none !important;
}
body main h1 > .lef-anchor-profile-heading,
main h1 > .lef-anchor-profile-heading {
  display: inline-flex !important;
}
body .lef-button:not(.lef-button-compact):not(:is(main h1 .lef-button, .lef-popover .lef-button, .lef-anchor-profile-heading .lef-button)),
body button[data-lef-profile-url]:not(.lef-button-compact),
body .lef-button[data-lef-profile-url]:not(.lef-button-compact) {
  display: none !important;
}
body main h1 .lef-anchor-profile-heading .lef-button[data-lef-profile-url] {
  display: inline-block !important;
}
body .lef-anchor:not(.lef-anchor-profile-heading) .lef-button[data-lef-profile-url],
body button.lef-button[data-lef-profile-url]:not(:is(main h1 .lef-button, .lef-popover .lef-button)) {
  box-sizing: border-box !important;
  font-size: 0 !important;
  height: 16px !important;
  max-width: 18px !important;
  min-height: 16px !important;
  min-width: 18px !important;
  overflow: hidden !important;
  padding: 2px 0 !important;
  text-align: center !important;
  width: 18px !important;
}
.lef-author-control-host {
  box-sizing: border-box !important;
  max-width: 100% !important;
  min-width: 0 !important;
  overflow: visible !important;
  position: static !important;
}
.lef-author-control-rail {
  align-items: center !important;
  display: inline-flex !important;
  flex: 0 0 18px !important;
  height: 16px !important;
  margin: 0 0 0 6px !important;
  max-width: 18px !important;
  min-width: 18px !important;
  overflow: visible !important;
  padding: 0 !important;
  pointer-events: auto !important;
  position: static !important;
  right: auto !important;
  top: auto !important;
  vertical-align: middle !important;
  width: 18px !important;
}
.lef-author-control-host > .lef-author-control-rail {
  margin: 0 0 0 6px !important;
  position: static !important;
  right: auto !important;
  top: auto !important;
}
.lef-anchor-author-rail {
  display: none !important;
  margin-left: 0 !important;
}
.lef-author-control-rail .lef-anchor-author-rail {
  display: inline-flex !important;
}
.lef-anchor-author-inline {
  display: inline-flex !important;
  margin-left: 6px !important;
  vertical-align: middle !important;
}
.lef-author-row-slot-host {
  align-items: center !important;
  display: flex !important;
  gap: 6px !important;
  grid-template-columns: none !important;
  max-width: 100% !important;
  min-width: 0 !important;
  overflow: visible !important;
}
.lef-anchor-author-slot {
  display: inline-flex !important;
  flex: 0 0 18px !important;
  margin-left: 0 !important;
  vertical-align: middle !important;
}
.lef-author-control-rail .lef-button {
  box-sizing: border-box !important;
  border: 1px solid #0a66c2 !important;
  border-radius: 5px !important;
  background: #ffffff !important;
  color: #0a66c2 !important;
  cursor: pointer !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
  font-size: 0 !important;
  font-weight: 700 !important;
  height: 16px !important;
  line-height: 1 !important;
  max-width: 18px !important;
  min-height: 16px !important;
  min-width: 18px !important;
  overflow: hidden !important;
  padding: 2px 0 !important;
  text-align: center !important;
  width: 18px !important;
}
.lef-button.lef-button-compact {
  box-sizing: border-box !important;
  font-size: 0 !important;
  height: 16px !important;
  max-width: 18px !important;
  min-height: 16px !important;
  min-width: 18px !important;
  overflow: hidden !important;
  padding: 2px 0 !important;
  text-align: center !important;
  width: 18px !important;
}
.lef-author-control-rail .lef-button::before {
  content: "+" !important;
  font-size: 10px !important;
  line-height: 1 !important;
}
.lef-button.lef-button-compact::before {
  content: "+" !important;
  font-size: 10px !important;
  line-height: 1 !important;
}
body .lef-anchor:not(.lef-anchor-profile-heading) .lef-button[data-lef-profile-url]::before,
body button.lef-button[data-lef-profile-url]:not(:is(main h1 .lef-button, .lef-popover .lef-button))::before {
  content: "+" !important;
  font-size: 10px !important;
  line-height: 1 !important;
}
body .lef-anchor:not(.lef-anchor-profile-heading) > .lef-button:not(.lef-button-compact) {
  display: none !important;
}
`;
  (document.head || document.documentElement).appendChild(style);
}

function injectOverlayLoop() {
  markHelperActive();
  closeDetachedPopover();
  removeUnsafeInlineAuthorControls();
  const shouldSweep = shouldSweepOverlayControls();
  if (shouldSweep) {
    addProfileHeaderButton();
    addAuthorButtons();
    markOverlayControlsSwept();
  }
  updateVisibleButtonStates();
  refreshFeeds({ ttlMs: 10000, background: true })
    .then(() => {
      closeDetachedPopover();
      if (shouldSweepOverlayControls()) {
        addProfileHeaderButton();
        addAuthorButtons();
        markOverlayControlsSwept();
      }
      updateVisibleButtonStates();
    })
    .catch(() => {});
  setTimeout(injectOverlayLoop, 3000);
}

function startOverlayMutationObserver() {
  if (state.overlayObserver || typeof MutationObserver === "undefined") {
    return;
  }
  const root = document.documentElement || document.body;
  if (!root) {
    state.overlayMutationPending = true;
    return;
  }
  state.overlayObserver = new MutationObserver((records) => {
    if (records.some(mutationTouchesLinkedInContent)) {
      state.overlayMutationPending = true;
    }
  });
  state.overlayObserver.observe(root, { childList: true, subtree: true });
}

function mutationTouchesLinkedInContent(record) {
  return [...record.addedNodes, ...record.removedNodes].some((node) => !isHelperMutationNode(node));
}

function isHelperMutationNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return Boolean(node.parentElement?.closest?.(".lef-anchor, .lef-author-control-rail, .lef-popover, .lef-refresh-banner"));
  }
  return Boolean(node.closest?.(".lef-anchor, .lef-author-control-rail, .lef-popover, .lef-refresh-banner"));
}

function shouldSweepOverlayControls() {
  const now = Date.now();
  return (
    state.overlayMutationPending ||
    state.lastOverlayUrl !== location.href ||
    now - state.lastOverlaySweepAt >= OVERLAY_SWEEP_FALLBACK_MS
  );
}

function markOverlayControlsSwept() {
  state.overlayMutationPending = false;
  state.lastOverlaySweepAt = Date.now();
  state.lastOverlayUrl = location.href;
}

function markHelperActive() {
  document.documentElement.setAttribute(HELPER_ACTIVE_ATTRIBUTE, String(Date.now()));
  document.documentElement.setAttribute(HELPER_VERSION_ATTRIBUTE, HELPER_VERSION);
}

function captureVisibleActivityLoop() {
  markHelperActive();
  clearTimeout(state.passiveCaptureTimer);
  if (pageCanRunPassiveCapture() && !state.refreshRunning && !state.passiveCaptureRunning && !backgroundApiInCooldown()) {
    state.passiveCaptureRunning = true;
    captureVisibleActivity({ reason: "passive", background: true })
      .catch(() => {})
      .finally(() => {
        state.passiveCaptureRunning = false;
      });
  }
  state.passiveCaptureTimer = window.setTimeout(captureVisibleActivityLoop, 15000);
}

function pageCanRunPassiveCapture() {
  return document.visibilityState !== "hidden";
}

async function refreshFeeds({ ttlMs = 0, background = false } = {}) {
  if (ttlMs && Date.now() - state.lastFeedFetchAt < ttlMs && state.feeds.length > 0) {
    return state.feeds;
  }
  if (background && backgroundApiInCooldown()) {
    return state.feeds;
  }
  if (state.feedRequest && (background || !state.feedRequestBackground)) {
    return state.feedRequest;
  }
  const sequence = ++state.feedWriteSequence;
  const feedRequest = request("/api/feeds", {
    background,
    timeoutMs: background ? BACKGROUND_REQUEST_TIMEOUT_MS : undefined,
    validate: normalizeFeedSnapshots,
  })
    .then((feeds) => rememberFeeds(feeds, sequence))
    .finally(() => {
      if (state.feedRequest === feedRequest) {
        state.feedRequest = null;
        state.feedRequestBackground = false;
      }
    });
  state.feedRequest = feedRequest;
  state.feedRequestBackground = Boolean(background);
  return feedRequest;
}

function rememberFeeds(feeds, sequence = ++state.feedWriteSequence) {
  if (sequence < state.feedWriteSequence) {
    return state.feeds;
  }
  state.feeds = normalizeFeedSnapshots(feeds);
  state.lastFeedFetchAt = Date.now();
  return state.feeds;
}

function addProfileHeaderButton() {
  const profileUrl = currentProfileUrl();
  if (!profileUrl) {
    return;
  }
  const normalizedProfileUrl = normalizeProfileUrl(profileUrl);

  const heading = document.querySelector("main h1");
  if (!heading) {
    return;
  }

  const existingControls = [...heading.querySelectorAll(".lef-anchor")].filter((node) => node.parentElement === heading);
  if (
    heading.dataset.lefProfileUrl === normalizedProfileUrl &&
    existingControls.length === 1 &&
    existingControls[0].dataset.lefProfileUrl === normalizedProfileUrl
  ) {
    return;
  }

  for (const control of existingControls) {
    control.remove();
  }
  heading.dataset.lefInjected = "true";
  heading.dataset.lefProfileUrl = normalizedProfileUrl;
  heading.appendChild(createAnchorControl(profileHeadingNameFromHeading(heading), normalizedProfileUrl, { placement: "profile-heading" }));
}

function addAuthorButtons() {
  const searchRoots = authorSearchRoots();
  const uniqueLinks = [
    ...new Set(searchRoots.flatMap((root) => [...root.querySelectorAll('a[href*="/in/"]')])),
  ];
  const links = uniqueLinks.map(authorLinkCandidate).filter(Boolean);

  const linksNeedingControls = links.filter(({ link, profileUrl }) => {
    const existingControl = authorControlForLink(link, profileUrl);
    return link.dataset.lefProfileUrl !== profileUrl || existingControl?.dataset.lefProfileUrl !== profileUrl;
  });

  for (const { link, name, profileUrl } of linksNeedingControls.slice(0, 120)) {
    if (!profileUrl) {
      continue;
    }
    const placementTarget = authorControlPlacementTarget(link, name);
    if (!placementTarget) {
      continue;
    }
    if (isUnsafeAuthorControlPlacement(link, name, placementTarget)) {
      continue;
    }
    const existingControl = authorControlForLink(link, profileUrl);
    existingControl?.remove();
    link.dataset.lefInjected = "true";
    link.dataset.lefProfileUrl = profileUrl;
    insertAuthorControl(
      link,
      placementTarget,
      createAnchorControl(name, profileUrl, { placement: "author-rail" }),
    );
  }
}

function authorSearchRoots() {
  const selector = authorActorSelector();
  const roots = [...document.querySelectorAll(selector)];
  return roots.length > 0 ? roots : [document];
}

function authorLinkCandidate(link) {
  const profileUrl = normalizeProfileUrl(link.href);
  if (!profileUrl) {
    return undefined;
  }
  const name = authorNameFromLink(link);
  if (!isLikelyPersonName(name) || shouldSkipAuthorLink(link, name)) {
    return undefined;
  }
  return { link, name, profileUrl };
}

function authorControlForLink(link, profileUrl = normalizeProfileUrl(link.href)) {
  const sameProfileControl = (node) =>
    node?.classList?.contains("lef-anchor") && node.dataset.lefProfileUrl === profileUrl ? node : null;
  const host = authorControlHost(link);
  const rail = existingAuthorControlRail(host);
  return (
    [...(rail?.querySelectorAll(".lef-anchor") || [])].map(sameProfileControl).find(Boolean) ||
    authorRowSlotControlForLink(link, profileUrl) ||
    sameProfileControl(link.querySelector(".lef-anchor")) ||
    sameProfileControl(link.nextElementSibling) ||
    [...(link.parentElement?.children || [])].map(sameProfileControl).find(Boolean) ||
    null
  );
}

function insertAuthorControl(link, placementTarget, control) {
  const host = authorControlHost(link, placementTarget);
  if (host && host.contains(placementTarget)) {
    for (const existingControl of existingAuthorControlRail(host)?.querySelectorAll(".lef-anchor") || []) {
      if (existingControl.dataset.lefProfileUrl === control.dataset.lefProfileUrl) {
        existingControl.remove();
      }
    }
    const rail = authorControlRail(host);
    if (rail) {
      rail.appendChild(control);
      if (authorControlRailOverlapsVisibleText(rail, host)) {
        control.remove();
        removeEmptyAuthorControlRail(host, rail);
      }
      removeUnsafeInlineAuthorControls();
      return;
    }
  }
  if (insertAuthorRowSlotControl(link, placementTarget, control)) {
    return;
  }
  insertInlineAuthorControl(link, placementTarget, control);
}

function insertAuthorRowSlotControl(link, placementTarget, control) {
  const host = authorRowSlotHost(link, placementTarget);
  if (!host) {
    return false;
  }
  const anchorChild = authorRowSlotAnchorChild(link, host);
  if (!anchorChild) {
    return false;
  }
  authorRowSlotControlForLink(link, control.dataset.lefProfileUrl)?.remove();
  control.classList.remove("lef-anchor-author-rail");
  control.classList.add("lef-anchor-author-slot");
  host.classList.add("lef-author-row-slot-host");
  anchorChild.insertAdjacentElement("afterend", control);
  if (isUnsafeAuthorRowSlotAnchor(control)) {
    control.remove();
    cleanupAuthorRowSlotHost(host);
    return false;
  }
  removeUnsafeInlineAuthorControls();
  return control.isConnected;
}

function authorRowSlotControlForLink(link, profileUrl = normalizeProfileUrl(link.href)) {
  const host = authorRowSlotHost(link, link);
  return [...(host?.children || [])].find(
    (child) => child.classList?.contains("lef-anchor-author-slot") && child.dataset.lefProfileUrl === profileUrl,
  ) || null;
}

function authorRowSlotHost(link, placementTarget = link) {
  if (!link || !placementTarget || isUnsafeAuthorControlPlacement(link, authorNameFromLink(link), placementTarget)) {
    return null;
  }
  const anchorChild = link.parentElement;
  const host = anchorChild?.parentElement;
  if (!anchorChild || !host || !host.contains(placementTarget) || isLinkedInCommentSurfaceElement(host)) {
    return null;
  }
  const linkRect = link.getBoundingClientRect();
  const anchorRect = anchorChild.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const text = cleanText(textWithoutHelperControls(host));
  const hostStyle = getComputedStyle(host);
  return (
    profileUrlsInElement(host).size === 1 &&
    linkRect.width >= 48 &&
    linkRect.height >= 12 &&
    anchorRect.height <= 28 &&
    hostRect.height >= 16 &&
    hostRect.height <= 42 &&
    hostRect.width >= linkRect.width + AUTHOR_CONTROL_SLOT_WIDTH + 18 &&
    text.length <= 180 &&
    !hasSocialAttributionVerb(text) &&
    !isInsideSocialAttributionText(host) &&
    hostStyle.position !== "absolute"
  ) ? host : null;
}

function authorRowSlotAnchorChild(link, host) {
  const child = link?.parentElement;
  return child?.parentElement === host ? child : null;
}

function cleanupAuthorRowSlotHost(host) {
  if (host?.classList?.contains("lef-author-row-slot-host") && !host.querySelector(".lef-anchor-author-slot")) {
    host.classList.remove("lef-author-row-slot-host");
  }
}

function insertInlineAuthorControl(link, placementTarget, control) {
  if (!canInsertInlineAuthorControl(link, placementTarget)) {
    return;
  }
  const existingInline = authorInlineControlForLink(link, control.dataset.lefProfileUrl);
  existingInline?.remove();
  control.classList.remove("lef-anchor-author-rail");
  control.classList.add("lef-anchor-author-inline");
  placementTarget.insertAdjacentElement("afterend", control);
  if (isUnsafeAuthorInlineAnchor(control)) {
    control.remove();
    return;
  }
  removeUnsafeInlineAuthorControls();
}

function authorInlineControlForLink(link, profileUrl = normalizeProfileUrl(link.href)) {
  const candidate = link.nextElementSibling;
  return candidate?.classList?.contains("lef-anchor-author-inline") && candidate.dataset.lefProfileUrl === profileUrl
    ? candidate
    : null;
}

function canInsertInlineAuthorControl(link, placementTarget = link) {
  if (!link || !placementTarget || placementTarget !== link || isUnsafeAuthorControlPlacement(link, authorNameFromLink(link), placementTarget)) {
    return false;
  }
  const parent = link.parentElement;
  if (!parent || link.querySelector(".lef-anchor") || authorInlineControlForLink(link)) {
    return false;
  }
  const targetRect = link.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const text = cleanText(textWithoutHelperControls(parent));
  return (
    profileUrlsInElement(parent).size === 1 &&
    targetRect.width >= 48 &&
    targetRect.height >= 12 &&
    parentRect.height >= 16 &&
    parentRect.height <= 72 &&
    text.length <= 180 &&
    !hasSocialAttributionVerb(text) &&
    parentRect.right - Math.max(targetRect.right, rightmostTextRectInReferenceLine(parent, targetRect)) >= AUTHOR_CONTROL_SLOT_WIDTH + 10
  );
}

function authorControlRail(host) {
  if (!host) {
    return undefined;
  }
  const mount = authorControlRailMount(host);
  if (!authorControlRailCanMount(host, mount)) {
    return undefined;
  }
  host.classList.add("lef-author-control-host");
  const existingRail = existingAuthorControlRail(host);
  if (existingRail) {
    if (existingRail.parentElement !== host) {
      host.appendChild(existingRail);
    }
    return existingRail;
  }
  const rail = document.createElement("div");
  rail.className = "lef-author-control-rail";
  host.appendChild(rail);
  return rail;
}

function authorControlRailMount(host) {
  let mount = host;
  for (let depth = 0; mount?.parentElement && depth < 3; depth += 1) {
    if (!isSingleLineFlexRowHost(mount.parentElement)) {
      break;
    }
    mount = mount.parentElement;
  }
  return mount || host;
}

function existingAuthorControlRail(host) {
  if (!host) {
    return undefined;
  }
  const childRail = [...host.children].find((child) => child.classList?.contains("lef-author-control-rail"));
  if (childRail) {
    return childRail;
  }
  const nextSibling = host.nextElementSibling;
  if (nextSibling?.classList?.contains("lef-author-control-rail")) {
    return nextSibling;
  }
  const mount = authorControlRailMount(host);
  if (mount !== host && mount.nextElementSibling?.classList?.contains("lef-author-control-rail")) {
    return mount.nextElementSibling;
  }
  return undefined;
}

function removeEmptyAuthorControlRail(host, rail) {
  if (rail && !rail.querySelector(".lef-anchor")) {
    rail.remove();
  }
  if (host && !existingAuthorControlRail(host)) {
    host.classList.remove("lef-author-control-host");
  }
}

function authorControlHost(link, placementTarget = link) {
  if (isUnsafeAuthorControlPlacement(link, authorNameFromLink(link), placementTarget)) {
    return null;
  }
  const actorRoot = authorActorRoot(link);
  if (actorRoot && isCommentAuthorActorRoot(actorRoot)) {
    return isCrampedCommentAuthorActorRoot(actorRoot, placementTarget) || !authorHostCanReserveRail(actorRoot, placementTarget)
      ? null
      : actorRoot;
  }
  return (
    (authorHostCanReserveRail(actorRoot, placementTarget) ? actorRoot : null) ||
    authorMetadataHost(link, placementTarget) ||
    inferredAuthorControlHost(link)
  );
}

function authorHostCanReserveRail(host, placementTarget) {
  if (!host || !placementTarget || !host.contains(placementTarget)) {
    return false;
  }
  const hostRect = host.getBoundingClientRect();
  const style = getComputedStyle(host);
  return (
    authorHostHasRoomForControl(host, placementTarget, { minWidth: 168, slotWidth: 42 }) &&
    hostRect.height >= 24 &&
    hostRect.height <= 220 &&
    !isCompactAuthorControlHost(host, placementTarget) &&
    !isSingleLineFlexRowHost(host) &&
    style.display !== "inline" &&
    style.position !== "absolute"
  );
}

function authorMetadataHost(link, placementTarget = link) {
  const actorRoot = authorActorRoot(link);
  let current = placementTarget?.parentElement || link.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (!current.contains(link) || (placementTarget && !current.contains(placementTarget))) {
      current = current.parentElement;
      continue;
    }
    const text = cleanText(textWithoutHelperControls(current));
    const profileUrlCount = profileUrlsInElement(current).size;
    const rect = current.getBoundingClientRect();
    const style = getComputedStyle(current);
    if (
      profileUrlCount === 1 &&
      text.length <= 260 &&
      rect.width >= 80 &&
      rect.height >= 32 &&
      authorHostHasRoomForControl(current, placementTarget) &&
      !isSingleLineFlexRowHost(current) &&
      style.display !== "inline" &&
      style.display !== "inline-block" &&
      style.position !== "absolute" &&
      !isCompactNameOnlyHost(current, link, text, rect) &&
      !isSocialAttributionText(text, profileUrlCount)
    ) {
      return current;
    }
    if (actorRoot && current === actorRoot) {
      break;
    }
    current = current.parentElement;
  }
  return null;
}

function authorActorRoot(link) {
  return link.closest(authorActorSelector());
}

function authorActorSelector() {
  return [
    ".update-components-actor",
    ".feed-shared-actor",
    ".comments-comment-entity",
    ".comments-comment-meta",
    ".comments-post-meta",
  ].join(", ");
}

function isCommentAuthorActorRoot(actorRoot) {
  return Boolean(actorRoot?.matches?.(".comments-comment-entity, .comments-comment-meta, .comments-post-meta"));
}

function isCrampedCommentAuthorActorRoot(actorRoot, placementTarget) {
  if (!actorRoot || !placementTarget) {
    return true;
  }
  const rootRect = actorRoot.getBoundingClientRect();
  const targetRect = placementTarget.getBoundingClientRect();
  const text = cleanText(textWithoutHelperControls(actorRoot));
  const firstLineText = cleanText(visualLineTextNearRect(actorRoot, targetRect) || text);
  return (
    rootRect.width < 260 ||
    rootRect.height < 64 ||
    firstLineText.length > 96 ||
    rootRect.left + 28 > targetRect.left ||
    rightmostTextRectInReferenceLine(actorRoot, targetRect) + AUTHOR_CONTROL_SLOT_WIDTH + 16 > rootRect.right
  );
}

function inferredAuthorControlHost(link) {
  let current = link.parentElement;
  for (let depth = 0; current && depth < 7; depth += 1) {
    const text = cleanText(textWithoutHelperControls(current));
    const rect = current.getBoundingClientRect();
    const profileUrlCount = profileUrlsInElement(current).size;
    if (
      profileUrlCount === 1 &&
      rect.width >= 140 &&
      rect.height >= 32 &&
      rect.height <= 130 &&
      text.length <= 320 &&
      authorHostHasRoomForControl(current, link) &&
      !isCompactAuthorControlHost(current, link) &&
      !isSingleLineFlexRowHost(current) &&
      !isSocialAttributionText(text, profileUrlCount) &&
      !isSocialAttributionHost(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isUnsafeAuthorControlPlacement(link, name = "", placementTarget = link) {
  return (
    isCommentSurfaceAuthorCollisionRisk(link, placementTarget) ||
    isTightActionAttributionLine(link, name, placementTarget) ||
    isDenseSocialActionLine(link, name, placementTarget) ||
    isLinkedInActionVerbLine(link, name) ||
    isSocialAttributionLink(link) ||
    isInlineActionAttributionAroundLink(link, name) ||
    isInlineSocialActionHeader(link, name, placementTarget) ||
    isFeedActionAttributionLink(link, name) ||
    isInlineActionVerbSiblingLine(link, name) ||
    isInsideSocialAttributionText(placementTarget) ||
    isCompactLinkedInAttributionPlacement(link, name, placementTarget) ||
    isCompactActionLinePlacement(link, name, placementTarget)
  );
}

function isCommentSurfaceAuthorCollisionRisk(link, placementTarget = link) {
  const commentSurface = closestLinkedInCommentSurface(placementTarget || link);
  if (!commentSurface || commentSurface.matches?.("main h1")) {
    return false;
  }
  const targetRect = placementTarget?.getBoundingClientRect?.() || link.getBoundingClientRect();
  const surfaceRect = commentSurface.getBoundingClientRect();
  if (!targetRect || !surfaceRect || targetRect.width < 24 || targetRect.height < 10) {
    return true;
  }
  const lineText = visualLineTextNearRect(commentSurface, targetRect) || cleanText(textWithoutHelperControls(commentSurface));
  const rightEdge = Math.max(targetRect.right, rightmostTextRectInReferenceLine(commentSurface, targetRect));
  return (
    surfaceRect.height <= 108 ||
    cleanText(lineText).length > 80 ||
    rightEdge + AUTHOR_CONTROL_SLOT_WIDTH + 18 > surfaceRect.right
  );
}

function closestLinkedInCommentSurface(element) {
  let current = element;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (isLinkedInCommentSurfaceElement(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isLinkedInCommentSurfaceElement(element) {
  const classText = typeof element?.className === "string" ? element.className : element?.getAttribute?.("class") || "";
  return /\bcomments?-|\bcomments?__/i.test(classText);
}

function isTightActionAttributionLine(link, name = "", placementTarget = link) {
  const referenceRect = (placementTarget || link)?.getBoundingClientRect?.() || link.getBoundingClientRect();
  if (!referenceRect || referenceRect.width < 24 || referenceRect.height < 10) {
    return false;
  }
  const normalizedName = cleanText(name).toLowerCase();
  let current = placementTarget || link;
  for (let depth = 0; current && depth < 7; depth += 1) {
    const parent = current.parentElement;
    const text = cleanText(
      [
        visualLineTextNearRect(parent || current, referenceRect),
        visualLineTextNearRect(current, referenceRect),
        nearbyInlineNodeSnapshot(current).text,
        nearbyAuthorLineSnapshot(current).text,
      ]
        .filter(Boolean)
        .join(" "),
    ).toLowerCase();
    const profileUrlCount = Math.max(
      profileUrlsInVisualLine(parent || current, referenceRect).size,
      profileUrlsInVisualLine(current, referenceRect).size,
      profileUrlsInElement(parent || current).size,
      profileUrlsInElement(current).size,
    );
    const firstVerbIndex = text.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
    const nameIndex = normalizedName ? text.indexOf(normalizedName) : -1;
    if (
      text &&
      text.length <= 260 &&
      firstVerbIndex >= 0 &&
      (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
      firstVerbIndex <= Math.max(170, (nameIndex >= 0 ? nameIndex : 0) + normalizedName.length + 110) &&
      (profileUrlCount > 1 ||
        /\b(?:and|with)\b/.test(text.slice(0, firstVerbIndex + 32)) ||
        text.endsWith(text.match(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/)?.[0] || ""))
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function isInlineActionAttributionAroundLink(link, name = "") {
  let current = link;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const { text, profileUrlCount } = inlineActionAttributionSnapshot(current);
    if (
      text &&
      text.length <= 280 &&
      (isFeedActionAttributionText(text, name, profileUrlCount) ||
        isActionAttributionText(text, profileUrlCount, name) ||
        isCompactSocialAttributionText(text, profileUrlCount))
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function inlineActionAttributionSnapshot(element) {
  const parent = element?.parentElement;
  if (!parent) {
    return { text: "", profileUrlCount: 0 };
  }
  const siblings = [...parent.childNodes];
  const elementIndex = siblings.indexOf(element);
  const nearbyNodes =
    elementIndex >= 0
      ? siblings.slice(Math.max(0, elementIndex - 4), Math.min(siblings.length, elementIndex + 5))
      : [element];
  const profileUrls = new Set();
  const text = cleanText(
    nearbyNodes
      .map((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          for (const profileUrl of profileUrlsInElement(node)) {
            profileUrls.add(profileUrl);
          }
          return textWithoutHelperControls(node);
        }
        return node.textContent || "";
      })
      .join(" "),
  );
  return { text, profileUrlCount: profileUrls.size };
}

function isInlineActionVerbSiblingLine(link, name = "") {
  const normalizedName = cleanText(name).toLowerCase();
  let current = link;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const parent = current.parentElement;
    if (!parent) {
      break;
    }
    const siblings = [...parent.childNodes];
    const currentIndex = siblings.indexOf(current);
    if (currentIndex < 0) {
      current = parent;
      continue;
    }
    const nearby = siblings.slice(Math.max(0, currentIndex - 3), Math.min(siblings.length, currentIndex + 7));
    const profileUrls = new Set();
    const text = cleanText(
      nearby
        .map((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            for (const profileUrl of profileUrlsInElement(node)) {
              profileUrls.add(profileUrl);
            }
            return textWithoutHelperControls(node);
          }
          return node.textContent || "";
        })
        .join(" "),
    ).toLowerCase();
    const firstVerbIndex = text.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
    const nameIndex = normalizedName ? text.indexOf(normalizedName) : -1;
    if (
      text &&
      text.length <= 260 &&
      firstVerbIndex >= 0 &&
      (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
      (profileUrls.size > 1 || /\b(?:and|with)\b/.test(text.slice(0, firstVerbIndex + 32)))
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function isDenseSocialActionLine(link, name = "", placementTarget = link) {
  const referenceRect = (placementTarget || link)?.getBoundingClientRect?.() || link.getBoundingClientRect();
  if (!referenceRect || referenceRect.width < 24 || referenceRect.height < 10) {
    return false;
  }
  const normalizedName = cleanText(name).toLowerCase();
  let current = placementTarget || link;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const parent = current.parentElement;
    const inline = nearbyInlineNodeSnapshot(current);
    const nearby = nearbyAuthorLineSnapshot(current);
    const text = cleanText(
      [
        visualLineTextNearRect(current, referenceRect),
        parent ? visualLineTextNearRect(parent, referenceRect) : "",
        inline.text,
        nearby.text,
        textWithoutHelperControls(current),
      ]
        .filter(Boolean)
        .join(" "),
    ).toLowerCase();
    const profileUrlCount = Math.max(
      profileUrlsInVisualLine(current, referenceRect).size,
      parent ? profileUrlsInVisualLine(parent, referenceRect).size : 0,
      profileUrlsInElement(current).size,
      parent ? profileUrlsInElement(parent).size : 0,
      inline.profileUrlCount,
      nearby.profileUrlCount,
    );
    const firstVerbIndex = text.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
    const nameIndex = normalizedName ? text.indexOf(normalizedName) : -1;
    if (
      text &&
      text.length <= 420 &&
      firstVerbIndex >= 0 &&
      (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
      firstVerbIndex <= Math.max(200, (nameIndex >= 0 ? nameIndex : 0) + normalizedName.length + 128) &&
      (profileUrlCount > 1 || /\b(?:and|with)\b/.test(text.slice(0, firstVerbIndex + 40)) || isAttributionSurface(current))
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function isInlineSocialActionHeader(link, name = "", placementTarget = link) {
  const normalizedName = cleanText(name).toLowerCase();
  const targetRect = placementTarget?.getBoundingClientRect?.() || link.getBoundingClientRect();
  if (!targetRect || targetRect.width < 24 || targetRect.height < 10) {
    return false;
  }
  let current = placementTarget?.parentElement || link.parentElement;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const rect = current.getBoundingClientRect();
    if (rect.height <= 96) {
      const inline = nearbyInlineNodeSnapshot(current);
      const nearby = nearbyAuthorLineSnapshot(current);
      const lineText = cleanText(
        [visualLineTextNearRect(current, targetRect), inline.text, nearby.text].filter(Boolean).join(" "),
      ).toLowerCase();
      const profileUrlCount = Math.max(
        profileUrlsInVisualLine(current, targetRect).size,
        profileUrlsInElement(current).size,
        inline.profileUrlCount,
        nearby.profileUrlCount,
      );
      const firstVerbIndex = lineText.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
      const nameIndex = normalizedName ? lineText.indexOf(normalizedName) : -1;
      if (
        lineText &&
        lineText.length <= 320 &&
        firstVerbIndex >= 0 &&
        (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
        firstVerbIndex <= Math.max(180, (nameIndex >= 0 ? nameIndex : 0) + normalizedName.length + 120) &&
        (profileUrlCount > 1 || /\b(?:and|with)\b/.test(lineText.slice(0, firstVerbIndex + 32)))
      ) {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

function isCompactLinkedInAttributionPlacement(link, name = "", placementTarget = link) {
  const targetRect = placementTarget?.getBoundingClientRect?.();
  if (!targetRect || targetRect.width < 1 || targetRect.height < 1) {
    return false;
  }
  let current = placementTarget;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const parent = current.parentElement;
    const lineText = visualLineTextNearRect(parent || current, targetRect);
    const nearbyText = cleanText(
      [current, ...[...(parent?.children || [])].filter((child) => child !== current && isNearbyElementSibling(child, current))]
        .map((element) => textWithoutHelperControls(element))
        .join(" "),
    );
    const text = cleanText([lineText, nearbyText].filter(Boolean).join(" "));
    const profileUrlCount = Math.max(profileUrlsInVisualLine(parent || current, targetRect).size, profileUrlsInElement(parent || current).size);
    if (
      text.length <= 280 &&
      (isActionAttributionText(text, profileUrlCount, name) ||
        isLinkedInActionSummaryText(text, profileUrlCount, name) ||
        isActionVerbNearLinkedInNameLine(text, profileUrlCount, name))
    ) {
      return true;
    }
    current = parent;
  }
  return false;
}

function isFeedActionAttributionLink(link, name = "") {
  const attribution = link.closest(feedActionAttributionSelector());
  if (attribution && isFeedActionAttributionText(textWithoutHelperControls(attribution), name, profileUrlsInElement(attribution).size)) {
    return true;
  }

  let current = link.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const parent = current.parentElement;
    const text = cleanText(
      [current, ...[...(parent?.children || [])].filter((child) => child !== current && isNearbyElementSibling(child, current))]
        .map((element) => textWithoutHelperControls(element))
        .join(" "),
    );
    const profileUrlCount = new Set([
      ...profileUrlsInElement(current),
      ...profileUrlsInElement(parent || current),
    ]).size;
    if (isFeedActionAttributionText(text, name, profileUrlCount)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isFeedActionAttributionText(text, name = "", profileUrlCount = 0) {
  const clean = cleanText(text).toLowerCase();
  if (!clean || clean.length > 220 || !hasSocialAttributionVerb(clean)) {
    return false;
  }
  const normalizedName = cleanText(name).toLowerCase();
  const firstVerbIndex = clean.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
  if (firstVerbIndex < 0 || firstVerbIndex > Math.max(150, normalizedName.length + 96)) {
    return false;
  }
  const actionVerbMatch = clean.match(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
  return (
    ((normalizedName && clean.includes(normalizedName)) || profileUrlCount >= 1) &&
    (/\b(?:and|with)\b/.test(clean.slice(0, firstVerbIndex + 24)) || clean.endsWith(actionVerbMatch?.[0] || ""))
  );
}

function isCompactActionLinePlacement(link, name = "", placementTarget = link) {
  const targetRect = placementTarget?.getBoundingClientRect?.();
  if (!targetRect || targetRect.width < 1 || targetRect.height < 1) {
    return false;
  }
  let current = placementTarget;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const rect = current.getBoundingClientRect();
    if (rect.height <= 96) {
      const text = visualLineTextNearRect(current, targetRect) || cleanText(textWithoutHelperControls(current));
      const profileUrlCount = profileUrlsInVisualLine(current, targetRect).size || profileUrlsInElement(current).size;
      if (
        isActionAttributionText(text, profileUrlCount, name) ||
        isCompactSocialAttributionText(text, profileUrlCount) ||
        isLinkedInActionSummaryText(text, profileUrlCount, name)
      ) {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

function authorControlRailCanMount(host, mount) {
  if (!host || !mount) {
    return false;
  }
  const text = cleanText(textWithoutHelperControls(mount));
  const profileUrlCount = profileUrlsInElement(mount).size;
  return !(
    isCrampedAuthorRailMount(host, mount) ||
    isSocialAttributionHost(mount) ||
    isActionAttributionText(text, profileUrlCount) ||
    isCompactSocialAttributionText(text, profileUrlCount)
  );
}

function isCrampedAuthorRailMount(host, mount) {
  const hostRect = host.getBoundingClientRect();
  const mountRect = mount.getBoundingClientRect();
  const text = cleanText(textWithoutHelperControls(mount));
  const profileUrlCount = profileUrlsInElement(mount).size;
  return Boolean(
    text &&
      mountRect.height <= 34 &&
      text.length <= 180 &&
      (hasSocialAttributionVerb(text) || profileUrlCount > 1 || hostRect.width < 140 || mountRect.width < 180),
  );
}

function removeUnsafeInlineAuthorControls() {
  removeLegacyFullSizeAuthorControls();
  compactNonProfileControls();
  for (const control of document.querySelectorAll(
    [
      ".lef-anchor:not(.lef-anchor-author-rail):not(.lef-anchor-profile-heading)",
      'a[href*="/in/"] .lef-anchor',
      'a[href*="/in/"] + .lef-anchor',
      ".lef-anchor-inside",
      ".update-components-header .lef-anchor",
      ".feed-shared-header .lef-anchor",
      ".feed-shared-social-activity .lef-anchor",
      ".social-details-social-activity .lef-anchor",
      ".update-components-social-activity .lef-anchor",
      ".update-components-actor__description .lef-anchor",
      ".update-components-actor__sub-description .lef-anchor",
      '[class*="actor__description"] .lef-anchor',
      '[class*="actor__sub-description"] .lef-anchor',
      `${authorActorSelector()} .lef-anchor`,
    ].join(", "),
  )) {
    if (isUnsafeInlineAuthorControl(control)) {
      control.remove();
    }
  }
  for (const button of document.querySelectorAll(".lef-button, button[data-lef-profile-url], .lef-button[data-lef-profile-url]")) {
    if (isUnsafeOrphanAuthorButton(button)) {
      (button.closest(".lef-anchor") || button).remove();
    }
  }
  for (const anchor of document.querySelectorAll(".lef-anchor-author-rail")) {
    if (isUnsafeAuthorRailAnchor(anchor)) {
      anchor.remove();
    }
  }
  for (const rail of document.querySelectorAll(".lef-author-control-rail")) {
    compactLegacyAuthorRailButtons(rail);
    if (isUnsafeAuthorControlRail(rail)) {
      rail.remove();
      continue;
    }
    if (!rail.querySelector(".lef-anchor")) {
      rail.remove();
    }
  }
  for (const host of document.querySelectorAll(".lef-author-row-slot-host")) {
    cleanupAuthorRowSlotHost(host);
  }
}

function removeLegacyFullSizeAuthorControls() {
  for (const control of document.querySelectorAll(".lef-anchor, .lef-button")) {
    if (control.closest("main h1, .lef-popover, .lef-author-control-rail, .lef-anchor-profile-heading")) {
      continue;
    }
    const button = control.matches?.(".lef-button") ? control : control.querySelector?.(".lef-button");
    const label = cleanText(button?.textContent || "");
    if (label === "Feeds" || /^In\s+\d+$/i.test(label)) {
      (control.closest(".lef-anchor") || button || control).remove();
    }
  }
}

function compactNonProfileControls() {
  for (const button of document.querySelectorAll(".lef-button[data-lef-profile-url]")) {
    if (!button.closest("main h1, .lef-popover, .lef-anchor-profile-heading")) {
      button.classList.add("lef-button-compact");
    }
  }
}

function isUnsafeAuthorRailAnchor(anchor) {
  const rail = anchor.closest(".lef-author-control-rail");
  return Boolean(
    anchor &&
      !rail &&
      !anchor.closest("main h1") &&
      (isInsideSocialAttributionText(anchor) ||
        isSocialAttributionHost(anchor.parentElement) ||
        anchor.closest(attributionSurfaceSelector()) ||
        anchor.closest(authorActorSelector())),
  );
}

function compactLegacyAuthorRailButtons(rail) {
  for (const button of rail.querySelectorAll(".lef-button:not(.lef-button-compact)")) {
    button.classList.add("lef-button-compact");
    const label = cleanText(button.textContent || "");
    const countMatch = label.match(/\b(?:In\s+)?(\d+)\b/i);
    const count = countMatch ? Number(countMatch[1]) : 0;
    updateButtonLabel(button, isSafeInteger(count) && count > 0 ? count : 0);
  }
}

function isUnsafeOrphanAuthorButton(button) {
  return Boolean(
    button &&
      !button.closest("main h1") &&
      !isCompactAuthorButton(button) &&
      !button.closest(".lef-author-control-rail") &&
      !button.closest(".lef-popover") &&
      !button.closest(".lef-anchor-profile-heading"),
  );
}

function isCompactAuthorButton(button) {
  return isCompactAuthorRailButton(button) || isCompactAuthorSlotButton(button);
}

function isCompactAuthorRailButton(button) {
  return Boolean(
    button?.classList?.contains("lef-button-compact") &&
      button.closest(".lef-author-control-rail") &&
      button.closest(".lef-anchor-author-rail"),
  );
}

function isCompactAuthorSlotButton(button) {
  return Boolean(
    button?.classList?.contains("lef-button-compact") &&
      button.closest(".lef-author-row-slot-host") &&
      button.closest(".lef-anchor-author-slot"),
  );
}

function isUnsafeInlineAuthorControl(control) {
  if (control?.classList?.contains("lef-anchor-author-slot")) {
    return isUnsafeAuthorRowSlotAnchor(control);
  }
  if (control?.classList?.contains("lef-anchor-author-inline")) {
    return isUnsafeAuthorInlineAnchor(control);
  }
  return Boolean(
    control &&
      !control.closest("main h1") &&
      !control.closest(".lef-author-control-rail") &&
      (isInsideSocialAttributionText(control) ||
        isSocialAttributionHost(control.parentElement) ||
        control.closest(attributionSurfaceSelector()) ||
        control.classList?.contains("lef-anchor-inside") ||
        !control.classList?.contains("lef-anchor-profile-heading")),
  );
}

function isUnsafeAuthorRowSlotAnchor(anchor) {
  if (!anchor?.isConnected || !anchor.classList?.contains("lef-anchor-author-slot")) {
    return true;
  }
  const host = anchor.parentElement;
  const anchorChild = anchor.previousElementSibling;
  const link = anchorChild?.querySelector?.('a[href*="/in/"]');
  const profileUrl = normalizeProfileUrl(anchor.dataset.lefProfileUrl || "");
  const text = cleanText(textWithoutHelperControls(host || anchor));
  return Boolean(
    !host ||
      !host.classList?.contains("lef-author-row-slot-host") ||
      !link ||
      normalizeProfileUrl(link.href) !== profileUrl ||
      isLinkedInCommentSurfaceElement(host) ||
      isInsideSocialAttributionText(anchor) ||
      hasSocialAttributionVerb(text) ||
      profileUrlsInElement(host).size !== 1 ||
      shouldSkipAuthorLink(link, authorNameFromLink(link)) ||
      authorControlHitTargetIsBlocked(anchor) ||
      authorRowSlotOverlapsVisibleText(anchor, host)
  );
}

function authorControlHitTargetIsBlocked(anchor) {
  if (!anchor?.isConnected) {
    return true;
  }
  const rect = anchor.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return true;
  }
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
    return false;
  }
  const centerX = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
  const centerY = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
  const topElement = document.elementFromPoint(centerX, centerY);
  return Boolean(topElement && topElement !== anchor && !anchor.contains(topElement));
}

function authorRowSlotOverlapsVisibleText(anchor, host) {
  if (!anchor?.isConnected || !host?.isConnected || !host.contains(anchor)) {
    return true;
  }
  const anchorRect = anchor.getBoundingClientRect();
  if (anchorRect.width <= 0 || anchorRect.height <= 0) {
    return true;
  }
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = cleanText(node.textContent || "");
      if (!text || node.parentElement?.closest?.(".lef-anchor, .lef-popover, .lef-refresh-banner")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    for (const textRect of textNodeClientRects(node)) {
      if (rectsIntersect(anchorRect, textRect, 1)) {
        return true;
      }
    }
    node = walker.nextNode();
  }
  return false;
}

function isUnsafeAuthorInlineAnchor(anchor) {
  if (!anchor?.isConnected || !anchor.classList?.contains("lef-anchor-author-inline")) {
    return true;
  }
  const link = anchor.previousElementSibling;
  const profileUrl = normalizeProfileUrl(anchor.dataset.lefProfileUrl || "");
  if (!link?.matches?.('a[href*="/in/"]') || normalizeProfileUrl(link.href) !== profileUrl) {
    return true;
  }
  const parent = link.parentElement;
  const text = cleanText(textWithoutHelperControls(parent || link));
  return Boolean(
    !parent ||
      isCommentSurfaceAuthorCollisionRisk(link, link) ||
      isInsideSocialAttributionText(anchor) ||
      hasSocialAttributionVerb(text) ||
      profileUrlsInElement(parent).size !== 1 ||
      shouldSkipAuthorLink(link, authorNameFromLink(link)),
  );
}

function isUnsafeAuthorControlRail(rail) {
  const host = authorHostForRail(rail);
  if (
    authorControlRailOverlapsVisibleText(rail, host) ||
    isLinkedInCommentSurfaceElement(host) ||
    isInsideSocialAttributionText(rail) ||
    isSocialAttributionHost(host) ||
    isSingleLineFlexRowHost(host)
  ) {
    return true;
  }
  const profileUrl = normalizeProfileUrl(rail.querySelector(".lef-button")?.dataset.lefProfileUrl || "");
  if (!profileUrl || !host) {
    return true;
  }
  const link = authorRailMatchingLink(host, profileUrl);
  if (!link) {
    return true;
  }
  return shouldSkipAuthorLink(link, authorNameFromLink(link)) || isCompactAuthorControlHost(host, link);
}

function authorControlRailOverlapsVisibleText(rail, host) {
  if (!rail?.isConnected || !host?.isConnected || !host.contains(rail)) {
    return false;
  }
  const railRect = rail.getBoundingClientRect();
  if (railRect.width <= 0 || railRect.height <= 0) {
    return false;
  }
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = cleanText(node.textContent || "");
      if (!text || node.parentElement?.closest?.(".lef-author-control-rail, .lef-anchor, .lef-popover, .lef-refresh-banner")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    for (const textRect of textNodeClientRects(node)) {
      if (rectsIntersect(railRect, textRect, 2)) {
        return true;
      }
    }
    node = walker.nextNode();
  }
  return false;
}

function textNodeClientRects(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  range.detach();
  return rects;
}

function rectsIntersect(first, second, padding = 0) {
  return (
    first.left < second.right + padding &&
    first.right > second.left - padding &&
    first.top < second.bottom + padding &&
    first.bottom > second.top - padding
  );
}

function authorRailMatchingLink(host, profileUrl) {
  return [...host.querySelectorAll('a[href*="/in/"]')].find(
    (candidate) =>
      normalizeProfileUrl(candidate.href) === profileUrl &&
      !candidate.closest(".lef-author-control-rail, .lef-popover, .lef-refresh-banner"),
  );
}

function authorHostForRail(rail) {
  const previousSibling = rail.previousElementSibling;
  if (previousSibling?.classList?.contains("lef-author-control-host")) {
    return previousSibling;
  }
  const hostedSibling = previousSibling?.querySelector?.(".lef-author-control-host");
  if (hostedSibling) {
    return hostedSibling;
  }
  if (rail.parentElement?.classList?.contains("lef-author-control-host")) {
    return rail.parentElement;
  }
  return rail.parentElement;
}

function authorNameFromLink(link) {
  const labelName = profileNameFromAriaLabel(link.getAttribute("aria-label") || "");
  if (labelName) {
    return labelName;
  }
  const text = textWithoutHelperControls(link);
  return cleanText(text).replace(/\s*\u2022.*$/, "");
}

function profileNameFromAriaLabel(label) {
  const clean = cleanText(label);
  const profileMatch = clean.match(/^(?:view\s+)?(.+?)(?:'s|\u2019s)?\s+profile$/i);
  const candidate = profileMatch ? profileMatch[1] : clean;
  return isLikelyPersonName(candidate) ? candidate : "";
}

function authorControlPlacementTarget(link, name) {
  const normalizedName = cleanText(name);
  const candidates = [link, ...link.querySelectorAll("span, strong, div")];
  const nameElement =
    candidates.find((element) => visibleNameElementText(element) === normalizedName) ||
    candidates.find((element) => {
      const text = visibleNameElementText(element);
      return text.startsWith(`${normalizedName} `) && text.length <= normalizedName.length + 40;
    });

  if (!nameElement) {
    return undefined;
  }

  if (nameElement === link || link.contains(nameElement) || linkMostlyWrapsVisibleName(link, nameElement)) {
    return link;
  }
  return nameElement;
}

function visibleNameElementText(element) {
  const text = cleanText(textWithoutHelperControls(element));
  if (!text) {
    return "";
  }
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || rect.width < 24 || rect.height < 10) {
    return "";
  }
  return text;
}

function linkMostlyWrapsVisibleName(link, nameElement) {
  const linkRect = link.getBoundingClientRect();
  const nameRect = nameElement.getBoundingClientRect();
  return (
    Math.abs(linkRect.left - nameRect.left) <= 8 &&
    Math.abs(linkRect.top - nameRect.top) <= 8 &&
    linkRect.width <= nameRect.width + 96 &&
    linkRect.height <= nameRect.height + 18
  );
}

function isLikelyPersonName(name) {
  const words = cleanText(name).split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.join(" ").length <= 80;
}

function shouldSkipAuthorLink(link, name) {
  if (link.closest('aside, [aria-label="Sidebar"]')) {
    return true;
  }
  if (link.closest("p")) {
    return true;
  }
  if (isSocialAttributionLink(link)) {
    return true;
  }
  if (isTightActionAttributionLine(link, name)) {
    return true;
  }
  if (isDenseSocialActionLine(link, name)) {
    return true;
  }
  if (isLinkedInActionVerbLine(link, name)) {
    return true;
  }
  if (isLinkedInHeaderAttributionLink(link)) {
    return true;
  }
  if (isCompactLinkedInActionSummaryLink(link, name)) {
    return true;
  }
  if (isNearbySocialAttributionLine(link, name)) {
    return true;
  }
  if (isVisualActionAttributionLineLink(link, name)) {
    return true;
  }
  if (isSameLineActionAttributionLink(link, name)) {
    return true;
  }
  if (isVisibleActionAttributionCluster(link, name)) {
    return true;
  }
  if (isActionAttributionAncestorLink(link, name)) {
    return true;
  }
  if (isInlineActionAttributionCluster(link, name)) {
    return true;
  }
  if (isActionAttributionHeaderLink(link, name)) {
    return true;
  }
  if (isCompactInlineActionAttributionLink(link, name)) {
    return true;
  }
  if (isShortActionAttributionLineLink(link, name)) {
    return true;
  }
  if (isCompactAttributionSentenceLink(link)) {
    return true;
  }
  if (isAttributionSentenceAroundLink(link, name)) {
    return true;
  }
  if (isCompactSocialAttributionSentenceLink(link, name)) {
    return true;
  }

  const text = cleanText(textWithoutHelperControls(link) || name).toLowerCase();
  if (text.length > 110) {
    return true;
  }
  if (/premium|profile viewers?|post impressions|because you recently|saved items|newsletters|events/.test(text)) {
    return true;
  }
  if (ancestorTextMatches(link, /profile viewers?|post impressions|your premium features|recommended for you|because you recently/i)) {
    return true;
  }

  const linkStyle = getComputedStyle(link);
  const parentStyle = link.parentElement ? getComputedStyle(link.parentElement) : undefined;
  if (linkStyle.display === "inline" && parentStyle?.display === "inline") {
    return true;
  }

  const rect = link.getBoundingClientRect();
  return rect.width < 24 || rect.height < 12;
}

function isLinkedInActionVerbLine(link, name = "") {
  const linkRect = link.getBoundingClientRect();
  if (linkRect.width < 24 || linkRect.height < 10) {
    return false;
  }
  const normalizedName = cleanText(name).toLowerCase();
  let current = link.parentElement;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const parent = current.parentElement;
    const rect = current.getBoundingClientRect();
    if (rect.height <= 120) {
      const inline = nearbyInlineNodeSnapshot(current);
      const nearby = nearbyAuthorLineSnapshot(current);
      const text = cleanText(
        [
          visualLineTextNearRect(current, linkRect),
          inline.text,
          nearby.text,
          parent ? visualLineTextNearRect(parent, linkRect) : "",
        ]
          .filter(Boolean)
          .join(" "),
      ).toLowerCase();
      const profileUrlCount = Math.max(
        profileUrlsInVisualLine(current, linkRect).size,
        parent ? profileUrlsInVisualLine(parent, linkRect).size : 0,
        inline.profileUrlCount,
        nearby.profileUrlCount,
        profileUrlsInElement(current).size,
        parent ? profileUrlsInElement(parent).size : 0,
      );
      const firstVerbIndex = text.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
      const nameIndex = normalizedName ? text.indexOf(normalizedName) : -1;
      if (
        text &&
        text.length <= 360 &&
        firstVerbIndex >= 0 &&
        (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
        firstVerbIndex <= Math.max(190, (nameIndex >= 0 ? nameIndex : 0) + normalizedName.length + 120) &&
        (profileUrlCount > 1 ||
          /\b(?:and|with)\b/.test(text.slice(0, firstVerbIndex + 32)) ||
          isAttributionSurface(current) ||
          (parent && isAttributionSurface(parent)))
      ) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

function isActionAttributionAncestorLink(link, name = "") {
  const normalizedName = cleanText(name).toLowerCase();
  let current = link.parentElement;
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (current.matches?.("main h1")) {
      return false;
    }
    const text = cleanText(textWithoutHelperControls(current));
    if (!text || text.length > 360 || !hasSocialAttributionVerb(text)) {
      current = current.parentElement;
      continue;
    }
    const clean = text.toLowerCase();
    const rect = current.getBoundingClientRect();
    const profileUrlCount = profileUrlsInElement(current).size;
    const firstVerbIndex = clean.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
    const nameIndex = normalizedName ? clean.indexOf(normalizedName) : -1;
    if (
      firstVerbIndex >= 0 &&
      rect.height <= 120 &&
      (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
      firstVerbIndex <= Math.max(180, (nameIndex >= 0 ? nameIndex : 0) + normalizedName.length + 120) &&
      (profileUrlCount > 1 || /\b(?:and|with)\b/i.test(clean) || isAttributionSurface(current))
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isSocialAttributionLink(link) {
  if (isAttributionContextLink(link)) {
    return true;
  }
  const attributionSurface = link.closest(
    [
      ".update-components-header",
      ".feed-shared-header",
      ".feed-shared-social-activity",
      ".social-details-social-activity",
      ".update-components-social-activity",
      ".update-components-actor__description",
      ".update-components-actor__sub-description",
      '[class*="actor__description"]',
      '[class*="actor__sub-description"]',
    ].join(", "),
  );
  let current = link.parentElement;
  for (let depth = 0; current && depth < 14; depth += 1) {
    const profileUrlCount = profileUrlsInElement(current).size;
    const text = cleanText(textWithoutHelperControls(current));
    if (
      isSocialAttributionText(text, profileUrlCount) ||
      isCompactSocialAttributionText(text, profileUrlCount) ||
      isSocialAttributionHost(current) ||
      (attributionSurface &&
        (attributionSurface.contains(current) || current.contains(attributionSurface)) &&
        hasSocialAttributionVerb(text))
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isAttributionContextLink(link) {
  const context = link.closest(attributionSurfaceSelector());
  if (isCompactActionAttributionContext(link)) {
    return true;
  }
  if (!context) {
    return isLikelyInlineAttributionText(link);
  }
  const text = cleanText(textWithoutHelperControls(context));
  if (!text || text.length > 280 || !hasSocialAttributionVerb(text)) {
    return isLikelyInlineAttributionText(link);
  }
  const profileUrlCount = profileUrlsInElement(context).size;
  return profileUrlCount > 1 || /\b(?:and|with)\b/i.test(text) || isCompactSocialAttributionText(text, profileUrlCount);
}

function isLinkedInHeaderAttributionLink(link) {
  const header = link.closest(attributionSurfaceSelector());
  if (!header) {
    return false;
  }
  const text = cleanText(textWithoutHelperControls(header));
  return Boolean(text && text.length <= 420 && hasSocialAttributionVerb(text));
}

function isCompactLinkedInActionSummaryLink(link, name = "") {
  let current = link.parentElement;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const text = compactActionSummaryLineText(current, link);
    const profileUrlCount = profileUrlsInElement(current).size;
    const rect = current.getBoundingClientRect();
    if (
      text &&
      text.length <= 260 &&
      rect.height <= 72 &&
      isLinkedInActionSummaryText(text, profileUrlCount, name)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function compactActionSummaryLineText(element, link) {
  const parent = element.parentElement;
  const nearbyElements = [
    element,
    ...[...(parent?.children || [])].filter((child) => child !== element && isNearbyElementSibling(child, element)),
  ];
  const text = cleanText(nearbyElements.map((node) => textWithoutHelperControls(node)).join(" "));
  if (text) {
    return text;
  }
  const linkRect = link.getBoundingClientRect();
  return visualLineTextNearRect(element, linkRect);
}

function isLinkedInActionSummaryText(text, profileUrlCount, name = "") {
  const clean = cleanText(text).toLowerCase();
  if (!clean || clean.length > 260 || !hasSocialAttributionVerb(clean)) {
    return false;
  }
  const normalizedName = cleanText(name).toLowerCase();
  const firstVerbIndex = clean.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
  const actionVerbMatch = clean.match(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
  if (firstVerbIndex < 0 || firstVerbIndex > Math.max(180, normalizedName.length + 120)) {
    return false;
  }
  return (
    profileUrlCount >= 1 &&
    (!normalizedName || clean.includes(normalizedName)) &&
    (profileUrlCount > 1 ||
      /\b(?:and|with)\b/.test(clean.slice(0, firstVerbIndex + 20)) ||
      clean.endsWith(actionVerbMatch?.[0] || ""))
  );
}

function isCompactActionAttributionContext(link, name = cleanText(textWithoutHelperControls(link))) {
  const normalizedName = cleanText(name).toLowerCase();
  let current = link.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const text = cleanText(textWithoutHelperControls(current));
    if (!text || text.length > 220) {
      current = current.parentElement;
      continue;
    }
    const clean = text.toLowerCase();
    const rect = current.getBoundingClientRect();
    const firstVerbIndex = clean.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
    const nameIndex = normalizedName ? clean.indexOf(normalizedName) : -1;
    if (
      rect.height <= 64 &&
      firstVerbIndex >= 0 &&
      (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
      firstVerbIndex <= Math.max(120, (nameIndex >= 0 ? nameIndex : 0) + normalizedName.length + 80) &&
      (clean.endsWith(clean.match(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/)?.[0] || "") ||
        /\b(?:and|with)\b/.test(clean) ||
        profileUrlsInElement(current).size >= 1)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isLikelyInlineAttributionText(link) {
  let current = link.parentElement;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const parent = current.parentElement;
    if (!parent) {
      break;
    }
    const siblingText = cleanText(
      [...parent.children]
        .filter((child) => child === current || isNearbyElementSibling(child, current))
        .map((child) => textWithoutHelperControls(child))
        .join(" "),
    );
    if (isActionAttributionText(siblingText, profileUrlsInElement(parent).size, cleanText(textWithoutHelperControls(link)))) {
      return true;
    }
    current = parent;
  }
  return false;
}

function isNearbyElementSibling(candidate, target) {
  if (!candidate || !target || candidate === target) {
    return true;
  }
  const siblings = [...(target.parentElement?.children || [])];
  const candidateIndex = siblings.indexOf(candidate);
  const targetIndex = siblings.indexOf(target);
  return candidateIndex >= 0 && targetIndex >= 0 && Math.abs(candidateIndex - targetIndex) <= 3;
}

function isNearbySocialAttributionLine(link, name = "") {
  let current = link.parentElement;
  for (let depth = 0; current && depth < 12; depth += 1) {
    const { text, profileUrlCount } = nearbyAuthorLineSnapshot(current);
    if (!text || text.length > 420) {
      current = current.parentElement;
      continue;
    }
    if (
      isActionAttributionText(text, profileUrlCount, name) ||
      isCompactSocialAttributionText(text, profileUrlCount) ||
      (hasSocialAttributionVerb(text) && (profileUrlCount > 1 || isAttributionSurface(current)))
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isVisualActionAttributionLineLink(link, name = "") {
  const linkRect = link.getBoundingClientRect();
  if (linkRect.width < 24 || linkRect.height < 10) {
    return false;
  }
  let current = link.parentElement;
  for (let depth = 0; current && depth < 12; depth += 1) {
    const rect = current.getBoundingClientRect();
    if (rect.height <= 180) {
      const text = visualLineTextNearRect(current, linkRect);
      const profileUrlCount = profileUrlsInVisualLine(current, linkRect).size;
      if (
        text &&
        text.length <= 260 &&
        (isActionAttributionText(text, profileUrlCount, name) ||
          isCompactSocialAttributionText(text, profileUrlCount) ||
          isActionVerbNearLinkedInNameLine(text, profileUrlCount, name))
      ) {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

function isVisibleActionAttributionCluster(link, name = "") {
  const linkRect = link.getBoundingClientRect();
  if (linkRect.width < 24 || linkRect.height < 10) {
    return false;
  }
  const normalizedName = cleanText(name).toLowerCase();
  let current = link.parentElement;
  for (let depth = 0; current && depth < 9; depth += 1) {
    const rect = current.getBoundingClientRect();
    if (rect.height <= 90) {
      const lineText = visualLineTextNearRect(current, linkRect);
      const nearby = nearbyAuthorLineSnapshot(current);
      const text = cleanText(lineText || nearby.text).toLowerCase();
      const profileUrlCount = Math.max(profileUrlsInVisualLine(current, linkRect).size, nearby.profileUrlCount);
      const firstVerbIndex = text.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
      const nameIndex = normalizedName ? text.indexOf(normalizedName) : -1;
      if (
        text &&
        text.length <= 260 &&
        firstVerbIndex >= 0 &&
        (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
        firstVerbIndex <= Math.max(170, (nameIndex >= 0 ? nameIndex : 0) + normalizedName.length + 100) &&
        (profileUrlCount >= 1 || (normalizedName && text.includes(normalizedName)))
      ) {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

function isSameLineActionAttributionLink(link, name = "") {
  const linkRect = link.getBoundingClientRect();
  if (linkRect.width < 24 || linkRect.height < 10) {
    return false;
  }
  const normalizedName = cleanText(name).toLowerCase();
  let current = link.parentElement;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const rect = current.getBoundingClientRect();
    if (rect.height <= 84) {
      const lineText = visualLineTextNearRect(current, linkRect);
      const inline = nearbyInlineNodeSnapshot(current);
      const nearby = nearbyAuthorLineSnapshot(current);
      const text = cleanText([lineText, inline.text, nearby.text].filter(Boolean).join(" ")).toLowerCase();
      const profileUrlCount = Math.max(
        profileUrlsInVisualLine(current, linkRect).size,
        inline.profileUrlCount,
        nearby.profileUrlCount,
        profileUrlsInElement(current).size,
      );
      const firstVerbIndex = text.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
      const nameIndex = normalizedName ? text.indexOf(normalizedName) : -1;
      if (
        text &&
        text.length <= 320 &&
        firstVerbIndex >= 0 &&
        (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
        (profileUrlCount > 1 ||
          /\b(?:and|with)\b/.test(text.slice(0, firstVerbIndex + 24)) ||
          text.endsWith(text.match(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/)?.[0] || ""))
      ) {
        return true;
      }
    }
    current = current.parentElement;
  }
  return false;
}

function visualLineTextNearRect(root, referenceRect) {
  return cleanText(visualLineTextNodes(root, referenceRect).map((node) => node.textContent || "").join(" "));
}

function profileUrlsInVisualLine(root, referenceRect) {
  const profileUrls = new Set();
  for (const link of root.querySelectorAll('a[href*="/in/"]')) {
    if (elementOverlapsReferenceLine(link, referenceRect)) {
      const profileUrl = normalizeProfileUrl(link.href);
      if (profileUrl) {
        profileUrls.add(profileUrl);
      }
    }
  }
  return profileUrls;
}

function visualLineTextNodes(root, referenceRect) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = cleanText(node.textContent || "");
      if (!text || node.parentElement?.closest?.(".lef-anchor, .lef-popover, .lef-refresh-banner")) {
        return NodeFilter.FILTER_REJECT;
      }
      return textNodeOverlapsReferenceLine(node, referenceRect) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function textNodeOverlapsReferenceLine(node, referenceRect) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  range.detach();
  return rect.width > 0 && rect.height > 0 && rectOverlapsReferenceLine(rect, referenceRect);
}

function elementOverlapsReferenceLine(element, referenceRect) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rectOverlapsReferenceLine(rect, referenceRect);
}

function rectOverlapsReferenceLine(rect, referenceRect) {
  const referenceMidline = referenceRect.top + referenceRect.height / 2;
  const tolerance = Math.max(10, referenceRect.height * 0.75);
  return rect.top <= referenceMidline + tolerance && rect.bottom >= referenceMidline - tolerance;
}

function isInlineActionAttributionCluster(link, name = "") {
  let current = link;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const { text, profileUrlCount } = nearbyInlineNodeSnapshot(current);
    if (
      isActionAttributionText(text, profileUrlCount, name) ||
      isCompactSocialAttributionText(text, profileUrlCount) ||
      (hasSocialAttributionVerb(text) && profileUrlCount > 1)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function nearbyInlineNodeSnapshot(target) {
  const parent = target?.parentElement;
  if (!parent) {
    return { text: "", profileUrlCount: 0 };
  }
  const siblings = [...parent.childNodes];
  const targetIndex = siblings.indexOf(target);
  const nearbyNodes =
    targetIndex >= 0
      ? siblings.slice(Math.max(0, targetIndex - 4), Math.min(siblings.length, targetIndex + 5))
      : [target];
  const profileUrls = new Set();
  const text = cleanText(
    nearbyNodes
      .map((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          for (const profileUrl of profileUrlsInElement(node)) {
            profileUrls.add(profileUrl);
          }
          return textWithoutHelperControls(node);
        }
        return node.textContent || "";
      })
      .join(" "),
  );
  return { text, profileUrlCount: profileUrls.size };
}

function nearbyAuthorLineSnapshot(element) {
  const nearbyElements = [
    element,
    ...[...(element?.parentElement?.children || [])].filter(
      (child) => child !== element && isNearbyElementSibling(child, element),
    ),
  ].filter(Boolean);
  const profileUrls = new Set();
  const text = cleanText(
    nearbyElements
      .map((nearbyElement) => {
        for (const profileUrl of profileUrlsInElement(nearbyElement)) {
          profileUrls.add(profileUrl);
        }
        return textWithoutHelperControls(nearbyElement);
      })
      .join(" "),
  );
  return { text, profileUrlCount: profileUrls.size };
}

function isActionAttributionHeaderLink(link, name) {
  let current = link.parentElement;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const text = cleanText(textWithoutHelperControls(current));
    if (isActionAttributionText(text, profileUrlsInElement(current).size, name)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isCompactInlineActionAttributionLink(link, name) {
  const normalizedName = cleanText(name).toLowerCase();
  let current = link.parentElement;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const text = cleanText(textWithoutHelperControls(current));
    if (!text || text.length > 280) {
      current = current.parentElement;
      continue;
    }
    const clean = text.toLowerCase();
    const rect = current.getBoundingClientRect();
    if (
      rect.height <= 96 &&
      clean.includes(normalizedName) &&
      hasSocialAttributionVerb(clean) &&
      (/\b(?:and|with)\b/.test(clean) || profileUrlsInElement(current).size > 1)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isShortActionAttributionLineLink(link, name) {
  const normalizedName = cleanText(name).toLowerCase();
  let current = link.parentElement;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const text = cleanText(textWithoutHelperControls(current));
    if (!text || text.length > 260) {
      current = current.parentElement;
      continue;
    }
    const clean = text.toLowerCase();
    const rect = current.getBoundingClientRect();
    const firstVerbIndex = clean.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
    const actionVerbMatch = clean.match(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
    if (
      rect.height <= 72 &&
      firstVerbIndex >= 0 &&
      firstVerbIndex <= Math.max(120, normalizedName.length + 80) &&
      (clean.endsWith(actionVerbMatch?.[0] || "") ||
        /\b(?:and|with)\b/.test(clean) ||
        profileUrlsInElement(current).size > 1)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isAttributionSurface(element) {
  return Boolean(element?.closest(attributionSurfaceSelector()));
}

function isCompactAttributionSentenceLink(link) {
  let current = link.parentElement;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const text = cleanText(textWithoutHelperControls(current));
    if (!text || text.length > 220) {
      current = current.parentElement;
      continue;
    }
    const rect = current.getBoundingClientRect();
    if (
      rect.height <= 54 &&
      hasSocialAttributionVerb(text) &&
      /(?:^|\s)(?:and|with)\s+/i.test(text) &&
      profileUrlsInElement(current).size >= 1
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isAttributionSentenceAroundLink(link, name = "") {
  const normalizedName = cleanText(name).toLowerCase();
  let current = link.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const parent = current.parentElement;
    const text = cleanText(
      [current, ...[...(parent?.children || [])].filter((child) => child !== current && isNearbyElementSibling(child, current))]
        .map((element) => textWithoutHelperControls(element))
        .join(" "),
    );
    if (!text || text.length > 260) {
      current = current.parentElement;
      continue;
    }
    const clean = text.toLowerCase();
    const firstVerbIndex = clean.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
    if (
      firstVerbIndex >= 0 &&
      (!normalizedName || clean.includes(normalizedName)) &&
      (/\b(?:and|with)\b/.test(clean.slice(0, firstVerbIndex + 20)) || profileUrlsInElement(parent || current).size > 1)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isCompactSocialAttributionSentenceLink(link, name = "") {
  const normalizedName = cleanText(name).toLowerCase();
  let current = link.parentElement;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const parent = current.parentElement;
    const lineText = cleanText(textWithoutHelperControls(current));
    const nearbyText = cleanText(
      [current, ...[...(parent?.children || [])].filter((child) => child !== current && isNearbyElementSibling(child, current))]
        .map((element) => textWithoutHelperControls(element))
        .join(" "),
    );
    const text = nearbyText.length >= lineText.length ? nearbyText : lineText;
    if (!text || text.length > 260) {
      current = current.parentElement;
      continue;
    }
    const clean = text.toLowerCase();
    const firstVerbIndex = clean.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
    const nameIndex = normalizedName ? clean.indexOf(normalizedName) : -1;
    const rect = current.getBoundingClientRect();
    const profileUrlCount = new Set([
      ...profileUrlsInElement(current),
      ...profileUrlsInElement(parent || current),
    ]).size;
    if (
      rect.height <= 80 &&
      firstVerbIndex >= 0 &&
      (nameIndex < 0 || firstVerbIndex >= nameIndex) &&
      firstVerbIndex <= Math.max(160, (nameIndex >= 0 ? nameIndex : 0) + normalizedName.length + 96) &&
      (/\b(?:and|with)\b/.test(clean.slice(0, firstVerbIndex + 20)) ||
        profileUrlCount > 1 ||
        clean.endsWith(clean.match(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/)?.[0] || ""))
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function attributionSurfaceSelector() {
  return [
    ".update-components-header",
    ".feed-shared-header",
    ".feed-shared-update-v2__description",
    ".feed-shared-social-activity",
    ".social-details-social-activity",
    ".update-components-social-activity",
    ".update-components-actor__description",
    ".update-components-actor__sub-description",
    '[class*="feed-shared-update-v2__description"]',
    '[class*="social-activity"]',
    '[class*="update-components-header"]',
    '[class*="feed-shared-header"]',
    '[class*="actor__description"]',
    '[class*="actor__sub-description"]',
  ].join(", ");
}

function feedActionAttributionSelector() {
  return [
    ".feed-shared-update-v2__description",
    ".update-components-header",
    ".feed-shared-header",
    ".feed-shared-social-activity",
    ".social-details-social-activity",
    ".update-components-social-activity",
    ".update-components-actor__description",
    ".update-components-actor__sub-description",
    '[class*="actor__description"]',
    '[class*="actor__sub-description"]',
    '[class*="feed-shared-update-v2__description"]',
    '[class*="update-components-header"]',
    '[class*="feed-shared-header"]',
    '[class*="social-activity"]',
    '[class*="attribution"]',
  ].join(", ");
}

function isSocialAttributionText(text, profileUrlCount) {
  const clean = cleanText(text).toLowerCase();
  return (
    profileUrlCount > 1 &&
    clean.length <= 320 &&
    /\b(?:and|with)\b/.test(clean) &&
    hasSocialAttributionVerb(clean)
  );
}

function isActionAttributionText(text, profileUrlCount, name = "") {
  const clean = cleanText(text).toLowerCase();
  if (!clean || clean.length > 420 || !hasSocialAttributionVerb(clean)) {
    return false;
  }
  const normalizedName = cleanText(name).toLowerCase();
  const firstVerbIndex = clean.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
  const actionVerbMatch = clean.match(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
  const likelyHeaderWindow = firstVerbIndex >= 0 && firstVerbIndex <= Math.max(160, normalizedName.length + 96);
  return (
    likelyHeaderWindow &&
    (profileUrlCount > 1 ||
      /\b(?:and|with)\b/.test(clean.slice(0, firstVerbIndex + 20)) ||
      (profileUrlCount >= 1 &&
        (!normalizedName || clean.includes(normalizedName)) &&
        clean.endsWith(actionVerbMatch?.[0] || "")))
  );
}

function isActionVerbNearLinkedInNameLine(text, profileUrlCount, name = "") {
  const clean = cleanText(text).toLowerCase();
  if (!clean || clean.length > 260 || !hasSocialAttributionVerb(clean)) {
    return false;
  }
  const normalizedName = cleanText(name).toLowerCase();
  const firstVerbIndex = clean.search(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
  const actionVerbMatch = clean.match(/\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/);
  if (firstVerbIndex < 0 || firstVerbIndex > Math.max(180, normalizedName.length + 120)) {
    return false;
  }
  return (
    profileUrlCount >= 1 &&
    (!normalizedName || clean.includes(normalizedName)) &&
    (/\b(?:and|with)\b/.test(clean.slice(0, firstVerbIndex + 20)) || clean.endsWith(actionVerbMatch?.[0] || ""))
  );
}

function isSingleLineFlexRowHost(host) {
  if (!host) {
    return false;
  }
  const style = getComputedStyle(host);
  return (
    (style.display === "flex" || style.display === "inline-flex") &&
    style.flexWrap === "nowrap" &&
    (!style.flexDirection || style.flexDirection.startsWith("row"))
  );
}

function isCompactAuthorControlHost(host, placementTarget) {
  if (!host || !placementTarget) {
    return false;
  }
  const hostRect = host.getBoundingClientRect();
  const targetRect = placementTarget.getBoundingClientRect();
  const text = cleanText(textWithoutHelperControls(host)).toLowerCase();
  const targetText = cleanText(textWithoutHelperControls(placementTarget)).toLowerCase();
  return Boolean(
    targetText &&
      hostRect.height < 52 &&
      targetRect.height <= 28 &&
      text.startsWith(targetText) &&
      text.length <= targetText.length + 96,
  );
}

function authorHostHasRoomForControl(host, placementTarget, options = {}) {
  if (!host || !placementTarget) {
    return false;
  }
  const hostRect = host.getBoundingClientRect();
  const targetRect = placementTarget.getBoundingClientRect();
  const minWidth = options.minWidth || AUTHOR_CONTROL_MIN_HOST_WIDTH;
  const slotWidth = options.slotWidth || AUTHOR_CONTROL_SLOT_WIDTH;
  const visibleTargetWidth = targetRect.width > 0 ? targetRect.width : 0;
  const occupiedLineRight = Math.max(targetRect.right, rightmostTextRectInReferenceLine(host, targetRect));
  const inlineRoomAfterTarget = Math.max(0, hostRect.right - occupiedLineRight);
  const safeSlotWidth = slotWidth + 8;
  return (
    inlineRoomAfterTarget >= safeSlotWidth &&
    hostRect.width >= Math.max(minWidth, Math.min(260, visibleTargetWidth) + safeSlotWidth)
  );
}

function rightmostTextRectInReferenceLine(host, referenceRect) {
  if (!host || !referenceRect) {
    return 0;
  }
  let right = 0;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = cleanText(node.textContent || "");
      if (!text || node.parentElement?.closest?.(".lef-author-control-rail, .lef-anchor, .lef-popover, .lef-refresh-banner")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode();
  while (node) {
    for (const textRect of textNodeClientRects(node)) {
      if (rectOverlapsReferenceLine(textRect, referenceRect)) {
        right = Math.max(right, textRect.right);
      }
    }
    node = walker.nextNode();
  }
  return right;
}

function isCompactNameOnlyHost(host, link, text, rect) {
  const linkText = cleanText(textWithoutHelperControls(link));
  return Boolean(
    linkText &&
      rect.height < 44 &&
      text.toLowerCase().startsWith(linkText.toLowerCase()) &&
      text.length <= linkText.length + 32,
  );
}

function isCompactSocialAttributionText(text, profileUrlCount) {
  const clean = cleanText(text).toLowerCase();
  return (
    profileUrlCount >= 1 &&
    clean.length <= 180 &&
    /\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\s*$/.test(clean)
  );
}

function isInsideSocialAttributionText(element) {
  let current = element?.parentElement || null;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const text = cleanText(textWithoutHelperControls(current));
    const profileUrlCount = profileUrlsInElement(current).size;
    if (
      isSocialAttributionText(text, profileUrlCount) ||
      isCompactSocialAttributionText(text, profileUrlCount) ||
      isSocialAttributionHost(current)
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isSocialAttributionHost(element) {
  if (!element) {
    return false;
  }
  const text = cleanText(textWithoutHelperControls(element));
  const profileUrlCount = profileUrlsInElement(element).size;
  const rect = element.getBoundingClientRect();
  return (
    hasSocialAttributionVerb(text) &&
    profileUrlCount > 1 &&
    text.length <= 420 &&
    rect.height <= 90 &&
    /\b(?:and|with)\b/i.test(text)
  );
}

function hasSocialAttributionVerb(text) {
  return /\b(?:commented|replied|reacted|liked|reposted|shared|followed|mentioned)\b/.test(
    cleanText(text).toLowerCase(),
  );
}

function profileUrlsInElement(element) {
  const links = [
    ...(element.matches?.('a[href*="/in/"]') ? [element] : []),
    ...element.querySelectorAll('a[href*="/in/"]'),
  ];
  return new Set(links.map((link) => normalizeProfileUrl(link.href)).filter(Boolean));
}

function ancestorTextMatches(element, pattern) {
  let current = element.parentElement;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (pattern.test(cleanText(textWithoutHelperControls(current)))) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

function createAnchorControl(name, profileUrl, options = {}) {
  const normalizedProfileUrl = normalizeProfileUrl(profileUrl);
  const wrapper = document.createElement("span");
  wrapper.className = options.placement ? `lef-anchor lef-anchor-${options.placement}` : "lef-anchor";
  wrapper.dataset.lefProfileUrl = normalizedProfileUrl;
  const button = document.createElement("button");
  button.className = "lef-button";
  if (options.placement !== "profile-heading") {
    button.classList.add("lef-button-compact");
  }
  button.type = "button";
  button.dataset.lefProfileUrl = normalizedProfileUrl;
  updateButtonLabel(button, 0);
  wrapper.appendChild(button);

  updateButtonState(button, normalizedProfileUrl, { background: true });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPopover(button, { name, profileUrl: normalizedProfileUrl });
  });

  return wrapper;
}

async function updateButtonState(button, profileUrl, options = {}) {
  const normalizedProfileUrl = normalizeProfileUrl(profileUrl);
  const status = await profileStatus(normalizedProfileUrl, options).catch(() => undefined);
  applyButtonStatus(button, normalizedProfileUrl, status);
}

function applyButtonStatus(button, profileUrl, status) {
  const normalizedProfileUrl = normalizeProfileUrl(profileUrl);
  if (!button.isConnected || button.dataset.lefProfileUrl !== normalizedProfileUrl) {
    return;
  }
  compactNonProfileButton(button);
  button.dataset.lefStatusRefreshedAt = String(Date.now());
  if (!status) {
    button.classList.add("lef-offline");
    button.classList.remove("lef-member");
    updateButtonLabel(button, 0, { offline: true });
    removeButtonIfItNowCollides(button);
    return;
  }
  const count = Array.isArray(status.feedIds) ? status.feedIds.length : 0;
  button.classList.toggle("lef-member", count > 0);
  button.classList.remove("lef-offline");
  updateButtonLabel(button, count);
  removeButtonIfItNowCollides(button);
}

function updateButtonLabel(button, count, options = {}) {
  const isCompact = button.classList.contains("lef-button-compact");
  const safeCount = isSafeInteger(count) && count > 0 ? count : 0;
  if (isCompact) {
    button.textContent = safeCount > 0 ? String(Math.min(safeCount, 99)) : "+";
  } else {
    button.textContent = safeCount > 0 ? `In ${safeCount}` : "Feeds";
  }
  const membershipText =
    safeCount > 0
      ? `In ${safeCount} custom engagement ${safeCount === 1 ? "feed" : "feeds"}`
      : "Add this person to a custom engagement feed";
  const offlineText = options.offline ? " Local app is offline." : "";
  button.title = `${membershipText}.${offlineText}`.trim();
  button.setAttribute("aria-label", membershipText);
}

function compactNonProfileButton(button) {
  if (!button.closest(".lef-anchor-profile-heading")) {
    button.classList.add("lef-button-compact");
  }
}

function removeButtonIfItNowCollides(button) {
  const rail = button.closest(".lef-author-control-rail");
  if (!rail) {
    if (!button.classList.contains("lef-button-compact") && !button.closest("main h1, .lef-popover, .lef-anchor-profile-heading")) {
      (button.closest(".lef-anchor") || button).remove();
    }
    return;
  }

  const host = authorHostForRail(rail);
  if (authorControlRailOverlapsVisibleText(rail, host)) {
    const control = button.closest(".lef-anchor") || button;
    control.remove();
    removeEmptyAuthorControlRail(host, rail);
  }
}

function updateProfileControls(profileUrl) {
  const normalizedProfileUrl = normalizeProfileUrl(profileUrl);
  for (const button of document.querySelectorAll(".lef-button")) {
    if (button.dataset.lefProfileUrl === normalizedProfileUrl) {
      updateButtonState(button, normalizedProfileUrl);
    }
  }
}

function updateVisibleButtonStates() {
  const buttonsByProfileUrl = new Map();
  for (const button of document.querySelectorAll(".lef-button")) {
    const profileUrl = normalizeProfileUrl(button.dataset.lefProfileUrl || "");
    if (!profileUrl || !buttonShouldRefreshStatus(button)) {
      continue;
    }
    const entry = buttonsByProfileUrl.get(profileUrl) || { buttons: [], needsRefresh: false };
    entry.buttons.push(button);
    entry.needsRefresh = entry.needsRefresh || buttonNeedsStatusRefresh(button);
    buttonsByProfileUrl.set(profileUrl, entry);
  }
  for (const [profileUrl, { buttons, needsRefresh }] of buttonsByProfileUrl) {
    if (!needsRefresh) {
      continue;
    }
    profileStatus(profileUrl, { background: true })
      .then((status) => {
        for (const button of buttons) {
          applyButtonStatus(button, profileUrl, status);
        }
      })
      .catch(() => {
        for (const button of buttons) {
          applyButtonStatus(button, profileUrl, undefined);
        }
      });
  }
}

function buttonNeedsStatusRefresh(button) {
  const refreshedAt = Number(button.dataset.lefStatusRefreshedAt || 0);
  return !Number.isFinite(refreshedAt) || Date.now() - refreshedAt >= STATUS_BUTTON_REFRESH_TTL_MS;
}

function buttonShouldRefreshStatus(button) {
  if (!button.isConnected) {
    return false;
  }
  if (button === state.activePopoverAnchor || button.closest(".lef-anchor-profile-heading")) {
    return true;
  }
  const rect = button.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const margin = STATUS_BUTTON_VIEWPORT_MARGIN_PX;
  return (
    rect.bottom >= -margin &&
    rect.top <= window.innerHeight + margin &&
    rect.right >= -margin &&
    rect.left <= window.innerWidth + margin
  );
}

async function openPopover(anchor, person) {
  closeActivePopover({ cancelPending: false });
  const popoverRequestId = ++state.popoverRequestSequence;
  state.popoverOpening = true;
  let feedLoadError = "";
  try {
    await refreshFeeds();
  } catch (nextError) {
    feedLoadError = errorMessage(nextError);
  }
  let status;
  let membershipLoadError = "";
  try {
    status = await profileStatus(person.profileUrl, { force: true });
  } catch (nextError) {
    membershipLoadError = `Could not load current feed membership. ${errorMessage(nextError)}`;
  }
  if (!popoverRequestIsCurrent(popoverRequestId, anchor)) {
    finishPopoverOpening(popoverRequestId);
    return;
  }
  const feedListLoaded = !feedLoadError;
  const membershipStatusLoaded = status && Array.isArray(status.feedIds);
  const popoverReady = feedListLoaded && membershipStatusLoaded;
  const selected = new Set(membershipStatusLoaded ? status.feedIds : []);
  const knownFeedIds = new Set(popoverReady ? state.feeds.map((feed) => feed.id).filter(Boolean) : []);
  const popover = document.createElement("div");
  popover.className = "lef-popover";
  popover.innerHTML = `<strong>${escapeHtml(person.name || "LinkedIn member")}</strong>`;

  const error = document.createElement("span");
  error.className = "lef-popover-error";
  error.textContent = [feedLoadError, membershipLoadError].filter(Boolean).join(" ");
  const setPopoverBusy = (busy) => {
    for (const control of popover.querySelectorAll("input, button")) {
      const fullFeedAddBlocked = control.dataset.lefFeedFull === "true" && !control.checked;
      control.disabled =
        busy || fullFeedAddBlocked || (control.dataset.lefRequiresPopoverReady === "true" && !popoverReady);
    }
  };
  const reconcileSelectedFeeds = (nextStatus) => {
    if (!nextStatus || !Array.isArray(nextStatus.feedIds)) {
      return;
    }
    selected.clear();
    for (const feedId of nextStatus.feedIds.filter(Boolean)) {
      selected.add(feedId);
    }
    for (const checkbox of popover.querySelectorAll('input[type="checkbox"][data-lef-feed-id]')) {
      checkbox.checked = selected.has(checkbox.dataset.lefFeedId);
    }
  };
  const refreshPopoverFeedRows = () => {
    for (const checkbox of popover.querySelectorAll('input[type="checkbox"][data-lef-feed-id]')) {
      const feed = state.feeds.find((currentFeed) => currentFeed.id === checkbox.dataset.lefFeedId);
      if (!feed) {
        continue;
      }
      const peopleCount = boundedFeedPeopleCount(feed.peopleCount);
      checkbox.dataset.lefFeedFull = String(peopleCount >= MAX_PEOPLE_PER_FEED);
      checkbox.title =
        checkbox.dataset.lefFeedFull === "true" && !checkbox.checked
          ? "This feed is full. Remove someone before adding a new profile."
          : "";
      const countLabel = checkbox.parentElement?.querySelector(".lef-feed-count");
      if (countLabel) {
        countLabel.textContent = `${feed.name} (${peopleCount}/${MAX_PEOPLE_PER_FEED})`;
      }
    }
  };

  const feedRowExists = (feedId) =>
    [...popover.querySelectorAll('input[type="checkbox"][data-lef-feed-id]')].some(
      (checkbox) => checkbox.dataset.lefFeedId === feedId,
    );
  const renderFeedRow = (feed) => {
    const row = document.createElement("label");
    row.className = "lef-feed-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.lefFeedId = feed.id;
    checkbox.dataset.lefFeedFull = String(boundedFeedPeopleCount(feed.peopleCount) >= MAX_PEOPLE_PER_FEED);
    checkbox.dataset.lefRequiresPopoverReady = "true";
    checkbox.checked = selected.has(feed.id);
    checkbox.disabled = !popoverReady || (checkbox.dataset.lefFeedFull === "true" && !checkbox.checked);
    if (checkbox.disabled && checkbox.dataset.lefFeedFull === "true") {
      checkbox.title = "This feed is full. Remove someone before adding a new profile.";
    }
    checkbox.addEventListener("change", async () => {
      setPopoverBusy(true);
      error.textContent = "";
      const previousFeedIds = [...selected];
      try {
        if (checkbox.checked) {
          selected.add(feed.id);
        } else {
          selected.delete(feed.id);
        }
        const nextStatus = await saveMembership(person, [...selected], [...knownFeedIds]);
        if (!popoverActionIsCurrent(popoverRequestId, popover, anchor)) {
          return;
        }
        reconcileSelectedFeeds(nextStatus);
        updateFeedCountsForMembershipChange(previousFeedIds, nextStatus.feedIds);
        refreshPopoverFeedRows();
        rememberProfileStatus(person.profileUrl, nextStatus);
        updateProfileControls(person.profileUrl);
      } catch (nextError) {
        if (!popoverActionIsCurrent(popoverRequestId, popover, anchor)) {
          return;
        }
        if (checkbox.checked) {
          selected.delete(feed.id);
        } else {
          selected.add(feed.id);
        }
        checkbox.checked = selected.has(feed.id);
        error.textContent = errorMessage(nextError);
      } finally {
        if (popoverActionIsCurrent(popoverRequestId, popover, anchor)) {
          setPopoverBusy(false);
        }
      }
    });
    const countLabel = document.createElement("span");
    countLabel.className = "lef-feed-count";
    countLabel.textContent = `${feed.name} (${boundedFeedPeopleCount(feed.peopleCount)}/${MAX_PEOPLE_PER_FEED})`;
    row.append(checkbox, countLabel);
    return row;
  };
  const appendFeedRow = (feed, beforeNode) => {
    if (!feed?.id || feedRowExists(feed.id)) {
      return;
    }
    popover.insertBefore(renderFeedRow(feed), beforeNode || null);
  };

  for (const feed of state.feeds) {
    appendFeedRow(feed);
  }

  const newFeed = document.createElement("form");
  newFeed.className = "lef-new-feed";
  newFeed.innerHTML = `<input placeholder="Quick-create feed" aria-label="New feed name" maxlength="80" /><button type="submit">Add</button>`;
  for (const control of newFeed.querySelectorAll("input, button")) {
    control.dataset.lefRequiresPopoverReady = "true";
    control.disabled = !popoverReady;
  }
  newFeed.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!popoverReady) {
      error.textContent = [feedLoadError, membershipLoadError].filter(Boolean).join(" ") || "Could not load current feed data.";
      return;
    }
    const input = newFeed.querySelector("input");
    const submit = newFeed.querySelector("button");
    const name = input.value.trim();
    if (!name) {
      return;
    }
    error.textContent = "";
    setPopoverBusy(true);
    let previousFeedIds = [];
    let attemptedFeedId = "";
    try {
      const requestId = createClientRequestId();
      const feed = await request("/api/feeds/get-or-create", {
        method: "POST",
        body: { name, lookbackDays: 15, requestId },
        validate: normalizeFeedSnapshot,
      });
      if (!popoverActionIsCurrent(popoverRequestId, popover, anchor)) {
        return;
      }
      rememberFeeds(upsertFeedSnapshot(state.feeds, feed));
      appendFeedRow(feed, newFeed);
      if (boundedFeedPeopleCount(feed.peopleCount) >= MAX_PEOPLE_PER_FEED && !selected.has(feed.id)) {
        refreshPopoverFeedRows();
        error.textContent = `"${feed.name}" already has ${MAX_PEOPLE_PER_FEED} people. Remove someone before adding a new profile.`;
        return;
      }
      previousFeedIds = [...selected];
      selected.add(feed.id);
      attemptedFeedId = feed.id;
      knownFeedIds.add(feed.id);
      const nextStatus = await saveMembership(person, [...selected], [...knownFeedIds]);
      if (!popoverActionIsCurrent(popoverRequestId, popover, anchor)) {
        return;
      }
      reconcileSelectedFeeds(nextStatus);
      updateFeedCountsForMembershipChange(previousFeedIds, nextStatus.feedIds);
      rememberProfileStatus(person.profileUrl, nextStatus);
      updateProfileControls(person.profileUrl);
      closeActivePopover({ cancelPending: false });
    } catch (nextError) {
      if (!popoverActionIsCurrent(popoverRequestId, popover, anchor)) {
        return;
      }
      if (attemptedFeedId) {
        selected.clear();
        for (const feedId of previousFeedIds) {
          selected.add(feedId);
        }
        reconcileSelectedFeeds({ feedIds: previousFeedIds });
      }
      error.textContent = errorMessage(nextError);
    } finally {
      if (popoverActionIsCurrent(popoverRequestId, popover, anchor)) {
        setPopoverBusy(false);
      }
    }
  });
  popover.appendChild(newFeed);
  popover.appendChild(error);

  const hint = document.createElement("span");
  hint.className = "lef-hint";
  hint.textContent = "Saved locally to your Engagement Feed app.";
  popover.appendChild(hint);

  popover.style.visibility = "hidden";
  if (!popoverRequestIsCurrent(popoverRequestId, anchor)) {
    finishPopoverOpening(popoverRequestId);
    return;
  }
  state.popoverOpening = false;
  document.body.appendChild(popover);
  state.activePopover = popover;
  state.activePopoverAnchor = anchor;
  positionPopover(popover, anchor);
  popover.style.visibility = "";
}

function popoverRequestIsCurrent(requestId, anchor) {
  return requestId === state.popoverRequestSequence && anchor.isConnected;
}

function popoverActionIsCurrent(requestId, popover, anchor) {
  return popoverRequestIsCurrent(requestId, anchor) && state.activePopover === popover && popover.isConnected;
}

function positionPopover(popover, anchor) {
  if (!popover?.isConnected || !anchor?.isConnected) {
    return;
  }
  const margin = 12;
  const gap = 8;
  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth || 280;
  const height = popover.offsetHeight || 300;
  const fitsBelow = rect.bottom + gap + height <= window.innerHeight - margin;
  const preferredTop = fitsBelow ? rect.bottom + gap : rect.top - gap - height;
  const top = Math.max(margin, Math.min(preferredTop, window.innerHeight - margin - height));
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - margin - width));
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

function scheduleActivePopoverPosition() {
  if (!state.activePopover && !state.popoverOpening) {
    return;
  }
  if (state.popoverPositionFrame) {
    return;
  }
  state.popoverPositionFrame = window.requestAnimationFrame(() => {
    state.popoverPositionFrame = 0;
    if (state.activePopover && state.activePopoverAnchor?.isConnected) {
      positionPopover(state.activePopover, state.activePopoverAnchor);
      return;
    }
    if (state.activePopover || state.popoverOpening) {
      closeActivePopover();
    }
  });
}

function finishPopoverOpening(requestId) {
  if (requestId === state.popoverRequestSequence) {
    state.popoverOpening = false;
  }
}

function closeActivePopover({ cancelPending = true } = {}) {
  if (cancelPending) {
    state.popoverRequestSequence += 1;
  }
  if (state.popoverPositionFrame) {
    window.cancelAnimationFrame(state.popoverPositionFrame);
    state.popoverPositionFrame = 0;
  }
  state.popoverOpening = false;
  state.activePopover?.remove();
  state.activePopover = null;
  state.activePopoverAnchor = null;
}

function closeDetachedPopover() {
  if (state.activePopover && (!state.activePopover.isConnected || !state.activePopoverAnchor?.isConnected)) {
    closeActivePopover();
  }
}

function upsertFeedSnapshot(feeds, feed) {
  if (!feed || !feed.id) {
    return feeds;
  }
  const existingIndex = feeds.findIndex((currentFeed) => currentFeed.id === feed.id);
  if (existingIndex === -1) {
    return [...feeds, feed];
  }
  return feeds.map((currentFeed, index) => (index === existingIndex ? feed : currentFeed));
}

function updateFeedCountsForMembershipChange(previousFeedIds, nextFeedIds) {
  if (!Array.isArray(nextFeedIds)) {
    return;
  }
  const previous = new Set(previousFeedIds.filter(Boolean));
  const next = new Set(nextFeedIds.filter(Boolean));
  let changed = false;
  state.feeds = state.feeds.map((feed) => {
    const wasMember = previous.has(feed.id);
    const isMember = next.has(feed.id);
    if (wasMember === isMember) {
      return feed;
    }
    changed = true;
    const currentCount = boundedFeedPeopleCount(feed.peopleCount);
    const peopleCount = boundedFeedPeopleCount(currentCount + (isMember ? 1 : -1));
    return { ...feed, peopleCount };
  });
  if (changed) {
    state.lastFeedFetchAt = 0;
  }
}

function boundedFeedPeopleCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_PEOPLE_PER_FEED, Math.round(count)));
}

function requireFeedPeopleCount(value) {
  if (!isSafeInteger(value) || value < 0 || value > MAX_PEOPLE_PER_FEED) {
    throw new MalformedApiResponseError("Feed response has an invalid people count.");
  }
  return value;
}

function normalizeFeedSnapshots(value) {
  if (!Array.isArray(value)) {
    throw new MalformedApiResponseError("Feed list response was malformed.");
  }
  const feeds = value.map(normalizeFeedSnapshot);
  const feedIds = feeds.map((feed) => feed.id);
  if (new Set(feedIds).size !== feedIds.length) {
    throw new MalformedApiResponseError("Feed list response has duplicate feed ids.");
  }
  return feeds;
}

function normalizeFeedSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MalformedApiResponseError("Feed response was malformed.");
  }
  requireNonEmptyString(value, "id", "feed");
  requireNonEmptyString(value, "name", "feed");
  return {
    ...value,
    id: value.id,
    name: value.name,
    lookbackDays: requireIntegerInRange(value, "lookbackDays", "feed", 1, 365),
    peopleCount: requireFeedPeopleCount(value.peopleCount),
  };
}

function normalizeProfileStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.feedIds)) {
    throw new MalformedApiResponseError("Profile status response was malformed.");
  }
  if (
    value.feedIds.some((feedId) => typeof feedId !== "string" || !feedId.trim() || feedId !== feedId.trim()) ||
    new Set(value.feedIds).size !== value.feedIds.length
  ) {
    throw new MalformedApiResponseError("Profile status response has invalid feed ids.");
  }
  return {
    ...value,
    feedIds: value.feedIds,
  };
}

function normalizeProfileStatusMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MalformedApiResponseError("Profile status batch response was malformed.");
  }
  const statuses = {};
  const seenProfileUrls = new Set();
  for (const [profileUrl, status] of Object.entries(value)) {
    const normalizedProfileUrl = normalizeProfileUrl(profileUrl);
    if (!normalizedProfileUrl || normalizedProfileUrl !== profileUrl || seenProfileUrls.has(normalizedProfileUrl)) {
      throw new MalformedApiResponseError("Profile status batch response has invalid profile urls.");
    }
    seenProfileUrls.add(normalizedProfileUrl);
    statuses[normalizedProfileUrl] = normalizeProfileStatus(status);
  }
  return statuses;
}

async function saveMembership(person, feedIds, knownFeedIds = feedIds) {
  const requestId = createClientRequestId();
  return request("/api/profile-memberships", {
    method: "POST",
    validate: normalizeProfileStatus,
    body: {
      name: person.name,
      profileUrl: person.profileUrl,
      feedIds,
      knownFeedIds,
      requestId,
    },
  });
}

async function captureVisibleActivity(options = {}) {
  const activeFeedIds = options.feedId
    ? [options.feedId]
    : await inferActiveFeedIds({ background: Boolean(options.background) });
  if (activeFeedIds.length === 0) {
    return emptyCaptureResult();
  }

  const ownerProfileUrl = options.ownerProfileUrl || currentProfileUrl();
  const ownerName = options.ownerName || profileHeadingName();
  const containers = visibleActivityContainers({ includeLoaded: Boolean(options.includeLoaded) });
  const lookbackCutoffTime = options.reason === "refresh-session" ? timestampFromIso(options.lookbackCutoffAt) : 0;
  const items = [];
  const seen = new Set();

  for (const container of containers.slice(0, 60)) {
    const anchor = container.querySelector('a[href*="/in/"]');
    const profileUrl = ownerProfileUrl || normalizeProfileUrl(anchor?.href || "");
    if (!profileUrl) {
      continue;
    }

    const sourceAnchor =
      container.querySelector('a[href*="/feed/update/"]') ||
      container.querySelector('a[href*="/posts/"]') ||
      container.querySelector('a[href*="/pulse/"]') ||
      container.querySelector('a[href*="/comments/"]');
    const text = capturedTextFromElement(container).slice(0, 1600);
    if (text.length < 12) {
      continue;
    }

    const activityTimestamp = activityTimestampFromContainer(container);
    if (!activityTimestamp && activityTimestampRequired(options)) {
      continue;
    }
    if (lookbackCutoffTime && activityTimestamp && activityTimestamp < lookbackCutoffTime) {
      break;
    }
    const activityAt = activityTimestamp ? new Date(activityTimestamp).toISOString() : new Date().toISOString();
    const type = options.targetKind === "comments" ? "comment" : inferActivityType(text);
    const sourceUrl = normalizeSourceUrl(sourceAnchor?.href || "");
    if (!sourceUrl && isWholePageFallbackContainer(container)) {
      continue;
    }
    const fallbackSourceUrl = sourceUrl || normalizeSourceUrl(location.href);
    if (!fallbackSourceUrl) {
      continue;
    }
    const externalId = stableItemId(profileUrl, fallbackSourceUrl, type, text, activityAt);
    if (seen.has(externalId)) {
      continue;
    }
    seen.add(externalId);

    items.push({
      personName: ownerName || capturedTextFromElement(anchor) || "LinkedIn member",
      profileUrl,
      ownerProfileUrl,
      type,
      sourceUrl: fallbackSourceUrl,
      externalId,
      text,
      activityAt,
    });
  }

  if (items.length === 0) {
    return emptyCaptureResult();
  }

  const passiveSignature = passiveCaptureSignature(activeFeedIds, items, options);
  if (passiveSignature && passiveCaptureRecentlySucceeded(passiveSignature)) {
    return emptyCaptureResult();
  }

  const result = await captureItemsForFeeds(activeFeedIds, items, options);
  if (passiveSignature) {
    rememberPassiveCaptureSignature(passiveSignature);
  }
  return result;
}

function visibleActivityContainers({ includeLoaded = false } = {}) {
  const selectors = [
    ".feed-shared-update-v2",
    ".occludable-update",
    ".profile-creator-shared-feed-update__container",
    ".comments-comment-item",
    ".update-components-actor",
  ];
  const containers = dedupeNestedActivityContainers([...document.querySelectorAll(selectors.join(","))].filter((node) => {
    const rect = node.getBoundingClientRect();
    const isUsableContainer = rect.width > 240 && rect.height > 40;
    return isUsableContainer && (includeLoaded || (rect.bottom > 0 && rect.top < window.innerHeight + 1200));
  }));
  if (containers.length > 0) {
    return containers;
  }
  const main = document.querySelector("main");
  return main ? [main] : [];
}

function isWholePageFallbackContainer(container) {
  return container.matches("main");
}

function activityTimestampRequired(options) {
  return options.reason === "refresh-session";
}

function dedupeNestedActivityContainers(containers) {
  return containers.filter((node) => {
    if (!node.matches(".update-components-actor")) {
      return true;
    }
    return !containers.some(
      (other) => other !== node && !other.matches(".update-components-actor") && other.contains(node),
    );
  });
}

async function inferActiveFeedIds(options = {}) {
  const profileUrl = currentProfileUrl();
  if (!profileUrl) {
    return [];
  }
  const status = await profileStatus(profileUrl, options).catch(() => undefined);
  return Array.isArray(status?.feedIds) ? [...new Set(status.feedIds.filter(Boolean))] : [];
}

async function profileStatus(profileUrl, options = {}) {
  const normalized = normalizeProfileUrl(profileUrl);
  if (!normalized) {
    return { feedIds: [] };
  }
  const cached = state.statusCache.get(normalized);
  if (!options.force && cached && Date.now() - cached.fetchedAt < STATUS_CACHE_TTL_MS) {
    return cached.status;
  }
  if (!options.force && state.statusRequests.has(normalized)) {
    return state.statusRequests.get(normalized);
  }
  const sequence = ++state.statusWriteSequence;
  if (!options.force && options.background) {
    return enqueueProfileStatusBatch(normalized, sequence);
  }
  const statusRequest = request(`/api/profile-status?profileUrl=${encodeURIComponent(normalized)}`, {
    background: Boolean(options.background),
    timeoutMs: options.background ? BACKGROUND_REQUEST_TIMEOUT_MS : undefined,
    validate: normalizeProfileStatus,
  })
    .then((status) => rememberProfileStatus(normalized, status, sequence))
    .finally(() => {
      if (state.statusRequests.get(normalized) === statusRequest) {
        state.statusRequests.delete(normalized);
      }
    });
  if (!options.force) {
    state.statusRequests.set(normalized, statusRequest);
  }
  return statusRequest;
}

function enqueueProfileStatusBatch(normalized, sequence) {
  const statusRequest = new Promise((resolve, reject) => {
    state.statusBatchQueue.set(normalized, { resolve, reject, sequence });
  });
  state.statusRequests.set(normalized, statusRequest);
  if (!state.statusBatchTimer) {
    state.statusBatchTimer = window.setTimeout(flushProfileStatusBatch, STATUS_BATCH_DELAY_MS);
  }
  return statusRequest;
}

async function flushProfileStatusBatch() {
  const entries = [...state.statusBatchQueue.entries()];
  state.statusBatchQueue.clear();
  state.statusBatchTimer = 0;
  if (entries.length === 0) {
    return;
  }
  for (const chunk of chunkEntries(entries, STATUS_BATCH_SIZE)) {
    try {
      const profileUrls = chunk.map(([profileUrl]) => profileUrl);
      const statuses = await request("/api/profile-statuses", {
        method: "POST",
        body: { profileUrls },
        background: true,
        timeoutMs: BACKGROUND_REQUEST_TIMEOUT_MS,
        validate: normalizeProfileStatusMap,
      });
      requireProfileStatusBatchEntries(statuses, profileUrls);
      for (const [profileUrl, entry] of chunk) {
        entry.resolve(rememberProfileStatus(profileUrl, statuses[profileUrl], entry.sequence));
      }
    } catch (error) {
      for (const [, entry] of chunk) {
        entry.reject(error);
      }
    } finally {
      for (const [profileUrl] of chunk) {
        state.statusRequests.delete(profileUrl);
      }
    }
  }
}

function chunkEntries(entries, size) {
  const chunks = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(entries.slice(index, index + size));
  }
  return chunks;
}

function requireProfileStatusBatchEntries(statuses, profileUrls) {
  const requested = new Set(profileUrls);
  const returned = new Set(Object.keys(statuses || {}));
  if (
    requested.size !== returned.size ||
    [...requested].some((profileUrl) => !returned.has(profileUrl)) ||
    [...returned].some((profileUrl) => !requested.has(profileUrl))
  ) {
    throw new MalformedApiResponseError("Profile status batch response was incomplete.");
  }
}

function rememberProfileStatus(profileUrl, status, sequence = ++state.statusWriteSequence) {
  const normalized = normalizeProfileUrl(profileUrl);
  const cached = state.statusCache.get(normalized);
  if (cached && cached.sequence > sequence) {
    return cached.status;
  }
  const normalizedStatus = normalizeProfileStatus(status);
  state.statusCache.set(normalized, { status: normalizedStatus, fetchedAt: Date.now(), sequence });
  trimStatusCache();
  return normalizedStatus;
}

function startRefreshRunnerFromPage() {
  const urlSession = new URL(location.href).searchParams.get("lefSession");
  if (urlSession) {
    sessionStorage.setItem(SESSION_STORAGE_KEY, urlSession);
  }
  const sessionId = urlSession || sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!sessionId || state.refreshRunning) {
    return;
  }
  const storedResume = readStoredRefreshResume(sessionId);
  if (state.refreshTimer) {
    if (!urlSession || (storedResume && storedResume.resumeAt > Date.now())) {
      return;
    }
    clearRefreshResumeTimers();
  }
  if (storedResume && storedResume.resumeAt > Date.now()) {
    scheduleStoredRefreshSessionResume(storedResume);
    return;
  }
  startRefreshRun(sessionId);
}

function startRefreshRun(sessionId) {
  if (state.refreshRunning) {
    return;
  }
  state.refreshRunning = true;
  runRefreshSession(sessionId).finally(() => {
    state.refreshRunning = false;
  });
}

async function runRefreshSession(sessionId) {
  clearRefreshResumeTimers();
  let session;
  let target;
  let completionRequestId = "";
  try {
    session = await request(`/api/refresh-sessions/active?id=${encodeURIComponent(sessionId)}`, {
      validate: normalizeActiveRefreshSession,
    });
    if (!session || session.active === false || session.status !== "running") {
      renderRefreshBanner(session?.status || "done", "LinkedIn refresh is not running.");
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }

    target = session.currentTarget;
    completionRequestId = createClientRequestId();
    if (!target) {
      renderRefreshBanner("error", "LinkedIn refresh is still running, but the next page is not ready. Retrying session check in 7s.");
      scheduleRefreshSessionResume(sessionId, 7000, session);
      return;
    }

    if (isLinkedInLoginGate()) {
      const message = "Sign in to LinkedIn, then this refresh will continue.";
      await reportRefreshHeartbeat(sessionId, target, message).catch(() => undefined);
      renderRefreshBanner("waiting", message);
      scheduleRefreshSessionResume(sessionId, 5000);
      return;
    }

    const pageTargetIndex = refreshTargetIndexFromUrl(location.href);
    const hasTargetParam = isSafeInteger(pageTargetIndex);
    const pageMatchesCurrentTarget = pageMatchesTarget(target);
    if (!pageMatchesCurrentTarget || (hasTargetParam && pageTargetIndex !== target.index)) {
      const navigationUrl = nextRefreshNavigationUrl(session, target);
      if (!navigationUrl) {
        const nextSession = await reportRefreshTargetError(
          sessionId,
          target,
          "Refresh target URL is unavailable.",
          completionRequestId,
        );
        continueRefreshSession(nextSession, "LinkedIn page issue: Refresh target URL is unavailable.");
        return;
      }
      renderRefreshBanner("moving", "Opening the expected LinkedIn activity page.");
      window.location.href = navigationUrl;
      return;
    }

    renderRefreshBanner(
      "running",
      `Refreshing ${target.personName} ${target.kind} (${session.completedTargets + 1}/${session.totalTargets}, attempt ${session.currentAttempt || 1}/${session.maxAttempts || 1})`,
    );
    await waitForPageSettled(session.lookbackCutoffAt);
    if (!pageMatchesTarget(target)) {
      const navigationUrl = nextRefreshNavigationUrl(session, target);
      if (!navigationUrl) {
        const nextSession = await reportRefreshTargetError(
          sessionId,
          target,
          "Refresh target changed before capture.",
          completionRequestId,
        );
        continueRefreshSession(nextSession, "LinkedIn page issue: Refresh target changed before capture.");
        return;
      }
      renderRefreshBanner("moving", "LinkedIn changed pages before capture. Reopening the expected activity page.");
      window.location.href = navigationUrl;
      return;
    }

    const blockingMessage = detectLinkedInBlockingState();
    if (blockingMessage) {
      const nextSession = await reportRefreshTargetError(sessionId, target, blockingMessage, completionRequestId);
      continueRefreshSession(nextSession, `LinkedIn page issue: ${blockingMessage}`);
      return;
    }

    const captureResult = await captureVisibleActivity({
      feedId: session.feedId,
      ownerProfileUrl: target.profileUrl,
      ownerName: target.personName,
      targetKind: target.kind,
      includeLoaded: true,
      reason: "refresh-session",
      lookbackCutoffAt: session.lookbackCutoffAt,
      writeTimeoutMs: REFRESH_WRITE_REQUEST_TIMEOUT_MS,
    });
    const nextSession = await request(`/api/refresh-sessions/${encodeURIComponent(sessionId)}/complete-target`, {
      method: "POST",
      timeoutMs: REFRESH_WRITE_REQUEST_TIMEOUT_MS,
      validate: normalizeRefreshSession,
      body: {
        targetIndex: target.index,
        url: location.href,
        captureResult,
        requestId: completionRequestId,
      },
    });

    continueRefreshSession(nextSession, `Captured ${captureResult.inserted} new item(s).`);
  } catch (nextError) {
    if (session && target) {
      try {
        const nextSession = await reportRefreshTargetError(
          sessionId,
          target,
          errorMessage(nextError),
          completionRequestId || createClientRequestId(),
        );
        continueRefreshSession(nextSession, "Temporary capture problem.");
        return;
      } catch {
        const recoveredSession = await recoverActiveRefreshSession(sessionId).catch(() => undefined);
        if (recoveredSession && recoveredSession.active !== false) {
          continueRefreshSession(recoveredSession, "Temporary capture problem.");
          return;
        }
        // If the local app itself is unreachable, keep this LinkedIn page open and retry from here.
      }
    }
    renderRefreshBanner("error", `Engagement Feed app is unreachable. ${errorMessage(nextError)}`);
    scheduleRefreshSessionResume(sessionId, 7000);
  }
}

async function reportRefreshTargetError(sessionId, target, message, requestId) {
  return request(`/api/refresh-sessions/${encodeURIComponent(sessionId)}/complete-target`, {
    method: "POST",
    noRetry: true,
    timeoutMs: REFRESH_WRITE_REQUEST_TIMEOUT_MS,
    validate: normalizeRefreshSession,
    body: {
      targetIndex: target.index,
      url: location.href,
      error: message,
      requestId,
    },
  });
}

async function reportRefreshHeartbeat(sessionId, target, message) {
  return request(`/api/refresh-sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
    method: "POST",
    validate: normalizeRefreshSession,
    body: {
      targetIndex: target.index,
      url: location.href,
      message,
    },
  });
}

async function recoverActiveRefreshSession(sessionId) {
  return request(`/api/refresh-sessions/active?id=${encodeURIComponent(sessionId)}`, {
    noRetry: true,
    timeoutMs: BACKGROUND_REQUEST_TIMEOUT_MS,
    validate: normalizeActiveRefreshSession,
  });
}

function continueRefreshSession(nextSession, prefix) {
  const navigationUrl =
    nextSession.status === "running" ? nextRefreshNavigationUrl(nextSession, nextSession.currentTarget) : "";
  if (nextSession.status === "running" && navigationUrl) {
    const delayMs = normalizeRefreshResumeDelayMs(nextSession.nextDelayMs ?? nextSession.delayMs);
    const pageTargetIndex = refreshTargetIndexFromUrl(location.href);
    const retrying =
      nextSession.currentTarget &&
      nextSession.currentTarget.index === pageTargetIndex &&
      nextSession.currentAttempt > 1;
    const retryText = retrying ? ` Retrying attempt ${nextSession.currentAttempt}/${nextSession.maxAttempts}.` : "";
    const issueText = nextSession.failedTargets > 0 ? ` ${nextSession.failedTargets} page issue(s) so far.` : "";
    const pacingText =
      nextSession.nextDelayReason && nextSession.nextDelayReason !== "Standard pacing"
        ? ` ${nextSession.nextDelayReason}.`
        : "";
    renderRefreshBanner(
      retrying || nextSession.rateLimitStreak > 0 ? "error" : "running",
      `${prefix}${retryText}${issueText}${pacingText} Next page opens in ${formatDelay(delayMs)}.`,
    );
    scheduleRefreshSessionResume(nextSession.id, delayMs, nextSession);
    return;
  }

  if (nextSession.status === "running") {
    renderRefreshBanner(
      "error",
      `${prefix} Refresh is still running, but the next LinkedIn page is unavailable. Retrying session check in 7s.`,
    );
    scheduleRefreshSessionResume(nextSession.id, 7000, nextSession);
    return;
  }

  renderRefreshBanner(
    nextSession.status,
    `Refresh ${nextSession.status}. ${nextSession.inserted} new item(s) captured. ${nextSession.failedTargets || 0} page issue(s).`,
  );
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

function scheduleRefreshSessionResume(sessionId, delayMs, expectedSession) {
  clearRefreshResumeTimers();
  const safeDelayMs = normalizeRefreshResumeDelayMs(delayMs);
  const expectedSessionSignature = refreshSessionResumeSignature(expectedSession);
  rememberRefreshResume(sessionId, Date.now() + safeDelayMs, expectedSessionSignature);
  state.refreshTimer = window.setTimeout(() => {
    clearRefreshResumeTimers();
    startRefreshRun(sessionId);
  }, safeDelayMs);

  if (safeDelayMs > REFRESH_RESUME_POLL_MS * 2 && expectedSessionSignature) {
    state.refreshPollTimer = window.setInterval(() => {
      pollScheduledRefreshSession(sessionId, expectedSessionSignature).catch(() => {});
    }, REFRESH_RESUME_POLL_MS);
  }
}

function scheduleStoredRefreshSessionResume(storedResume) {
  clearRefreshResumeTimers();
  const remainingMs = normalizeRefreshResumeDelayMs(storedResume.resumeAt - Date.now());
  rememberRefreshResume(storedResume.sessionId, Date.now() + remainingMs, storedResume.expectedSessionSignature);
  state.refreshTimer = window.setTimeout(() => {
    clearRefreshResumeTimers();
    startRefreshRun(storedResume.sessionId);
  }, remainingMs);
  if (remainingMs > REFRESH_RESUME_POLL_MS * 2 && storedResume.expectedSessionSignature) {
    state.refreshPollTimer = window.setInterval(() => {
      pollScheduledRefreshSession(storedResume.sessionId, storedResume.expectedSessionSignature).catch(() => {});
    }, REFRESH_RESUME_POLL_MS);
  }
}

function clearRefreshResumeTimers() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = 0;
  clearInterval(state.refreshPollTimer);
  state.refreshPollTimer = 0;
  sessionStorage.removeItem(RESUME_STORAGE_KEY);
}

async function pollScheduledRefreshSession(sessionId, expectedSessionSignature) {
  if (state.refreshRunning) {
    return;
  }
  const session = await request(`/api/refresh-sessions/active?id=${encodeURIComponent(sessionId)}`, {
    background: true,
    ignoreCooldown: true,
    timeoutMs: BACKGROUND_REQUEST_TIMEOUT_MS,
    validate: normalizeActiveRefreshSession,
  });
  const nextSessionSignature = refreshSessionResumeSignature(session);
  if (!session || session.active === false || session.status !== "running" || nextSessionSignature !== expectedSessionSignature) {
    clearRefreshResumeTimers();
    startRefreshRun(sessionId);
  }
}

function refreshSessionResumeSignature(session) {
  const target = session?.currentTarget;
  if (!session || !target) {
    return "";
  }
  return [
    session.status,
    session.feedId,
    session.lookbackCutoffAt,
    session.totalTargets,
    session.completedTargets,
    session.currentAttempt,
    session.maxAttempts,
    session.nextDelayMs,
    session.nextDelayReason,
    target.index,
    target.personId,
    target.kind,
    target.url,
  ].join("|");
}

function rememberRefreshResume(sessionId, resumeAt, expectedSessionSignature) {
  if (!sessionId || !Number.isFinite(resumeAt)) {
    return;
  }
  sessionStorage.setItem(
    RESUME_STORAGE_KEY,
    JSON.stringify({
      sessionId,
      resumeAt,
      expectedSessionSignature: expectedSessionSignature || "",
    }),
  );
}

function readStoredRefreshResume(sessionId) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(RESUME_STORAGE_KEY) || "null");
    if (!raw || raw.sessionId !== sessionId || !Number.isFinite(Number(raw.resumeAt))) {
      sessionStorage.removeItem(RESUME_STORAGE_KEY);
      return undefined;
    }
    return {
      sessionId: raw.sessionId,
      resumeAt: Number(raw.resumeAt),
      expectedSessionSignature: String(raw.expectedSessionSignature || ""),
    };
  } catch {
    sessionStorage.removeItem(RESUME_STORAGE_KEY);
    return undefined;
  }
}

function waitForPageSettled(lookbackCutoffAt) {
  return new Promise((resolve) => {
    let lastHeight = document.body.scrollHeight;
    let lastActivityCount = visibleActivityContainers({ includeLoaded: true }).length;
    let stableTicks = 0;
    let activityStableTicks = 0;
    let olderActivityTicks = 0;
    const cutoffTime = timestampFromIso(lookbackCutoffAt);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      window.scrollBy({ top: Math.max(420, window.innerHeight * 0.6), behavior: "auto" });
      const nextHeight = document.body.scrollHeight;
      const nextActivityCount = visibleActivityContainers({ includeLoaded: true }).length;
      const hasUsefulLinkedInSurface = pageHasUsefulLinkedInSurface();
      if (nextHeight === lastHeight) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
        lastHeight = nextHeight;
      }
      if (nextActivityCount === lastActivityCount) {
        activityStableTicks += 1;
      } else {
        activityStableTicks = 0;
        lastActivityCount = nextActivityCount;
      }

      if (cutoffTime && visibleActivityHasOlderItem(cutoffTime)) {
        olderActivityTicks += 1;
      } else {
        olderActivityTicks = 0;
      }

      const elapsedMs = Date.now() - startedAt;
      const maxWaitMs = hasUsefulLinkedInSurface ? 7500 : 10000;
      const contentLooksSettled = hasUsefulLinkedInSurface && stableTicks >= 2 && activityStableTicks >= 2 && elapsedMs >= 2600;
      if (olderActivityTicks >= 1 || contentLooksSettled || elapsedMs > maxWaitMs) {
        window.clearInterval(timer);
        window.scrollTo({ top: 0, behavior: "auto" });
        window.setTimeout(resolve, 600);
      }
    }, 650);
  });
}

function renderRefreshBanner(status, message) {
  let banner = document.querySelector(".lef-refresh-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "lef-refresh-banner";
    document.body.appendChild(banner);
  }
  banner.dataset.status = status;
  banner.textContent = message;
}

function formatDelay(ms) {
  const seconds = Math.max(0, Math.round(normalizeRefreshResumeDelayMs(ms) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function normalizeRefreshResumeDelayMs(value, fallback = REFRESH_RESUME_DEFAULT_DELAY_MS) {
  const delayMs = Number(value);
  const fallbackMs = Number(fallback);
  const safeFallback = Number.isFinite(fallbackMs)
    ? Math.max(REFRESH_RESUME_MIN_DELAY_MS, Math.min(REFRESH_RESUME_MAX_DELAY_MS, Math.round(fallbackMs)))
    : REFRESH_RESUME_DEFAULT_DELAY_MS;
  if (!Number.isFinite(delayMs)) {
    return safeFallback;
  }
  return Math.max(REFRESH_RESUME_MIN_DELAY_MS, Math.min(REFRESH_RESUME_MAX_DELAY_MS, Math.round(delayMs)));
}

function currentProfileUrl() {
  return normalizeProfileUrl(location.href);
}

function pageMatchesTarget(target) {
  const profileUrl = currentProfileUrl();
  if (normalizeProfileUrl(profileUrl) !== normalizeProfileUrl(target.profileUrl)) {
    return false;
  }
  if (target.kind === "comments") {
    return /\/recent-activity\/comments\/?/i.test(location.pathname);
  }
  return /\/recent-activity\/all\/?/i.test(location.pathname);
}

function nextRefreshNavigationUrl(session, target) {
  if (session?.nextUrl && isLinkedInRefreshTargetUrl(session.nextUrl)) {
    return session.nextUrl;
  }
  if (!target?.url || !isLinkedInRefreshTargetUrl(target.url)) {
    return "";
  }
  try {
    const parsed = new URL(target.url);
    parsed.searchParams.set("lefSession", session.id);
    parsed.searchParams.set("lefTarget", String(target.index));
    return parsed.toString();
  } catch {
    return "";
  }
}

function isLinkedInRefreshTargetUrl(url) {
  try {
    const parsed = new URL(url, location.origin);
    return isLinkedInHost(parsed.hostname) && /^\/in\/[^/]+\/recent-activity\/(?:all|comments)\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function refreshTargetIndexFromUrl(url) {
  try {
    const value = new URL(url).searchParams.get("lefTarget");
    if (value === null || value.trim() === "") {
      return undefined;
    }
    const index = Number(value);
    return isSafeInteger(index) && index >= 0 ? index : undefined;
  } catch {
    return undefined;
  }
}

function profileHeadingName() {
  const heading = document.querySelector("main h1");
  return cleanText(textWithoutHelperControls(heading));
}

function profileHeadingNameFromHeading(heading) {
  const text = textWithoutHelperControls(heading);
  return cleanText(text) || "LinkedIn member";
}

function normalizeProfileUrl(url) {
  try {
    const parsed = new URL(String(url || ""), location.origin);
    if (!isLinkedInHost(parsed.hostname)) {
      return "";
    }
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)\/?/i);
    if (!match) {
      return "";
    }
    const publicId = cleanLinkedInPublicId(decodeURIComponent(match[1]));
    return publicId ? `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/` : "";
  } catch {
    return "";
  }
}

function isLinkedInHost(hostname) {
  const cleanHostname = String(hostname || "").toLowerCase();
  return cleanHostname === "linkedin.com" || cleanHostname.endsWith(".linkedin.com");
}

function cleanLinkedInPublicId(publicId) {
  const cleanPublicId = String(publicId || "")
    .trim()
    .replace(/^[<([{]+/, "")
    .replace(/[>\])}]+$/, "")
    .replace(/[.,;:!]+$/, "")
    .replace(/[>\])}]+$/, "");
  if (!cleanPublicId || /[/?#\\]|\s/.test(cleanPublicId)) {
    return "";
  }
  return cleanPublicId;
}

function inferActivityType(text) {
  return /\bcommented\b|\breplied\b|\bcomment\b/i.test(text) ? "comment" : "post";
}

function activityTimestampFromContainer(container) {
  const time = container.querySelector("time");
  const datetime = time?.getAttribute("datetime");
  if (datetime && Number.isFinite(new Date(datetime).getTime())) {
    return new Date(datetime).getTime();
  }

  const timeText = activityTimestampCandidateFromText(time?.textContent || time?.getAttribute("aria-label") || "");
  if (timeText) {
    const parsedTimeText = parseLinkedInDate(timeText);
    return parsedTimeText ? new Date(parsedTimeText).getTime() : undefined;
  }

  const ariaTimestamp = [...container.querySelectorAll("[aria-label], span")]
    .map((node) => node.getAttribute("aria-label") || node.textContent || "")
    .map(cleanText)
    .filter((text) => text.length > 0 && text.length <= 80)
    .map(activityTimestampCandidateFromText)
    .find(Boolean);
  const parsed = parseLinkedInDate(ariaTimestamp || "");
  return parsed ? new Date(parsed).getTime() : undefined;
}

function activityTimestampCandidateFromText(text) {
  const clean = cleanText(text);
  if (!clean || clean.length > 80) {
    return "";
  }
  const segments = [clean, ...clean.split(/[•·|]/)].map(cleanTimestampSegment).filter(Boolean);
  return segments.find(isLinkedInTimestampText) || "";
}

function cleanTimestampSegment(text) {
  return cleanText(text)
    .replace(/^(?:posted|shared|commented|replied)\s+/i, "")
    .replace(/\s+(?:edited|visible to anyone|visible to connections|visible to linkedin members)$/i, "");
}

function isLinkedInTimestampText(text) {
  const clean = cleanText(text).toLowerCase();
  if (/^(?:now|just now|yesterday)$/.test(clean)) {
    return true;
  }
  if (/^\d+\s*(?:m|h|d|w|mo|mos|y|min|mins|hr|hrs|wk|wks|yr|yrs)(?:\s+ago)?$/.test(clean)) {
    return true;
  }
  if (/^\d+\s*(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago$/.test(clean)) {
    return true;
  }
  return /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+\d{1,2}(?:,\s*\d{4})?$/.test(clean);
}

function visibleActivityHasOlderItem(cutoffTime) {
  return visibleActivityContainers()
    .slice(0, 30)
    .some((container) => {
      const timestamp = activityTimestampFromContainer(container);
      return timestamp ? timestamp < cutoffTime : false;
    });
}

function timestampFromIso(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseLinkedInDate(text) {
  const clean = cleanText(text).toLowerCase();
  if (!clean) {
    return "";
  }
  if (/\bnow\b|\bjust now\b/.test(clean)) {
    return new Date().toISOString();
  }
  if (/\byesterday\b/.test(clean)) {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return date.toISOString();
  }

  const relative = clean.match(
    /(?:^|\s)(\d+)\s*(minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d|weeks?|wks?|wk|w|months?|mos?|mo|years?|yrs?|yr|y)(?:\s|$|[.])/,
  );
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const date = new Date();
    const unitAliases = {
      minutes: "minute",
      minute: "minute",
      mins: "minute",
      min: "minute",
      m: "minute",
      hours: "hour",
      hour: "hour",
      hrs: "hour",
      hr: "hour",
      h: "hour",
      days: "day",
      day: "day",
      d: "day",
      weeks: "week",
      week: "week",
      wks: "week",
      wk: "week",
      w: "week",
      months: "month",
      month: "month",
      mos: "month",
      mo: "month",
      years: "year",
      year: "year",
      yrs: "year",
      yr: "year",
      y: "year",
    };
    const normalizedUnit = unitAliases[unit];
    const multipliers = {
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000,
    };
    return normalizedUnit ? new Date(date.getTime() - amount * multipliers[normalizedUnit]).toISOString() : "";
  }

  const absolute = clean.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/);
  if (absolute) {
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = monthNames.indexOf(absolute[1] === "sept" ? "sep" : absolute[1]);
    const day = Number(absolute[2]);
    const year = absolute[3] ? Number(absolute[3]) : new Date().getFullYear();
    const date = new Date(year, month, day, 12);
    if (date.getTime() > Date.now()) {
      date.setFullYear(date.getFullYear() - 1);
    }
    return date.toISOString();
  }

  return "";
}

function stableItemId(profileUrl, sourceUrl, type, text, activityAt) {
  const source = normalizeSourceUrl(sourceUrl);
  const sourceLooksStable = isStableLinkedInItemSource(source);
  if (sourceLooksStable) {
    return type === "comment" ? `${type}:${profileUrl}:${source}:${hash(text)}` : `${type}:${source}`;
  }
  return `${type}:${profileUrl}:${String(activityAt || "").slice(0, 10)}:${hash(text || source)}`;
}

function normalizeSourceUrl(url) {
  try {
    const parsed = new URL(url, location.origin);
    if (!isLinkedInHost(parsed.hostname) || !isLinkedInEngagementSourcePath(parsed.pathname)) {
      return "";
    }
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|trk|lipi|miniProfileUrn|trackingId|lefSession|lefTarget)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function isLinkedInEngagementSourcePath(pathname) {
  const cleanPath = String(pathname || "").toLowerCase();
  return (
    /^\/feed\/update\/[^/]+/i.test(cleanPath) ||
    /^\/posts\/[^/]+/i.test(cleanPath) ||
    /^\/pulse\/[^/]+/i.test(cleanPath) ||
    /^\/comments\/[^/]+/i.test(cleanPath) ||
    /^\/in\/[^/]+\/recent-activity\/(?:all|comments)\/?$/i.test(cleanPath)
  );
}

function isStableLinkedInItemSource(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl, location.origin);
    return isLinkedInHost(parsed.hostname) && /^\/(?:feed\/update|posts|pulse|comments)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isLinkedInLoginGate() {
  return /\/login|checkpoint|uas\/login/i.test(location.pathname) || Boolean(document.querySelector('input[name="session_key"]'));
}

function detectLinkedInBlockingState() {
  if (isLinkedInLoginGate()) {
    return "LinkedIn is asking you to sign in.";
  }

  const pageText = cleanText(document.body?.innerText || "").toLowerCase();
  const patterns = [
    [/too many requests|unusual traffic|temporarily restricted|rate limit/, "LinkedIn appears to be rate limiting this profile page."],
    [/something went wrong|try again later|page isn.?t working/, "LinkedIn returned a temporary error page."],
    [
      /this profile is not available|profile unavailable|profile (?:is not|isn(?:['\u2019])?t) available|page (?:not found|doesn(?:['\u2019])?t exist|isn(?:['\u2019])?t available)|member unavailable/,
      "This LinkedIn profile page is unavailable.",
    ],
  ];
  for (const [pattern, message] of patterns) {
    if (pattern.test(pageText)) {
      return message;
    }
  }

  const main = document.querySelector("main");
  if (!pageHasUsefulLinkedInSurface(main) && /\/recent-activity\//i.test(location.pathname)) {
    return "LinkedIn activity did not load useful content yet.";
  }

  return "";
}

function pageHasUsefulLinkedInSurface(main = document.querySelector("main")) {
  const activitySelector = [
    'a[href*="/feed/update/"]',
    'a[href*="/posts/"]',
    'a[href*="/pulse/"]',
    'a[href*="/comments/"]',
    '[data-urn*="urn:li:activity"]',
    ".feed-shared-update-v2",
    ".comments-comment-item",
    ".profile-creator-shared-feed-update__container",
    ".occludable-update",
  ].join(", ");
  return (
    Boolean(main?.querySelector(activitySelector)) ||
    Boolean(document.querySelector(".profile-creator-shared-feed-update__container, .occludable-update"))
  );
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function capturedTextFromElement(element) {
  if (!element) {
    return "";
  }
  return cleanText(textWithoutHelperControls(element));
}

function textWithoutHelperControls(element) {
  if (!element) {
    return "";
  }
  const clone = element.cloneNode(true);
  for (const helperNode of clone.querySelectorAll(".lef-anchor, .lef-popover, .lef-refresh-banner")) {
    helperNode.remove();
  }
  return clone.innerText || clone.textContent || "";
}

function passiveCaptureSignature(feedIds, items, options = {}) {
  if (options.reason !== "passive") {
    return "";
  }
  const feedPart = [...new Set(feedIds.filter(Boolean))].sort().join(",");
  const itemPart = items
    .map((item) =>
      [
        item.externalId,
        item.profileUrl,
        item.sourceUrl,
        item.type,
        String(item.activityAt || "").slice(0, 10),
        hash(item.text),
      ].join("|"),
    )
    .sort()
    .join(";");
  return hash(`${feedPart}::${itemPart}`);
}

function passiveCaptureRecentlySucceeded(signature) {
  return (
    signature &&
    state.lastPassiveCaptureSignature === signature &&
    Date.now() - state.lastPassiveCaptureAt < PASSIVE_CAPTURE_SIGNATURE_TTL_MS
  );
}

function rememberPassiveCaptureSignature(signature) {
  state.lastPassiveCaptureSignature = signature;
  state.lastPassiveCaptureAt = Date.now();
}

function escapeHtml(text) {
  return String(text || "").replace(/[&<>"']/g, (char) => {
    const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return replacements[char];
  });
}

function hash(value) {
  let result = 0;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    result = (Math.imul(31, result) + text.charCodeAt(index)) | 0;
  }
  return String(result >>> 0);
}

function createClientRequestId() {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") {
    return `req_${browserCrypto.randomUUID()}`;
  }
  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return `req_${formatClientRequestUuidBytes(bytes)}`;
  }
  lastResortClientRequestCounter = (lastResortClientRequestCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `req_${Date.now().toString(36)}_${lastResortClientRequestCounter.toString(36)}`;
}

function formatClientRequestUuidBytes(bytes) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10, 16).join("")}`;
}

function emptyCaptureResult() {
  return {
    received: 0,
    inserted: 0,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  };
}

function normalizeCaptureResult(value) {
  const result = requireRecord(value, "capture result");
  const normalized = {
    received: requireNonNegativeInteger(result, "received", "capture result"),
    inserted: requireNonNegativeInteger(result, "inserted", "capture result"),
    updated: requireNonNegativeInteger(result, "updated", "capture result"),
    skippedOlder: requireNonNegativeInteger(result, "skippedOlder", "capture result"),
    skippedUntracked: requireNonNegativeInteger(result, "skippedUntracked", "capture result"),
    skippedInvalid: requireNonNegativeInteger(result, "skippedInvalid", "capture result"),
  };
  for (const [key, count] of Object.entries(normalized)) {
    if (key !== "received" && count > normalized.received) {
      throw new MalformedApiResponseError(`capture result response has impossible ${key}.`);
    }
  }
  const processed =
    normalized.inserted +
    normalized.updated +
    normalized.skippedOlder +
    normalized.skippedUntracked +
    normalized.skippedInvalid;
  if (processed > normalized.received) {
    throw new MalformedApiResponseError("capture result response has impossible aggregate counts.");
  }
  return normalized;
}

function normalizeActiveRefreshSession(value) {
  if (!value) {
    return value;
  }
  const session = requireRecord(value, "active refresh session");
  if (session.active === false) {
    return session;
  }
  return normalizeRefreshSession(session);
}

function normalizeRefreshSession(value) {
  const session = requireRecord(value, "refresh session");
  for (const key of ["id", "feedId", "feedName"]) {
    requireNonEmptyString(session, key, "refresh session");
  }
  for (const key of ["lookbackCutoffAt", "createdAt", "updatedAt"]) {
    requireDateString(session, key, "refresh session");
  }
  for (const key of ["lastError", "nextDelayReason"]) {
    requireString(session, key, "refresh session");
  }
  if (!["running", "done", "canceled", "failed"].includes(session.status)) {
    throw new MalformedApiResponseError("Refresh session response has an unknown status.");
  }
  requireIntegerInRange(session, "lookbackDays", "refresh session", 1, 365);
  for (const key of [
    "totalTargets",
    "completedTargets",
    "failedTargets",
    "inserted",
    "updated",
    "skippedOlder",
    "skippedUntracked",
    "skippedInvalid",
    "delayMs",
    "nextDelayMs",
    "issueStreak",
    "rateLimitStreak",
    "currentAttempt",
    "maxAttempts",
  ]) {
    requireNonNegativeInteger(session, key, "refresh session");
  }
  const totalTargets = session.totalTargets;
  const completedTargets = session.completedTargets;
  const failedTargets = session.failedTargets;
  const currentAttempt = session.currentAttempt;
  const maxAttempts = session.maxAttempts;
  const status = session.status;
  if (completedTargets > totalTargets || failedTargets > completedTargets) {
    throw new MalformedApiResponseError("Refresh session response has inconsistent progress.");
  }
  if (currentAttempt < 1 || maxAttempts < 1 || currentAttempt > maxAttempts) {
    throw new MalformedApiResponseError("Refresh session response has inconsistent retry state.");
  }
  if ((status === "done" || status === "failed") && completedTargets !== totalTargets) {
    throw new MalformedApiResponseError("Refresh session response has an impossible finished progress state.");
  }
  if (session.nextUrl !== undefined && typeof session.nextUrl !== "string") {
    throw new MalformedApiResponseError("Refresh session response has an invalid next URL.");
  }
  let currentTarget;
  if (session.currentTarget !== undefined) {
    currentTarget = normalizeRefreshTarget(session.currentTarget);
    if (currentTarget.index >= totalTargets) {
      throw new MalformedApiResponseError("Refresh session response has an out-of-range current target.");
    }
  }
  if (status === "running") {
    if (!currentTarget || currentTarget.index !== completedTargets) {
      throw new MalformedApiResponseError("Refresh session response has an inconsistent current target.");
    }
    if (!refreshUrlMatchesTarget(session.nextUrl, currentTarget, { sessionId: session.id, targetIndex: currentTarget.index })) {
      throw new MalformedApiResponseError("Refresh session response has an invalid next URL.");
    }
  } else if (currentTarget || session.nextUrl !== undefined) {
    throw new MalformedApiResponseError("Refresh session response has stale navigation details.");
  }
  return session;
}

function normalizeRefreshTarget(value) {
  const target = requireRecord(value, "refresh target");
  requireNonNegativeInteger(target, "index", "refresh target");
  for (const key of ["personId", "personName", "profileUrl", "url"]) {
    requireNonEmptyString(target, key, "refresh target");
  }
  if (target.kind !== "posts" && target.kind !== "comments") {
    throw new MalformedApiResponseError("Refresh target response has an unknown kind.");
  }
  if (!refreshUrlMatchesTarget(target.url, target)) {
    throw new MalformedApiResponseError("Refresh target response has an invalid URL.");
  }
  return target;
}

function refreshUrlMatchesTarget(url, target, options = {}) {
  if (typeof url !== "string") {
    return false;
  }
  try {
    const parsed = new URL(url, location.origin);
    if (!isLinkedInHost(parsed.hostname)) {
      return false;
    }
    if (normalizeProfileUrl(parsed.toString()) !== normalizeProfileUrl(target.profileUrl)) {
      return false;
    }
    if (refreshActivityKindFromPath(parsed.pathname) !== target.kind) {
      return false;
    }
    if (options.sessionId !== undefined && parsed.searchParams.get("lefSession") !== options.sessionId) {
      return false;
    }
    if (options.targetIndex !== undefined && parsed.searchParams.get("lefTarget") !== String(options.targetIndex)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function refreshActivityKindFromPath(pathname) {
  const cleanPath = pathname.toLowerCase();
  if (/\/recent-activity\/comments\/?$/.test(cleanPath)) {
    return "comments";
  }
  if (/\/recent-activity\/(?:all\/?)?$/.test(cleanPath)) {
    return "posts";
  }
  return undefined;
}

function requireRecord(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MalformedApiResponseError(`${context} response was malformed.`);
  }
  return value;
}

function requireString(record, key, context) {
  if (typeof record[key] !== "string") {
    throw new MalformedApiResponseError(`${context} response is missing ${key}.`);
  }
  return record[key];
}

function requireNonEmptyString(record, key, context) {
  const value = requireString(record, key, context);
  if (!value.trim()) {
    throw new MalformedApiResponseError(`${context} response is missing ${key}.`);
  }
  return value;
}

function requireDateString(record, key, context) {
  const value = requireNonEmptyString(record, key, context);
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new MalformedApiResponseError(`${context} response has invalid ${key}.`);
  }
  return value;
}

function requireNonNegativeInteger(record, key, context) {
  const value = record[key];
  if (!isSafeInteger(value) || value < 0) {
    throw new MalformedApiResponseError(`${context} response is missing ${key}.`);
  }
  return value;
}

function requireIntegerInRange(record, key, context, minimum, maximum) {
  const value = record[key];
  if (!isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MalformedApiResponseError(`${context} response is missing ${key}.`);
  }
  return value;
}

function isSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

async function captureItemsForFeeds(feedIds, items, options = {}) {
  const itemChunks = chunkCapturedItems(items);
  const feedIdChunks = chunkCapturedFeedIds(feedIds);
  if (itemChunks.length === 0 || feedIdChunks.length === 0) {
    return emptyCaptureResult();
  }
  const results = [];
  for (const feedIdChunk of feedIdChunks) {
    for (const itemChunk of itemChunks) {
      results.push(await captureItemsChunkForFeeds(feedIdChunk, itemChunk, options));
    }
  }
  return aggregateCaptureResults(results);
}

async function captureItemsChunkForFeeds(feedIds, items, options = {}) {
  const requestId = createClientRequestId();
  const timeoutMs = captureWriteTimeoutMs(options);
  if (feedIds.length === 1) {
    return request("/api/capture-items", {
      method: "POST",
      background: Boolean(options.background),
      retryInBackground: Boolean(options.background),
      timeoutMs,
      validate: normalizeCaptureResult,
      body: {
        feedId: feedIds[0],
        items,
        requestId,
      },
    });
  }

  return request("/api/capture-items/multi", {
    method: "POST",
    background: Boolean(options.background),
    retryInBackground: Boolean(options.background),
    timeoutMs,
    validate: normalizeCaptureResult,
    body: {
      feedIds,
      items,
      requestId,
    },
  });
}

function chunkCapturedItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const chunks = [];
  for (let index = 0; index < items.length; index += MAX_CAPTURE_ITEMS_PER_REQUEST) {
    chunks.push(items.slice(index, index + MAX_CAPTURE_ITEMS_PER_REQUEST));
  }
  return chunks;
}

function chunkCapturedFeedIds(feedIds) {
  if (!Array.isArray(feedIds) || feedIds.length === 0) {
    return [];
  }
  const uniqueFeedIds = [...new Set(feedIds.filter(Boolean))];
  const chunks = [];
  for (let index = 0; index < uniqueFeedIds.length; index += MAX_CAPTURE_FEEDS_PER_REQUEST) {
    chunks.push(uniqueFeedIds.slice(index, index + MAX_CAPTURE_FEEDS_PER_REQUEST));
  }
  return chunks;
}

function aggregateCaptureResults(results) {
  return results.reduce((summary, result) => {
    summary.received += result.received;
    summary.inserted += result.inserted;
    summary.updated += result.updated;
    summary.skippedOlder += result.skippedOlder;
    summary.skippedUntracked += result.skippedUntracked;
    summary.skippedInvalid += result.skippedInvalid;
    return summary;
  }, emptyCaptureResult());
}

function captureWriteTimeoutMs(options = {}) {
  if (isSafeInteger(options.writeTimeoutMs) && options.writeTimeoutMs > 0) {
    return options.writeTimeoutMs;
  }
  return options.background ? BACKGROUND_WRITE_REQUEST_TIMEOUT_MS : undefined;
}

async function request(path, options = {}, attempt = 0) {
  if (options.background && !options.ignoreCooldown && backgroundApiInCooldown()) {
    throw new RecoverableApiBaseError("Engagement Feed app is temporarily unavailable.");
  }
  const bases = [state.apiBase, ...API_BASES.filter((base) => base !== state.apiBase)];
  let lastError;
  for (const base of bases) {
    try {
      const data = await requestFromBase(base, path, options);
      state.apiBase = base;
      rememberApiBase(base);
      state.apiUnavailableUntil = 0;
      return data;
    } catch (error) {
      lastError = error;
      if (error instanceof RecoverableApiBaseError) {
        forgetApiBase(base);
        if (state.apiBase === base) {
          state.apiBase = nextApiBaseAfter(base);
        }
      }
      if (error instanceof RetryableApiStatusError) {
        state.apiBase = base;
        break;
      }
      if (!isConnectionError(error)) {
        throw error;
      }
    }
  }
  const maxRetries = options.noRetry || (options.background && !options.retryInBackground) ? 0 : 2;
  if (attempt < maxRetries) {
    await delay(retryDelayMsForAttempt(attempt, lastError));
    return request(path, options, attempt + 1);
  }
  if (options.background && isConnectionError(lastError)) {
    state.apiUnavailableUntil = Date.now() + backgroundCooldownMsForError(lastError);
  }
  throw lastError || new Error("Engagement Feed app is unreachable.");
}

function readRememberedApiBase() {
  try {
    const remembered = sessionStorage.getItem(API_BASE_STORAGE_KEY);
    return API_BASES.includes(remembered) ? remembered : "";
  } catch {
    return "";
  }
}

function rememberApiBase(base) {
  if (!API_BASES.includes(base)) {
    return;
  }
  try {
    sessionStorage.setItem(API_BASE_STORAGE_KEY, base);
  } catch {
    // Storage may be unavailable on locked-down pages; in-memory fallback still works.
  }
}

function forgetApiBase(base) {
  if (readRememberedApiBase() !== base) {
    return;
  }
  try {
    sessionStorage.removeItem(API_BASE_STORAGE_KEY);
  } catch {
    // Storage may be unavailable on locked-down pages; the next request will probe all bases.
  }
}

function nextApiBaseAfter(base) {
  const index = API_BASES.indexOf(base);
  if (index < 0) {
    return API_BASES[0];
  }
  return API_BASES[(index + 1) % API_BASES.length] || API_BASES[0];
}

async function requestFromBase(base, path, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const response = await fetchLocalApi(base, path, options, controller.signal);
    return await readLocalApiResponse(base, response, options);
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchLocalApi(base, path, options, signal) {
  if (canUseBackgroundApiProxy()) {
    try {
      return await requestFromBackground(base, path, options, signal);
    } catch (error) {
      if (!isBackgroundApiProxyError(error)) {
        throw error;
      }
      if (!canUseDirectLocalApiFallback(path)) {
        throw error;
      }
    }
  }
  return fetch(`${base}${path}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", [API_IDENTITY_HEADER]: "1" },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal,
  });
}

function canUseBackgroundApiProxy() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

function canUseDirectLocalApiFallback(path) {
  return path === "/health" || path.startsWith("/api/");
}

function requestFromBackground(base, path, options, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      finish(() => reject(new DOMException("The operation was aborted.", "AbortError")));
    };
    signal?.addEventListener("abort", abort, { once: true });
    chrome.runtime.sendMessage(
      {
        type: "lef-local-api-request",
        base,
        path,
        method: options.method || "GET",
        body: options.body,
        timeoutMs: options.timeoutMs || 10000,
      },
      (response) => {
        finish(() => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new BackgroundApiProxyError(runtimeError.message || "Extension background request failed."));
            return;
          }
          if (!response?.ok) {
            reject(new BackgroundApiProxyError(response?.error || "Extension background request failed."));
            return;
          }
          try {
            resolve(toBackgroundApiResponse(response.result));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
  });
}

function toBackgroundApiResponse(result) {
  if (!result || typeof result !== "object") {
    throw new BackgroundApiProxyError("Extension background returned an invalid response.");
  }
  const headers = result.headers && typeof result.headers === "object" ? result.headers : {};
  return {
    ok: Boolean(result.ok),
    status: Number(result.status) || 0,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    async json() {
      return JSON.parse(String(result.bodyText || ""));
    },
  };
}

async function readLocalApiResponse(base, response, options = {}) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new RecoverableApiBaseError(`Local API at ${base} did not return JSON.`);
  }
  if (response.headers.get(API_IDENTITY_HEADER) !== "1") {
    throw new RecoverableApiBaseError(`Local service at ${base} is not the Engagement Feed app.`);
  }
  if (!response.ok || data.error) {
    const message = data.error || `Request failed: ${response.status}`;
    if (isRetryableApiStatus(response.status)) {
      throw new RetryableApiStatusError(message, response.status, retryAfterDelayMs(response.headers.get("Retry-After")));
    }
    throw new Error(message);
  }
  return options.validate ? options.validate(data) : data;
}

function backgroundApiInCooldown() {
  return state.apiUnavailableUntil > Date.now();
}

function trimStatusCache() {
  if (state.statusCache.size <= MAX_STATUS_CACHE_ENTRIES) {
    return;
  }
  const entries = [...state.statusCache.entries()].sort((first, second) => first[1].fetchedAt - second[1].fetchedAt);
  for (const [key] of entries.slice(0, state.statusCache.size - MAX_STATUS_CACHE_ENTRIES)) {
    state.statusCache.delete(key);
  }
}

class RecoverableApiBaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecoverableApiBaseError";
  }
}

class MalformedApiResponseError extends RecoverableApiBaseError {
  constructor(message) {
    super(message);
    this.name = "MalformedApiResponseError";
  }
}

class RetryableApiStatusError extends Error {
  constructor(message, status, retryAfterMs) {
    super(message);
    this.name = "RetryableApiStatusError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

class BackgroundApiProxyError extends RecoverableApiBaseError {
  constructor(message) {
    super(message);
    this.name = "BackgroundApiProxyError";
  }
}

function isBackgroundApiProxyError(error) {
  return error instanceof BackgroundApiProxyError;
}

function isConnectionError(error) {
  return (
    error instanceof RecoverableApiBaseError ||
    error instanceof RetryableApiStatusError ||
    error instanceof TypeError ||
    isAbortError(error)
  );
}

function isAbortError(error) {
  return Boolean(error && typeof error === "object" && error.name === "AbortError");
}

function isRetryableApiStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMsForAttempt(attempt, error) {
  if (error instanceof RetryableApiStatusError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return 500 * (attempt + 1);
}

function backgroundCooldownMsForError(error) {
  if (error instanceof RetryableApiStatusError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return BACKGROUND_API_COOLDOWN_MS;
}

function retryAfterDelayMs(value) {
  const cleanValue = String(value || "").trim();
  if (!cleanValue) {
    return undefined;
  }
  const seconds = Number(cleanValue);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000)));
  }
  const timestamp = Date.parse(cleanValue);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, timestamp - Date.now()));
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

document.addEventListener("click", (event) => {
  if ((state.activePopover || state.popoverOpening) && !state.activePopover?.contains(event.target)) {
    closeActivePopover();
  }
});

window.addEventListener("resize", scheduleActivePopoverPosition, { passive: true });
window.addEventListener("scroll", scheduleActivePopoverPosition, { capture: true, passive: true });
window.addEventListener("popstate", startRefreshRunnerFromPage);
window.addEventListener("focus", startRefreshRunnerFromPage);
document.addEventListener("visibilitychange", () => {
  if (pageCanRunPassiveCapture()) {
    clearTimeout(state.passiveCaptureTimer);
    captureVisibleActivityLoop();
  }
});
