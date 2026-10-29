import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const contentScriptPath = path.resolve("chrome-extension", "content.js");
const contentCssPath = path.resolve("chrome-extension", "content.css");
const backgroundScriptPath = path.resolve("chrome-extension", "background.js");
const manifestPath = path.resolve("chrome-extension", "manifest.json");
const chromeControlPath = path.resolve("electron", "chromeControl.ts");

function sourceConstant(source, name) {
  const match = source.match(new RegExp(`const ${name} = "([^"]+)";|export const ${name} = "([^"]+)";`));
  return match?.[1] || match?.[2] || "";
}

test("helper extension manifest stays visible and has required host permissions", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, "1.0.32");
  assert.equal(manifest.action.default_title, "LinkedIn Engagement Feed Helper");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.ok(manifest.host_permissions.includes("https://www.linkedin.com/*"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:38421/*"));
});

test("helper extension version stays in sync across Chrome and desktop probes", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const contentSource = fs.readFileSync(contentScriptPath, "utf8");
  const chromeControlSource = fs.readFileSync(chromeControlPath, "utf8");

  assert.equal(sourceConstant(contentSource, "HELPER_VERSION"), manifest.version);
  assert.equal(sourceConstant(chromeControlSource, "EXPECTED_HELPER_VERSION"), manifest.version);
});

test("helper extension proxies local api calls through the background worker", () => {
  const contentSource = fs.readFileSync(contentScriptPath, "utf8");
  const backgroundSource = fs.readFileSync(backgroundScriptPath, "utf8");
  const requestFromBase = contentSource.slice(contentSource.indexOf("async function requestFromBase"), contentSource.indexOf("function backgroundApiInCooldown"));

  assert.match(backgroundSource, /const LOCAL_API_BASES = new Set\(\[/);
  assert.match(backgroundSource, /chrome\.runtime\.onMessage\.addListener\(\(message, _sender, sendResponse\) => \{/);
  assert.match(backgroundSource, /message\.type !== "lef-local-api-request"/);
  assert.match(backgroundSource, /forwardLocalApiRequest\(message\)/);
  assert.match(backgroundSource, /return true;/);
  assert.match(backgroundSource, /function normalizeLocalApiBase\(base\)/);
  assert.match(backgroundSource, /if \(!LOCAL_API_BASES\.has\(base\)\) \{/);
  assert.match(backgroundSource, /function normalizeLocalApiPath\(path\)/);
  assert.match(backgroundSource, /!path\.startsWith\("\/"\) \|\| path\.startsWith\("\/\/"\)/);
  assert.match(backgroundSource, /function normalizeLocalApiMethod\(method\)/);
  assert.match(backgroundSource, /\["GET", "POST", "PATCH", "DELETE"\]\.includes\(clean\)/);
  assert.match(backgroundSource, /headers\[key\.toLowerCase\(\)\] = value;/);
  assert.match(backgroundSource, /bodyText: await response\.text\(\),/);

  assert.match(requestFromBase, /const response = await fetchLocalApi\(base, path, options, controller\.signal\);/);
  assert.match(requestFromBase, /return await readLocalApiResponse\(base, response, options\);/);
  assert.match(requestFromBase, /function canUseBackgroundApiProxy\(\) \{\s+return typeof chrome !== "undefined" && Boolean\(chrome\.runtime\?\.sendMessage\);/);
  assert.match(requestFromBase, /if \(!canUseDirectLocalApiFallback\(path\)\) \{\s+throw error;\s+\}/);
  assert.match(requestFromBase, /headers: \{ "Content-Type": "application\/json", \[API_IDENTITY_HEADER\]: "1" \}/);
  assert.match(requestFromBase, /function canUseDirectLocalApiFallback\(path\) \{\s+return path === "\/health" \|\| path\.startsWith\("\/api\/"\);/);
  assert.match(requestFromBase, /let settled = false;/);
  assert.match(requestFromBase, /const finish = \(callback\) => \{\s+if \(settled\) \{\s+return;\s+\}\s+settled = true;\s+signal\?\.removeEventListener\("abort", abort\);\s+callback\(\);/);
  assert.match(requestFromBase, /const abort = \(\) => \{\s+finish\(\(\) => reject\(new DOMException\("The operation was aborted\.", "AbortError"\)\)\);/);
  assert.match(requestFromBase, /chrome\.runtime\.sendMessage\(/);
  assert.match(requestFromBase, /type: "lef-local-api-request",/);
  assert.match(requestFromBase, /finish\(\(\) => \{\s+const runtimeError = chrome\.runtime\.lastError;/);
  assert.match(requestFromBase, /resolve\(toBackgroundApiResponse\(response\.result\)\);/);
  assert.match(requestFromBase, /function readLocalApiResponse\(base, response, options = \{\}\)/);
  assert.match(requestFromBase, /if \(response\.headers\.get\(API_IDENTITY_HEADER\) !== "1"\)/);
  assert.match(requestFromBase, /throw new RetryableApiStatusError\(message, response\.status, retryAfterDelayMs\(response\.headers\.get\("Retry-After"\)\)\);/);
  assert.match(contentSource, /class BackgroundApiProxyError extends RecoverableApiBaseError/);
  assert.match(contentSource, /function isBackgroundApiProxyError\(error\)/);
});

test("LinkedIn overlay controls are keyed by normalized profile URL", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");

  assert.match(source, /dataset\.lefProfileUrl/);
  assert.match(source, /const profileUrl = normalizeProfileUrl\(link\.href\);/);
  assert.match(source, /existingControls/);
  assert.match(source, /control\.remove\(\)/);
  assert.match(source, /updateProfileControls\(person\.profileUrl\)/);
  assert.match(source, /button\.dataset\.lefProfileUrl !== normalizedProfileUrl/);
  assert.doesNotMatch(source, /LINKEDIN_PROFILE_RE\.test\(link\.href\)/);
});

test("LinkedIn author overlay cap applies after already-injected links are skipped", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const addAuthors = source.slice(source.indexOf("function addAuthorButtons"), source.indexOf("function createAnchorControl"));

  assert.match(addAuthors, /const linksNeedingControls = links\.filter\(\(\{ link, profileUrl \}\) => \{/);
  assert.match(addAuthors, /const existingControl = authorControlForLink\(link, profileUrl\);/);
  assert.match(addAuthors, /return link\.dataset\.lefProfileUrl !== profileUrl \|\| existingControl\?\.dataset\.lefProfileUrl !== profileUrl;/);
  assert.match(addAuthors, /for \(const \{ link, name, profileUrl \} of linksNeedingControls\.slice\(0, 120\)\) \{/);
  assert.match(addAuthors, /const existingControl = authorControlForLink\(link, profileUrl\);/);
  assert.doesNotMatch(addAuthors, /for \(const link of links\.slice\(0, 120\)\) \{/);
});

test("LinkedIn author overlay avoids social text and stretched grid siblings", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");

  assert.match(source, /function authorSearchRoots\(\)/);
  assert.match(source, /\.update-components-actor/);
  assert.match(source, /const uniqueLinks = \[\s+\.\.\.new Set\(searchRoots\.flatMap/);
  assert.match(source, /const placementTarget = authorControlPlacementTarget\(link, name\);/);
  assert.match(source, /if \(!placementTarget\) \{\s+continue;\s+\}/);
  assert.match(source, /if \(isUnsafeAuthorControlPlacement\(link, name, placementTarget\)\) \{\s+continue;\s+\}/);
  assert.match(source, /insertAuthorControl\(\s+link,\s+placementTarget,\s+createAnchorControl\(name, profileUrl, \{ placement: "author-rail" \}\),\s+\);/);
  assert.match(source, /function authorNameFromLink\(link\)/);
  assert.match(source, /function shouldSkipAuthorLink\(link, name\)/);
  assert.match(source, /link\.closest\('aside, \[aria-label="Sidebar"\]'\)/);
  assert.match(source, /link\.closest\("p"\)/);
  assert.match(source, /if \(text\.length > 110\) \{/);
  assert.match(source, /if \(isSocialAttributionLink\(link\)\) \{/);
  assert.match(source, /function isSocialAttributionLink\(link\)/);
  assert.match(source, /function isSocialAttributionText\(text, profileUrlCount\)/);
  assert.match(source, /function hasSocialAttributionVerb\(text\)/);
  assert.match(source, /commented\|replied\|reacted\|liked\|reposted\|shared\|followed\|mentioned/);
  assert.match(source, /isCompactLinkedInAttributionPlacement\(link, name, placementTarget\)/);
  assert.match(source, /function isCompactLinkedInAttributionPlacement\(link, name = "", placementTarget = link\)/);
  assert.match(source, /function profileUrlsInElement\(element\)/);
  assert.match(source, /function ancestorTextMatches\(element, pattern\)/);
  assert.match(source, /profile viewers\?\|post impressions\|your premium features\|recommended for you\|because you recently/i);
  assert.match(source, /linkStyle\.display === "inline" && parentStyle\?\.display === "inline"/);
  assert.doesNotMatch(source, /link\.insertAdjacentElement\("afterend", createAnchorControl\(cleanText\(link\.textContent \|\| ""\), profileUrl\)\)/);
});

test("LinkedIn author overlay attaches to a detected name line", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const addAuthors = source.slice(source.indexOf("function addAuthorButtons"), source.indexOf("function isLikelyPersonName"));

  assert.match(addAuthors, /function authorControlForLink\(link, profileUrl = normalizeProfileUrl\(link\.href\)\)/);
  assert.match(addAuthors, /const sameProfileControl = \(node\) =>/);
  assert.match(addAuthors, /node\.dataset\.lefProfileUrl === profileUrl \? node : null/);
  assert.match(addAuthors, /const host = authorControlHost\(link, placementTarget\);/);
  assert.match(addAuthors, /const rail = existingAuthorControlRail\(host\);/);
  assert.match(addAuthors, /\[\.\.\.\(rail\?\.querySelectorAll\("\.lef-anchor"\) \|\| \[\]\)\]\.map\(sameProfileControl\)\.find\(Boolean\) \|\|/);
  assert.match(addAuthors, /sameProfileControl\(link\.querySelector\("\.lef-anchor"\)\) \|\|/);
  assert.match(addAuthors, /sameProfileControl\(link\.nextElementSibling\) \|\|/);
  assert.match(addAuthors, /\[\.\.\.\(link\.parentElement\?\.children \|\| \[\]\)\]\.map\(sameProfileControl\)\.find\(Boolean\) \|\|/);
  assert.match(addAuthors, /const labelName = profileNameFromAriaLabel\(link\.getAttribute\("aria-label"\) \|\| ""\);/);
  assert.match(addAuthors, /function profileNameFromAriaLabel\(label\)/);
  assert.match(addAuthors, /clean\.match\(\/\^\(\?:view\\s\+\)\?\(\.\+\?\)\(\?:'s\|\\u2019s\)\?\\s\+profile\$\/i\)/);
  assert.match(addAuthors, /function authorControlPlacementTarget\(link, name\)/);
  assert.match(addAuthors, /const candidates = \[link, \.\.\.link\.querySelectorAll\("span, strong, div"\)\];/);
  assert.match(addAuthors, /const nameElement =/);
  assert.match(addAuthors, /visibleNameElementText\(element\) === normalizedName/);
  assert.match(addAuthors, /text\.startsWith\(`\$\{normalizedName\} `\) && text\.length <= normalizedName\.length \+ 40/);
  assert.match(addAuthors, /function visibleNameElementText\(element\)/);
  assert.match(addAuthors, /rect\.width < 24 \|\| rect\.height < 10/);
  assert.match(addAuthors, /function linkMostlyWrapsVisibleName\(link, nameElement\)/);
  assert.match(addAuthors, /return nameElement;/);
});

test("LinkedIn author overlay reserves an anchored helper rail outside name text", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const css = fs.readFileSync(contentCssPath, "utf8");
  const addAuthors = source.slice(source.indexOf("function addAuthorButtons"), source.indexOf("function authorNameFromLink"));
  const hostSelection = source.slice(source.indexOf("function authorControlHost"), source.indexOf("function isUnsafeAuthorControlPlacement"));

  assert.match(addAuthors, /insertAuthorControl\(\s+link,\s+placementTarget,\s+createAnchorControl\(name, profileUrl, \{ placement: "author-rail" \}\),\s+\);/);
  assert.match(addAuthors, /function insertAuthorControl\(link, placementTarget, control\)/);
  assert.match(addAuthors, /const host = authorControlHost\(link, placementTarget\);/);
  assert.match(addAuthors, /if \(host && host\.contains\(placementTarget\)\) \{/);
  assert.match(addAuthors, /existingAuthorControlRail\(host\)\?\.querySelectorAll\("\.lef-anchor"\) \|\| \[\]/);
  assert.match(addAuthors, /const rail = authorControlRail\(host\);/);
  assert.match(addAuthors, /rail\.appendChild\(control\);/);
  assert.match(addAuthors, /if \(insertAuthorRowSlotControl\(link, placementTarget, control\)\) \{\s+return;\s+\}/);
  assert.match(addAuthors, /function insertAuthorRowSlotControl\(link, placementTarget, control\)/);
  assert.match(addAuthors, /const host = authorRowSlotHost\(link, placementTarget\);/);
  assert.match(addAuthors, /control\.classList\.add\("lef-anchor-author-slot"\);/);
  assert.match(addAuthors, /host\.classList\.add\("lef-author-row-slot-host"\);/);
  assert.match(addAuthors, /anchorChild\.insertAdjacentElement\("afterend", control\);/);
  assert.match(addAuthors, /if \(isUnsafeAuthorRowSlotAnchor\(control\)\) \{/);
  assert.match(addAuthors, /function authorRowSlotHost\(link, placementTarget = link\)/);
  assert.match(addAuthors, /hostRect\.height <= 42/);
  assert.match(addAuthors, /hostRect\.width >= linkRect\.width \+ AUTHOR_CONTROL_SLOT_WIDTH \+ 18/);
  assert.match(addAuthors, /function isUnsafeAuthorRowSlotAnchor\(anchor\)/);
  assert.match(addAuthors, /authorRowSlotOverlapsVisibleText\(anchor, host\)/);
  assert.match(addAuthors, /authorControlHitTargetIsBlocked\(anchor\) \|\|/);
  assert.match(addAuthors, /function authorControlHitTargetIsBlocked\(anchor\)/);
  assert.match(addAuthors, /document\.elementFromPoint\(centerX, centerY\)/);
  assert.match(addAuthors, /topElement !== anchor && !anchor\.contains\(topElement\)/);
  assert.match(addAuthors, /insertInlineAuthorControl\(link, placementTarget, control\);/);
  assert.match(addAuthors, /function insertInlineAuthorControl\(link, placementTarget, control\)/);
  assert.match(addAuthors, /if \(!canInsertInlineAuthorControl\(link, placementTarget\)\) \{\s+return;\s+\}/);
  assert.match(addAuthors, /control\.classList\.remove\("lef-anchor-author-rail"\);/);
  assert.match(addAuthors, /control\.classList\.add\("lef-anchor-author-inline"\);/);
  assert.match(addAuthors, /placementTarget\.insertAdjacentElement\("afterend", control\);/);
  assert.match(addAuthors, /if \(isUnsafeAuthorInlineAnchor\(control\)\) \{\s+control\.remove\(\);/);
  assert.match(addAuthors, /function canInsertInlineAuthorControl\(link, placementTarget = link\)/);
  assert.match(addAuthors, /profileUrlsInElement\(parent\)\.size === 1/);
  assert.match(addAuthors, /!hasSocialAttributionVerb\(text\)/);
  assert.match(addAuthors, /rightmostTextRectInReferenceLine\(parent, targetRect\)/);
  assert.match(addAuthors, /function isUnsafeAuthorInlineAnchor\(anchor\)/);
  assert.match(addAuthors, /function authorControlRail\(host\)/);
  assert.match(addAuthors, /if \(!authorControlRailCanMount\(host, mount\)\) \{\s+return undefined;\s+\}/);
  assert.match(addAuthors, /host\.classList\.add\("lef-author-control-host"\);/);
  assert.match(addAuthors, /rail\.className = "lef-author-control-rail";/);
  assert.match(addAuthors, /function existingAuthorControlRail\(host\)/);
  assert.match(addAuthors, /const mount = authorControlRailMount\(host\);/);
  assert.match(addAuthors, /if \(existingRail\.parentElement !== host\) \{\s+host\.appendChild\(existingRail\);/);
  assert.doesNotMatch(addAuthors, /mount\.insertAdjacentElement\("afterend", rail\);/);
  assert.match(addAuthors, /host\.appendChild\(rail\);/);
  assert.match(addAuthors, /function authorControlRailMount\(host\)/);
  assert.match(addAuthors, /for \(let depth = 0; mount\?\.parentElement && depth < 3; depth \+= 1\)/);
  assert.match(addAuthors, /if \(!isSingleLineFlexRowHost\(mount\.parentElement\)\) \{\s+break;/);
  assert.match(addAuthors, /mount = mount\.parentElement;/);
  assert.match(addAuthors, /mount !== host && mount\.nextElementSibling\?\.classList\?\.contains\("lef-author-control-rail"\)/);
  assert.match(addAuthors, /function authorControlHost\(link, placementTarget = link\)/);
  assert.match(addAuthors, /const actorRoot = authorActorRoot\(link\);/);
  assert.match(
    addAuthors,
    /if \(actorRoot && isCommentAuthorActorRoot\(actorRoot\)\) \{\s+return isCrampedCommentAuthorActorRoot\(actorRoot, placementTarget\) \|\| !authorHostCanReserveRail\(actorRoot, placementTarget\)\s+\? null\s+: actorRoot;\s+\}/,
  );
  assert.match(addAuthors, /\(authorHostCanReserveRail\(actorRoot, placementTarget\) \? actorRoot : null\) \|\|/);
  assert.match(addAuthors, /function authorHostCanReserveRail\(host, placementTarget\)/);
  assert.match(addAuthors, /authorHostHasRoomForControl\(host, placementTarget, \{ minWidth: 168, slotWidth: 42 \}\)/);
  assert.match(addAuthors, /!isCompactAuthorControlHost\(host, placementTarget\)/);
  assert.match(source, /function authorHostHasRoomForControl\(host, placementTarget, options = \{\}\)/);
  assert.match(source, /const minWidth = options\.minWidth \|\| AUTHOR_CONTROL_MIN_HOST_WIDTH;/);
  assert.match(source, /const slotWidth = options\.slotWidth \|\| AUTHOR_CONTROL_SLOT_WIDTH;/);
  assert.match(source, /const occupiedLineRight = Math\.max\(targetRect\.right, rightmostTextRectInReferenceLine\(host, targetRect\)\);/);
  assert.match(source, /const inlineRoomAfterTarget = Math\.max\(0, hostRect\.right - occupiedLineRight\);/);
  assert.match(source, /function rightmostTextRectInReferenceLine\(host, referenceRect\)/);
  assert.match(source, /document\.createTreeWalker\(host, NodeFilter\.SHOW_TEXT/);
  assert.match(source, /rectOverlapsReferenceLine\(textRect, referenceRect\)/);
  assert.match(
    source,
    /const safeSlotWidth = slotWidth \+ 8;\s+return \(\s+inlineRoomAfterTarget >= safeSlotWidth &&\s+hostRect\.width >= Math\.max\(minWidth, Math\.min\(260, visibleTargetWidth\) \+ safeSlotWidth\)/,
  );
  assert.match(addAuthors, /style\.display !== "inline"/);
  assert.match(addAuthors, /style\.position !== "absolute"/);
  assert.match(addAuthors, /!isSingleLineFlexRowHost\(host\)/);
  assert.match(addAuthors, /authorMetadataHost\(link, placementTarget\) \|\|/);
  assert.match(addAuthors, /function authorMetadataHost\(link, placementTarget = link\)/);
  assert.match(addAuthors, /const actorRoot = authorActorRoot\(link\);/);
  assert.match(addAuthors, /function authorActorRoot\(link\)/);
  assert.match(addAuthors, /return link\.closest\(authorActorSelector\(\)\);/);
  assert.match(addAuthors, /function authorActorSelector\(\)/);
  assert.match(addAuthors, /function isCommentAuthorActorRoot\(actorRoot\)/);
  assert.match(addAuthors, /\.comments-comment-entity, \.comments-comment-meta, \.comments-post-meta/);
  assert.match(addAuthors, /function isCrampedCommentAuthorActorRoot\(actorRoot, placementTarget\)/);
  assert.match(addAuthors, /rootRect\.height < 64/);
  assert.match(addAuthors, /firstLineText\.length > 96/);
  assert.match(addAuthors, /rightmostTextRectInReferenceLine\(actorRoot, targetRect\) \+ AUTHOR_CONTROL_SLOT_WIDTH \+ 16 > rootRect\.right/);
  assert.match(addAuthors, /isUnsafeAuthorControlPlacement\(link, authorNameFromLink\(link\), placementTarget\)/);
  assert.match(addAuthors, /function isUnsafeAuthorControlPlacement\(link, name = "", placementTarget = link\)/);
  assert.match(addAuthors, /isDenseSocialActionLine\(link, name, placementTarget\) \|\|/);
  assert.match(addAuthors, /isLinkedInActionVerbLine\(link, name\) \|\|/);
  assert.match(addAuthors, /isSocialAttributionLink\(link\) \|\|/);
  assert.match(addAuthors, /isInsideSocialAttributionText\(placementTarget\) \|\|/);
  assert.match(addAuthors, /isCompactActionLinePlacement\(link, name, placementTarget\)/);
  assert.match(addAuthors, /function isCompactActionLinePlacement\(link, name = "", placementTarget = link\)/);
  assert.match(addAuthors, /visualLineTextNearRect\(current, targetRect\) \|\| cleanText\(textWithoutHelperControls\(current\)\)/);
  assert.match(addAuthors, /profileUrlsInVisualLine\(current, targetRect\)\.size \|\| profileUrlsInElement\(current\)\.size/);
  assert.match(addAuthors, /isLinkedInActionSummaryText\(text, profileUrlCount, name\)/);
  assert.match(addAuthors, /function authorControlRailCanMount\(host, mount\)/);
  assert.match(addAuthors, /isCrampedAuthorRailMount\(host, mount\) \|\|/);
  assert.match(addAuthors, /function isCrampedAuthorRailMount\(host, mount\)/);
  assert.match(addAuthors, /mountRect\.height <= 34/);
  assert.match(addAuthors, /hasSocialAttributionVerb\(text\) \|\| profileUrlCount > 1 \|\| hostRect\.width < 140 \|\| mountRect\.width < 180/);
  assert.match(addAuthors, /isActionAttributionText\(text, profileUrlCount\)/);
  assert.match(addAuthors, /profileUrlCount === 1/);
  assert.match(addAuthors, /rect\.height >= 32/);
  assert.match(addAuthors, /!isSingleLineFlexRowHost\(current\)/);
  assert.match(addAuthors, /style\.display !== "inline-block"/);
  assert.match(addAuthors, /style\.position !== "absolute"/);
  assert.match(addAuthors, /!isCompactNameOnlyHost\(current, link, text, rect\)/);
  assert.match(addAuthors, /inferredAuthorControlHost\(link\)/);
  assert.match(addAuthors, /function inferredAuthorControlHost\(link\)/);
  assert.match(addAuthors, /\.update-components-actor/);
  assert.match(addAuthors, /\.comments-comment-entity/);
  assert.match(hostSelection, /profileUrlCount === 1/);
  assert.doesNotMatch(hostSelection, /profileUrlCount >= 1/);
  assert.match(addAuthors, /authorHostHasRoomForControl\(current, placementTarget\)/);
  assert.match(addAuthors, /authorHostHasRoomForControl\(current, link\)/);
  assert.match(addAuthors, /!isCompactAuthorControlHost\(current, link\)/);
  assert.match(source, /function isCompactAuthorControlHost\(host, placementTarget\)/);
  assert.match(source, /hostRect\.height < 52/);
  assert.match(source, /targetRect\.height <= 28/);
  assert.match(source, /text\.startsWith\(targetText\)/);
  assert.match(source, /text\.length <= targetText\.length \+ 96/);
  assert.match(addAuthors, /isTightActionAttributionLine\(link, name, placementTarget\) \|\|/);
  assert.match(addAuthors, /function isTightActionAttributionLine\(link, name = "", placementTarget = link\)/);
  assert.match(css, /\.lef-author-control-host \{/);
  assert.match(css, /position: static !important;/);
  assert.match(css, /overflow: visible !important;/);
  assert.match(css, /min-height: 20px !important;/);
  assert.doesNotMatch(css, /padding-right:\s*28px !important;/);
  assert.doesNotMatch(css, /\.lef-author-control-host \{[^}]*flex-wrap: wrap !important;/s);
  assert.match(css, /\.lef-author-control-rail \{/);
  assert.match(css, /clear: none !important;/);
  assert.match(css, /display: inline-flex !important;/);
  assert.match(css, /flex-wrap: nowrap !important;/);
  assert.match(css, /flex: 0 0 18px !important;/);
  assert.match(css, /grid-column: auto !important;/);
  assert.match(css, /justify-content: flex-start !important;/);
  assert.match(css, /line-height: 16px !important;/);
  assert.match(css, /margin: 0 0 0 6px !important;/);
  assert.match(css, /max-width: 18px !important;/);
  assert.match(css, /min-height: 16px !important;/);
  assert.match(css, /min-width: 18px !important;/);
  assert.match(css, /order: initial !important;/);
  assert.match(css, /position: static !important;/);
  assert.match(css, /right: auto !important;/);
  assert.match(css, /top: auto !important;/);
  assert.match(css, /width: 18px !important;/);
  assert.match(css, /\.lef-author-control-host > \.lef-author-control-rail \{/);
  assert.match(css, /\.lef-author-control-host > \.lef-author-control-rail \{[\s\S]*margin: 0 0 0 6px !important;[\s\S]*position: static !important;[\s\S]*right: auto !important;[\s\S]*top: auto !important;/);
  assert.match(css, /\.lef-anchor-author-rail \.lef-button \{/);
  assert.match(css, /min-height: 16px !important;/);
  assert.match(css, /font-size: 10px !important;/);
  assert.match(css, /body \.lef-anchor:not\(\.lef-anchor-profile-heading\) \.lef-button\[data-lef-profile-url\],/);
  assert.match(css, /body \.lef-anchor:not\(\.lef-anchor-profile-heading\) \.lef-button\[data-lef-profile-url\]::before,/);
  assert.match(css, /body \.lef-anchor:not\(\.lef-anchor-profile-heading\) > \.lef-button:not\(\.lef-button-compact\) \{[\s\S]*display: none !important;/);
  assert.match(css, /main \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\):not\(\.lef-anchor-profile-heading\) \{[\s\S]*display: none !important;/);
  assert.match(css, /main h1 > \.lef-anchor-profile-heading \{[\s\S]*display: inline-flex !important;/);
  assert.match(css, /\.lef-author-row-slot-host \{[\s\S]*display: flex !important;[\s\S]*gap: 6px !important;[\s\S]*overflow: visible !important;/);
  assert.match(css, /\.lef-anchor-author-slot \{[\s\S]*display: inline-flex !important;[\s\S]*flex: 0 0 18px !important;/);
  assert.match(css, /\.update-components-header \.lef-author-control-rail,\s+\.feed-shared-header \.lef-author-control-rail,\s+\.feed-shared-update-v2__description \.lef-author-control-rail,/);
  assert.match(css, /\.update-components-actor__description \.lef-author-control-rail,/);
  assert.match(css, /\[class\*="actor__sub-description"\] \.lef-author-control-rail/);
  assert.match(css, /\.comments-comment-entity \.lef-author-control-rail,/);
  assert.match(css, /\.comments-comment-meta \.lef-author-control-rail,/);
  assert.match(css, /\[class\*="comments-comment"\] \.lef-author-control-rail/);
  assert.match(css, /\[class\*="comment-"\] \.lef-author-control-rail,/);
  assert.match(css, /\[class\*="comments__"\] \.lef-author-control-rail/);
  assert.doesNotMatch(addAuthors, /function commentAuthorNameLine/);
  assert.doesNotMatch(addAuthors, /nameLine\.appendChild\(control\)/);
  assert.doesNotMatch(css, /\.lef-author-name-row/);
});

test("LinkedIn author overlay removes legacy inline helper buttons", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const addAuthors = source.slice(source.indexOf("function addAuthorButtons"), source.indexOf("function authorSearchRoots"));
  const cleanup = source.slice(source.indexOf("function removeUnsafeInlineAuthorControls"), source.indexOf("function authorNameFromLink"));

  const loop = source.slice(source.indexOf("function injectOverlayLoop"), source.indexOf("function startOverlayMutationObserver"));

  assert.match(loop, /closeDetachedPopover\(\);\s+removeUnsafeInlineAuthorControls\(\);\s+const shouldSweep = shouldSweepOverlayControls\(\);/);
  assert.doesNotMatch(addAuthors, /removeUnsafeInlineAuthorControls\(\);/);
  assert.match(cleanup, /function removeUnsafeInlineAuthorControls\(\)/);
  assert.match(cleanup, /removeLegacyFullSizeAuthorControls\(\);/);
  assert.match(cleanup, /function removeLegacyFullSizeAuthorControls\(\)/);
  assert.ok(cleanup.indexOf("removeLegacyFullSizeAuthorControls();") < cleanup.indexOf("compactNonProfileControls();"));
  assert.match(cleanup, /document\.querySelectorAll\("\.lef-anchor, \.lef-button"\)/);
  assert.match(cleanup, /control\.closest\("main h1, \.lef-popover, \.lef-author-control-rail, \.lef-anchor-profile-heading"\)/);
  assert.match(cleanup, /label === "Feeds" \|\| \/\^In\\s\+\\d\+\$\/i\.test\(label\)/);
  assert.match(cleanup, /\(control\.closest\("\.lef-anchor"\) \|\| button \|\| control\)\.remove\(\);/);
  assert.match(cleanup, /compactNonProfileControls\(\);/);
  assert.match(cleanup, /function compactNonProfileControls\(\)/);
  assert.match(cleanup, /document\.querySelectorAll\("\.lef-button\[data-lef-profile-url\]"\)/);
  assert.match(cleanup, /!button\.closest\("main h1, \.lef-popover, \.lef-anchor-profile-heading"\)/);
  assert.match(cleanup, /\.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-profile-heading\)/);
  assert.match(cleanup, /control\?\.classList\?\.contains\("lef-anchor-author-slot"\)/);
  assert.match(cleanup, /return isUnsafeAuthorRowSlotAnchor\(control\);/);
  assert.match(cleanup, /control\?\.classList\?\.contains\("lef-anchor-author-inline"\)/);
  assert.match(cleanup, /return isUnsafeAuthorInlineAnchor\(control\);/);
  assert.match(cleanup, /'a\[href\*="\/in\/"\] \.lef-anchor'/);
  assert.match(cleanup, /'a\[href\*="\/in\/"\] \+ \.lef-anchor'/);
  assert.match(cleanup, /\.lef-anchor-inside/);
  assert.match(cleanup, /\.update-components-header \.lef-anchor/);
  assert.match(cleanup, /\.feed-shared-social-activity \.lef-anchor/);
  assert.match(cleanup, /\.update-components-actor__description \.lef-anchor/);
  assert.match(cleanup, /\[class\*="actor__sub-description"\] \.lef-anchor/);
  assert.match(cleanup, /\$\{authorActorSelector\(\)\} \.lef-anchor/);
  assert.match(cleanup, /isUnsafeInlineAuthorControl\(control\)/);
  assert.match(cleanup, /function isUnsafeInlineAuthorControl\(control\)/);
  assert.match(cleanup, /!control\.closest\("main h1"\)/);
  assert.match(cleanup, /!control\.closest\("\.lef-author-control-rail"\)/);
  assert.match(cleanup, /isInsideSocialAttributionText\(control\)/);
  assert.match(cleanup, /control\.closest\(attributionSurfaceSelector\(\)\)/);
  assert.match(cleanup, /!control\.classList\?\.contains\("lef-anchor-profile-heading"\)/);
  assert.doesNotMatch(cleanup, /!control\.classList\?\.contains\("lef-anchor-author-rail"\)/);
  assert.match(cleanup, /document\.querySelectorAll\("\.lef-author-control-rail"\)/);
  assert.match(cleanup, /document\.querySelectorAll\("\.lef-author-row-slot-host"\)/);
  assert.match(cleanup, /cleanupAuthorRowSlotHost\(host\);/);
  assert.match(cleanup, /function isCompactAuthorButton\(button\)/);
  assert.match(cleanup, /isCompactAuthorRailButton\(button\) \|\| isCompactAuthorSlotButton\(button\)/);
  assert.match(cleanup, /function isCompactAuthorSlotButton\(button\)/);
  assert.match(cleanup, /compactLegacyAuthorRailButtons\(rail\);/);
  assert.match(cleanup, /function compactLegacyAuthorRailButtons\(rail\)/);
  assert.match(cleanup, /\.lef-button:not\(\.lef-button-compact\)/);
  assert.match(cleanup, /button\.classList\.add\("lef-button-compact"\);/);
  assert.match(cleanup, /updateButtonLabel\(button, isSafeInteger\(count\) && count > 0 \? count : 0\);/);
  assert.match(cleanup, /document\.querySelectorAll\("\.lef-button, button\[data-lef-profile-url\], \.lef-button\[data-lef-profile-url\]"\)/);
  assert.match(cleanup, /isUnsafeOrphanAuthorButton\(button\)/);
  assert.match(cleanup, /\(button\.closest\("\.lef-anchor"\) \|\| button\)\.remove\(\);/);
  assert.match(cleanup, /document\.querySelectorAll\("\.lef-anchor-author-rail"\)/);
  assert.match(cleanup, /isUnsafeAuthorRailAnchor\(anchor\)/);
  assert.match(cleanup, /function isUnsafeAuthorRailAnchor\(anchor\)/);
  assert.match(cleanup, /const rail = anchor\.closest\("\.lef-author-control-rail"\);/);
  assert.match(cleanup, /!rail &&/);
  assert.match(cleanup, /anchor\.closest\(attributionSurfaceSelector\(\)\)/);
  assert.match(cleanup, /anchor\.closest\(authorActorSelector\(\)\)/);
  assert.match(cleanup, /function isUnsafeOrphanAuthorButton\(button\)/);
  assert.match(cleanup, /!isCompactAuthorButton\(button\)/);
  assert.match(cleanup, /!button\.closest\("\.lef-author-control-rail"\)/);
  assert.match(cleanup, /!button\.closest\("\.lef-popover"\)/);
  assert.match(cleanup, /!button\.closest\("\.lef-anchor-profile-heading"\)/);
  assert.match(cleanup, /function isCompactAuthorRailButton\(button\)/);
  assert.match(cleanup, /button\?\.classList\?\.contains\("lef-button-compact"\)/);
  assert.match(cleanup, /button\.closest\("\.lef-author-control-rail"\)/);
  assert.match(cleanup, /button\.closest\("\.lef-anchor-author-rail"\)/);
  assert.match(cleanup, /isUnsafeAuthorControlRail\(rail\)/);
  assert.match(cleanup, /function isUnsafeAuthorControlRail\(rail\)/);
  assert.match(cleanup, /const host = authorHostForRail\(rail\);/);
  assert.match(cleanup, /isInsideSocialAttributionText\(rail\) \|\|/);
  assert.match(cleanup, /isSocialAttributionHost\(host\) \|\|/);
  assert.match(cleanup, /isSingleLineFlexRowHost\(host\)/);
  assert.match(cleanup, /const profileUrl = normalizeProfileUrl\(rail\.querySelector\("\.lef-button"\)\?\.dataset\.lefProfileUrl \|\| ""\);/);
  assert.match(cleanup, /if \(!profileUrl \|\| !host\) \{\s+return true;\s+\}/);
  assert.match(cleanup, /const link = authorRailMatchingLink\(host, profileUrl\);/);
  assert.match(cleanup, /if \(!link\) \{\s+return true;\s+\}/);
  assert.match(cleanup, /return shouldSkipAuthorLink\(link, authorNameFromLink\(link\)\) \|\| isCompactAuthorControlHost\(host, link\);/);
  assert.match(cleanup, /function authorRailMatchingLink\(host, profileUrl\)/);
  assert.match(cleanup, /host\.querySelectorAll\('a\[href\*="\/in\/"\]'\)/);
  assert.match(cleanup, /normalizeProfileUrl\(candidate\.href\) === profileUrl/);
  assert.match(cleanup, /!candidate\.closest\("\.lef-author-control-rail, \.lef-popover, \.lef-refresh-banner"\)/);
  assert.match(cleanup, /function authorHostForRail\(rail\)/);
  assert.match(cleanup, /rail\.previousElementSibling/);
  assert.match(cleanup, /previousSibling\?\.classList\?\.contains\("lef-author-control-host"\)/);
  assert.match(cleanup, /previousSibling\?\.querySelector\?\.\("\.lef-author-control-host"\)/);
  assert.match(cleanup, /!rail\.querySelector\("\.lef-anchor"\)/);
  assert.match(cleanup, /control\.remove\(\);/);
  assert.match(cleanup, /rail\.remove\(\);/);
});

test("LinkedIn author overlay skips multi-person social attribution before text length filtering", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const host = source.slice(source.indexOf("function authorControlHost"), source.indexOf("function authorMetadataHost"));
  const skip = source.slice(source.indexOf("function shouldSkipAuthorLink"), source.indexOf("function ancestorTextMatches"));
  const social = source.slice(source.indexOf("function isSocialAttributionLink"), source.indexOf("function isSocialAttributionText"));
  const inside = source.slice(source.indexOf("function isInsideSocialAttributionText"), source.indexOf("function hasSocialAttributionVerb"));

  assert.match(host, /if \(isUnsafeAuthorControlPlacement\(link, authorNameFromLink\(link\), placementTarget\)\) \{\s+return null;\s+\}/);
  assert.ok(host.indexOf("isUnsafeAuthorControlPlacement") < host.indexOf("authorActorRoot(link)"));
  assert.match(source, /function isUnsafeAuthorControlPlacement\(link, name = "", placementTarget = link\)/);
  assert.ok(source.indexOf("isSocialAttributionLink(link)") < source.indexOf("isCompactActionLinePlacement(link, name, placementTarget)"));
  assert.ok(source.indexOf("isInlineSocialActionHeader(link, name, placementTarget)") < source.indexOf("isFeedActionAttributionLink(link, name)"));
  assert.match(source, /function isInlineSocialActionHeader\(link, name = "", placementTarget = link\)/);
  assert.match(source, /const inline = nearbyInlineNodeSnapshot\(current\);/);
  assert.match(source, /const nearby = nearbyAuthorLineSnapshot\(current\);/);
  assert.match(source, /profileUrlsInVisualLine\(current, targetRect\)\.size,\s+profileUrlsInElement\(current\)\.size,\s+inline\.profileUrlCount,\s+nearby\.profileUrlCount,/);
  assert.match(source, /lineText\.length <= 320/);
  assert.match(source, /firstVerbIndex <= Math\.max\(180, \(nameIndex >= 0 \? nameIndex : 0\) \+ normalizedName\.length \+ 120\)/);
  assert.match(source, /profileUrlCount > 1 \|\| \/\\b\(\?:and\|with\)\\b\/\.test\(lineText\.slice\(0, firstVerbIndex \+ 32\)\)/);
  assert.ok(skip.indexOf("isSocialAttributionLink(link)") < skip.indexOf("const text = cleanText"));
  assert.ok(skip.indexOf("isActionAttributionHeaderLink(link, name)") < skip.indexOf("const text = cleanText"));
  assert.match(social, /for \(let depth = 0; current && depth < 14; depth \+= 1\)/);
  assert.match(social, /if \(isAttributionContextLink\(link\)\) \{\s+return true;\s+\}/);
  assert.match(source, /function isLikelyInlineAttributionText\(link\)/);
  assert.match(source, /function isNearbyElementSibling\(candidate, target\)/);
  assert.match(source, /isActionAttributionText\(siblingText, profileUrlsInElement\(parent\)\.size, cleanText\(textWithoutHelperControls\(link\)\)\)/);
  assert.match(source, /Math\.abs\(candidateIndex - targetIndex\) <= 3/);
  assert.match(source, /function isAttributionContextLink\(link\)/);
  assert.match(source, /const context = link\.closest\(attributionSurfaceSelector\(\)\);/);
  assert.match(source, /function isCompactActionAttributionContext\(link, name = cleanText\(textWithoutHelperControls\(link\)\)\)/);
  assert.match(source, /if \(isCompactActionAttributionContext\(link\)\) \{\s+return true;\s+\}/);
  assert.match(source, /return isLikelyInlineAttributionText\(link\);/);
  assert.match(source, /profileUrlCount > 1 \|\| \/\\b\(\?:and\|with\)\\b\/i\.test\(text\) \|\| isCompactSocialAttributionText\(text, profileUrlCount\)/);
  assert.match(source, /function isActionAttributionHeaderLink\(link, name\)/);
  assert.match(source, /function isActionAttributionText\(text, profileUrlCount, name = ""\)/);
  assert.match(source, /const firstVerbIndex = clean\.search\(\/\\b\(\?:commented\|replied\|reacted\|liked\|reposted\|shared\|followed\|mentioned\)\\b\/\);/);
  assert.match(source, /const actionVerbMatch = clean\.match\(\/\\b\(\?:commented\|replied\|reacted\|liked\|reposted\|shared\|followed\|mentioned\)\\b\/\);/);
  assert.match(source, /firstVerbIndex <= Math\.max\(160, normalizedName\.length \+ 96\)/);
  assert.match(source, /profileUrlCount >= 1 &&\s+\(!normalizedName \|\| clean\.includes\(normalizedName\)\) &&\s+clean\.endsWith\(actionVerbMatch\?\.\[0\] \|\| ""\)/);
  assert.match(social, /\.update-components-header/);
  assert.match(social, /\.feed-shared-social-activity/);
  assert.match(social, /isSocialAttributionText\(text, profileUrlCount\) \|\|/);
  assert.match(social, /isCompactSocialAttributionText\(text, profileUrlCount\) \|\|/);
  assert.match(social, /isSocialAttributionHost\(current\) \|\|/);
  assert.match(social, /attributionSurface\.contains\(current\) \|\| current\.contains\(attributionSurface\)/);
  assert.match(social, /hasSocialAttributionVerb\(text\)/);
  assert.match(source, /function isCompactSocialAttributionText\(text, profileUrlCount\)/);
  assert.match(source, /profileUrlCount >= 1/);
  assert.match(source, /clean\.length <= 180/);
  assert.match(inside, /function isSocialAttributionHost\(element\)/);
  assert.match(inside, /profileUrlCount > 1/);
  assert.match(inside, /rect\.height <= 90/);
  assert.match(inside, /\\b\(\?:and\|with\)\\b/);
  assert.match(source, /commented\|replied\|reacted\|liked\|reposted\|shared\|followed\|mentioned/);
  assert.match(source, /function isInsideSocialAttributionText\(element\)/);
  assert.match(source, /function isNearbySocialAttributionLine\(link, name = ""\)/);
  assert.match(source, /function isCompactAttributionSentenceLink\(link\)/);
  assert.match(source, /function isAttributionSentenceAroundLink\(link, name = ""\)/);
  assert.match(source, /function isLinkedInHeaderAttributionLink\(link\)/);
  assert.match(source, /isLinkedInHeaderAttributionLink\(link\)/);
  assert.match(source, /function isCompactLinkedInActionSummaryLink\(link, name = ""\)/);
  assert.match(source, /isCompactLinkedInActionSummaryLink\(link, name\)/);
  assert.match(source, /function compactActionSummaryLineText\(element, link\)/);
  assert.match(source, /function isLinkedInActionSummaryText\(text, profileUrlCount, name = ""\)/);
  assert.match(source, /profileUrlCount >= 1/);
  assert.match(source, /function isCompactActionAttributionContext\(link, name = cleanText\(textWithoutHelperControls\(link\)\)\)/);
  assert.match(source, /function isCompactInlineActionAttributionLink\(link, name\)/);
  assert.match(source, /function isShortActionAttributionLineLink\(link, name\)/);
  assert.match(source, /isCompactInlineActionAttributionLink\(link, name\)/);
  assert.match(source, /isShortActionAttributionLineLink\(link, name\)/);
  assert.match(source, /isCompactAttributionSentenceLink\(link\)/);
  assert.match(source, /isAttributionSentenceAroundLink\(link, name\)/);
  assert.match(source, /isCompactSocialAttributionSentenceLink\(link, name\)/);
  assert.match(source, /function isCompactSocialAttributionSentenceLink\(link, name = ""\)/);
  assert.match(source, /rect\.height <= 54/);
  assert.match(source, /rect\.height <= 64/);
  assert.match(source, /rect\.height <= 96/);
  assert.match(source, /rect\.height <= 72/);
  assert.match(source, /rect\.height <= 80/);
  assert.match(source, /clean\.includes\(normalizedName\)/);
  assert.match(source, /clean\.endsWith\(actionVerbMatch\?\.\[0\] \|\| ""\)/);
  assert.match(source, /clean\.endsWith\(clean\.match\(\/\\b\(\?:commented\|replied\|reacted\|liked\|reposted\|shared\|followed\|mentioned\)\\b\/\)\?\.\[0\] \|\| ""\)/);
  assert.match(source, /function isAttributionSurface\(element\)/);
  assert.match(source, /function attributionSurfaceSelector\(\)/);
  assert.match(source, /\[class\*="social-activity"\]/);
  assert.match(source, /isNearbySocialAttributionLine\(link, name\)/);
  assert.match(source, /isInlineActionAttributionCluster\(link, name\)/);
  assert.match(source, /function isInlineActionAttributionCluster\(link, name = ""\)/);
  assert.match(source, /function nearbyInlineNodeSnapshot\(target\)/);
  assert.match(source, /const siblings = \[\.\.\.parent\.childNodes\];/);
  assert.match(source, /siblings\.slice\(Math\.max\(0, targetIndex - 4\), Math\.min\(siblings\.length, targetIndex \+ 5\)\)/);
  assert.match(source, /node\.nodeType === Node\.ELEMENT_NODE/);
  assert.match(source, /return node\.textContent \|\| "";/);
  assert.match(source, /for \(let depth = 0; current && depth < 12; depth \+= 1\)/);
  assert.match(source, /function nearbyAuthorLineSnapshot\(element\)/);
  assert.match(source, /const \{ text, profileUrlCount \} = nearbyAuthorLineSnapshot\(current\);/);
  assert.match(source, /isActionAttributionText\(text, profileUrlCount, name\)/);
  assert.match(source, /isCompactSocialAttributionText\(text, profileUrlCount\)/);
  assert.match(source, /isNearbyElementSibling\(child, element\)/);
  assert.match(source, /profileUrlsInElement\(parent \|\| current\)\.size > 1/);
  assert.match(source, /clean\.length <= 320/);
});

test("LinkedIn helper injects critical overlay CSS before adding controls", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const boot = source.slice(source.indexOf("function boot"), source.indexOf("function injectOverlayLoop"));
  const criticalStyles = source.slice(source.indexOf("function injectCriticalOverlayStyles"), source.indexOf("function injectOverlayLoop"));

  assert.match(source, /const CRITICAL_STYLE_ID = "lef-critical-overlay-style";/);
  assert.match(boot, /injectCriticalOverlayStyles\(\);\s+markHelperActive\(\);/);
  assert.match(criticalStyles, /document\.getElementById\(CRITICAL_STYLE_ID\)/);
  assert.match(criticalStyles, /style\.id = CRITICAL_STYLE_ID;/);
  assert.match(criticalStyles, /body \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\):not\(\.lef-anchor-profile-heading\)/);
  assert.match(criticalStyles, /\.update-components-header \.lef-anchor,/);
  assert.match(criticalStyles, /\.comments-comment-entity \.lef-anchor,/);
  assert.match(criticalStyles, /\.comments-comment-meta \.lef-author-control-rail,/);
  assert.match(criticalStyles, /\[class\*="comment-"\] \.lef-anchor,/);
  assert.match(criticalStyles, /\[class\*="comments__"\] \.lef-author-control-rail/);
  assert.match(criticalStyles, /\.lef-author-control-rail \.lef-button \{/);
  assert.match(criticalStyles, /\.lef-author-row-slot-host \{/);
  assert.match(criticalStyles, /\.lef-anchor-author-slot \{/);
  assert.match(criticalStyles, /font-size: 0 !important;/);
  assert.match(criticalStyles, /\.lef-button\.lef-button-compact \{/);
  assert.match(criticalStyles, /\.lef-author-control-rail \.lef-button::before \{/);
  assert.match(criticalStyles, /content: "\+" !important;/);
  assert.match(criticalStyles, /\.lef-button\.lef-button-compact::before \{/);
  assert.doesNotMatch(criticalStyles, /padding-right:\s*28px !important;/);
  assert.match(criticalStyles, /\(document\.head \|\| document\.documentElement\)\.appendChild\(style\);/);
});

test("LinkedIn author overlay keeps compact action headers and author controls from colliding with names", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const css = fs.readFileSync(contentCssPath, "utf8");
  const skip = source.slice(source.indexOf("function shouldSkipAuthorLink"), source.indexOf("function isSocialAttributionLink"));
  const visualLine = source.slice(source.indexOf("function isVisualActionAttributionLineLink"), source.indexOf("function isInlineActionAttributionCluster"));
  const createControl = source.slice(source.indexOf("function createAnchorControl"), source.indexOf("async function updateButtonState"));
  const status = source.slice(source.indexOf("function applyButtonStatus"), source.indexOf("function updateProfileControls"));

  assert.match(skip, /isVisualActionAttributionLineLink\(link, name\)/);
  assert.match(source, /function isCommentSurfaceAuthorCollisionRisk\(link, placementTarget = link\)/);
  assert.match(source, /function closestLinkedInCommentSurface\(element\)/);
  assert.match(source, /function isLinkedInCommentSurfaceElement\(element\)/);
  assert.match(source, /\\bcomments\?-\|\\bcomments\?__/);
  assert.match(source, /rightEdge \+ AUTHOR_CONTROL_SLOT_WIDTH \+ 18 > surfaceRect\.right/);
  assert.match(skip, /isLinkedInActionVerbLine\(link, name\)/);
  assert.match(skip, /isSameLineActionAttributionLink\(link, name\)/);
  assert.match(skip, /isVisibleActionAttributionCluster\(link, name\)/);
  assert.match(skip, /isActionAttributionAncestorLink\(link, name\)/);
  assert.ok(skip.indexOf("isActionAttributionAncestorLink(link, name)") < skip.indexOf("isInlineActionAttributionCluster(link, name)"));
  assert.match(visualLine, /function isVisualActionAttributionLineLink\(link, name = ""\)/);
  assert.match(source, /function isLinkedInActionVerbLine\(link, name = ""\)/);
  assert.match(visualLine, /function isVisibleActionAttributionCluster\(link, name = ""\)/);
  assert.match(visualLine, /function isSameLineActionAttributionLink\(link, name = ""\)/);
  assert.match(visualLine, /const inline = nearbyInlineNodeSnapshot\(current\);/);
  assert.match(visualLine, /profileUrlsInVisualLine\(current, linkRect\)\.size,\s+inline\.profileUrlCount,\s+nearby\.profileUrlCount,\s+profileUrlsInElement\(current\)\.size,/);
  assert.match(visualLine, /const lineText = visualLineTextNearRect\(current, linkRect\);/);
  assert.match(visualLine, /const nearby = nearbyAuthorLineSnapshot\(current\);/);
  assert.match(visualLine, /profileUrlsInVisualLine\(current, linkRect\)\.size, nearby\.profileUrlCount/);
  assert.match(visualLine, /firstVerbIndex <= Math\.max\(170, \(nameIndex >= 0 \? nameIndex : 0\) \+ normalizedName\.length \+ 100\)/);
  assert.match(visualLine, /visualLineTextNearRect\(current, linkRect\)/);
  assert.match(visualLine, /profileUrlsInVisualLine\(current, linkRect\)\.size/);
  assert.match(visualLine, /text\.length <= 260/);
  assert.match(visualLine, /isCompactSocialAttributionText\(text, profileUrlCount\)/);
  assert.match(visualLine, /isActionVerbNearLinkedInNameLine\(text, profileUrlCount, name\)/);
  assert.match(source, /function isInlineActionVerbSiblingLine\(link, name = ""\)/);
  assert.match(source, /siblings\.slice\(Math\.max\(0, currentIndex - 3\), Math\.min\(siblings\.length, currentIndex \+ 7\)\)/);
  assert.match(source, /const lineText = visualLineTextNearRect\(parent \|\| current, targetRect\);/);
  assert.match(source, /const nearbyText = cleanText\(/);
  assert.match(source, /profileUrlsInVisualLine\(parent \|\| current, targetRect\)\.size, profileUrlsInElement\(parent \|\| current\)\.size/);
  assert.match(source, /isLinkedInActionSummaryText\(text, profileUrlCount, name\)/);
  assert.match(source, /function isActionVerbNearLinkedInNameLine\(text, profileUrlCount, name = ""\)/);
  assert.match(source, /firstVerbIndex > Math\.max\(180, normalizedName\.length \+ 120\)/);
  assert.match(source, /profileUrlCount >= 1/);
  assert.match(source, /clean\.endsWith\(actionVerbMatch\?\.\[0\] \|\| ""\)/);
  assert.match(visualLine, /function visualLineTextNodes\(root, referenceRect\)/);
  assert.match(visualLine, /document\.createTreeWalker\(root, NodeFilter\.SHOW_TEXT/);
  assert.ok(visualLine.includes('node.parentElement?.closest?.(".lef-anchor, .lef-popover, .lef-refresh-banner")'));
  assert.match(visualLine, /function rectOverlapsReferenceLine\(rect, referenceRect\)/);
  assert.match(createControl, /if \(options\.placement !== "profile-heading"\) \{\s+button\.classList\.add\("lef-button-compact"\);/);
  assert.doesNotMatch(createControl, /options\.placement === "author-rail"/);
  assert.match(createControl, /updateButtonLabel\(button, 0\);/);
  assert.match(status, /compactNonProfileButton\(button\);/);
  assert.match(status, /function compactNonProfileButton\(button\)/);
  assert.match(status, /if \(!button\.closest\("\.lef-anchor-profile-heading"\)\) \{\s+button\.classList\.add\("lef-button-compact"\);/);
  assert.match(status, /function updateButtonLabel\(button, count, options = \{\}\)/);
  assert.match(status, /button\.classList\.contains\("lef-button-compact"\)/);
  assert.match(status, /button\.textContent = safeCount > 0 \? String\(Math\.min\(safeCount, 99\)\) : "\+"/);
  assert.match(status, /button\.setAttribute\("aria-label", membershipText\);/);
  assert.match(status, /removeButtonIfItNowCollides\(button\);/);
  assert.match(status, /function removeButtonIfItNowCollides\(button\)/);
  assert.match(status, /!button\.classList\.contains\("lef-button-compact"\) && !button\.closest\("main h1, \.lef-popover, \.lef-anchor-profile-heading"\)/);
  assert.match(status, /\(button\.closest\("\.lef-anchor"\) \|\| button\)\.remove\(\);/);
  assert.match(status, /const rail = button\.closest\("\.lef-author-control-rail"\);/);
  assert.match(status, /if \(authorControlRailOverlapsVisibleText\(rail, host\)\) \{/);
  assert.match(css, /\.lef-anchor-author-rail \.lef-button \{[\s\S]*width: 18px !important;[\s\S]*min-width: 18px !important;[\s\S]*padding: 2px 0 !important;/);
  assert.match(css, /\.lef-anchor-author-rail \{[\s\S]*display: none !important;/);
  assert.match(css, /\.lef-author-control-rail \.lef-anchor-author-rail \{[\s\S]*display: inline-flex !important;/);
  assert.match(css, /\.lef-button\.lef-button-compact \{[\s\S]*font-size: 0 !important;[\s\S]*overflow: hidden !important;[\s\S]*width: 18px !important;/);
  assert.match(css, /\.lef-button\.lef-button-compact::before \{[\s\S]*content: "\+" !important;/);
  assert.match(css, /body \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\):not\(\.lef-anchor-profile-heading\) \{[\s\S]*display: none !important;/);
  assert.match(css, /body main h1 > \.lef-anchor-profile-heading \{[\s\S]*display: inline-flex !important;/);
  assert.match(css, /body \.lef-button:not\(\.lef-button-compact\):not\(:is\(main h1 \.lef-button, \.lef-popover \.lef-button, \.lef-anchor-profile-heading \.lef-button\)\),/);
  assert.match(css, /body \.lef-button\[data-lef-profile-url\]:not\(\.lef-button-compact\) \{[\s\S]*display: none !important;/);
  assert.match(css, /body main h1 \.lef-anchor-profile-heading \.lef-button\[data-lef-profile-url\] \{[\s\S]*display: inline-block !important;/);
  assert.match(css, /\.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\):not\(\.lef-anchor-profile-heading\) \.lef-button \{[\s\S]*display: none !important;/);
  assert.match(css, /\.lef-anchor-author-inline \{[\s\S]*display: inline-flex !important;[\s\S]*vertical-align: middle !important;/);
  assert.match(css, /\.lef-anchor-author-slot \{[\s\S]*display: inline-flex !important;[\s\S]*flex: 0 0 18px !important;/);
  assert.match(css, /\.update-components-header \.lef-anchor,\s+\.feed-shared-header \.lef-anchor,\s+\.feed-shared-update-v2__description \.lef-anchor,\s+\.feed-shared-social-activity \.lef-anchor,/);
  assert.match(css, /\.update-components-header \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\.feed-shared-update-v2__description \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\[class\*="update-components-header"\] \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\[class\*="feed-shared-header"\] \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\[class\*="social-activity"\] \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\[class\*="attribution"\] \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\.update-components-actor \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /a\[href\*="\/in\/"\] \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /a\[href\*="\/in\/"\] \+ \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\[class\*="update-components"\] \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\[class\*="feed-shared"\] \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\[class\*="comment-"\] \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\[class\*="comments__"\] \.lef-anchor:not\(\.lef-anchor-author-rail\):not\(\.lef-anchor-author-inline\):not\(\.lef-anchor-author-slot\)/);
  assert.match(css, /\.lef-author-control-rail \.lef-button \{/);
  assert.match(css, /\.lef-author-control-rail \.lef-button::before \{/);
  assert.match(css, /content: "\+" !important;/);
});

test("LinkedIn author overlay skips inline action rows and removes text-overlapping rails", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const placement = source.slice(source.indexOf("function isUnsafeAuthorControlPlacement"), source.indexOf("function isInlineSocialActionHeader"));
  const inlineAction = source.slice(source.indexOf("function isInlineActionAttributionAroundLink"), source.indexOf("function isInlineSocialActionHeader"));
  const insert = source.slice(source.indexOf("function insertAuthorControl"), source.indexOf("function authorControlRail"));
  const railSafety = source.slice(source.indexOf("function isUnsafeAuthorControlRail"), source.indexOf("function authorRailMatchingLink"));

  assert.match(placement, /isInlineActionAttributionAroundLink\(link, name\)/);
  assert.match(inlineAction, /function isInlineActionAttributionAroundLink\(link, name = ""\)/);
  assert.match(inlineAction, /const \{ text, profileUrlCount \} = inlineActionAttributionSnapshot\(current\);/);
  assert.match(inlineAction, /isFeedActionAttributionText\(text, name, profileUrlCount\)/);
  assert.match(inlineAction, /isActionAttributionText\(text, profileUrlCount, name\)/);
  assert.match(inlineAction, /function inlineActionAttributionSnapshot\(element\)/);
  assert.match(inlineAction, /\[\.\.\.parent\.childNodes\]/);
  assert.match(inlineAction, /siblings\.slice\(Math\.max\(0, elementIndex - 4\), Math\.min\(siblings\.length, elementIndex \+ 5\)\)/);
  assert.match(inlineAction, /node\.nodeType === Node\.ELEMENT_NODE/);
  assert.match(inlineAction, /return \{ text, profileUrlCount: profileUrls\.size \};/);
  assert.match(insert, /rail\.appendChild\(control\);\s+if \(authorControlRailOverlapsVisibleText\(rail, host\)\) \{\s+control\.remove\(\);\s+removeEmptyAuthorControlRail\(host, rail\);/);
  assert.match(railSafety, /authorControlRailOverlapsVisibleText\(rail, host\) \|\|/);
  assert.match(railSafety, /isLinkedInCommentSurfaceElement\(host\) \|\|/);
  assert.match(railSafety, /function authorControlRailOverlapsVisibleText\(rail, host\)/);
  assert.match(railSafety, /document\.createTreeWalker\(host, NodeFilter\.SHOW_TEXT/);
  assert.ok(railSafety.includes('node.parentElement?.closest?.(".lef-author-control-rail, .lef-anchor, .lef-popover, .lef-refresh-banner")'));
  assert.match(railSafety, /for \(const textRect of textNodeClientRects\(node\)\) \{/);
  assert.match(railSafety, /if \(rectsIntersect\(railRect, textRect, 2\)\) \{/);
  assert.match(railSafety, /function rectsIntersect\(first, second, padding = 0\)/);
});

test("LinkedIn author overlay keeps helper controls out of nested author links", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const css = fs.readFileSync(contentCssPath, "utf8");
  const placement = source.slice(source.indexOf("function authorControlPlacementTarget"), source.indexOf("function isLikelyPersonName"));

  assert.match(
    placement,
    /if \(nameElement === link \|\| link\.contains\(nameElement\) \|\| linkMostlyWrapsVisibleName\(link, nameElement\)\) \{\s+return link;\s+\}/,
  );
  assert.ok(placement.indexOf("link.contains(nameElement)") < placement.indexOf("return link;"));
  assert.match(css, /\.lef-anchor \{/);
  assert.match(css, /position: static !important;/);
  assert.match(css, /float: none !important;/);
  assert.match(css, /transform: none !important;/);
  assert.match(css, /inset: auto !important;/);
  assert.match(css, /grid-column: auto !important;/);
  assert.match(css, /grid-row: auto !important;/);
});

test("LinkedIn membership popover is measured and clamped to the viewport", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const css = fs.readFileSync(contentCssPath, "utf8");
  const openPopover = source.slice(source.indexOf("async function openPopover"), source.indexOf("function popoverRequestIsCurrent"));
  const position = source.slice(source.indexOf("function positionPopover"), source.indexOf("function finishPopoverOpening"));
  const close = source.slice(source.indexOf("function closeActivePopover"), source.indexOf("function closeDetachedPopover"));

  assert.match(source, /popoverPositionFrame: 0/);
  assert.match(openPopover, /popover\.style\.visibility = "hidden";/);
  assert.match(openPopover, /document\.body\.appendChild\(popover\);/);
  assert.match(openPopover, /positionPopover\(popover, anchor\);/);
  assert.match(openPopover, /popover\.style\.visibility = "";/);
  assert.match(position, /const width = popover\.offsetWidth \|\| 280;/);
  assert.match(position, /const height = popover\.offsetHeight \|\| 300;/);
  assert.match(position, /const fitsBelow = rect\.bottom \+ gap \+ height <= window\.innerHeight - margin;/);
  assert.match(position, /Math\.max\(margin, Math\.min\(preferredTop, window\.innerHeight - margin - height\)\)/);
  assert.match(position, /Math\.max\(margin, Math\.min\(rect\.left, window\.innerWidth - margin - width\)\)/);
  assert.match(position, /window\.requestAnimationFrame/);
  assert.match(close, /window\.cancelAnimationFrame\(state\.popoverPositionFrame\);/);
  assert.match(source, /window\.addEventListener\("resize", scheduleActivePopoverPosition, \{ passive: true \}\);/);
  assert.match(source, /window\.addEventListener\("scroll", scheduleActivePopoverPosition, \{ capture: true, passive: true \}\);/);
  assert.doesNotMatch(openPopover, /window\.innerHeight - 300/);
  assert.match(css, /max-height: calc\(100vh - 24px\) !important;/);
  assert.match(css, /overflow: auto !important;/);
  assert.match(css, /overscroll-behavior: contain !important;/);
  assert.match(css, /\.lef-feed-count \{[\s\S]*text-overflow: ellipsis !important;[\s\S]*white-space: nowrap !important;/);
});

test("LinkedIn author overlay ignores hidden profile-card names", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const placement = source.slice(source.indexOf("function authorControlPlacementTarget"), source.indexOf("function isLikelyPersonName"));

  assert.match(placement, /candidates\.find\(\(element\) => visibleNameElementText\(element\) === normalizedName\)/);
  assert.match(placement, /const rect = element\.getBoundingClientRect\(\);/);
  assert.match(placement, /const style = getComputedStyle\(element\);/);
  assert.match(placement, /style\.display === "none" \|\| style\.visibility === "hidden"/);
  assert.match(placement, /rect\.width < 24 \|\| rect\.height < 10/);
  assert.match(placement, /linkMostlyWrapsVisibleName\(link, nameElement\)/);
  assert.match(placement, /return nameElement;/);
});

test("LinkedIn name extraction ignores nested helper controls", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const authorName = source.slice(source.indexOf("function authorNameFromLink"), source.indexOf("function profileNameFromAriaLabel"));
  const placement = source.slice(source.indexOf("function authorControlPlacementTarget"), source.indexOf("function isLikelyPersonName"));
  const skip = source.slice(source.indexOf("function shouldSkipAuthorLink"), source.indexOf("function ancestorTextMatches"));
  const ancestorText = source.slice(source.indexOf("function ancestorTextMatches"), source.indexOf("function createAnchorControl"));
  const profileHeading = source.slice(source.indexOf("function profileHeadingName()"), source.indexOf("function profileHeadingNameFromHeading"));
  const headingName = source.slice(source.indexOf("function profileHeadingNameFromHeading"), source.indexOf("function normalizeProfileUrl"));
  const helper = source.slice(source.indexOf("function textWithoutHelperControls"), source.indexOf("function passiveCaptureSignature"));

  assert.match(authorName, /const text = textWithoutHelperControls\(link\);/);
  assert.match(placement, /visibleNameElementText\(element\) === normalizedName/);
  assert.match(placement, /const text = visibleNameElementText\(element\);/);
  assert.match(placement, /const text = cleanText\(textWithoutHelperControls\(element\)\);/);
  assert.match(skip, /const text = cleanText\(textWithoutHelperControls\(link\) \|\| name\)\.toLowerCase\(\);/);
  assert.match(ancestorText, /pattern\.test\(cleanText\(textWithoutHelperControls\(current\)\)\)/);
  assert.match(profileHeading, /const heading = document\.querySelector\("main h1"\);/);
  assert.match(profileHeading, /return cleanText\(textWithoutHelperControls\(heading\)\);/);
  assert.match(headingName, /const text = textWithoutHelperControls\(heading\);/);
  assert.match(helper, /const clone = element\.cloneNode\(true\);/);
  assert.match(helper, /clone\.querySelectorAll\("\.lef-anchor, \.lef-popover, \.lef-refresh-banner"\)/);
  assert.match(helper, /helperNode\.remove\(\);/);
  assert.match(helper, /return clone\.innerText \|\| clone\.textContent \|\| "";/);
  assert.doesNotMatch(authorName, /link\.childNodes/);
  assert.doesNotMatch(profileHeading, /document\.querySelector\("main h1"\)\?\.textContent/);
  assert.doesNotMatch(headingName, /heading\.childNodes/);
  assert.doesNotMatch(placement, /element\.textContent/);
  assert.doesNotMatch(ancestorText, /current\.textContent/);
  assert.doesNotMatch(skip, /link\.textContent/);
});

test("LinkedIn profile normalization rejects deceptive non-linkedin hosts", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const normalizeProfile = source.slice(source.indexOf("function normalizeProfileUrl"), source.indexOf("function inferActivityType"));
  const addAuthors = source.slice(source.indexOf("function addAuthorButtons"), source.indexOf("function createAnchorControl"));

  assert.doesNotMatch(source, /const LINKEDIN_PROFILE_RE/);
  assert.match(normalizeProfile, /new URL\(String\(url \|\| ""\), location\.origin\)/);
  assert.match(normalizeProfile, /if \(!isLinkedInHost\(parsed\.hostname\)\) \{\s+return "";\s+\}/);
  assert.match(normalizeProfile, /parsed\.pathname\.match\(\/\^\\\/in\\\/\(\[\^\/\?#\]\+\)\\\/\?\/i\)/);
  assert.match(normalizeProfile, /function isLinkedInHost\(hostname\)/);
  assert.match(normalizeProfile, /cleanHostname === "linkedin\.com" \|\| cleanHostname\.endsWith\("\.linkedin\.com"\)/);
  assert.match(normalizeProfile, /function cleanLinkedInPublicId\(publicId\)/);
  assert.match(normalizeProfile, /\/\[\/\?#\\\\\]\|\\s\/\.test\(cleanPublicId\)/);
  assert.match(addAuthors, /const profileUrl = normalizeProfileUrl\(link\.href\);/);
  assert.match(addAuthors, /if \(!profileUrl\) \{\s+continue;\s+\}/);
  assert.doesNotMatch(normalizeProfile, /String\(url \|\| ""\)\.match\(LINKEDIN_PROFILE_RE\)/);
});

test("offline overlay status clears stale membership styling", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");

  assert.match(source, /button\.classList\.add\("lef-offline"\)/);
  assert.match(source, /button\.classList\.remove\("lef-member"\)/);
  assert.match(source, /Array\.isArray\(status\.feedIds\) \? status\.feedIds\.length : 0/);
});

test("existing overlay buttons refresh after local app connectivity recovers", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const loop = source.slice(source.indexOf("function injectOverlayLoop"), source.indexOf("function markHelperActive"));
  const buttonState = source.slice(source.indexOf("async function updateButtonState"), source.indexOf("async function openPopover"));

  assert.match(loop, /const shouldSweep = shouldSweepOverlayControls\(\);/);
  assert.match(loop, /closeDetachedPopover\(\);\s+removeUnsafeInlineAuthorControls\(\);\s+const shouldSweep = shouldSweepOverlayControls\(\);/);
  assert.match(loop, /if \(shouldSweep\) \{\s+addProfileHeaderButton\(\);\s+addAuthorButtons\(\);\s+markOverlayControlsSwept\(\);\s+\}\s+updateVisibleButtonStates\(\);/);
  assert.match(source, /const STATUS_BUTTON_VIEWPORT_MARGIN_PX = 700;/);
  assert.match(buttonState, /function applyButtonStatus\(button, profileUrl, status\)/);
  assert.match(buttonState, /updateButtonState\(button, normalizedProfileUrl\);/);
  assert.match(buttonState, /function updateVisibleButtonStates\(\)/);
  assert.match(buttonState, /const buttonsByProfileUrl = new Map\(\);/);
  assert.match(buttonState, /for \(const button of document\.querySelectorAll\("\.lef-button"\)\)/);
  assert.match(buttonState, /const profileUrl = normalizeProfileUrl\(button\.dataset\.lefProfileUrl \|\| ""\);/);
  assert.match(buttonState, /if \(!profileUrl \|\| !buttonShouldRefreshStatus\(button\)\) \{\s+continue;\s+\}/);
  assert.match(buttonState, /const entry = buttonsByProfileUrl\.get\(profileUrl\) \|\| \{ buttons: \[\], needsRefresh: false \};/);
  assert.match(buttonState, /entry\.buttons\.push\(button\);/);
  assert.match(buttonState, /entry\.needsRefresh = entry\.needsRefresh \|\| buttonNeedsStatusRefresh\(button\);/);
  assert.match(buttonState, /buttonsByProfileUrl\.set\(profileUrl, entry\);/);
  assert.match(buttonState, /for \(const \[profileUrl, \{ buttons, needsRefresh \}\] of buttonsByProfileUrl\)/);
  assert.match(buttonState, /if \(!needsRefresh\) \{\s+continue;\s+\}/);
  assert.match(buttonState, /profileStatus\(profileUrl, \{ background: true \}\)/);
  assert.match(buttonState, /applyButtonStatus\(button, profileUrl, status\);/);
  assert.match(buttonState, /applyButtonStatus\(button, profileUrl, undefined\);/);
  assert.match(buttonState, /button\.dataset\.lefStatusRefreshedAt = String\(Date\.now\(\)\);/);
  assert.match(buttonState, /function buttonNeedsStatusRefresh\(button\)/);
  assert.match(buttonState, /Date\.now\(\) - refreshedAt >= STATUS_BUTTON_REFRESH_TTL_MS/);
  assert.match(buttonState, /function buttonShouldRefreshStatus\(button\)/);
  assert.match(buttonState, /if \(!button\.isConnected\) \{\s+return false;\s+\}/);
  assert.match(buttonState, /button === state\.activePopoverAnchor \|\| button\.closest\("\.lef-anchor-profile-heading"\)/);
  assert.match(buttonState, /const rect = button\.getBoundingClientRect\(\);/);
  assert.match(buttonState, /const margin = STATUS_BUTTON_VIEWPORT_MARGIN_PX;/);
  assert.match(buttonState, /rect\.bottom >= -margin &&\s+rect\.top <= window\.innerHeight \+ margin &&\s+rect\.right >= -margin &&\s+rect\.left <= window\.innerWidth \+ margin/);
});

test("LinkedIn overlay full sweeps are mutation-aware with a periodic safety fallback", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const boot = source.slice(source.indexOf("function boot"), source.indexOf("function injectOverlayLoop"));
  const loop = source.slice(source.indexOf("function injectOverlayLoop"), source.indexOf("function markHelperActive"));
  const observer = source.slice(source.indexOf("function startOverlayMutationObserver"), source.indexOf("function markHelperActive"));

  assert.match(source, /const OVERLAY_SWEEP_FALLBACK_MS = 30000;/);
  assert.match(source, /overlayObserver: null/);
  assert.match(source, /overlayMutationPending: true/);
  assert.match(source, /lastOverlaySweepAt: 0/);
  assert.match(source, /lastOverlayUrl: ""/);
  assert.match(boot, /startOverlayMutationObserver\(\);/);
  assert.match(loop, /const shouldSweep = shouldSweepOverlayControls\(\);/);
  assert.match(loop, /closeDetachedPopover\(\);\s+removeUnsafeInlineAuthorControls\(\);\s+const shouldSweep = shouldSweepOverlayControls\(\);/);
  assert.match(loop, /if \(shouldSweep\) \{/);
  assert.match(loop, /markOverlayControlsSwept\(\);/);
  assert.match(loop, /updateVisibleButtonStates\(\);/);
  assert.match(observer, /function startOverlayMutationObserver\(\)/);
  assert.match(observer, /typeof MutationObserver === "undefined"/);
  assert.match(observer, /new MutationObserver\(\(records\) => \{/);
  assert.match(observer, /records\.some\(mutationTouchesLinkedInContent\)/);
  assert.match(observer, /state\.overlayMutationPending = true;/);
  assert.match(observer, /state\.overlayObserver\.observe\(root, \{ childList: true, subtree: true \}\);/);
  assert.match(observer, /function mutationTouchesLinkedInContent\(record\)/);
  assert.match(observer, /\[\.\.\.record\.addedNodes, \.\.\.record\.removedNodes\]\.some\(\(node\) => !isHelperMutationNode\(node\)\)/);
  assert.match(observer, /function isHelperMutationNode\(node\)/);
  assert.match(observer, /node\.nodeType !== Node\.ELEMENT_NODE/);
  assert.ok(observer.includes('node.parentElement?.closest?.(".lef-anchor, .lef-author-control-rail, .lef-popover, .lef-refresh-banner")'));
  assert.ok(observer.includes('node.closest?.(".lef-anchor, .lef-author-control-rail, .lef-popover, .lef-refresh-banner")'));
  assert.match(observer, /function shouldSweepOverlayControls\(\)/);
  assert.match(observer, /state\.overlayMutationPending \|\|/);
  assert.match(observer, /state\.lastOverlayUrl !== location\.href \|\|/);
  assert.match(observer, /now - state\.lastOverlaySweepAt >= OVERLAY_SWEEP_FALLBACK_MS/);
  assert.match(observer, /function markOverlayControlsSwept\(\)/);
  assert.match(observer, /state\.overlayMutationPending = false;/);
  assert.match(observer, /state\.lastOverlaySweepAt = Date\.now\(\);/);
  assert.match(observer, /state\.lastOverlayUrl = location\.href;/);
});

test("background extension work is guarded by in-flight state and API cooldown", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const request = source.slice(source.indexOf("async function request"), source.indexOf("async function requestFromBase"));

  assert.match(source, /passiveCaptureRunning: false/);
  assert.match(source, /passiveCaptureTimer: 0/);
  assert.match(source, /pageCanRunPassiveCapture\(\) && !state\.refreshRunning && !state\.passiveCaptureRunning && !backgroundApiInCooldown\(\)/);
  assert.match(source, /state\.passiveCaptureRunning = true/);
  assert.match(source, /state\.passiveCaptureRunning = false/);
  assert.match(source, /BACKGROUND_REQUEST_TIMEOUT_MS = 2500/);
  assert.match(source, /BACKGROUND_WRITE_REQUEST_TIMEOUT_MS = 10000/);
  assert.match(source, /BACKGROUND_API_COOLDOWN_MS/);
  assert.match(source, /state\.apiUnavailableUntil = Date\.now\(\) \+ backgroundCooldownMsForError\(lastError\)/);
  assert.match(source, /function backgroundCooldownMsForError\(error\)/);
  assert.match(source, /const maxRetries = options\.noRetry \|\| \(options\.background && !options\.retryInBackground\) \? 0 : 2/);
  assert.match(source, /options\.timeoutMs \|\| 10000/);
  assert.match(request, /if \(options\.background && !options\.ignoreCooldown && backgroundApiInCooldown\(\)\) \{/);
  assert.ok(request.indexOf("if (attempt < maxRetries)") < request.indexOf("state.apiUnavailableUntil = Date.now() + backgroundCooldownMsForError(lastError)"));
});

test("helper extension writes a live heartbeat marker for desktop probes", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const boot = source.slice(source.indexOf("function boot"), source.indexOf("async function refreshFeeds"));
  const marker = source.slice(source.indexOf("function markHelperActive"), source.indexOf("function captureVisibleActivityLoop"));

  assert.match(source, /const HELPER_VERSION = "\d+\.\d+\.\d+";/);
  assert.match(source, /const HELPER_ACTIVE_ATTRIBUTE = "data-lef-helper-active-at";/);
  assert.match(source, /const HELPER_VERSION_ATTRIBUTE = "data-lef-helper-version";/);
  assert.match(source, /const HELPER_HEARTBEAT_MS = 4000;/);
  assert.match(source, /helperHeartbeatTimer: 0/);
  assert.match(boot, /markHelperActive\(\);/);
  assert.match(boot, /state\.helperHeartbeatTimer = window\.setInterval\(markHelperActive, HELPER_HEARTBEAT_MS\);/);
  assert.match(boot, /startOverlayMutationObserver\(\);/);
  assert.match(boot, /function injectOverlayLoop\(\) \{\s+markHelperActive\(\);/);
  assert.match(marker, /document\.documentElement\.setAttribute\(HELPER_ACTIVE_ATTRIBUTE, String\(Date\.now\(\)\)\);/);
  assert.match(marker, /document\.documentElement\.setAttribute\(HELPER_VERSION_ATTRIBUTE, HELPER_VERSION\);/);
});

test("passive capture only runs from visible tabs with one scheduled timer", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const loop = source.slice(source.indexOf("function captureVisibleActivityLoop"), source.indexOf("async function refreshFeeds"));
  const visibilityListener = source.slice(source.indexOf('document.addEventListener("visibilitychange"'));

  assert.match(source, /function pageCanRunPassiveCapture\(\) \{\s+return document\.visibilityState !== "hidden";\s+\}/);
  assert.match(loop, /clearTimeout\(state\.passiveCaptureTimer\);/);
  assert.match(loop, /state\.passiveCaptureTimer = window\.setTimeout\(captureVisibleActivityLoop, 15000\);/);
  assert.match(visibilityListener, /if \(pageCanRunPassiveCapture\(\)\) \{\s+clearTimeout\(state\.passiveCaptureTimer\);\s+captureVisibleActivityLoop\(\);/);
});

test("extension retries transient local api statuses", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const connectionHelper = source.slice(source.indexOf("function isConnectionError"), source.indexOf("function isRetryableApiStatus"));

  assert.match(source, /MAX_RETRY_AFTER_MS = 10000/);
  assert.match(source, /class RetryableApiStatusError extends Error/);
  assert.match(source, /if \(isRetryableApiStatus\(response\.status\)\) \{\s+throw new RetryableApiStatusError\(message, response\.status, retryAfterDelayMs\(response\.headers\.get\("Retry-After"\)\)\);/);
  assert.match(source, /error instanceof RetryableApiStatusError/);
  assert.match(source, /function isRetryableApiStatus\(status\) \{\s+return status === 408 \|\| status === 429 \|\| status >= 500;/);
  assert.match(source, /const maxRetries = options\.noRetry \|\| \(options\.background && !options\.retryInBackground\) \? 0 : 2/);
  assert.match(source, /await delay\(retryDelayMsForAttempt\(attempt, lastError\)\);/);
  assert.match(source, /function retryDelayMsForAttempt\(attempt, error\)/);
  assert.match(source, /error instanceof RetryableApiStatusError && error\.retryAfterMs !== undefined/);
  assert.match(source, /function backgroundCooldownMsForError\(error\)/);
  assert.match(source, /return BACKGROUND_API_COOLDOWN_MS;/);
  assert.match(source, /function retryAfterDelayMs\(value\)/);
  assert.match(source, /Math\.max\(0, Math\.min\(MAX_RETRY_AFTER_MS, Math\.round\(seconds \* 1000\)\)\)/);
  assert.match(source, /Math\.max\(0, Math\.min\(MAX_RETRY_AFTER_MS, timestamp - Date\.now\(\)\)\)/);
  assert.match(source, /if \(error instanceof RetryableApiStatusError\) \{\s+state\.apiBase = base;\s+break;\s+\}/);
  assert.match(connectionHelper, /isAbortError\(error\)/);
  assert.match(connectionHelper, /function isAbortError\(error\) \{\s+return Boolean\(error && typeof error === "object" && error\.name === "AbortError"\);/);
  assert.doesNotMatch(connectionHelper, /instanceof DOMException/);
  assert.ok(source.indexOf("if (error instanceof RetryableApiStatusError)") < source.indexOf("if (!isConnectionError(error))"));
});

test("extension remembers verified local api base and forgets wrong services", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const startup = source.slice(source.indexOf("const API_BASE_STORAGE_KEY"), source.indexOf("boot();"));
  const request = source.slice(source.indexOf("async function request"), source.indexOf("async function requestFromBase"));
  const helpers = source.slice(source.indexOf("function readRememberedApiBase"), source.indexOf("async function requestFromBase"));

  assert.match(startup, /const API_BASE_STORAGE_KEY = "lefApiBase";/);
  assert.match(startup, /apiBase: readRememberedApiBase\(\) \|\| API_BASES\[0\]/);
  assert.match(request, /state\.apiBase = base;\s+rememberApiBase\(base\);\s+state\.apiUnavailableUntil = 0;/);
  assert.match(request, /if \(error instanceof RecoverableApiBaseError\) \{\s+forgetApiBase\(base\);/);
  assert.match(request, /if \(state\.apiBase === base\) \{\s+state\.apiBase = nextApiBaseAfter\(base\);/);
  assert.match(helpers, /function readRememberedApiBase\(\)/);
  assert.match(helpers, /sessionStorage\.getItem\(API_BASE_STORAGE_KEY\)/);
  assert.match(helpers, /return API_BASES\.includes\(remembered\) \? remembered : "";/);
  assert.match(helpers, /function rememberApiBase\(base\)/);
  assert.match(helpers, /sessionStorage\.setItem\(API_BASE_STORAGE_KEY, base\);/);
  assert.match(helpers, /function forgetApiBase\(base\)/);
  assert.match(helpers, /readRememberedApiBase\(\) !== base/);
  assert.match(helpers, /sessionStorage\.removeItem\(API_BASE_STORAGE_KEY\);/);
  assert.match(helpers, /function nextApiBaseAfter\(base\)/);
  assert.match(helpers, /return API_BASES\[\(index \+ 1\) % API_BASES\.length\] \|\| API_BASES\[0\];/);
});

test("feed list refreshes dedupe safely and ignore stale responses", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const refreshFeeds = source.slice(source.indexOf("async function refreshFeeds"), source.indexOf("function addProfileHeaderButton"));
  const quickCreate = source.slice(source.indexOf("newFeed.addEventListener"), source.indexOf("popover.appendChild(newFeed)"));
  const upsert = source.slice(source.indexOf("function upsertFeedSnapshot"), source.indexOf("async function saveMembership"));

  assert.match(source, /feedRequest: null/);
  assert.match(source, /feedRequestBackground: false/);
  assert.match(source, /feedWriteSequence: 0/);
  assert.match(refreshFeeds, /if \(state\.feedRequest && \(background \|\| !state\.feedRequestBackground\)\) \{\s+return state\.feedRequest;\s+\}/);
  assert.match(refreshFeeds, /const sequence = \+\+state\.feedWriteSequence;/);
  assert.match(refreshFeeds, /\.then\(\(feeds\) => rememberFeeds\(feeds, sequence\)\)/);
  assert.match(refreshFeeds, /if \(state\.feedRequest === feedRequest\) \{\s+state\.feedRequest = null;\s+state\.feedRequestBackground = false;/);
  assert.match(refreshFeeds, /state\.feedRequest = feedRequest;\s+state\.feedRequestBackground = Boolean\(background\);/);
  assert.match(refreshFeeds, /function rememberFeeds\(feeds, sequence = \+\+state\.feedWriteSequence\)/);
  assert.match(refreshFeeds, /if \(sequence < state\.feedWriteSequence\) \{\s+return state\.feeds;\s+\}/);
  assert.match(refreshFeeds, /validate: normalizeFeedSnapshots,/);
  assert.match(refreshFeeds, /state\.feeds = normalizeFeedSnapshots\(feeds\);/);
  assert.match(quickCreate, /rememberFeeds\(upsertFeedSnapshot\(state\.feeds, feed\)\);/);
  assert.match(quickCreate, /validate: normalizeFeedSnapshot,/);
  assert.doesNotMatch(quickCreate, /state\.lastFeedFetchAt = 0;/);
  assert.match(upsert, /const existingIndex = feeds\.findIndex\(\(currentFeed\) => currentFeed\.id === feed\.id\);/);
  assert.match(upsert, /return \[\.\.\.feeds, feed\];/);
});

test("profile status cache expires and stays bounded", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");

  assert.match(source, /STATUS_CACHE_TTL_MS = 60000/);
  assert.match(source, /STATUS_BUTTON_REFRESH_TTL_MS = 15000/);
  assert.match(source, /MAX_STATUS_CACHE_ENTRIES = 300/);
  assert.match(source, /Date\.now\(\) - cached\.fetchedAt < STATUS_CACHE_TTL_MS/);
  assert.match(source, /profileStatus\(person\.profileUrl, \{ force: true \}\)/);
  assert.match(source, /function rememberProfileStatus\(profileUrl, status, sequence = \+\+state\.statusWriteSequence\)/);
  assert.match(source, /const normalizedStatus = normalizeProfileStatus\(status\);/);
  assert.match(source, /state\.statusCache\.set\(normalized, \{ status: normalizedStatus, fetchedAt: Date\.now\(\), sequence \}\)/);
  assert.match(source, /rememberProfileStatus\(normalized, status, sequence\)/);
  assert.match(source, /trimStatusCache\(\)/);
});

test("profile status skips invalid profile urls before local api lookup", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const profileStatus = source.slice(source.indexOf("async function profileStatus"), source.indexOf("function rememberProfileStatus"));

  assert.match(profileStatus, /const normalized = normalizeProfileUrl\(profileUrl\);/);
  assert.match(profileStatus, /if \(!normalized\) \{\s+return \{ feedIds: \[\] \};\s+\}/);
  assert.ok(profileStatus.indexOf("if (!normalized)") < profileStatus.indexOf("state.statusCache.get(normalized)"));
  assert.ok(profileStatus.indexOf("if (!normalized)") < profileStatus.indexOf("request(`/api/profile-status?profileUrl=${encodeURIComponent(normalized)}`"));
});

test("profile status lookups dedupe in-flight requests and ignore stale responses", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const profileStatus = source.slice(source.indexOf("async function profileStatus"), source.indexOf("function startRefreshRunnerFromPage"));
  const rememberStatus = source.slice(source.indexOf("function rememberProfileStatus"), source.indexOf("function startRefreshRunnerFromPage"));

  assert.match(source, /STATUS_BATCH_DELAY_MS = 35/);
  assert.match(source, /STATUS_BATCH_SIZE = 200/);
  assert.match(source, /statusRequests: new Map\(\)/);
  assert.match(source, /statusBatchQueue: new Map\(\)/);
  assert.match(source, /statusBatchTimer: 0/);
  assert.match(source, /statusWriteSequence: 0/);
  assert.match(profileStatus, /if \(!options\.force && state\.statusRequests\.has\(normalized\)\) \{\s+return state\.statusRequests\.get\(normalized\);\s+\}/);
  assert.match(profileStatus, /const sequence = \+\+state\.statusWriteSequence;/);
  assert.match(profileStatus, /if \(!options\.force && options\.background\) \{\s+return enqueueProfileStatusBatch\(normalized, sequence\);\s+\}/);
  assert.match(profileStatus, /\.then\(\(status\) => rememberProfileStatus\(normalized, status, sequence\)\)/);
  assert.match(profileStatus, /if \(state\.statusRequests\.get\(normalized\) === statusRequest\) \{\s+state\.statusRequests\.delete\(normalized\);/);
  assert.match(profileStatus, /if \(!options\.force\) \{\s+state\.statusRequests\.set\(normalized, statusRequest\);/);
  assert.match(profileStatus, /function enqueueProfileStatusBatch\(normalized, sequence\)/);
  assert.match(profileStatus, /state\.statusBatchQueue\.set\(normalized, \{ resolve, reject, sequence \}\);/);
  assert.match(profileStatus, /state\.statusBatchTimer = window\.setTimeout\(flushProfileStatusBatch, STATUS_BATCH_DELAY_MS\);/);
  assert.match(profileStatus, /async function flushProfileStatusBatch\(\)/);
  assert.match(profileStatus, /for \(const chunk of chunkEntries\(entries, STATUS_BATCH_SIZE\)\) \{/);
  assert.match(profileStatus, /const profileUrls = chunk\.map\(\(\[profileUrl\]\) => profileUrl\);/);
  assert.match(profileStatus, /request\("\/api\/profile-statuses", \{\s+method: "POST",\s+body: \{ profileUrls \},\s+background: true,/);
  assert.match(profileStatus, /validate: normalizeProfileStatusMap,/);
  assert.match(profileStatus, /requireProfileStatusBatchEntries\(statuses, profileUrls\);/);
  assert.match(profileStatus, /for \(const \[profileUrl, entry\] of chunk\) \{\s+entry\.resolve\(rememberProfileStatus\(profileUrl, statuses\[profileUrl\], entry\.sequence\)\);/);
  assert.match(profileStatus, /catch \(error\) \{\s+for \(const \[, entry\] of chunk\) \{\s+entry\.reject\(error\);/);
  assert.match(profileStatus, /finally \{\s+for \(const \[profileUrl\] of chunk\) \{\s+state\.statusRequests\.delete\(profileUrl\);/);
  assert.doesNotMatch(profileStatus, /for \(const \[, entry\] of entries\) \{\s+entry\.reject\(error\);/);
  assert.match(profileStatus, /function chunkEntries\(entries, size\)/);
  assert.match(profileStatus, /chunks\.push\(entries\.slice\(index, index \+ size\)\);/);
  assert.match(profileStatus, /function requireProfileStatusBatchEntries\(statuses, profileUrls\)/);
  assert.match(profileStatus, /const requested = new Set\(profileUrls\);/);
  assert.match(profileStatus, /const returned = new Set\(Object\.keys\(statuses \|\| \{\}\)\);/);
  assert.match(profileStatus, /requested\.size !== returned\.size/);
  assert.match(profileStatus, /\[\.\.\.requested\]\.some\(\(profileUrl\) => !returned\.has\(profileUrl\)\)/);
  assert.match(profileStatus, /\[\.\.\.returned\]\.some\(\(profileUrl\) => !requested\.has\(profileUrl\)\)/);
  assert.match(profileStatus, /throw new MalformedApiResponseError\("Profile status batch response was incomplete\."\);/);
  assert.doesNotMatch(profileStatus, /statuses\?\.\[profileUrl\] \|\| \{ feedIds: \[\] \}/);
  assert.match(rememberStatus, /if \(cached && cached\.sequence > sequence\) \{\s+return cached\.status;\s+\}/);
  assert.match(rememberStatus, /return normalizedStatus;/);
});

test("extension validates local api response shapes before caching or continuing refreshes", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const feedHelpers = source.slice(source.indexOf("function boundedFeedPeopleCount"), source.indexOf("function normalizeFeedSnapshots"));
  const validators = source.slice(source.indexOf("function normalizeFeedSnapshots"), source.indexOf("async function saveMembership"));
  const refreshValidators = source.slice(source.indexOf("function normalizeCaptureResult"), source.indexOf("async function captureItemsForFeeds"));
  const requestFromBase = source.slice(source.indexOf("async function requestFromBase"), source.indexOf("function backgroundApiInCooldown"));
  const refreshRunner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("function continueRefreshSession"));
  const poll = source.slice(source.indexOf("async function pollScheduledRefreshSession"), source.indexOf("function refreshSessionResumeSignature"));
  const capture = source.slice(source.indexOf("async function captureItemsForFeeds"), source.indexOf("async function request"));

  assert.match(validators, /function normalizeFeedSnapshots\(value\)/);
  assert.match(validators, /throw new MalformedApiResponseError\("Feed list response was malformed\."\);/);
  assert.match(validators, /const feeds = value\.map\(normalizeFeedSnapshot\);/);
  assert.match(validators, /const feedIds = feeds\.map\(\(feed\) => feed\.id\);/);
  assert.match(validators, /if \(new Set\(feedIds\)\.size !== feedIds\.length\) \{\s+throw new MalformedApiResponseError\("Feed list response has duplicate feed ids\."\);/);
  assert.match(validators, /return feeds;/);
  assert.match(validators, /function normalizeFeedSnapshot\(value\)/);
  assert.match(validators, /requireNonEmptyString\(value, "id", "feed"\);/);
  assert.match(validators, /requireNonEmptyString\(value, "name", "feed"\);/);
  assert.match(validators, /lookbackDays: requireIntegerInRange\(value, "lookbackDays", "feed", 1, 365\),/);
  assert.match(validators, /peopleCount: requireFeedPeopleCount\(value\.peopleCount\),/);
  assert.match(feedHelpers, /function requireFeedPeopleCount\(value\)/);
  assert.match(feedHelpers, /!isSafeInteger\(value\) \|\| value < 0 \|\| value > MAX_PEOPLE_PER_FEED/);
  assert.match(feedHelpers, /throw new MalformedApiResponseError\("Feed response has an invalid people count\."\);/);
  assert.match(validators, /function normalizeProfileStatus\(value\)/);
  assert.match(validators, /!Array\.isArray\(value\.feedIds\)/);
  assert.match(validators, /value\.feedIds\.some\(\(feedId\) => typeof feedId !== "string" \|\| !feedId\.trim\(\) \|\| feedId !== feedId\.trim\(\)\)/);
  assert.match(validators, /new Set\(value\.feedIds\)\.size !== value\.feedIds\.length/);
  assert.match(validators, /throw new MalformedApiResponseError\("Profile status response has invalid feed ids\."\);/);
  assert.match(validators, /feedIds: value\.feedIds/);
  assert.doesNotMatch(validators, /feedIds: \[\.\.\.new Set\(value\.feedIds\)\]/);
  assert.doesNotMatch(validators, /value\.feedIds\.filter\(\(feedId\) => typeof feedId === "string" && feedId\)/);
  assert.match(validators, /function normalizeProfileStatusMap\(value\)/);
  assert.match(validators, /const seenProfileUrls = new Set\(\);/);
  assert.match(validators, /const normalizedProfileUrl = normalizeProfileUrl\(profileUrl\);/);
  assert.match(validators, /!normalizedProfileUrl \|\| normalizedProfileUrl !== profileUrl \|\| seenProfileUrls\.has\(normalizedProfileUrl\)/);
  assert.match(validators, /throw new MalformedApiResponseError\("Profile status batch response has invalid profile urls\."\);/);
  assert.match(validators, /seenProfileUrls\.add\(normalizedProfileUrl\);/);
  assert.match(validators, /statuses\[normalizedProfileUrl\] = normalizeProfileStatus\(status\);/);
  assert.match(refreshValidators, /function normalizeCaptureResult\(value\)/);
  assert.match(refreshValidators, /received: requireNonNegativeInteger\(result, "received", "capture result"\)/);
  assert.match(refreshValidators, /skippedInvalid: requireNonNegativeInteger\(result, "skippedInvalid", "capture result"\)/);
  assert.match(refreshValidators, /for \(const \[key, count\] of Object\.entries\(normalized\)\) \{/);
  assert.match(refreshValidators, /if \(key !== "received" && count > normalized\.received\) \{/);
  assert.match(refreshValidators, /throw new MalformedApiResponseError\(`capture result response has impossible \$\{key\}\.`\);/);
  assert.match(refreshValidators, /const processed =\s+normalized\.inserted \+\s+normalized\.updated \+\s+normalized\.skippedOlder \+\s+normalized\.skippedUntracked \+\s+normalized\.skippedInvalid;/);
  assert.match(refreshValidators, /if \(processed > normalized\.received\) \{\s+throw new MalformedApiResponseError\("capture result response has impossible aggregate counts\."\);/);
  assert.match(refreshValidators, /return normalized;/);
  assert.match(refreshValidators, /function normalizeActiveRefreshSession\(value\)/);
  assert.match(refreshValidators, /if \(session\.active === false\) \{\s+return session;\s+\}/);
  assert.match(refreshValidators, /return normalizeRefreshSession\(session\);/);
  assert.match(refreshValidators, /function normalizeRefreshSession\(value\)/);
  assert.match(refreshValidators, /for \(const key of \["id", "feedId", "feedName"\]\) \{\s+requireNonEmptyString\(session, key, "refresh session"\);/);
  assert.match(refreshValidators, /for \(const key of \["lookbackCutoffAt", "createdAt", "updatedAt"\]\) \{\s+requireDateString\(session, key, "refresh session"\);/);
  assert.match(refreshValidators, /for \(const key of \["lastError", "nextDelayReason"\]\) \{\s+requireString\(session, key, "refresh session"\);/);
  assert.match(refreshValidators, /\["running", "done", "canceled", "failed"\]\.includes\(session\.status\)/);
  assert.match(refreshValidators, /requireIntegerInRange\(session, "lookbackDays", "refresh session", 1, 365\);/);
  assert.match(refreshValidators, /"currentAttempt",/);
  assert.match(refreshValidators, /"maxAttempts",/);
  assert.doesNotMatch(refreshValidators, /"lookbackDays",\s+"totalTargets"/);
  assert.match(refreshValidators, /requireNonNegativeInteger\(session, key, "refresh session"\);/);
  assert.match(refreshValidators, /const totalTargets = session\.totalTargets;/);
  assert.match(refreshValidators, /const completedTargets = session\.completedTargets;/);
  assert.match(refreshValidators, /const failedTargets = session\.failedTargets;/);
  assert.match(refreshValidators, /if \(completedTargets > totalTargets \|\| failedTargets > completedTargets\) \{\s+throw new MalformedApiResponseError\("Refresh session response has inconsistent progress\."\);/);
  assert.match(refreshValidators, /if \(currentAttempt < 1 \|\| maxAttempts < 1 \|\| currentAttempt > maxAttempts\) \{\s+throw new MalformedApiResponseError\("Refresh session response has inconsistent retry state\."\);/);
  assert.match(refreshValidators, /if \(\(status === "done" \|\| status === "failed"\) && completedTargets !== totalTargets\) \{\s+throw new MalformedApiResponseError\("Refresh session response has an impossible finished progress state\."\);/);
  assert.match(refreshValidators, /let currentTarget;/);
  assert.match(refreshValidators, /if \(session\.currentTarget !== undefined\) \{\s+currentTarget = normalizeRefreshTarget\(session\.currentTarget\);/);
  assert.match(refreshValidators, /if \(currentTarget\.index >= totalTargets\) \{\s+throw new MalformedApiResponseError\("Refresh session response has an out-of-range current target\."\);/);
  assert.match(refreshValidators, /if \(status === "running"\) \{/);
  assert.match(refreshValidators, /!currentTarget \|\| currentTarget\.index !== completedTargets/);
  assert.match(refreshValidators, /!refreshUrlMatchesTarget\(session\.nextUrl, currentTarget, \{ sessionId: session\.id, targetIndex: currentTarget\.index \}\)/);
  assert.match(refreshValidators, /throw new MalformedApiResponseError\("Refresh session response has stale navigation details\."\);/);
  assert.match(refreshValidators, /function normalizeRefreshTarget\(value\)/);
  assert.match(refreshValidators, /requireNonNegativeInteger\(target, "index", "refresh target"\);/);
  assert.match(refreshValidators, /for \(const key of \["personId", "personName", "profileUrl", "url"\]\) \{\s+requireNonEmptyString\(target, key, "refresh target"\);/);
  assert.match(refreshValidators, /target\.kind !== "posts" && target\.kind !== "comments"/);
  assert.match(refreshValidators, /if \(!refreshUrlMatchesTarget\(target\.url, target\)\)/);
  assert.match(refreshValidators, /function refreshUrlMatchesTarget\(url, target, options = \{\}\)/);
  assert.match(refreshValidators, /parsed\.searchParams\.get\("lefSession"\) !== options\.sessionId/);
  assert.match(refreshValidators, /parsed\.searchParams\.get\("lefTarget"\) !== String\(options\.targetIndex\)/);
  assert.match(refreshValidators, /function refreshActivityKindFromPath\(pathname\)/);
  assert.match(refreshValidators, /function requireRecord\(value, context\)/);
  assert.match(refreshValidators, /function requireNonEmptyString\(record, key, context\)/);
  assert.match(refreshValidators, /const value = requireString\(record, key, context\);\s+if \(!value\.trim\(\)\)/);
  assert.match(refreshValidators, /function requireDateString\(record, key, context\)/);
  assert.match(refreshValidators, /const value = requireNonEmptyString\(record, key, context\);\s+if \(!Number\.isFinite\(new Date\(value\)\.getTime\(\)\)\) \{/);
  assert.match(refreshValidators, /function requireNonNegativeInteger\(record, key, context\)/);
  assert.match(refreshValidators, /function requireIntegerInRange\(record, key, context, minimum, maximum\)/);
  assert.match(refreshValidators, /!isSafeInteger\(value\) \|\| value < 0/);
  assert.match(refreshValidators, /!isSafeInteger\(value\) \|\| value < minimum \|\| value > maximum/);
  assert.match(refreshValidators, /function isSafeInteger\(value\) \{\s+return typeof value === "number" && Number\.isSafeInteger\(value\);/);
  assert.doesNotMatch(refreshValidators, /Number\.isInteger\(value\)/);
  assert.match(requestFromBase, /return options\.validate \? options\.validate\(data\) : data;/);
  assert.match(source, /class MalformedApiResponseError extends RecoverableApiBaseError/);
  assert.match(refreshRunner, /validate: normalizeActiveRefreshSession,/);
  assert.match(refreshRunner, /validate: normalizeRefreshSession,/);
  assert.match(poll, /validate: normalizeActiveRefreshSession,/);
  assert.match(capture, /validate: normalizeCaptureResult,/);
});

test("membership popover reuses saved status for button updates", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));

  assert.match(popover, /const nextStatus = await saveMembership\(person, \[\.\.\.selected\], \[\.\.\.knownFeedIds\]\);/);
  assert.match(popover, /rememberProfileStatus\(person\.profileUrl, nextStatus\);\s+updateProfileControls\(person\.profileUrl\);/);
  assert.doesNotMatch(popover, /state\.statusCache\.delete\(normalizeProfileUrl\(person\.profileUrl\)\);/);
});

test("membership popover ignores stale opens and outside clicks cancel pending opens", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));
  const clickHandler = source.slice(source.indexOf('document.addEventListener("click"'));

  assert.match(source, /popoverOpening: false/);
  assert.match(source, /popoverRequestSequence: 0/);
  assert.match(source, /activePopoverAnchor: null/);
  assert.match(popover, /closeActivePopover\(\{ cancelPending: false \}\);/);
  assert.match(popover, /const popoverRequestId = \+\+state\.popoverRequestSequence;/);
  assert.match(popover, /state\.popoverOpening = true;/);
  assert.match(popover, /if \(!popoverRequestIsCurrent\(popoverRequestId, anchor\)\) \{\s+finishPopoverOpening\(popoverRequestId\);\s+return;\s+\}/);
  assert.match(popover, /state\.popoverOpening = false;\s+document\.body\.appendChild\(popover\);\s+state\.activePopover = popover;\s+state\.activePopoverAnchor = anchor;/);
  assert.match(popover, /function popoverRequestIsCurrent\(requestId, anchor\) \{\s+return requestId === state\.popoverRequestSequence && anchor\.isConnected;\s+\}/);
  assert.match(popover, /function finishPopoverOpening\(requestId\) \{\s+if \(requestId === state\.popoverRequestSequence\) \{\s+state\.popoverOpening = false;/);
  assert.match(clickHandler, /\(state\.activePopover \|\| state\.popoverOpening\) && !state\.activePopover\?\.contains\(event\.target\)/);
  assert.match(clickHandler, /closeActivePopover\(\);/);
  assert.match(popover, /function closeActivePopover\(\{ cancelPending = true \} = \{\}\) \{/);
  assert.match(popover, /state\.popoverRequestSequence \+= 1;/);
  assert.match(popover, /state\.activePopoverAnchor = null;/);
});

test("membership popover ignores stale async save responses", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));

  assert.match(source, /function popoverActionIsCurrent\(requestId, popover, anchor\) \{/);
  assert.match(source, /return popoverRequestIsCurrent\(requestId, anchor\) && state\.activePopover === popover && popover\.isConnected;/);
  assert.match(
    popover,
    /const nextStatus = await saveMembership\(person, \[\.\.\.selected\], \[\.\.\.knownFeedIds\]\);\s+if \(!popoverActionIsCurrent\(popoverRequestId, popover, anchor\)\) \{\s+return;\s+\}\s+reconcileSelectedFeeds\(nextStatus\);/,
  );
  assert.match(
    popover,
    /catch \(nextError\) \{\s+if \(!popoverActionIsCurrent\(popoverRequestId, popover, anchor\)\) \{\s+return;\s+\}/,
  );
  assert.match(
    popover,
    /finally \{\s+if \(popoverActionIsCurrent\(popoverRequestId, popover, anchor\)\) \{\s+setPopoverBusy\(false\);/,
  );
});

test("membership popover closes when LinkedIn detaches its anchor", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const loop = source.slice(source.indexOf("function injectOverlayLoop"), source.indexOf("function captureVisibleActivityLoop"));
  const popover = source.slice(source.indexOf("function closeActivePopover"), source.indexOf("function upsertFeedSnapshot"));

  assert.match(loop, /closeDetachedPopover\(\);\s+removeUnsafeInlineAuthorControls\(\);\s+const shouldSweep = shouldSweepOverlayControls\(\);/);
  assert.match(loop, /if \(shouldSweep\) \{\s+addProfileHeaderButton\(\);\s+addAuthorButtons\(\);\s+markOverlayControlsSwept\(\);\s+\}\s+updateVisibleButtonStates\(\);\s+refreshFeeds/);
  assert.match(loop, /\.then\(\(\) => \{\s+closeDetachedPopover\(\);\s+if \(shouldSweepOverlayControls\(\)\) \{/);
  assert.match(loop, /addProfileHeaderButton\(\);\s+addAuthorButtons\(\);/);
  assert.match(popover, /function closeDetachedPopover\(\) \{/);
  assert.match(popover, /state\.activePopover && \(!state\.activePopover\.isConnected \|\| !state\.activePopoverAnchor\?\.isConnected\)/);
  assert.match(popover, /closeActivePopover\(\);/);
});

test("membership popover reconciles checkbox state from saved status", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));

  assert.match(popover, /const reconcileSelectedFeeds = \(nextStatus\) => \{/);
  assert.match(popover, /if \(!nextStatus \|\| !Array\.isArray\(nextStatus\.feedIds\)\) \{\s+return;\s+\}/);
  assert.match(popover, /selected\.clear\(\);/);
  assert.match(popover, /for \(const feedId of nextStatus\.feedIds\.filter\(Boolean\)\) \{\s+selected\.add\(feedId\);/);
  assert.match(popover, /checkbox\.dataset\.lefFeedId = feed\.id;/);
  assert.match(popover, /checkbox\.checked = selected\.has\(checkbox\.dataset\.lefFeedId\);/);
  assert.match(popover, /reconcileSelectedFeeds\(nextStatus\);\s+updateFeedCountsForMembershipChange\(previousFeedIds, nextStatus\.feedIds\);/);
  assert.match(popover, /rememberProfileStatus\(person\.profileUrl, nextStatus\);\s+updateProfileControls\(person\.profileUrl\);/);
});

test("membership popover refreshes cached feed counts after saved status", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));
  const helper = source.slice(source.indexOf("function updateFeedCountsForMembershipChange"), source.indexOf("async function saveMembership"));

  assert.match(popover, /const refreshPopoverFeedRows = \(\) => \{/);
  assert.match(popover, /const previousFeedIds = \[\.\.\.selected\];/);
  assert.match(popover, /updateFeedCountsForMembershipChange\(previousFeedIds, nextStatus\.feedIds\);\s+refreshPopoverFeedRows\(\);/);
  assert.match(popover, /const countLabel = document\.createElement\("span"\);/);
  assert.match(popover, /countLabel\.className = "lef-feed-count";/);
  assert.match(popover, /countLabel\.textContent = `\$\{feed\.name\} \(\$\{boundedFeedPeopleCount\(feed\.peopleCount\)\}\/\$\{MAX_PEOPLE_PER_FEED\}\)`;/);
  assert.match(helper, /const previous = new Set\(previousFeedIds\.filter\(Boolean\)\);/);
  assert.match(helper, /const next = new Set\(nextFeedIds\.filter\(Boolean\)\);/);
  assert.match(helper, /state\.feeds = state\.feeds\.map\(\(feed\) => \{/);
  assert.match(helper, /const currentCount = boundedFeedPeopleCount\(feed\.peopleCount\);/);
  assert.match(helper, /const peopleCount = boundedFeedPeopleCount\(currentCount \+ \(isMember \? 1 : -1\)\);/);
  assert.match(helper, /state\.lastFeedFetchAt = 0;/);
});

test("membership popover bounds optimistic feed counts to valid capacity", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const helper = source.slice(source.indexOf("function updateFeedCountsForMembershipChange"), source.indexOf("async function saveMembership"));

  assert.match(source, /const MAX_PEOPLE_PER_FEED = 200;/);
  assert.match(helper, /function boundedFeedPeopleCount\(value\)/);
  assert.match(helper, /if \(!Number\.isFinite\(count\)\) \{\s+return 0;\s+\}/);
  assert.match(helper, /return Math\.max\(0, Math\.min\(MAX_PEOPLE_PER_FEED, Math\.round\(count\)\)\);/);
  assert.doesNotMatch(helper, /peopleCount: boundedFeedPeopleCount\(value\.peopleCount\)/);
  assert.doesNotMatch(helper, /Math\.max\(0, currentCount \+ \(isMember \? 1 : -1\)\)/);
});

test("membership popover disables adding to full feeds but still permits removal", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));

  assert.match(popover, /checkbox\.dataset\.lefFeedFull = String\(boundedFeedPeopleCount\(feed\.peopleCount\) >= MAX_PEOPLE_PER_FEED\);/);
  assert.match(popover, /const fullFeedAddBlocked = control\.dataset\.lefFeedFull === "true" && !control\.checked;/);
  assert.match(popover, /busy \|\| fullFeedAddBlocked \|\| \(control\.dataset\.lefRequiresPopoverReady === "true" && !popoverReady\)/);
  assert.match(popover, /checkbox\.disabled = !popoverReady \|\| \(checkbox\.dataset\.lefFeedFull === "true" && !checkbox\.checked\);/);
  assert.match(popover, /This feed is full\. Remove someone before adding a new profile\./);
});

test("membership popover does not overwrite feeds when status loading fails", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");

  assert.doesNotMatch(source, /profileStatus\(person\.profileUrl, \{ force: true \}\)\.catch\(\(\) => \(\{ feedIds: \[\] \}\)\)/);
  assert.match(source, /membershipStatusLoaded = status && Array\.isArray\(status\.feedIds\)/);
  assert.match(source, /const popoverReady = feedListLoaded && membershipStatusLoaded;/);
  assert.match(source, /membershipStatusLoaded \? status\.feedIds : \[\]/);
  assert.match(source, /const knownFeedIds = new Set\(popoverReady \? state\.feeds\.map\(\(feed\) => feed\.id\)\.filter\(Boolean\) : \[\]\)/);
  assert.match(source, /saveMembership\(person, \[\.\.\.selected\], \[\.\.\.knownFeedIds\]\)/);
  assert.match(source, /dataset\.lefRequiresPopoverReady = "true"/);
  assert.match(source, /busy \|\| fullFeedAddBlocked \|\| \(control\.dataset\.lefRequiresPopoverReady === "true" && !popoverReady\)/);
  assert.match(source, /if \(!popoverReady\) \{/);
});

test("membership popover disables writes when the feed list fails to load", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));
  const quickCreate = popover.slice(popover.indexOf("newFeed.addEventListener"), popover.indexOf("popover.appendChild(newFeed)"));

  assert.match(popover, /let feedLoadError = "";/);
  assert.match(popover, /try \{\s+await refreshFeeds\(\);\s+\} catch \(nextError\) \{\s+feedLoadError = errorMessage\(nextError\);/);
  assert.match(popover, /const feedListLoaded = !feedLoadError;/);
  assert.match(popover, /const popoverReady = feedListLoaded && membershipStatusLoaded;/);
  assert.match(popover, /const knownFeedIds = new Set\(popoverReady \? state\.feeds\.map\(\(feed\) => feed\.id\)\.filter\(Boolean\) : \[\]\)/);
  assert.match(popover, /checkbox\.dataset\.lefRequiresPopoverReady = "true";/);
  assert.match(popover, /checkbox\.disabled = !popoverReady \|\| \(checkbox\.dataset\.lefFeedFull === "true" && !checkbox\.checked\);/);
  assert.match(popover, /control\.dataset\.lefRequiresPopoverReady = "true";\s+control\.disabled = !popoverReady;/);
  assert.match(quickCreate, /if \(!popoverReady\) \{\s+error\.textContent = \[feedLoadError, membershipLoadError\]\.filter\(Boolean\)\.join\(" "\) \|\| "Could not load current feed data\.";\s+return;\s+\}/);
});

test("membership popover can remove feeds changed during the same popover session", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));
  const quickCreate = popover.slice(popover.indexOf("newFeed.addEventListener"), popover.indexOf("popover.appendChild(newFeed)"));

  assert.match(popover, /const knownFeedIds = new Set\(popoverReady \? state\.feeds\.map\(\(feed\) => feed\.id\)\.filter\(Boolean\) : \[\]\)/);
  assert.match(popover, /await saveMembership\(person, \[\.\.\.selected\], \[\.\.\.knownFeedIds\]\);/);
  assert.match(quickCreate, /selected\.add\(feed\.id\);/);
  assert.match(quickCreate, /knownFeedIds\.add\(feed\.id\);/);
  assert.ok(quickCreate.indexOf("knownFeedIds.add(feed.id);") < quickCreate.indexOf("await saveMembership"));
});

test("membership popover blocks quick-create add attempts for existing full feeds", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));
  const quickCreate = popover.slice(popover.indexOf("newFeed.addEventListener"), popover.indexOf("popover.appendChild(newFeed)"));

  assert.match(quickCreate, /const requestId = createClientRequestId\(\);/);
  assert.match(
    quickCreate,
    /const feed = await request\("\/api\/feeds\/get-or-create", \{\s+method: "POST",\s+body: \{ name, lookbackDays: 15, requestId \},\s+validate: normalizeFeedSnapshot,\s+\}\);/,
  );
  assert.match(quickCreate, /rememberFeeds\(upsertFeedSnapshot\(state\.feeds, feed\)\);/);
  assert.match(
    quickCreate,
    /if \(boundedFeedPeopleCount\(feed\.peopleCount\) >= MAX_PEOPLE_PER_FEED && !selected\.has\(feed\.id\)\) \{\s+refreshPopoverFeedRows\(\);\s+error\.textContent = `"\$\{feed\.name\}" already has \$\{MAX_PEOPLE_PER_FEED\} people\. Remove someone before adding a new profile\.`;\s+return;\s+\}/,
  );
  assert.ok(quickCreate.indexOf("already has ${MAX_PEOPLE_PER_FEED} people") < quickCreate.indexOf("selected.add(feed.id);"));
  assert.ok(quickCreate.indexOf("already has ${MAX_PEOPLE_PER_FEED} people") < quickCreate.indexOf("await saveMembership"));
});

test("quick-create ignores stale popover responses", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));
  const quickCreate = popover.slice(popover.indexOf("newFeed.addEventListener"), popover.indexOf("popover.appendChild(newFeed)"));

  assert.match(
    quickCreate,
    /const requestId = createClientRequestId\(\);\s+const feed = await request\("\/api\/feeds\/get-or-create", \{\s+method: "POST",\s+body: \{ name, lookbackDays: 15, requestId \},\s+validate: normalizeFeedSnapshot,\s+\}\);\s+if \(!popoverActionIsCurrent\(popoverRequestId, popover, anchor\)\) \{\s+return;\s+\}\s+rememberFeeds/,
  );
  assert.match(
    quickCreate,
    /const nextStatus = await saveMembership\(person, \[\.\.\.selected\], \[\.\.\.knownFeedIds\]\);\s+if \(!popoverActionIsCurrent\(popoverRequestId, popover, anchor\)\) \{\s+return;\s+\}\s+reconcileSelectedFeeds\(nextStatus\);/,
  );
  assert.match(
    quickCreate,
    /catch \(nextError\) \{\s+if \(!popoverActionIsCurrent\(popoverRequestId, popover, anchor\)\) \{\s+return;\s+\}/,
  );
  assert.match(quickCreate, /error\.textContent = errorMessage\(nextError\);/);
});

test("quick-create keeps created feeds retryable when membership save fails", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const popover = source.slice(source.indexOf("async function openPopover"), source.indexOf("async function saveMembership"));
  const quickCreate = popover.slice(popover.indexOf("newFeed.addEventListener"), popover.indexOf("popover.appendChild(newFeed)"));

  assert.match(popover, /const feedRowExists = \(feedId\) =>\s+\[\.\.\.popover\.querySelectorAll\('input\[type="checkbox"\]\[data-lef-feed-id\]'\)\]\.some\(/);
  assert.match(popover, /\(checkbox\) => checkbox\.dataset\.lefFeedId === feedId,/);
  assert.match(popover, /const renderFeedRow = \(feed\) => \{/);
  assert.match(popover, /checkbox\.addEventListener\("change", async \(\) => \{/);
  assert.match(popover, /const appendFeedRow = \(feed, beforeNode\) => \{/);
  assert.match(popover, /if \(!feed\?\.id \|\| feedRowExists\(feed\.id\)\) \{\s+return;\s+\}/);
  assert.match(popover, /popover\.insertBefore\(renderFeedRow\(feed\), beforeNode \|\| null\);/);
  assert.match(popover, /for \(const feed of state\.feeds\) \{\s+appendFeedRow\(feed\);\s+\}/);
  assert.match(quickCreate, /rememberFeeds\(upsertFeedSnapshot\(state\.feeds, feed\)\);\s+appendFeedRow\(feed, newFeed\);/);
  assert.ok(quickCreate.indexOf("appendFeedRow(feed, newFeed);") < quickCreate.indexOf("already has ${MAX_PEOPLE_PER_FEED} people"));
  assert.match(quickCreate, /let previousFeedIds = \[\];\s+let attemptedFeedId = "";/);
  assert.match(quickCreate, /previousFeedIds = \[\.\.\.selected\];\s+selected\.add\(feed\.id\);\s+attemptedFeedId = feed\.id;/);
  assert.match(
    quickCreate,
    /if \(attemptedFeedId\) \{\s+selected\.clear\(\);\s+for \(const feedId of previousFeedIds\) \{\s+selected\.add\(feedId\);\s+\}\s+reconcileSelectedFeeds\(\{ feedIds: previousFeedIds \}\);/,
  );
  assert.doesNotMatch(source, /function cssEscape/);
});

test("passive capture writes to every feed membership for the visible profile", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");

  assert.match(source, /inferActiveFeedIds/);
  assert.match(source, /activeFeedIds\.length === 0/);
  assert.match(source, /captureItemsForFeeds\(activeFeedIds, items, options\)/);
  assert.match(source, /\/api\/capture-items\/multi/);
  assert.match(source, /\[\.\.\.new Set\(status\.feedIds\.filter\(Boolean\)\)\]/);
});

test("passive capture skips recently successful identical snapshots", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureVisibleActivity"), source.indexOf("function visibleActivityContainers"));
  const helpers = source.slice(source.indexOf("function passiveCaptureSignature"), source.indexOf("function escapeHtml"));

  assert.match(source, /const PASSIVE_CAPTURE_SIGNATURE_TTL_MS = 5 \* 60 \* 1000;/);
  assert.match(source, /lastPassiveCaptureSignature: "",/);
  assert.match(source, /lastPassiveCaptureAt: 0,/);
  assert.match(capture, /const passiveSignature = passiveCaptureSignature\(activeFeedIds, items, options\);/);
  assert.match(capture, /if \(passiveSignature && passiveCaptureRecentlySucceeded\(passiveSignature\)\) \{\s+return emptyCaptureResult\(\);\s+\}/);
  assert.match(capture, /const result = await captureItemsForFeeds\(activeFeedIds, items, options\);/);
  assert.match(capture, /if \(passiveSignature\) \{\s+rememberPassiveCaptureSignature\(passiveSignature\);\s+\}/);
  assert.ok(capture.indexOf("const result = await captureItemsForFeeds") < capture.indexOf("rememberPassiveCaptureSignature(passiveSignature);"));
  assert.match(helpers, /if \(options\.reason !== "passive"\) \{\s+return "";\s+\}/);
  assert.match(helpers, /\[\.\.\.new Set\(feedIds\.filter\(Boolean\)\)\]\.sort\(\)\.join\(","\)/);
  assert.match(helpers, /String\(item\.activityAt \|\| ""\)\.slice\(0, 10\)/);
  assert.match(helpers, /hash\(item\.text\)/);
  assert.match(helpers, /state\.lastPassiveCaptureSignature === signature/);
  assert.match(helpers, /Date\.now\(\) - state\.lastPassiveCaptureAt < PASSIVE_CAPTURE_SIGNATURE_TTL_MS/);
  assert.match(helpers, /state\.lastPassiveCaptureSignature = signature;/);
  assert.match(helpers, /state\.lastPassiveCaptureAt = Date\.now\(\);/);
});

test("capture writes carry a stable idempotency key through request retries", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureItemsForFeeds"), source.indexOf("async function request"));

  assert.match(source, /function createClientRequestId\(\)/);
  assert.match(source, /browserCrypto\.randomUUID/);
  assert.match(capture, /const requestId = createClientRequestId\(\);/);
  assert.match(capture, /requestId,/);
  assert.doesNotMatch(capture, /requestId: createClientRequestId\(\)/);
});

test("extension retry request ids use browser crypto instead of math random", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const requestIdHelpers = source.slice(source.indexOf("let lastResortClientRequestCounter"), source.indexOf("function emptyCaptureResult"));

  assert.match(requestIdHelpers, /let lastResortClientRequestCounter = 0;/);
  assert.match(requestIdHelpers, /const browserCrypto = globalThis\.crypto;/);
  assert.match(requestIdHelpers, /browserCrypto\?\.randomUUID/);
  assert.match(requestIdHelpers, /return `req_\$\{browserCrypto\.randomUUID\(\)\}`;/);
  assert.match(requestIdHelpers, /browserCrypto\?\.getRandomValues/);
  assert.match(requestIdHelpers, /browserCrypto\.getRandomValues\(bytes\);/);
  assert.match(requestIdHelpers, /bytes\[6\] = \(bytes\[6\] & 0x0f\) \| 0x40;/);
  assert.match(requestIdHelpers, /bytes\[8\] = \(bytes\[8\] & 0x3f\) \| 0x80;/);
  assert.match(requestIdHelpers, /function formatClientRequestUuidBytes\(bytes\)/);
  assert.match(requestIdHelpers, /lastResortClientRequestCounter = \(lastResortClientRequestCounter \+ 1\) % Number\.MAX_SAFE_INTEGER;/);
  assert.doesNotMatch(requestIdHelpers, /Math\.random/);
});

test("capture writes chunk oversized snapshots before local api overflow", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureItemsForFeeds"), source.indexOf("async function request"));

  assert.match(source, /const MAX_CAPTURE_ITEMS_PER_REQUEST = 120;/);
  assert.match(capture, /const itemChunks = chunkCapturedItems\(items\);/);
  assert.match(capture, /const feedIdChunks = chunkCapturedFeedIds\(feedIds\);/);
  assert.match(capture, /if \(itemChunks\.length === 0 \|\| feedIdChunks\.length === 0\) \{\s+return emptyCaptureResult\(\);\s+\}/);
  assert.match(capture, /const results = \[\];\s+for \(const feedIdChunk of feedIdChunks\) \{\s+for \(const itemChunk of itemChunks\) \{\s+results\.push\(await captureItemsChunkForFeeds\(feedIdChunk, itemChunk, options\)\);/);
  assert.match(capture, /return aggregateCaptureResults\(results\);/);
  assert.match(capture, /async function captureItemsChunkForFeeds\(feedIds, items, options = \{\}\) \{/);
  assert.match(capture, /const requestId = createClientRequestId\(\);/);
  assert.match(capture, /function chunkCapturedItems\(items\) \{/);
  assert.match(capture, /for \(let index = 0; index < items\.length; index \+= MAX_CAPTURE_ITEMS_PER_REQUEST\) \{/);
  assert.match(capture, /items\.slice\(index, index \+ MAX_CAPTURE_ITEMS_PER_REQUEST\)/);
  assert.match(capture, /function aggregateCaptureResults\(results\) \{/);
  for (const key of ["received", "inserted", "updated", "skippedOlder", "skippedUntracked", "skippedInvalid"]) {
    assert.match(capture, new RegExp(`summary\\.${key} \\+= result\\.${key};`));
  }
  assert.match(capture, /\}, emptyCaptureResult\(\)\);/);
  assert.doesNotMatch(capture, /items\.slice\(0, MAX_CAPTURE_ITEMS_PER_REQUEST\)/);
});

test("capture writes chunk oversized feed fan-out before local api overflow", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureItemsForFeeds"), source.indexOf("async function request"));

  assert.match(source, /const MAX_CAPTURE_FEEDS_PER_REQUEST = 20;/);
  assert.match(capture, /const feedIdChunks = chunkCapturedFeedIds\(feedIds\);/);
  assert.match(capture, /function chunkCapturedFeedIds\(feedIds\) \{/);
  assert.match(capture, /const uniqueFeedIds = \[\.\.\.new Set\(feedIds\.filter\(Boolean\)\)\];/);
  assert.match(capture, /for \(let index = 0; index < uniqueFeedIds\.length; index \+= MAX_CAPTURE_FEEDS_PER_REQUEST\) \{/);
  assert.match(capture, /uniqueFeedIds\.slice\(index, index \+ MAX_CAPTURE_FEEDS_PER_REQUEST\)/);
  assert.match(capture, /captureItemsChunkForFeeds\(feedIdChunk, itemChunk, options\)/);
});

test("background capture writes retry without letting cooldown block the retry", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureItemsForFeeds"), source.indexOf("async function request"));
  const request = source.slice(source.indexOf("async function request"), source.indexOf("async function requestFromBase"));
  const feedRefresh = source.slice(source.indexOf("async function refreshFeeds"), source.indexOf("function rememberFeeds"));
  const profileStatus = source.slice(source.indexOf("async function profileStatus"), source.indexOf("function rememberProfileStatus"));

  assert.match(capture, /retryInBackground: Boolean\(options\.background\),/);
  assert.match(request, /const maxRetries = options\.noRetry \|\| \(options\.background && !options\.retryInBackground\) \? 0 : 2/);
  assert.match(request, /if \(attempt < maxRetries\) \{\s+await delay\(retryDelayMsForAttempt\(attempt, lastError\)\);\s+return request\(path, options, attempt \+ 1\);\s+\}\s+if \(options\.background && isConnectionError\(lastError\)\) \{/);
  assert.doesNotMatch(feedRefresh, /retryInBackground/);
  assert.doesNotMatch(profileStatus, /retryInBackground/);
});

test("membership writes carry a stable idempotency key through request retries", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const saveMembership = source.slice(source.indexOf("async function saveMembership"), source.indexOf("async function captureVisibleActivity"));

  assert.match(saveMembership, /const requestId = createClientRequestId\(\);/);
  assert.match(saveMembership, /requestId,/);
  assert.doesNotMatch(saveMembership, /requestId: createClientRequestId\(\)/);
});

test("capture source urls stay on linkedin surfaces", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureVisibleActivity"), source.indexOf("function visibleActivityContainers"));
  const normalizeSource = source.slice(source.indexOf("function normalizeSourceUrl"), source.indexOf("function isLinkedInLoginGate"));

  assert.match(source, /container\.querySelector\('a\[href\*="\/feed\/update\/"\]'\)/);
  assert.match(capture, /const sourceUrl = normalizeSourceUrl\(sourceAnchor\?\.href \|\| ""\);/);
  assert.match(capture, /const fallbackSourceUrl = sourceUrl \|\| normalizeSourceUrl\(location\.href\);/);
  assert.match(capture, /if \(!fallbackSourceUrl\) \{\s+continue;\s+\}/);
  assert.match(capture, /sourceUrl: fallbackSourceUrl,/);
  assert.match(normalizeSource, /if \(!isLinkedInHost\(parsed\.hostname\) \|\| !isLinkedInEngagementSourcePath\(parsed\.pathname\)\) \{\s+return "";\s+\}/);
  assert.match(normalizeSource, /function isLinkedInEngagementSourcePath\(pathname\)/);
  assert.match(normalizeSource, /\^\\\/in\\\/\[\^\/\]\+\\\/recent-activity\\\/\(\?:all\|comments\)\\\/\?\$/);
  assert.match(normalizeSource, /catch \{\s+return "";\s+\}/);
  assert.doesNotMatch(source, /container\.querySelector\("a\[href\]"\)/);
  assert.doesNotMatch(normalizeSource, /return String\(url \|\| ""\);/);
});

test("whole-page fallback capture requires an item source link", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureVisibleActivity"), source.indexOf("function visibleActivityContainers"));
  const containers = source.slice(source.indexOf("function visibleActivityContainers"), source.indexOf("function dedupeNestedActivityContainers"));

  assert.match(capture, /if \(!sourceUrl && isWholePageFallbackContainer\(container\)\) \{\s+continue;\s+\}/);
  assert.match(containers, /return main \? \[main\] : \[\];/);
  assert.match(containers, /function isWholePageFallbackContainer\(container\) \{\s+return container\.matches\("main"\);\s+\}/);
});

test("refresh capture skips undated activity instead of treating it as fresh", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureVisibleActivity"), source.indexOf("function visibleActivityContainers"));

  assert.match(capture, /const activityTimestamp = activityTimestampFromContainer\(container\);/);
  assert.match(capture, /if \(!activityTimestamp && activityTimestampRequired\(options\)\) \{\s+continue;\s+\}/);
  assert.match(capture, /const activityAt = activityTimestamp \? new Date\(activityTimestamp\)\.toISOString\(\) : new Date\(\)\.toISOString\(\);/);
  assert.match(source, /function activityTimestampRequired\(options\) \{\s+return options\.reason === "refresh-session";\s+\}/);
  assert.doesNotMatch(capture, /const activityAt = extractActivityAt\(container\);/);
});

test("refresh capture stops assembling items once visible activity is older than lookback", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureVisibleActivity"), source.indexOf("function visibleActivityContainers"));
  const runner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));

  assert.match(capture, /const lookbackCutoffTime = options\.reason === "refresh-session" \? timestampFromIso\(options\.lookbackCutoffAt\) : 0;/);
  assert.match(
    capture,
    /if \(lookbackCutoffTime && activityTimestamp && activityTimestamp < lookbackCutoffTime\) \{\s+break;\s+\}/,
  );
  assert.ok(capture.indexOf("if (!activityTimestamp && activityTimestampRequired(options))") < capture.indexOf("if (lookbackCutoffTime && activityTimestamp"));
  assert.ok(capture.indexOf("if (lookbackCutoffTime && activityTimestamp") < capture.indexOf("const activityAt = activityTimestamp"));
  assert.match(runner, /reason: "refresh-session",\s+lookbackCutoffAt: session\.lookbackCutoffAt,/);
});

test("activity capture only uses container-local profile anchors", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureVisibleActivity"), source.indexOf("function visibleActivityContainers"));

  assert.match(capture, /const anchor = container\.querySelector\('a\[href\*="\/in\/"\]'\);/);
  assert.match(capture, /const profileUrl = ownerProfileUrl \|\| normalizeProfileUrl\(anchor\?\.href \|\| ""\);/);
  assert.doesNotMatch(capture, /LINKEDIN_PROFILE_RE\.test\(anchor\.href\)/);
  assert.doesNotMatch(capture, /document\.querySelector\('main a\[href\*="\/in\/"\]'\)/);
});

test("activity capture strips helper ui from saved text and fallback names", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureVisibleActivity"), source.indexOf("function visibleActivityContainers"));
  const helper = source.slice(source.indexOf("function capturedTextFromElement"), source.indexOf("document.addEventListener"));

  assert.match(capture, /const text = capturedTextFromElement\(container\)\.slice\(0, 1600\);/);
  assert.match(capture, /personName: ownerName \|\| capturedTextFromElement\(anchor\) \|\| "LinkedIn member"/);
  assert.match(helper, /return cleanText\(textWithoutHelperControls\(element\)\);/);
  assert.match(helper, /function textWithoutHelperControls\(element\)/);
  assert.match(helper, /const clone = element\.cloneNode\(true\);/);
  assert.match(helper, /clone\.querySelectorAll\("\.lef-anchor, \.lef-popover, \.lef-refresh-banner"\)/);
  assert.match(helper, /helperNode\.remove\(\);/);
  assert.match(helper, /return clone\.innerText \|\| clone\.textContent \|\| "";/);
  assert.doesNotMatch(capture, /cleanText\(container\.textContent \|\| ""\)\.slice\(0, 1600\)/);
  assert.doesNotMatch(capture, /cleanText\(anchor\?\.textContent \|\| ""\) \|\| "LinkedIn member"/);
});

test("activity capture drops nested actor fragments when full updates are available", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");

  assert.match(source, /const containers = dedupeNestedActivityContainers\(\[\.\.\.document\.querySelectorAll/);
  assert.match(source, /function dedupeNestedActivityContainers\(containers\)/);
  assert.match(source, /node\.matches\("\.update-components-actor"\)/);
  assert.match(source, /!other\.matches\("\.update-components-actor"\) && other\.contains\(node\)/);
});

test("generic profile activity pages are not treated as stable item ids", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const stableItem = source.slice(source.indexOf("function stableItemId"), source.indexOf("function isLinkedInLoginGate"));

  assert.match(stableItem, /const sourceLooksStable = isStableLinkedInItemSource\(source\);/);
  assert.match(stableItem, /function isStableLinkedInItemSource\(sourceUrl\)/);
  assert.match(stableItem, /isLinkedInHost\(parsed\.hostname\) &&/);
  assert.match(stableItem, /\/\^\\\/\(\?:feed\\\/update\|posts\|pulse\|comments\)\\\/\/i\.test\(parsed\.pathname\)/);
  assert.doesNotMatch(source, /feed\\\/update\|posts\|pulse\|comments\|activity/);
  assert.doesNotMatch(stableItem, /linkedin\\\.com\\\/\(feed\\\/update\|posts\|pulse\|comments\)/);
});

test("activity date parsing recognizes full-word relative units", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const parser = source.slice(source.indexOf("function parseLinkedInDate"), source.indexOf("function stableItemId"));

  assert.match(parser, /\\byesterday\\b/);
  assert.match(parser, /date\.setDate\(date\.getDate\(\) - 1\);/);
  assert.match(parser, /minutes\?\|mins\?\|min\|m\|hours\?\|hrs\?\|hr\|h\|days\?\|d\|weeks\?\|wks\?\|wk\|w\|months\?\|mos\?\|mo\|years\?\|yrs\?\|yr\|y/);
  assert.match(parser, /minutes: "minute"/);
  assert.match(parser, /hours: "hour"/);
  assert.match(parser, /weeks: "week"/);
  assert.match(parser, /months: "month"/);
  assert.match(parser, /years: "year"/);
  assert.match(parser, /week: 7 \* 24 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(parser, /min\|m\|h\|hr\|d\|day\|w\|wk\|mo\|month\|yr\|y\|year\)s\?/);
});

test("activity timestamp extraction ignores non-timestamp duration text", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const timestamp = source.slice(source.indexOf("function activityTimestampFromContainer"), source.indexOf("function visibleActivityHasOlderItem"));

  assert.match(timestamp, /const timeText = activityTimestampCandidateFromText\(time\?\.textContent \|\| time\?\.getAttribute\("aria-label"\) \|\| ""\);/);
  assert.match(timestamp, /\.map\(activityTimestampCandidateFromText\)\s+\.find\(Boolean\);/);
  assert.match(timestamp, /const parsed = parseLinkedInDate\(ariaTimestamp \|\| ""\);/);
  assert.match(timestamp, /function activityTimestampCandidateFromText\(text\)/);
  assert.match(timestamp, /clean\.split\(\/\[•·\|\]\/\)/);
  assert.match(timestamp, /function cleanTimestampSegment\(text\)/);
  assert.match(timestamp, /posted\|shared\|commented\|replied/);
  assert.match(timestamp, /function isLinkedInTimestampText\(text\)/);
  assert.match(timestamp, /minutes\?\|hours\?\|days\?\|weeks\?\|months\?\|years\?\)\\s\+ago/);
  assert.match(timestamp, /m\|h\|d\|w\|mo\|mos\|y\|min\|mins\|hr\|hrs\|wk\|wks\|yr\|yrs/);
  assert.doesNotMatch(timestamp, /find\(\(text\) => parseLinkedInDate\(text\)\)/);
});

test("inferred multi-feed capture uses one bundled local write", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureItemsForFeeds"), source.indexOf("async function request"));

  assert.match(capture, /if \(feedIds\.length === 1\) \{/);
  assert.match(capture, /\/api\/capture-items"/);
  assert.match(capture, /\/api\/capture-items\/multi/);
  assert.match(capture, /feedIds,/);
  assert.doesNotMatch(capture, /Promise\.allSettled/);
  assert.doesNotMatch(capture, /feedIds\.map\(\(feedId\) =>/);
});

test("background capture writes use a longer timeout than background probes", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const capture = source.slice(source.indexOf("async function captureItemsForFeeds"), source.indexOf("async function request"));
  const feedRefresh = source.slice(source.indexOf("async function refreshFeeds"), source.indexOf("function rememberFeeds"));
  const profileStatus = source.slice(source.indexOf("async function profileStatus"), source.indexOf("function rememberProfileStatus"));
  const poll = source.slice(source.indexOf("async function pollScheduledRefreshSession"), source.indexOf("function refreshSessionResumeSignature"));

  assert.match(source, /const BACKGROUND_REQUEST_TIMEOUT_MS = 2500;/);
  assert.match(source, /const BACKGROUND_WRITE_REQUEST_TIMEOUT_MS = 10000;/);
  assert.match(capture, /retryInBackground: Boolean\(options\.background\),/);
  assert.match(capture, /const timeoutMs = captureWriteTimeoutMs\(options\);/);
  assert.match(capture, /timeoutMs,/);
  assert.match(capture, /function captureWriteTimeoutMs\(options = \{\}\)/);
  assert.match(capture, /return options\.background \? BACKGROUND_WRITE_REQUEST_TIMEOUT_MS : undefined;/);
  assert.doesNotMatch(capture, /timeoutMs: options\.background \? BACKGROUND_REQUEST_TIMEOUT_MS : undefined,/);
  assert.match(feedRefresh, /timeoutMs: background \? BACKGROUND_REQUEST_TIMEOUT_MS : undefined,/);
  assert.match(profileStatus, /timeoutMs: options\.background \? BACKGROUND_REQUEST_TIMEOUT_MS : undefined,/);
  assert.match(poll, /timeoutMs: BACKGROUND_REQUEST_TIMEOUT_MS,/);
});

test("manual refresh writes use an extended timeout without slowing passive capture", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));
  const errorReport = source.slice(source.indexOf("async function reportRefreshTargetError"), source.indexOf("async function reportRefreshHeartbeat"));
  const capture = source.slice(source.indexOf("async function captureItemsForFeeds"), source.indexOf("async function request"));
  const passiveLoop = source.slice(source.indexOf("function captureVisibleActivityLoop"), source.indexOf("function pageCanRunPassiveCapture"));

  assert.match(source, /const REFRESH_WRITE_REQUEST_TIMEOUT_MS = 30000;/);
  assert.match(runner, /reason: "refresh-session",\s+lookbackCutoffAt: session\.lookbackCutoffAt,\s+writeTimeoutMs: REFRESH_WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(runner, /method: "POST",\s+timeoutMs: REFRESH_WRITE_REQUEST_TIMEOUT_MS,\s+validate: normalizeRefreshSession,/);
  assert.match(errorReport, /method: "POST",\s+noRetry: true,\s+timeoutMs: REFRESH_WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(capture, /if \(isSafeInteger\(options\.writeTimeoutMs\) && options\.writeTimeoutMs > 0\) \{\s+return options\.writeTimeoutMs;\s+\}/);
  assert.match(capture, /return options\.background \? BACKGROUND_WRITE_REQUEST_TIMEOUT_MS : undefined;/);
  assert.doesNotMatch(passiveLoop, /writeTimeoutMs: REFRESH_WRITE_REQUEST_TIMEOUT_MS/);
});

test("refresh runner waits for useful LinkedIn content before accepting a settled page", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");

  assert.match(source, /const hasUsefulLinkedInSurface = pageHasUsefulLinkedInSurface\(\);/);
  assert.match(source, /let lastActivityCount = visibleActivityContainers\(\{ includeLoaded: true \}\)\.length;/);
  assert.match(source, /let activityStableTicks = 0;/);
  assert.match(source, /const nextActivityCount = visibleActivityContainers\(\{ includeLoaded: true \}\)\.length;/);
  assert.match(source, /const maxWaitMs = hasUsefulLinkedInSurface \? 7500 : 10000;/);
  assert.match(source, /stableTicks >= 2 && activityStableTicks >= 2 && elapsedMs >= 2600/);
  assert.match(source, /const elapsedMs = Date\.now\(\) - startedAt;/);
  assert.match(source, /elapsedMs > maxWaitMs/);
  assert.match(source, /function pageHasUsefulLinkedInSurface\(main = document\.querySelector\("main"\)\)/);
  const usefulSurface = source.slice(source.indexOf("function pageHasUsefulLinkedInSurface"), source.indexOf("function cleanText"));
  assert.match(usefulSurface, /const activitySelector = \[/);
  assert.match(usefulSurface, /'a\[href\*="\/feed\/update\/"\]'/);
  assert.match(usefulSurface, /'a\[href\*="\/posts\/"\]'/);
  assert.match(usefulSurface, /'a\[href\*="\/comments\/"\]'/);
  assert.match(usefulSurface, /\[data-urn\*="urn:li:activity"\]/);
  assert.match(usefulSurface, /\.feed-shared-update-v2/);
  assert.match(usefulSurface, /\.comments-comment-item/);
  assert.doesNotMatch(usefulSurface, /a\[href\*="\/in\/"\]/);
  assert.match(source, /!pageHasUsefulLinkedInSurface\(main\) && \/\\\/recent-activity\\\//);
});

test("refresh blocking detection recognizes unavailable profile variants", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const detector = source.slice(source.indexOf("function detectLinkedInBlockingState"), source.indexOf("function pageHasUsefulLinkedInSurface"));

  assert.match(detector, /This LinkedIn profile page is unavailable\./);
  assert.match(detector, /profile unavailable/);
  assert.match(detector, /profile \(\?:is not\|isn\(\?:\['\\u2019\]\)\?t\) available/);
  assert.match(detector, /page \(\?:not found\|doesn\(\?:\['\\u2019\]\)\?t exist\|isn\(\?:\['\\u2019\]\)\?t available\)/);
  assert.match(detector, /member unavailable/);
  assert.doesNotMatch(detector, /\u00e2\u20ac\u2122/);
  assert.ok(detector.indexOf("too many requests") < detector.indexOf("This LinkedIn profile page is unavailable."));
  assert.ok(detector.indexOf("something went wrong") < detector.indexOf("This LinkedIn profile page is unavailable."));
});

test("refresh blocking detection pattern matches straight and curly unavailable apostrophes", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const patternLine = source
    .split(/\r?\n/)
    .find((line) => line.includes("this profile is not available") && line.includes("member unavailable"));
  assert.ok(patternLine, "expected the unavailable profile regex to stay visible in the content script");

  const literal = patternLine.trim().replace(/,$/, "");
  const pattern = Function(`"use strict"; return (${literal});`)();

  assert.match("this page doesn't exist.", pattern);
  assert.match("this page doesn\u2019t exist.", pattern);
  assert.match("this profile isn't available.", pattern);
  assert.match("this profile isn\u2019t available.", pattern);
  assert.match("member unavailable.", pattern);
});

test("refresh runner rechecks active session before delayed navigation", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");

  assert.match(source, /scheduleRefreshSessionResume\(nextSession\.id, delayMs, nextSession\);/);
  assert.match(source, /function scheduleRefreshSessionResume\(sessionId, delayMs, expectedSession\)/);
  assert.match(source, /function startRefreshRun\(sessionId\)/);
  assert.match(source, /startRefreshRun\(sessionId\);/);
  assert.match(source, /const pageTargetIndex = refreshTargetIndexFromUrl\(location\.href\);/);
  assert.doesNotMatch(source, /window\.setTimeout\(\(\) => \{\s+window\.location\.href = nextSession\.nextUrl;/);
  assert.doesNotMatch(source, /Number\(new URL\(location\.href\)\.searchParams\.get\("lefTarget"\)\)/);
});

test("refresh target parsing does not treat missing params as target zero", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const parser = source.slice(source.indexOf("function refreshTargetIndexFromUrl"), source.indexOf("function profileHeadingName"));
  const runner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));
  const continuation = source.slice(source.indexOf("function continueRefreshSession"), source.indexOf("function scheduleRefreshSessionResume"));

  assert.match(parser, /const value = new URL\(url\)\.searchParams\.get\("lefTarget"\);/);
  assert.match(parser, /if \(value === null \|\| value\.trim\(\) === ""\) \{\s+return undefined;\s+\}/);
  assert.match(parser, /isSafeInteger\(index\) && index >= 0 \? index : undefined/);
  assert.doesNotMatch(parser, /Number\.isInteger\(index\)/);
  assert.match(runner, /const pageTargetIndex = refreshTargetIndexFromUrl\(location\.href\);/);
  assert.match(runner, /const hasTargetParam = isSafeInteger\(pageTargetIndex\);/);
  assert.match(continuation, /const pageTargetIndex = refreshTargetIndexFromUrl\(location\.href\);/);
});

test("refresh runner requires the page to match the target even when target param matches", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));

  assert.match(runner, /const pageMatchesCurrentTarget = pageMatchesTarget\(target\);/);
  assert.match(runner, /const navigationUrl = nextRefreshNavigationUrl\(session, target\);/);
  assert.match(
    runner,
    /if \(!navigationUrl\) \{\s+const nextSession = await reportRefreshTargetError\(\s+sessionId,\s+target,\s+"Refresh target URL is unavailable\.",\s+completionRequestId,\s+\);\s+continueRefreshSession\(nextSession, "LinkedIn page issue: Refresh target URL is unavailable\."\);\s+return;\s+\}/,
  );
  assert.match(runner, /renderRefreshBanner\("moving", "Opening the expected LinkedIn activity page\."\);\s+window\.location\.href = navigationUrl;/);
  assert.doesNotMatch(runner, /const targetParamMatches = hasTargetParam && pageTargetIndex === target\.index;/);
  assert.doesNotMatch(runner, /!\(targetParamMatches\) && !pageMatchesTarget/);
  assert.doesNotMatch(runner, /!targetParamMatches && !pageMatchesTarget\(target\)/);
  assert.doesNotMatch(runner, /window\.location\.href = session\.nextUrl/);
});

test("refresh runner rechecks target after page settling before capture", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));
  const afterSettled = runner.slice(runner.indexOf("await waitForPageSettled"), runner.indexOf("const captureResult = await captureVisibleActivity"));

  assert.match(afterSettled, /await waitForPageSettled\(session\.lookbackCutoffAt\);/);
  assert.match(afterSettled, /if \(!pageMatchesTarget\(target\)\) \{/);
  assert.match(afterSettled, /const navigationUrl = nextRefreshNavigationUrl\(session, target\);/);
  assert.match(afterSettled, /"Refresh target changed before capture\."/);
  assert.match(afterSettled, /renderRefreshBanner\("moving", "LinkedIn changed pages before capture\. Reopening the expected activity page\."\);/);
  assert.match(afterSettled, /window\.location\.href = navigationUrl;/);
  assert.ok(afterSettled.indexOf("if (!pageMatchesTarget(target))") < afterSettled.indexOf("const blockingMessage = detectLinkedInBlockingState();"));
  assert.ok(afterSettled.indexOf("const blockingMessage = detectLinkedInBlockingState();") < runner.indexOf("const captureResult = await captureVisibleActivity"));
});

test("refresh runner reconstructs missing target navigation urls safely", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const navigation = source.slice(source.indexOf("function nextRefreshNavigationUrl"), source.indexOf("function refreshTargetIndexFromUrl"));

  assert.match(navigation, /function nextRefreshNavigationUrl\(session, target\)/);
  assert.match(navigation, /if \(session\?\.nextUrl && isLinkedInRefreshTargetUrl\(session\.nextUrl\)\) \{\s+return session\.nextUrl;\s+\}/);
  assert.match(navigation, /if \(!target\?\.url \|\| !isLinkedInRefreshTargetUrl\(target\.url\)\) \{\s+return "";\s+\}/);
  assert.match(navigation, /const parsed = new URL\(target\.url\);/);
  assert.match(navigation, /parsed\.searchParams\.set\("lefSession", session\.id\);/);
  assert.match(navigation, /parsed\.searchParams\.set\("lefTarget", String\(target\.index\)\);/);
  assert.match(navigation, /return parsed\.toString\(\);/);
  assert.match(navigation, /function isLinkedInRefreshTargetUrl\(url\)/);
  assert.match(navigation, /isLinkedInHost\(parsed\.hostname\) && \/\^\\\/in\\\/\[\^\/\]\+\\\/recent-activity\\\/\(\?:all\|comments\)\\\/\?\$\/i\.test\(parsed\.pathname\)/);
});

test("refresh runner keeps ownership when running sessions temporarily lack next urls", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const continuation = source.slice(source.indexOf("function continueRefreshSession"), source.indexOf("function scheduleRefreshSessionResume"));

  assert.match(continuation, /const navigationUrl =\s+nextSession\.status === "running" \? nextRefreshNavigationUrl\(nextSession, nextSession\.currentTarget\) : "";/);
  assert.match(continuation, /if \(nextSession\.status === "running" && navigationUrl\) \{/);
  assert.match(continuation, /if \(nextSession\.status === "running"\) \{\s+renderRefreshBanner\(\s+"error",\s+`\$\{prefix\} Refresh is still running, but the next LinkedIn page is unavailable\. Retrying session check in 7s\.`/);
  assert.match(continuation, /scheduleRefreshSessionResume\(nextSession\.id, 7000, nextSession\);\s+return;\s+\}/);
  assert.ok(continuation.indexOf('if (nextSession.status === "running")') < continuation.indexOf("sessionStorage.removeItem(SESSION_STORAGE_KEY);"));
  assert.doesNotMatch(continuation, /if \(nextSession\.status === "running" && nextSession\.nextUrl\)/);
});

test("refresh runner keeps ownership when running sessions temporarily lack current targets", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));
  const missingTargetBranch = runner.slice(runner.indexOf("if (!target)"), runner.indexOf("if (isLinkedInLoginGate())"));

  assert.match(missingTargetBranch, /if \(!target\) \{/);
  assert.match(missingTargetBranch, /renderRefreshBanner\("error", "LinkedIn refresh is still running, but the next page is not ready\. Retrying session check in 7s\."\);/);
  assert.match(missingTargetBranch, /scheduleRefreshSessionResume\(sessionId, 7000, session\);/);
  assert.doesNotMatch(missingTargetBranch, /sessionStorage\.removeItem\(SESSION_STORAGE_KEY\)/);
});

test("refresh runner does not skip pending pacing timers on focus", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runnerStart = source.slice(source.indexOf("function startRefreshRunnerFromPage"), source.indexOf("async function runRefreshSession"));
  const runRefreshSession = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));
  const scheduler = source.slice(source.indexOf("function scheduleRefreshSessionResume"), source.indexOf("function waitForPageSettled"));

  assert.match(runnerStart, /if \(!sessionId \|\| state\.refreshRunning\) \{\s+return;\s+\}/);
  assert.match(runnerStart, /const storedResume = readStoredRefreshResume\(sessionId\);/);
  assert.match(runnerStart, /if \(state\.refreshTimer\) \{\s+if \(!urlSession \|\| \(storedResume && storedResume\.resumeAt > Date\.now\(\)\)\) \{\s+return;\s+\}\s+clearRefreshResumeTimers\(\);\s+\}/);
  assert.match(runnerStart, /if \(storedResume && storedResume\.resumeAt > Date\.now\(\)\) \{\s+scheduleStoredRefreshSessionResume\(storedResume\);\s+return;\s+\}/);
  assert.match(runnerStart, /startRefreshRun\(sessionId\);/);
  assert.match(runRefreshSession, /clearRefreshResumeTimers\(\);/);
  assert.match(runRefreshSession, /scheduleRefreshSessionResume\(sessionId, 5000\);/);
  assert.match(runRefreshSession, /scheduleRefreshSessionResume\(sessionId, 7000\);/);
  assert.doesNotMatch(runRefreshSession, /window\.setTimeout\(\(\) => runRefreshSession\(sessionId\)/);
  assert.match(scheduler, /function clearRefreshResumeTimers\(\)/);
  assert.match(scheduler, /clearTimeout\(state\.refreshTimer\);\s+state\.refreshTimer = 0;/);
  assert.match(scheduler, /clearInterval\(state\.refreshPollTimer\);\s+state\.refreshPollTimer = 0;/);
  assert.match(scheduler, /sessionStorage\.removeItem\(RESUME_STORAGE_KEY\);/);
  assert.match(scheduler, /clearRefreshResumeTimers\(\);\s+startRefreshRun\(sessionId\);/);
});

test("refresh runner lets fresh url sessions replace stale pending resumes", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runnerStart = source.slice(source.indexOf("function startRefreshRunnerFromPage"), source.indexOf("async function runRefreshSession"));

  assert.match(runnerStart, /const urlSession = new URL\(location\.href\)\.searchParams\.get\("lefSession"\);/);
  assert.match(runnerStart, /sessionStorage\.setItem\(SESSION_STORAGE_KEY, urlSession\);/);
  assert.match(runnerStart, /const storedResume = readStoredRefreshResume\(sessionId\);/);
  assert.match(runnerStart, /if \(state\.refreshTimer\) \{/);
  assert.match(runnerStart, /if \(!urlSession \|\| \(storedResume && storedResume\.resumeAt > Date\.now\(\)\)\) \{\s+return;\s+\}/);
  assert.match(runnerStart, /clearRefreshResumeTimers\(\);/);
  assert.ok(runnerStart.indexOf("clearRefreshResumeTimers();") < runnerStart.indexOf("startRefreshRun(sessionId);"));
  assert.doesNotMatch(runnerStart, /state\.refreshTimer\) \{\s+return;\s+\}/);
});

test("refresh runner restores scheduled resume state after reload", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runnerStart = source.slice(source.indexOf("function startRefreshRunnerFromPage"), source.indexOf("function startRefreshRun(sessionId)"));
  const scheduler = source.slice(source.indexOf("function scheduleRefreshSessionResume"), source.indexOf("function waitForPageSettled"));
  const storage = source.slice(source.indexOf("function rememberRefreshResume"), source.indexOf("function waitForPageSettled"));

  assert.match(source, /const RESUME_STORAGE_KEY = "lefRefreshResume";/);
  assert.match(runnerStart, /const storedResume = readStoredRefreshResume\(sessionId\);/);
  assert.match(runnerStart, /storedResume && storedResume\.resumeAt > Date\.now\(\)/);
  assert.match(runnerStart, /scheduleStoredRefreshSessionResume\(storedResume\);/);
  assert.match(scheduler, /const expectedSessionSignature = refreshSessionResumeSignature\(expectedSession\);/);
  assert.match(scheduler, /rememberRefreshResume\(sessionId, Date\.now\(\) \+ safeDelayMs, expectedSessionSignature\);/);
  assert.match(scheduler, /function scheduleStoredRefreshSessionResume\(storedResume\)/);
  assert.match(scheduler, /function scheduleStoredRefreshSessionResume\(storedResume\) \{\s+clearRefreshResumeTimers\(\);/);
  assert.match(scheduler, /const remainingMs = normalizeRefreshResumeDelayMs\(storedResume\.resumeAt - Date\.now\(\)\);/);
  assert.match(scheduler, /rememberRefreshResume\(storedResume\.sessionId, Date\.now\(\) \+ remainingMs, storedResume\.expectedSessionSignature\);/);
  assert.match(scheduler, /startRefreshRun\(storedResume\.sessionId\);/);
  assert.match(scheduler, /pollScheduledRefreshSession\(storedResume\.sessionId, storedResume\.expectedSessionSignature\)/);
  assert.match(storage, /function rememberRefreshResume\(sessionId, resumeAt, expectedSessionSignature\)/);
  assert.match(storage, /sessionStorage\.setItem\(\s+RESUME_STORAGE_KEY,\s+JSON\.stringify/);
  assert.match(storage, /function readStoredRefreshResume\(sessionId\)/);
  assert.match(storage, /JSON\.parse\(sessionStorage\.getItem\(RESUME_STORAGE_KEY\) \|\| "null"\)/);
  assert.match(storage, /raw\.sessionId !== sessionId/);
  assert.match(storage, /sessionStorage\.removeItem\(RESUME_STORAGE_KEY\);/);
});

test("refresh runner wakes long scheduled delays when app session state changes", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const scheduler = source.slice(source.indexOf("function scheduleRefreshSessionResume"), source.indexOf("function waitForPageSettled"));

  assert.match(source, /const REFRESH_RESUME_POLL_MS = 5000;/);
  assert.match(source, /refreshPollTimer: 0,/);
  assert.match(scheduler, /const expectedSessionSignature = refreshSessionResumeSignature\(expectedSession\);/);
  assert.match(scheduler, /const safeDelayMs = normalizeRefreshResumeDelayMs\(delayMs\);/);
  assert.match(scheduler, /rememberRefreshResume\(sessionId, Date\.now\(\) \+ safeDelayMs, expectedSessionSignature\);/);
  assert.match(scheduler, /\}, safeDelayMs\);/);
  assert.match(scheduler, /if \(safeDelayMs > REFRESH_RESUME_POLL_MS \* 2 && expectedSessionSignature\) \{/);
  assert.match(scheduler, /state\.refreshPollTimer = window\.setInterval\(\(\) => \{/);
  assert.match(scheduler, /pollScheduledRefreshSession\(sessionId, expectedSessionSignature\)\.catch\(\(\) => \{\}\);/);
  assert.match(scheduler, /\/api\/refresh-sessions\/active\?id=\$\{encodeURIComponent\(sessionId\)\}/);
  assert.match(scheduler, /background: true,/);
  assert.match(scheduler, /ignoreCooldown: true,/);
  assert.match(scheduler, /timeoutMs: BACKGROUND_REQUEST_TIMEOUT_MS,/);
  assert.match(scheduler, /nextSessionSignature !== expectedSessionSignature/);
  assert.match(scheduler, /clearRefreshResumeTimers\(\);\s+startRefreshRun\(sessionId\);/);
  assert.match(scheduler, /function refreshSessionResumeSignature\(session\)/);
  assert.match(scheduler, /session\.lookbackCutoffAt/);
  assert.match(scheduler, /session\.totalTargets/);
  assert.match(scheduler, /session\.currentAttempt/);
  assert.match(scheduler, /session\.nextDelayMs/);
  assert.match(scheduler, /target\.index/);
  assert.match(scheduler, /target\.url/);
});

test("refresh session polls bypass passive background cooldown only for refresh control", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const request = source.slice(source.indexOf("async function request"), source.indexOf("async function requestFromBase"));
  const poll = source.slice(source.indexOf("async function pollScheduledRefreshSession"), source.indexOf("function refreshSessionCurrentTargetSignature"));
  const capture = source.slice(source.indexOf("async function captureItemsForFeeds"), source.indexOf("async function request"));
  const feedRefresh = source.slice(source.indexOf("async function refreshFeeds"), source.indexOf("function rememberFeeds"));

  assert.match(request, /if \(options\.background && !options\.ignoreCooldown && backgroundApiInCooldown\(\)\) \{/);
  assert.match(poll, /background: true,\s+ignoreCooldown: true,\s+timeoutMs: BACKGROUND_REQUEST_TIMEOUT_MS,/);
  assert.doesNotMatch(capture, /ignoreCooldown/);
  assert.doesNotMatch(feedRefresh, /ignoreCooldown/);
});

test("refresh resume delays are normalized before timers and banner text", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const continuation = source.slice(source.indexOf("function continueRefreshSession"), source.indexOf("function scheduleRefreshSessionResume"));
  const scheduler = source.slice(source.indexOf("function scheduleRefreshSessionResume"), source.indexOf("function clearRefreshResumeTimers"));
  const formatter = source.slice(source.indexOf("function formatDelay"), source.indexOf("function currentProfileUrl"));
  const normalizer = source.slice(source.indexOf("function normalizeRefreshResumeDelayMs"), source.indexOf("function currentProfileUrl"));

  assert.match(source, /const REFRESH_RESUME_DEFAULT_DELAY_MS = 3000;/);
  assert.match(source, /const REFRESH_RESUME_MIN_DELAY_MS = 500;/);
  assert.match(source, /const REFRESH_RESUME_MAX_DELAY_MS = 180000;/);
  assert.match(continuation, /const delayMs = normalizeRefreshResumeDelayMs\(nextSession\.nextDelayMs \?\? nextSession\.delayMs\);/);
  assert.match(continuation, /formatDelay\(delayMs\)/);
  assert.match(scheduler, /const safeDelayMs = normalizeRefreshResumeDelayMs\(delayMs\);/);
  assert.match(scheduler, /const remainingMs = normalizeRefreshResumeDelayMs\(storedResume\.resumeAt - Date\.now\(\)\);/);
  assert.match(scheduler, /\}, safeDelayMs\);/);
  assert.match(formatter, /Math\.round\(normalizeRefreshResumeDelayMs\(ms\) \/ 1000\)/);
  assert.match(normalizer, /const delayMs = Number\(value\);/);
  assert.match(normalizer, /Number\.isFinite\(fallbackMs\)/);
  assert.match(normalizer, /REFRESH_RESUME_MIN_DELAY_MS, Math\.min\(REFRESH_RESUME_MAX_DELAY_MS, Math\.round\(delayMs\)\)/);
  assert.doesNotMatch(continuation, /nextSession\.nextDelayMs \|\| nextSession\.delayMs \|\| 3000/);
});

test("refresh runner keeps session ownership scoped to the current tab", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runnerStart = source.slice(source.indexOf("function startRefreshRunnerFromPage"), source.indexOf("async function runRefreshSession"));
  const runner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));
  const completion = source.slice(source.indexOf("function continueRefreshSession"), source.indexOf("function scheduleRefreshSessionResume"));

  assert.match(runnerStart, /sessionStorage\.setItem\(SESSION_STORAGE_KEY, urlSession\);/);
  assert.match(runnerStart, /urlSession \|\| sessionStorage\.getItem\(SESSION_STORAGE_KEY\)/);
  assert.doesNotMatch(runnerStart, /localStorage/);
  assert.match(runner, /sessionStorage\.removeItem\(SESSION_STORAGE_KEY\);/);
  assert.match(completion, /sessionStorage\.removeItem\(SESSION_STORAGE_KEY\);/);
  assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem|removeItem)\(SESSION_STORAGE_KEY/);
});

test("refresh runner heartbeats while waiting at LinkedIn login gates", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const loginGateBranch = source.slice(source.indexOf("if (isLinkedInLoginGate())"), source.indexOf("const pageTargetIndex"));
  const heartbeat = source.slice(source.indexOf("async function reportRefreshHeartbeat"), source.indexOf("function continueRefreshSession"));

  assert.match(loginGateBranch, /const message = "Sign in to LinkedIn, then this refresh will continue\.";/);
  assert.match(loginGateBranch, /await reportRefreshHeartbeat\(sessionId, target, message\)\.catch\(\(\) => undefined\);/);
  assert.match(heartbeat, /async function reportRefreshHeartbeat\(sessionId, target, message\)/);
  assert.match(heartbeat, /\/api\/refresh-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/heartbeat/);
  assert.match(heartbeat, /targetIndex: target\.index,/);
  assert.match(heartbeat, /url: location\.href,/);
});

test("refresh error reports do not recursively retry stateful backoff increments", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));
  const errorReport = source.slice(source.indexOf("async function reportRefreshTargetError"), source.indexOf("async function reportRefreshHeartbeat"));
  const successReportStart = runner.indexOf("const captureResult = await captureVisibleActivity");
  const successReport = runner.slice(successReportStart, runner.indexOf("continueRefreshSession(nextSession", successReportStart));

  assert.match(runner, /let completionRequestId = "";/);
  assert.match(runner, /completionRequestId = createClientRequestId\(\);/);
  assert.match(runner, /reportRefreshTargetError\(sessionId, target, blockingMessage, completionRequestId\)/);
  assert.match(runner, /completionRequestId \|\| createClientRequestId\(\)/);
  assert.match(errorReport, /method: "POST",\s+noRetry: true,/);
  assert.match(errorReport, /async function reportRefreshTargetError\(sessionId, target, message, requestId\)/);
  assert.match(errorReport, /error: message,/);
  assert.match(errorReport, /requestId,/);
  assert.doesNotMatch(successReport, /noRetry: true/);
  assert.match(successReport, /requestId: completionRequestId,/);
  assert.match(source, /const maxRetries = options\.noRetry \|\| \(options\.background && !options\.retryInBackground\) \? 0 : 2/);
});

test("refresh runner recovers live pacing after a lost target error response", () => {
  const source = fs.readFileSync(contentScriptPath, "utf8");
  const runner = source.slice(source.indexOf("async function runRefreshSession"), source.indexOf("async function reportRefreshTargetError"));
  const recovery = source.slice(source.indexOf("async function recoverActiveRefreshSession"), source.indexOf("function continueRefreshSession"));

  assert.match(
    runner,
    /catch \{\s+const recoveredSession = await recoverActiveRefreshSession\(sessionId\)\.catch\(\(\) => undefined\);\s+if \(recoveredSession && recoveredSession\.active !== false\) \{\s+continueRefreshSession\(recoveredSession, "Temporary capture problem\."\);\s+return;\s+\}/,
  );
  assert.match(recovery, /async function recoverActiveRefreshSession\(sessionId\)/);
  assert.match(recovery, /\/api\/refresh-sessions\/active\?id=\$\{encodeURIComponent\(sessionId\)\}/);
  assert.match(recovery, /noRetry: true,/);
  assert.match(recovery, /timeoutMs: BACKGROUND_REQUEST_TIMEOUT_MS,/);
  assert.match(recovery, /validate: normalizeActiveRefreshSession,/);
  assert.ok(runner.indexOf("recoverActiveRefreshSession(sessionId)") < runner.indexOf("scheduleRefreshSessionResume(sessionId, 7000);"));
});
