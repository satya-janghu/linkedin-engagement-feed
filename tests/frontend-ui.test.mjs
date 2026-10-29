import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const mainSourcePath = path.resolve("src", "main.tsx");
const stylesSourcePath = path.resolve("src", "styles.css");

test("bulk import clears pasted people after retry-safe full acceptance", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");

  assert.match(source, /const bulkPeopleTextRef = useRef\(""\);/);
  assert.match(source, /bulkPeopleTextRef\.current = bulkPeopleText;/);
  assert.match(source, /const bulkPeopleTextAtImport = bulkPeopleText;/);
  assert.match(source, /if \(queueViewRef\.current\.feedId === feedId && bulkPeopleTextRef\.current === bulkPeopleTextAtImport && shouldClearBulkImportText\(result\)\) \{\s+setBulkPeopleText\(""\);/);
  assert.match(source, /function shouldClearBulkImportText\(result: BulkPeopleResult\)/);
  assert.match(source, /const accepted = result\.added \+ result\.alreadyInFeed;/);
  assert.match(source, /result\.received > 0 && accepted >= result\.received/);
  assert.match(source, /result\.skippedInvalid === 0 && result\.skippedCapacity === 0/);
  assert.doesNotMatch(source, /if \(result\.added > 0 && result\.skippedInvalid === 0 && result\.skippedCapacity === 0\)/);
});

test("bulk import results only render for the feed that submitted them", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));

  assert.match(bulkImport, /const feedId = selectedFeed\.id;/);
  assert.match(bulkImport, /const bulkPeopleTextAtImport = bulkPeopleText;/);
  assert.match(bulkImport, /const knownRemainingCapacity = Math\.max\(0, MAX_PEOPLE_PER_FEED - selectedFeed\.peopleCount\);/);
  assert.match(bulkImport, /result = await bulkAddPeopleToFeed\(feedId, people, \{ knownRemainingCapacity \}\);/);
  assert.match(bulkImport, /await applyBulkImportResult\(feedId, result, view, bulkPeopleTextAtImport\);/);
  assert.match(bulkImport, /applyFeedCountDeltas\(new Map\(\[\[feedId, result\.added\]\]\)\);/);
  assert.match(bulkImport, /if \(queueViewRef\.current\.feedId === feedId\) \{\s+setBulkResult\(result\);\s+\}/);
  assert.match(bulkImport, /if \(queueViewRef\.current\.feedId === feedId && bulkPeopleTextRef\.current === bulkPeopleTextAtImport && shouldClearBulkImportText\(result\)\)/);
  assert.doesNotMatch(bulkImport, /setBulkResult\(result\);\s+applyFeedCountDeltas/);
});

test("partial bulk import failures still reconcile saved chunks", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));

  assert.match(source, /BulkImportPartialError,/);
  assert.match(bulkImport, /let result: BulkPeopleResult;/);
  assert.match(bulkImport, /catch \(nextError\) \{/);
  assert.match(bulkImport, /if \(isStaleFeedError\(nextError\) \|\| \(nextError instanceof BulkImportPartialError && isStaleFeedError\(nextError\.cause\)\)\) \{/);
  assert.match(bulkImport, /if \(nextError instanceof BulkImportPartialError\) \{/);
  assert.ok(bulkImport.indexOf("isStaleFeedError(nextError)") < bulkImport.indexOf("if (nextError instanceof BulkImportPartialError)"));
  assert.match(bulkImport, /await applyBulkImportResult\(feedId, nextError\.result, view, bulkPeopleTextAtImport\);/);
  assert.match(bulkImport, /throw nextError;/);
  assert.match(bulkImport, /async function applyBulkImportResult\(/);
  assert.match(bulkImport, /applyFeedCountDeltas\(new Map\(\[\[feedId, result\.added\]\]\)\);/);
  assert.match(bulkImport, /refreshPeopleForFeed\(feedId, view\.search\),\s+refreshPeopleForMovedSearch\(view\),\s+refreshSessionsForFeed\(feedId, \{ applyWhenHidden: queueViewRef\.current\.feedId !== feedId \}\),/);
});

test("bulk import result summarizes capped error details from skipped counts", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const bulkResult = source.slice(source.indexOf("function BulkImportResult"), source.indexOf("function RefreshProgress"));

  assert.match(bulkResult, /const totalSkipped = result\.skippedInvalid \+ result\.skippedCapacity;/);
  assert.match(bulkResult, /const visibleErrors = result\.errors\.slice\(0, 4\);/);
  assert.match(bulkResult, /const hiddenIssueCount = Math\.max\(0, totalSkipped - visibleErrors\.length\);/);
  assert.match(bulkResult, /className=\{totalSkipped > 0 \? "bulk-result warning" : "bulk-result"\}/);
  assert.match(
    bulkResult,
    /\{totalSkipped\} skipped \(\{result\.skippedInvalid\} invalid, \{result\.skippedCapacity\} over capacity\) -/,
  );
  assert.match(bulkResult, /\{result\.remainingCapacity\} slots left/);
  assert.match(bulkResult, /\{visibleErrors\.map\(\(entry\) => \(/);
  assert.match(bulkResult, /hiddenIssueCount > 0 && <span>\{hiddenIssueCount\} more issue\(s\)\.<\/span>/);
  assert.doesNotMatch(bulkResult, /result\.errors\.length - 4/);
});

test("bulk import parser cleans spreadsheet names and quoted urls", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const parseBulkPeople = source.slice(source.indexOf("function parseBulkPeople"), source.lastIndexOf("createRoot"));

  assert.match(parseBulkPeople, /\.flatMap\(\(line\) => \{/);
  assert.match(parseBulkPeople, /const parsedUrls = findBulkImportProfileUrls\(line\);/);
  assert.match(parseBulkPeople, /const candidates = parsedUrls\.length > 0 \? parsedUrls : \[\{ rawMatch: line, profileUrl: line \}\];/);
  assert.match(parseBulkPeople, /return candidates\.map\(\(parsedUrl\) => \{/);
  assert.match(parseBulkPeople, /const matchedUrl = cleanBulkImportField\(parsedUrl\.profileUrl\);/);
  assert.match(parseBulkPeople, /const profileUrl = normalizeBulkImportProfileUrl\(matchedUrl\);/);
  assert.match(parseBulkPeople, /const name = parsedUrls\.length === 1 \? cleanBulkImportField\(line\.replace\(parsedUrl\.rawMatch, ""\)\) : "";/);
  assert.match(parseBulkPeople, /function findBulkImportProfileUrls\(line: string\)/);
  assert.match(parseBulkPeople, /\.matchAll\(/);
  assert.match(parseBulkPeople, /linkedin\\\.com\)\?\\\/in\\\/\[\^\\s,;"'<>]\+/);
  assert.match(parseBulkPeople, /\(\?:https\?:\\\/\\\/\)\?\(\?:www\\\.\)\?linkedin\\\.com\\\/in\\\/\[\^\\s,;"'<>]\+/);
  assert.match(parseBulkPeople, /profileUrl: match\[2\]/);
  assert.match(parseBulkPeople, /function normalizeBulkImportProfileUrl\(matchedUrl: string\)/);
  assert.match(parseBulkPeople, /\^\\\/in\\\//);
  assert.match(parseBulkPeople, /\? `https:\/\/www\.linkedin\.com\$\{matchedUrl\}`/);
  assert.match(parseBulkPeople, /const normalized = canonicalBulkImportLinkedInProfileUrl\(rawProfileUrl\);/);
  assert.match(parseBulkPeople, /return normalized \|\| rawProfileUrl;/);
  assert.match(parseBulkPeople, /function canonicalBulkImportLinkedInProfileUrl\(profileUrl: string\)/);
  assert.match(parseBulkPeople, /hostname !== "linkedin\.com" && !hostname\.endsWith\("\.linkedin\.com"\)/);
  assert.match(parseBulkPeople, /parsed\.pathname\.match\(\/\\\/in\\\/\(\[\^\/\?#\]\+\)\/i\)/);
  assert.match(parseBulkPeople, /return `https:\/\/www\.linkedin\.com\/in\/\$\{encodeURIComponent\(decodeURIComponent\(match\[1\]\)\)\}\/`;/);
  assert.match(parseBulkPeople, /function cleanBulkImportField\(value: string\)/);
  assert.match(parseBulkPeople, /for \(let pass = 0; pass < 3; pass \+= 1\)/);
  assert.match(parseBulkPeople, /\.replace\(\/\^\["'`\]\+\|\["'`\]\+\$\/g, ""\)/);
});

test("bulk import parser accepts scheme-less linkedin urls inside spreadsheet rows", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const parseBulkPeople = source.slice(source.indexOf("function parseBulkPeople"), source.lastIndexOf("createRoot"));

  assert.ok(parseBulkPeople.includes("(?:https?:\\/\\/)?(?:www\\.)?linkedin\\.com\\/in\\/[^\\s,;\"'<>]+\\/?"));
  assert.match(parseBulkPeople, /\|\(\?:https\?:\\\/\\\/\)\?\(\?:www\\\.\)\?linkedin\\\.com\\\/in\\\//);
  assert.match(parseBulkPeople, /const name = parsedUrls\.length === 1 \? cleanBulkImportField\(line\.replace\(parsedUrl\.rawMatch, ""\)\) : "";/);
  assert.match(parseBulkPeople, /\^\\\/in\\\//);
  assert.match(parseBulkPeople, /canonicalBulkImportLinkedInProfileUrl\(rawProfileUrl\)/);
  assert.doesNotMatch(parseBulkPeople, /const candidates = parsedUrls\.length > 0 \? parsedUrls : \[\{ rawMatch: cleanBulkImportField\(line\)/);
});

test("feed and person import forms disable impossible submissions", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const addFeed = source.slice(source.indexOf("async function addFeed"), source.indexOf("async function saveFeedSettings"));
  const addPerson = source.slice(source.indexOf("async function addPersonToSelectedFeed"), source.indexOf("async function bulkImportPeople"));
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));
  const bulkImportControl = source.slice(source.indexOf("<details className=\"bulk-import\">"), source.indexOf("{bulkResult && <BulkImportResult"));

  assert.match(source, /const MAX_PEOPLE_PER_FEED = 200;/);
  assert.match(source, /const selectedFeedIsFull = \(selectedFeed\?\.peopleCount \?\? 0\) >= MAX_PEOPLE_PER_FEED;/);
  assert.match(source, /const feedWorkflowBusy = isFeedWorkflowBusy\(busyKeys\);/);
  assert.match(source, /const canCreateFeed = Boolean\(newFeedName\.trim\(\)\) && !feedWorkflowBusy;/);
  assert.match(source, /const canAddPerson = Boolean\(selectedFeed && newPersonUrl\.trim\(\) && !selectedFeedIsFull && !feedWorkflowBusy\);/);
  assert.match(source, /const canBulkImport = Boolean\(selectedFeed && bulkPeopleText\.trim\(\) && !feedWorkflowBusy\);/);
  assert.match(addFeed, /if \(!newFeedName\.trim\(\)\) \{\s+return;\s+\}/);
  assert.match(addPerson, /if \(!selectedFeed \|\| !newPersonUrl\.trim\(\) \|\| selectedFeedIsFull\) \{\s+return;\s+\}/);
  assert.doesNotMatch(bulkImport, /setError\("This feed is full\. Remove someone before importing new profiles\."\)/);
  assert.doesNotMatch(bulkImport, /selectedFeedIsFull\) \{\s+setError/);
  assert.match(source, /<button type="submit" aria-label="Create feed" disabled=\{!canCreateFeed\}>/);
  assert.match(source, /<button type="submit" className="secondary" disabled=\{!canAddPerson\}>/);
  assert.match(bulkImportControl, /disabled=\{!canBulkImport\}/);
  assert.match(bulkImportControl, /Existing profiles can still be checked, but new profiles will be skipped\./);
  assert.match(source, /Remove someone before adding a new profile; bulk import can still\s+check existing profiles and will skip new ones\./);
});

test("desktop layout constrains long feed and person text around controls", () => {
  const css = fs.readFileSync(stylesSourcePath, "utf8");

  assert.match(css, /button span \{[\s\S]*min-width: 0;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
  assert.match(css, /\.brand > div:last-child \{[\s\S]*min-width: 0;/);
  assert.match(css, /\.brand strong,\s+\.brand span \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
  assert.match(css, /\.feed-row span \{[\s\S]*min-width: 0;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
  assert.match(css, /\.feed-row small \{[\s\S]*flex: 0 0 auto;/);
  assert.match(css, /\.person-heading > div:first-child \{[\s\S]*min-width: 0;/);
  assert.match(css, /\.icon-actions \{[\s\S]*flex: 0 0 auto;/);
  assert.match(css, /\.membership-editor label span \{[\s\S]*min-width: 0;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
  assert.match(css, /\.topbar > div:first-child \{[\s\S]*min-width: 0;/);
  assert.match(css, /\.topbar h1 \{[\s\S]*overflow-wrap: anywhere;/);
  assert.match(css, /\.refresh-panel > div:first-child \{[\s\S]*min-width: 0;/);
  assert.match(css, /\.item-meta \{[\s\S]*min-width: 0;/);
  assert.match(css, /\.item-meta > div:last-child \{[\s\S]*min-width: 0;/);
  assert.match(css, /\.queue-item p \{[\s\S]*overflow-wrap: anywhere;/);
});

test("feed workflows serialize structural writes", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const runFeedWorkflowAction = source.slice(source.indexOf("async function runFeedWorkflowAction"), source.indexOf("function flushDeferredQuietLoad"));
  const addFeed = source.slice(source.indexOf("async function addFeed"), source.indexOf("async function saveFeedSettings"));
  const saveFeed = source.slice(source.indexOf("async function saveFeedSettings"), source.indexOf("async function removeSelectedFeed"));
  const removeFeed = source.slice(source.indexOf("async function removeSelectedFeed"), source.indexOf("async function addPersonToSelectedFeed"));
  const addPerson = source.slice(source.indexOf("async function addPersonToSelectedFeed"), source.indexOf("async function bulkImportPeople"));
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const removeFromFeed = source.slice(
    source.indexOf("async function removePersonFromSelectedFeed"),
    source.indexOf("async function removePersonEverywhere"),
  );
  const deleteEverywhere = source.slice(source.indexOf("async function removePersonEverywhere"), source.indexOf("async function launchWorkspace"));
  const startRefresh = source.slice(source.indexOf("async function startRefresh"), source.indexOf("async function stopRefresh"));
  const stopRefresh = source.slice(source.indexOf("async function stopRefresh"), source.indexOf("async function mark"));
  const personRow = source.slice(source.indexOf("function PersonRow"), source.indexOf("function Counter"));

  assert.match(source, /const FEED_WORKFLOW_BUSY_KEYS = new Set\(\[\s+"add-feed",\s+"save-feed",\s+"delete-feed",\s+"add-person",\s+"bulk-import",\s+"start-refresh",\s+"stop-refresh",\s+\]\);/);
  assert.match(source, /const FEED_WORKFLOW_BUSY_PREFIXES = \["membership-", "remove-", "delete-person-"\];/);
  assert.match(source, /function isFeedWorkflowBusy\(keys: ReadonlySet<string>, exceptKey = ""\)/);
  assert.match(runFeedWorkflowAction, /if \(isFeedWorkflowBusy\(busyKeysRef\.current, key\)\) \{\s+setNotice\("Finish the current feed update first\."\);\s+return;\s+\}/);
  assert.match(runFeedWorkflowAction, /await runAction\(key, action, successMessage\);/);
  assert.match(addFeed, /await runFeedWorkflowAction\("add-feed", async \(\) =>/);
  assert.match(saveFeed, /await runFeedWorkflowAction\(\s+"save-feed",/);
  assert.match(removeFeed, /await runFeedWorkflowAction\("delete-feed", async \(\) =>/);
  assert.match(addPerson, /await runFeedWorkflowAction\(\s+"add-person",/);
  assert.match(bulkImport, /await runFeedWorkflowAction\("bulk-import", async \(\) =>/);
  assert.match(toggleMembership, /await runFeedWorkflowAction\(`membership-\$\{person\.id\}`, async \(\) =>/);
  assert.match(removeFromFeed, /await runFeedWorkflowAction\(`remove-\$\{person\.id\}`, async \(\) =>/);
  assert.match(deleteEverywhere, /await runFeedWorkflowAction\(`delete-person-\$\{person\.id\}`, async \(\) =>/);
  assert.match(startRefresh, /await runFeedWorkflowAction\(\s+"start-refresh",/);
  assert.match(stopRefresh, /await runFeedWorkflowAction\(\s+"stop-refresh",/);
  assert.match(source, /feedWorkflowBusy=\{feedWorkflowBusy\}/);
  assert.match(source, /<button className="danger" onClick=\{removeSelectedFeed\} disabled=\{!selectedFeed \|\| feedWorkflowBusy\}>/);
  assert.match(source, /<RefreshProgress session=\{activeRefresh\} onStop=\{\(\) => stopRefresh\(activeRefresh\)\} isStopping=\{feedWorkflowBusy\} \/>/);
  assert.match(source, /isStopping=\{feedWorkflowBusy\}/);
  assert.match(personRow, /feedWorkflowBusy: boolean;/);
  assert.match(personRow, /const rowWorkflowBusy = feedWorkflowBusy \|\| membershipBusy \|\| removeBusy \|\| deleteBusy;/);
  assert.match(personRow, /disabled=\{rowWorkflowBusy\}/);
  assert.match(personRow, /disabled=\{rowWorkflowBusy \|\| fullFeedAddBlocked\}/);
});

test("feed and person forms only clear unchanged submitted text", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const addFeed = source.slice(source.indexOf("async function addFeed"), source.indexOf("async function saveFeedSettings"));
  const addPerson = source.slice(source.indexOf("async function addPersonToSelectedFeed"), source.indexOf("async function bulkImportPeople"));

  assert.match(source, /const newFeedNameRef = useRef\(""\);/);
  assert.match(source, /const newPersonNameRef = useRef\(""\);/);
  assert.match(source, /const newPersonUrlRef = useRef\(""\);/);
  assert.match(source, /newFeedNameRef\.current = newFeedName;/);
  assert.match(source, /newPersonNameRef\.current = newPersonName;/);
  assert.match(source, /newPersonUrlRef\.current = newPersonUrl;/);
  assert.match(addFeed, /const newFeedNameAtSubmit = newFeedName;/);
  assert.match(addFeed, /const feedIdAtSubmit = queueViewRef\.current\.feedId;/);
  assert.match(addFeed, /createFeed\(newFeedNameAtSubmit\.trim\(\)\)/);
  assert.match(addFeed, /if \(newFeedNameRef\.current === newFeedNameAtSubmit\) \{\s+setNewFeedName\(""\);/);
  assert.match(addPerson, /const newPersonNameAtSubmit = newPersonName;/);
  assert.match(addPerson, /const newPersonUrlAtSubmit = newPersonUrl;/);
  assert.match(addPerson, /name: newPersonNameAtSubmit\.trim\(\) \|\| "LinkedIn member"/);
  assert.match(addPerson, /profileUrl: newPersonUrlAtSubmit\.trim\(\)/);
  assert.match(addPerson, /if \(newPersonNameRef\.current === newPersonNameAtSubmit\) \{\s+setNewPersonName\(""\);/);
  assert.match(addPerson, /if \(newPersonUrlRef\.current === newPersonUrlAtSubmit\) \{\s+setNewPersonUrl\(""\);/);
  assert.doesNotMatch(addPerson, /setNewPersonName\(""\);\s+setNewPersonUrl\(""\);/);
});

test("completed feed creation preserves a feed selected while create was in flight", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const addFeed = source.slice(source.indexOf("async function addFeed"), source.indexOf("async function saveFeedSettings"));

  assert.match(addFeed, /const feedIdAtSubmit = queueViewRef\.current\.feedId;/);
  assert.match(addFeed, /const feed = await createFeed\(newFeedNameAtSubmit\.trim\(\)\);/);
  assert.match(addFeed, /if \(queueViewRef\.current\.feedId === feedIdAtSubmit\) \{\s+await loadData\(feed\.id\);\s+return;\s+\}/);
  assert.match(addFeed, /await settlePostWriteRefreshes\(undefined, \[refreshFeeds\(\)\]\);/);
  assert.ok(addFeed.indexOf("await loadData(feed.id);") < addFeed.indexOf("await settlePostWriteRefreshes(undefined, [refreshFeeds()]);"));
  assert.doesNotMatch(addFeed, /await loadData\(feed\.id\);\s+\}\);\s+\}/);
});

test("people manager blocks adding memberships to full feeds but permits removal", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const personRow = source.slice(source.indexOf("function PersonRow"), source.indexOf("function Counter"));

  assert.match(toggleMembership, /const alreadyMember = person\.feedIds\.includes\(feedId\);/);
  assert.match(toggleMembership, /if \(checked === alreadyMember\) \{\s+return;\s+\}/);
  assert.match(toggleMembership, /const targetFeed = feeds\.find\(\(feed\) => feed\.id === feedId\);/);
  assert.match(toggleMembership, /checked && targetFeed && targetFeed\.peopleCount >= MAX_PEOPLE_PER_FEED/);
  assert.match(toggleMembership, /Remove someone before adding a new profile\./);
  assert.match(personRow, /const isMember = person\.feedIds\.includes\(feed\.id\);/);
  assert.match(personRow, /const fullFeedAddBlocked = feed\.peopleCount >= MAX_PEOPLE_PER_FEED && !isMember;/);
  assert.match(personRow, /title=\{fullFeedAddBlocked \? "This feed is full\. Remove someone before adding a new profile\." : undefined\}/);
  assert.match(personRow, /const rowWorkflowBusy = feedWorkflowBusy \|\| membershipBusy \|\| removeBusy \|\| deleteBusy;/);
  assert.match(personRow, /disabled=\{rowWorkflowBusy \|\| fullFeedAddBlocked\}/);
});

test("membership workflows update visible feed counts from confirmed changes", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const helper = source.slice(source.indexOf("function applyFeedMembershipCountChange"), source.indexOf("function applyDeletedPerson"));
  const addPerson = source.slice(source.indexOf("async function addPersonToSelectedFeed"), source.indexOf("async function bulkImportPeople"));
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const removeFromFeed = source.slice(
    source.indexOf("async function removePersonFromSelectedFeed"),
    source.indexOf("async function removePersonEverywhere"),
  );
  const deleteEverywhere = source.slice(source.indexOf("async function removePersonEverywhere"), source.indexOf("async function launchWorkspace"));

  assert.match(helper, /const previous = new Set\(previousFeedIds\.filter\(Boolean\)\);/);
  assert.match(helper, /const next = new Set\(nextFeedIds\.filter\(Boolean\)\);/);
  assert.match(helper, /deltas\.set\(feedId, \(deltas\.get\(feedId\) \?\? 0\) \+ 1\);/);
  assert.match(helper, /deltas\.set\(feedId, \(deltas\.get\(feedId\) \?\? 0\) - 1\);/);
  assert.match(helper, /function applyFeedCountDeltas\(deltas: Map<string, number>\)/);
  assert.match(helper, /setFeeds\(\(currentFeeds\) =>/);
  assert.match(helper, /Math\.max\(0, Math\.min\(MAX_PEOPLE_PER_FEED, feed\.peopleCount \+ delta\)\)/);
  assert.match(addPerson, /!isLoading &&\s+!view\.search &&\s+!people\.some\(\(person\) => person\.id === updatedPerson\.id\) &&\s+updatedPerson\.feedIds\.includes\(feedId\)/);
  assert.match(addPerson, /applyFeedCountDeltas\(new Map\(\[\[feedId, 1\]\]\)\);/);
  assert.match(bulkImport, /applyFeedCountDeltas\(new Map\(\[\[feedId, result\.added\]\]\)\);/);
  assert.match(toggleMembership, /applyFeedMembershipCountChange\(person\.feedIds, updatedPerson\.feedIds\);/);
  assert.match(removeFromFeed, /applyFeedMembershipCountChange\(person\.feedIds, updatedPerson\.feedIds\);/);
  assert.match(deleteEverywhere, /applyFeedMembershipCountChange\(person\.feedIds, \[\]\);/);
});

test("membership edits refresh hidden feed sessions without acknowledging queue progress", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const changedHelper = source.slice(
    source.indexOf("function changedMembershipFeedIds"),
    source.indexOf("function applyFeedMembershipCountChange"),
  );
  const refreshSessions = source.slice(
    source.indexOf("async function refreshSessionsForFeed"),
    source.indexOf("function applyRefreshSessions"),
  );
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const removeFromFeed = source.slice(
    source.indexOf("async function removePersonFromSelectedFeed"),
    source.indexOf("async function removePersonEverywhere"),
  );
  const deleteEverywhere = source.slice(source.indexOf("async function removePersonEverywhere"), source.indexOf("async function launchWorkspace"));

  assert.match(changedHelper, /function changedMembershipFeedIds\(previousFeedIds: string\[\], nextFeedIds: string\[\]\)/);
  assert.match(changedHelper, /return \[\.\.\.new Set\(\[\.\.\.previous, \.\.\.next\]\)\]\.filter\(\(feedId\) => previous\.has\(feedId\) !== next\.has\(feedId\)\);/);
  assert.match(refreshSessions, /async function refreshSessionsForFeed\(\s+feedId: string,\s+options: \{ applyWhenHidden\?: boolean; refreshQueueOnProgress\?: boolean \} = \{\},\s+\)/);
  assert.match(refreshSessions, /const shouldRefreshQueueOnProgress = options\.refreshQueueOnProgress !== false;/);
  assert.match(refreshSessions, /if \(queueViewRef\.current\.feedId !== feedId\) \{\s+if \(options\.applyWhenHidden\) \{\s+mergeRefreshSessionsForFeed\(feedId, sessions\);\s+\}\s+return;\s+\}/);
  assert.ok(refreshSessions.indexOf("return;") < refreshSessions.indexOf("rememberRefreshSessionSignaturesForFeed(feedId, sessions);"));
  assert.match(toggleMembership, /const changedFeedIds = changedMembershipFeedIds\(person\.feedIds, updatedPerson\.feedIds\);/);
  assert.match(
    toggleMembership,
    /\.\.\.changedFeedIds\.map\(\(changedFeedId\) =>\s+refreshSessionsForFeed\(changedFeedId, \{\s+applyWhenHidden: changedFeedId !== view\.feedId,\s+refreshQueueOnProgress: !\(selectedFeedWasAffected && changedFeedId === view\.feedId\),\s+\}\),\s+\)/,
  );
  assert.doesNotMatch(toggleMembership, /selectedFeedWasAffected \? refreshSessionsForFeed\(view\.feedId\) : Promise\.resolve\(\)/);
  assert.match(removeFromFeed, /const changedFeedIds = changedMembershipFeedIds\(person\.feedIds, updatedPerson\.feedIds\);/);
  assert.match(
    removeFromFeed,
    /\.\.\.changedFeedIds\.map\(\(changedFeedId\) =>\s+refreshSessionsForFeed\(changedFeedId, \{\s+applyWhenHidden: changedFeedId !== view\.feedId,\s+refreshQueueOnProgress: changedFeedId !== feedId,\s+\}\),\s+\)/,
  );
  assert.match(deleteEverywhere, /const changedFeedIds = changedMembershipFeedIds\(person\.feedIds, \[\]\);/);
  assert.match(
    deleteEverywhere,
    /\.\.\.changedFeedIds\.map\(\(changedFeedId\) =>\s+refreshSessionsForFeed\(changedFeedId, \{\s+applyWhenHidden: changedFeedId !== view\.feedId,\s+refreshQueueOnProgress: changedFeedId !== view\.feedId,\s+\}\),\s+\)/,
  );
});

test("people writes repair the current search when it changes during the request", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const helper = source.slice(source.indexOf("function refreshPeopleForMovedSearch"), source.indexOf("async function refreshQueueForFeed"));
  const addPerson = source.slice(source.indexOf("async function addPersonToSelectedFeed"), source.indexOf("async function bulkImportPeople"));
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const removeFromFeed = source.slice(
    source.indexOf("async function removePersonFromSelectedFeed"),
    source.indexOf("async function removePersonEverywhere"),
  );
  const deleteEverywhere = source.slice(source.indexOf("async function removePersonEverywhere"), source.indexOf("async function launchWorkspace"));

  assert.match(helper, /function refreshPeopleForMovedSearch\(view: \{ feedId: string; search: string \}\)/);
  assert.match(helper, /queueViewRef\.current\.feedId !== view\.feedId \|\| peopleSearchRef\.current === view\.search/);
  assert.match(helper, /return refreshPeopleForFeed\(view\.feedId, peopleSearchRef\.current, \{ refreshFeeds: false \}\);/);
  assert.match(addPerson, /refreshPeopleForMovedSearch\(view\),/);
  assert.match(bulkImport, /const view = currentPeopleView\(\);/);
  assert.match(bulkImport, /refreshPeopleForFeed\(feedId, view\.search\),\s+refreshPeopleForMovedSearch\(view\),/);
  assert.match(toggleMembership, /refreshPeopleForMovedSearch\(view\),/);
  assert.match(removeFromFeed, /refreshPeopleForMovedSearch\(view\),/);
  assert.match(deleteEverywhere, /refreshPeopleForMovedSearch\(view\),/);
});

test("queue status actions backfill the visible batch", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const mark = source.slice(source.indexOf("async function mark"), source.indexOf("async function backfillQueueAfterStatusRemoval"));
  const backfill = source.slice(
    source.indexOf("async function backfillQueueAfterStatusRemoval"),
    source.indexOf("function applyQueueStatusChange"),
  );

  assert.match(source, /const loadedCountAtClick = items\.length;/);
  assert.match(source, /const lastLoadedItemAtClick = items\[items\.length - 1\];/);
  assert.match(source, /const visibleTotalAtClick = visibleQueueTotal;/);
  assert.match(source, /change\.previousStatus === statusAtClick && change\.status !== statusAtClick/);
  assert.match(source, /backfillQueueAfterStatusRemoval\(feedIdAtClick, statusAtClick, \{/);
  assert.match(source, /lastLoadedItemAtClick,/);
  assert.match(mark, /\.catch\(\(error\) => \{\s+if \(isRequestCanceledError\(error\)\) \{\s+return;\s+\}\s+requestDeferredQuietLoad\(\);\s+\}\);/);
  assert.match(backfill, /const desiredVisibleCount = Math\.min\(context\.loadedCountAtClick, nextVisibleTotal\);/);
  assert.match(backfill, /const missingCount = Math\.max\(0, desiredVisibleCount - itemsRef\.current\.length\);/);
  assert.match(backfill, /const cursor = itemsRef\.current\[itemsRef\.current\.length - 1\] \?\? context\.lastLoadedItemAtClick;/);
  assert.match(backfill, /const actionMutationVersionAtBackfillStart = actionMutationVersionRef\.current;/);
  assert.match(backfill, /const read = beginTargetedRead\(`queue:\$\{feedId\}`\);/);
  assert.match(backfill, /getQueueView\(feedId, status, \{ limit: missingCount, after: cursor, signal: read\.signal \}\)/);
  assert.match(backfill, /finally \{\s+read\.finish\(\);/);
  assert.match(backfill, /actionMutationVersionAtBackfillStart !== actionMutationVersionRef\.current/);
  assert.match(backfill, /const currentMissingCount = Math\.max\(0, desiredVisibleCount - itemsRef\.current\.length\);/);
  assert.match(backfill, /const backfillItems = queueView\.items\.slice\(0, currentMissingCount\);/);
  assert.match(backfill, /const addedCount = appendQueueItems\(backfillItems\);/);
  assert.match(backfill, /requestDeferredQuietLoad\(\);\s+return;/);
  assert.doesNotMatch(source, /listQueue\(feedId, status, \{ limit: 1, after: context\.lastLoadedItemAtClick \}\)/);
  assert.doesNotMatch(source, /listQueue\(feedId, status, \{ limit: 1, offset: context\.loadedCountAtClick - 1 \}\)/);
  assert.match(source, /loadDataRequestRef\.current !== context\.loadDataRequestId/);
  assert.match(source, /function appendQueueItems\(nextItems: QueueItem\[\]\)/);
  assert.match(source, /replaceQueueItems\(mergeQueueItems\(itemsRef\.current, nextItems\)\);/);
  assert.match(source, /function queueAppendNeedsRepair\(nextItems: QueueItem\[\], addedCount: number, visibleCount: number, totalCount: number\)/);
});

test("queue status actions wait for feed workflows", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const mark = source.slice(source.indexOf("async function mark"), source.indexOf("async function backfillQueueAfterStatusRemoval"));
  const queueItems = source.slice(source.indexOf("{items.map((item) =>"), source.indexOf("{hasMoreQueueItems &&"));

  assert.match(source, /const QUEUE_STATUS_BUSY_KEY = "queue-status";/);
  assert.match(source, /const queueStatusBusy = isBusy\(QUEUE_STATUS_BUSY_KEY\);/);
  assert.match(source, /const loadMoreQueueBusy = isBusy\("load-more-queue"\);/);
  assert.match(mark, /if \(isFeedWorkflowBusy\(busyKeysRef\.current\)\) \{\s+setNotice\("Finish the current feed update first\."\);\s+return;\s+\}/);
  assert.match(mark, /if \(busyKeysRef\.current\.has\(QUEUE_STATUS_BUSY_KEY\)\) \{\s+setNotice\("Finish the current queue item update first\."\);\s+return;\s+\}/);
  assert.match(mark, /if \(busyKeysRef\.current\.has\("load-more-queue"\)\) \{\s+setNotice\("Finish loading more queue items first\."\);\s+return;\s+\}/);
  assert.match(mark, /await runAction\(QUEUE_STATUS_BUSY_KEY, async \(\) => \{/);
  assert.doesNotMatch(mark, /await runAction\(`item-\$\{item\.id\}`, async \(\) => \{/);
  assert.match(queueItems, /const itemStatusBusy = feedWorkflowBusy \|\| queueStatusBusy \|\| loadMoreQueueBusy;/);
  assert.match(queueItems, /onClick=\{\(\) => mark\(item, "new"\)\} disabled=\{itemStatusBusy\}/);
  assert.match(queueItems, /onClick=\{\(\) => mark\(item, "skipped"\)\} disabled=\{itemStatusBusy\}/);
  assert.match(queueItems, /onClick=\{\(\) => mark\(item, "done"\)\} disabled=\{itemStatusBusy\}/);
  assert.doesNotMatch(source, /isItemStatusBusy\(item\.id\)/);
});

test("invalidated queue backfills schedule one quiet repair load", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const requestDeferredQuietLoad = source.slice(source.indexOf("function requestDeferredQuietLoad"), source.indexOf("function currentPeopleView"));
  const backfill = source.slice(
    source.indexOf("async function backfillQueueAfterStatusRemoval"),
    source.indexOf("function applyQueueStatusChange"),
  );

  assert.doesNotMatch(requestDeferredQuietLoad, /if \(!currentDeferredLoadFeedId\(\)\) \{\s+return;\s+\}/);
  assert.match(requestDeferredQuietLoad, /deferredQuietLoadFeedIdRef\.current = feedId \|\| deferredQuietLoadFeedIdRef\.current \|\| currentDeferredLoadFeedId\(\) \|\| undefined;/);
  assert.match(requestDeferredQuietLoad, /deferredQuietLoadRef\.current = true;\s+flushDeferredQuietLoad\(\);/);
  assert.match(backfill, /if \(currentView\.feedId !== feedId \|\| currentView\.status !== status\) \{\s+return;\s+\}/);
  assert.match(
    backfill,
    /if \(actionMutationVersionAtBackfillStart !== actionMutationVersionRef\.current \|\| loadDataRequestRef\.current !== context\.loadDataRequestId\) \{\s+requestDeferredQuietLoad\(\);\s+return;\s+\}/,
  );
});

test("quiet background reload failures do not replace visible action errors", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));
  const runAction = source.slice(source.indexOf("async function runAction"), source.indexOf("function currentPeopleView"));

  assert.match(source, /const quietLoadDataRequestRef = useRef\(0\);/);
  assert.match(source, /const actionMutationVersionRef = useRef\(0\);/);
  assert.match(loadData, /const foregroundRequestIdAtStart = loadDataRequestRef\.current;/);
  assert.match(loadData, /const actionMutationVersionAtStart = actionMutationVersionRef\.current;/);
  assert.match(loadData, /const requestId = options\.quiet \? \+\+quietLoadDataRequestRef\.current : \+\+loadDataRequestRef\.current;/);
  assert.match(
    loadData,
    /requestId !== quietLoadDataRequestRef\.current \|\|\s+foregroundRequestIdAtStart !== loadDataRequestRef\.current/,
  );
  assert.match(loadData, /actionMutationVersionAtStart !== actionMutationVersionRef\.current \|\|\s+busyKeysRef\.current\.size > 0/);
  assert.match(loadData, /if \(!options\.quiet\) \{\s+clearDeferredQuietLoadRetry\(\);\s+activeLoadingRequestRef\.current = requestId;/);
  assert.match(loadData, /catch \(nextError\) \{\s+if \(!options\.quiet && requestId === loadDataRequestRef\.current\) \{/);
  assert.doesNotMatch(loadData, /catch \(nextError\) \{\s+if \(requestId === loadDataRequestRef\.current\) \{/);
  assert.match(runAction, /busyKeysRef\.current = new Set\(busyKeysRef\.current\)\.add\(key\);\s+actionMutationVersionRef\.current \+= 1;/);
  assert.match(runAction, /busyKeysRef\.current = next;\s+actionMutationVersionRef\.current \+= 1;/);
});

test("stale action completions do not overwrite newer messages", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const runAction = source.slice(source.indexOf("async function runAction"), source.indexOf("async function runFeedWorkflowAction"));

  assert.match(source, /const actionMessageVersionRef = useRef\(0\);/);
  assert.match(runAction, /const actionMessageVersion = \+\+actionMessageVersionRef\.current;/);
  assert.match(runAction, /if \(successMessage && actionMessageVersionRef\.current === actionMessageVersion\) \{\s+setNotice\(successMessage\);/);
  assert.match(runAction, /catch \(nextError\) \{\s+if \(isRequestCanceledError\(nextError\)\) \{\s+return;\s+\}\s+if \(actionMessageVersionRef\.current === actionMessageVersion\) \{\s+setActionError\(errorMessage\(nextError\)\);/);
  assert.doesNotMatch(runAction, /catch \(nextError\) \{\s+setError\(errorMessage\(nextError\)\);/);
});

test("action errors clear stale load-error ownership", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const runAction = source.slice(source.indexOf("async function runAction"), source.indexOf("async function runFeedWorkflowAction"));
  const errorHelpers = source.slice(source.indexOf("function clearVisibleError"), source.indexOf("function requestConnectivityRecoveryLoad"));
  const saveFeed = source.slice(source.indexOf("async function saveFeedSettings"), source.indexOf("async function removeSelectedFeed"));
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const launchWorkspace = source.slice(source.indexOf("async function launchWorkspace"), source.indexOf("async function startRefresh"));
  const startRefresh = source.slice(source.indexOf("async function startRefresh"), source.indexOf("async function stopRefresh"));

  assert.match(errorHelpers, /function clearVisibleError\(\) \{\s+loadDataErrorRef\.current = false;\s+setError\(""\);/);
  assert.match(errorHelpers, /function setActionError\(message: string\) \{\s+loadDataErrorRef\.current = false;\s+setError\(message\);/);
  assert.match(errorHelpers, /function setLoadDataError\(message: string\) \{\s+loadDataErrorRef\.current = true;\s+setError\(message\);/);
  assert.match(errorHelpers, /function clearLoadDataError\(\) \{\s+if \(loadDataErrorRef\.current\) \{\s+loadDataErrorRef\.current = false;\s+setError\(""\);/);
  assert.match(runAction, /clearVisibleError\(\);\s+setNotice\(""\);/);
  assert.match(runAction, /setActionError\(errorMessage\(nextError\)\);/);
  assert.match(saveFeed, /setActionError\("Feed name is required\."\);/);
  assert.match(saveFeed, /setActionError\("Lookback must be a number between 1 and 365 days\."\);/);
  assert.match(toggleMembership, /setActionError\(`"\$\{targetFeed\.name\}" already has \$\{MAX_PEOPLE_PER_FEED\} people\. Remove someone before adding a new profile\.`\);/);
  assert.match(launchWorkspace, /clearVisibleError\(\);/);
  assert.match(launchWorkspace, /setActionError\(message\);/);
  assert.match(startRefresh, /setActionError\("This feed no longer exists\. Pick another feed before refreshing LinkedIn\."\);/);
  assert.match(startRefresh, /setActionError\("Add at least one person to this feed before refreshing LinkedIn\."\);/);
});

test("failed quiet repair reloads retry without surfacing stale errors", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));
  const loadDataCatch = loadData.slice(loadData.indexOf("} catch (nextError)"), loadData.indexOf("} finally"));
  const flushDeferredQuietLoad = source.slice(source.indexOf("function flushDeferredQuietLoad"), source.indexOf("function requestDeferredQuietLoad"));
  const scheduleRetry = source.slice(
    source.indexOf("function scheduleDeferredQuietLoadRetry"),
    source.indexOf("function clearDeferredQuietLoadRetry"),
  );
  const clearRetry = source.slice(
    source.indexOf("function clearDeferredQuietLoadRetry"),
    source.indexOf("function requestDeferredQuietLoad"),
  );

  assert.match(source, /const DEFERRED_QUIET_RETRY_DELAYS_MS = \[2000, 5000, 15000\];/);
  assert.match(source, /const deferredQuietLoadFeedIdRef = useRef<string \| undefined>\(undefined\);/);
  assert.match(source, /const deferredQuietLoadRetryTimerRef = useRef<number \| undefined>\(undefined\);/);
  assert.match(source, /const deferredQuietLoadRetryAttemptRef = useRef\(0\);/);
  assert.match(loadData, /if \(!options\.quiet\) \{\s+clearDeferredQuietLoadRetry\(\);/);
  assert.match(loadData, /setQueueCounts\(nextQueueCounts\);\s+clearDeferredQuietLoadRetry\(\);/);
  assert.match(
    loadData,
    /else if \(\s+options\.quiet &&\s+requestId === quietLoadDataRequestRef\.current &&\s+foregroundRequestIdAtStart === loadDataRequestRef\.current &&\s+actionMutationVersionAtStart === actionMutationVersionRef\.current &&\s+busyKeysRef\.current\.size === 0\s+\) \{\s+deferredQuietLoadFeedIdRef\.current = requestedFeedId;\s+deferredQuietLoadRef\.current = true;\s+scheduleDeferredQuietLoadRetry\(\);/,
  );
  assert.doesNotMatch(loadDataCatch, /if \(options\.quiet[\s\S]+setError\(errorMessage\(nextError\)\)/);
  assert.match(flushDeferredQuietLoad, /if \(deferredQuietLoadRetryTimerRef\.current !== undefined\) \{\s+return;\s+\}/);
  assert.match(scheduleRetry, /DEFERRED_QUIET_RETRY_DELAYS_MS\[\s+Math\.min\(deferredQuietLoadRetryAttemptRef\.current, DEFERRED_QUIET_RETRY_DELAYS_MS\.length - 1\)\s+\]/);
  assert.match(scheduleRetry, /deferredQuietLoadRetryAttemptRef\.current \+= 1;/);
  assert.match(scheduleRetry, /deferredQuietLoadRetryTimerRef\.current = window\.setTimeout\(\(\) => \{\s+deferredQuietLoadRetryTimerRef\.current = undefined;\s+flushDeferredQuietLoad\(\);/);
  assert.match(clearRetry, /window\.clearTimeout\(deferredQuietLoadRetryTimerRef\.current\);/);
  assert.match(clearRetry, /deferredQuietLoadRetryAttemptRef\.current = 0;/);
  assert.match(
    source,
    /useEffect\(\s+\(\) => \(\) => \{\s+clearDeferredQuietLoadRetry\(\);\s+foregroundLoadAbortRef\.current\?\.abort\(\);\s+quietLoadAbortRef\.current\?\.abort\(\);\s+abortTargetedReads\(\);\s+\},\s+\[\],\s+\);/,
  );
});

test("focus and online recovery retry failed quiet loads conservatively", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));
  const recovery = source.slice(source.indexOf("function requestConnectivityRecoveryLoad"), source.indexOf("function currentPeopleView"));
  const recoveryEffect = source.slice(
    source.indexOf('window.addEventListener("online", recover)') - 180,
    source.indexOf("useEffect(() => {", source.indexOf('document.removeEventListener("visibilitychange", recoverWhenVisible);')),
  );

  assert.match(source, /const CONNECTIVITY_RECOVERY_RELOAD_COOLDOWN_MS = 10000;/);
  assert.match(source, /const selectedFeedIdRef = useRef<string \| undefined>\(undefined\);/);
  assert.match(source, /const loadDataErrorRef = useRef\(false\);/);
  assert.match(source, /const isLoadingRef = useRef\(true\);/);
  assert.match(source, /const isLaunchingRef = useRef\(false\);/);
  assert.match(source, /const connectivityRecoveryReloadAtRef = useRef\(0\);/);
  assert.match(loadData, /clearLoadDataError\(\);/);
  assert.match(loadData, /if \(!options\.quiet && requestId === loadDataRequestRef\.current\) \{\s+setLoadDataError\(errorMessage\(nextError\)\);/);
  assert.match(recovery, /if \(!deferredQuietLoadRef\.current && !loadDataErrorRef\.current\) \{\s+return;\s+\}/);
  assert.match(recovery, /if \(busyKeysRef\.current\.size > 0\) \{\s+deferredQuietLoadRef\.current = true;\s+return;\s+\}/);
  assert.match(recovery, /if \(isLoadingRef\.current \|\| isLaunchingRef\.current\) \{\s+return;\s+\}/);
  assert.match(recovery, /now - connectivityRecoveryReloadAtRef\.current < CONNECTIVITY_RECOVERY_RELOAD_COOLDOWN_MS/);
  assert.match(recovery, /const feedId = deferredQuietLoadFeedIdRef\.current \|\| currentDeferredLoadFeedId\(\);/);
  assert.match(recovery, /if \(feedId\) \{\s+deferredQuietLoadRef\.current = false;\s+deferredQuietLoadFeedIdRef\.current = undefined;\s+loadData\(feedId, \{ quiet: true \}\)\.catch\(console\.error\);\s+return;\s+\}/);
  assert.match(recovery, /deferredQuietLoadRef\.current = false;\s+deferredQuietLoadFeedIdRef\.current = undefined;\s+loadData\(undefined, \{ quiet: true \}\)\.catch\(console\.error\);/);
  assert.match(recovery, /function currentDeferredLoadFeedId\(\) \{\s+return queueViewRef\.current\.feedId \|\| selectedFeedIdRef\.current;\s+\}/);
  assert.match(source, /selectedFeedIdRef\.current = selectedFeedId;/);
  assert.doesNotMatch(source, /errorRef/);
  assert.match(source, /isLoadingRef\.current = isLoading;/);
  assert.match(source, /isLaunchingRef\.current = isLaunching;/);
  assert.match(recoveryEffect, /window\.addEventListener\("online", recover\);/);
  assert.match(recoveryEffect, /window\.addEventListener\("focus", recover\);/);
  assert.match(recoveryEffect, /document\.visibilityState === "visible"/);
  assert.match(recoveryEffect, /document\.addEventListener\("visibilitychange", recoverWhenVisible\);/);
  assert.match(recoveryEffect, /window\.removeEventListener\("online", recover\);/);
  assert.match(recoveryEffect, /window\.removeEventListener\("focus", recover\);/);
  assert.match(recoveryEffect, /document\.removeEventListener\("visibilitychange", recoverWhenVisible\);/);
});

test("quiet reloads blocked by actions are replayed after the app settles", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));
  const runAction = source.slice(source.indexOf("async function runAction"), source.indexOf("function flushDeferredQuietLoad"));
  const flushDeferredQuietLoad = source.slice(source.indexOf("function flushDeferredQuietLoad"), source.indexOf("function currentPeopleView"));
  const requestDeferredQuietLoad = source.slice(source.indexOf("function requestDeferredQuietLoad"), source.indexOf("function currentPeopleView"));

  assert.match(source, /const deferredQuietLoadRef = useRef\(false\);/);
  assert.match(loadData, /const quietRequestWasBlockedByAction =\s+Boolean\(options\.quiet\) &&/);
  assert.match(loadData, /foregroundRequestIdAtStart === loadDataRequestRef\.current &&/);
  assert.match(loadData, /requestId === quietLoadDataRequestRef\.current &&/);
  assert.match(loadData, /actionMutationVersionAtStart !== actionMutationVersionRef\.current \|\| busyKeysRef\.current\.size > 0/);
  assert.match(loadData, /if \(quietRequestWasBlockedByAction && !viewChangedSinceRequest\) \{\s+deferredQuietLoadFeedIdRef\.current = requestedFeedId;\s+deferredQuietLoadRef\.current = true;\s+flushDeferredQuietLoad\(\);/);
  assert.match(runAction, /if \(next\.size === 0\) \{\s+flushDeferredQuietLoad\(\);\s+refreshPollKickRef\.current\(\);/);
  assert.match(flushDeferredQuietLoad, /if \(!deferredQuietLoadRef\.current \|\| busyKeysRef\.current\.size > 0\) \{\s+return;\s+\}/);
  assert.match(flushDeferredQuietLoad, /const feedId = deferredQuietLoadFeedIdRef\.current \|\| currentDeferredLoadFeedId\(\);/);
  assert.match(flushDeferredQuietLoad, /function currentDeferredLoadFeedId\(\) \{\s+return queueViewRef\.current\.feedId \|\| selectedFeedIdRef\.current;\s+\}/);
  assert.doesNotMatch(flushDeferredQuietLoad, /queueViewRef\.current\.feedId \|\| selectedFeedId;/);
  assert.match(flushDeferredQuietLoad, /deferredQuietLoadRef\.current = false;\s+deferredQuietLoadFeedIdRef\.current = undefined;\s+loadData\(feedId \|\| undefined, \{ quiet: true \}\)\.catch\(console\.error\);/);
  assert.match(requestDeferredQuietLoad, /deferredQuietLoadRef\.current = true;\s+flushDeferredQuietLoad\(\);/);
});

test("deferred quiet reloads keep global and targeted repairs retryable", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));
  const flushDeferredQuietLoad = source.slice(source.indexOf("function flushDeferredQuietLoad"), source.indexOf("function scheduleDeferredQuietLoadRetry"));
  const requestDeferredQuietLoad = source.slice(source.indexOf("function requestDeferredQuietLoad"), source.indexOf("function beginTargetedRead"));
  const requestForFeed = source.slice(source.indexOf("function requestDeferredQuietLoadForFeed"), source.indexOf("function beginTargetedRead"));

  assert.match(source, /const deferredQuietLoadFeedIdRef = useRef<string \| undefined>\(undefined\);/);
  assert.match(loadData, /if \(quietRequestWasBlockedByAction && !viewChangedSinceRequest\) \{\s+deferredQuietLoadFeedIdRef\.current = requestedFeedId;\s+deferredQuietLoadRef\.current = true;/);
  assert.match(loadData, /deferredQuietLoadFeedIdRef\.current = requestedFeedId;\s+deferredQuietLoadRef\.current = true;\s+scheduleDeferredQuietLoadRetry\(\);/);
  assert.match(flushDeferredQuietLoad, /const feedId = deferredQuietLoadFeedIdRef\.current \|\| currentDeferredLoadFeedId\(\);/);
  assert.doesNotMatch(flushDeferredQuietLoad, /if \(!feedId\) \{\s+deferredQuietLoadRef\.current = false;/);
  assert.match(flushDeferredQuietLoad, /deferredQuietLoadFeedIdRef\.current = undefined;\s+loadData\(feedId \|\| undefined, \{ quiet: true \}\)\.catch\(console\.error\);/);
  assert.match(requestDeferredQuietLoad, /function requestDeferredQuietLoad\(feedId\?: string\)/);
  assert.match(requestDeferredQuietLoad, /deferredQuietLoadFeedIdRef\.current = feedId \|\| deferredQuietLoadFeedIdRef\.current \|\| currentDeferredLoadFeedId\(\) \|\| undefined;/);
  assert.doesNotMatch(requestDeferredQuietLoad, /return;\s+}\s+deferredQuietLoadRef\.current = true;/);
  assert.match(requestForFeed, /requestDeferredQuietLoad\(feedId \|\| currentFeedId \|\| undefined\);/);
});

test("post-write refresh failures schedule quiet repair without failing the action", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const helper = source.slice(source.indexOf("async function settlePostWriteRefreshes"), source.indexOf("function applyRefreshSessions"));
  const addFeed = source.slice(source.indexOf("async function addFeed"), source.indexOf("async function saveFeedSettings"));
  const saveFeed = source.slice(source.indexOf("async function saveFeedSettings"), source.indexOf("async function removeSelectedFeed"));
  const addPerson = source.slice(source.indexOf("async function addPersonToSelectedFeed"), source.indexOf("async function bulkImportPeople"));
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const removeFromFeed = source.slice(
    source.indexOf("async function removePersonFromSelectedFeed"),
    source.indexOf("async function removePersonEverywhere"),
  );
  const deleteEverywhere = source.slice(source.indexOf("async function removePersonEverywhere"), source.indexOf("async function launchWorkspace"));

  assert.match(helper, /const results = await Promise\.allSettled\(refreshes\);/);
  assert.match(helper, /results\.some\(\(result\) => result\.status === "rejected" && !isRequestCanceledError\(result\.reason\)\)/);
  assert.match(helper, /requestDeferredQuietLoadForFeed\(feedId\);/);
  assert.match(addFeed, /await settlePostWriteRefreshes\(undefined, \[refreshFeeds\(\)\]\);/);
  assert.match(saveFeed, /await settlePostWriteRefreshes\(feedIdAtSave, \[/);
  assert.match(addPerson, /await settlePostWriteRefreshes\(feedId, \[/);
  assert.match(bulkImport, /await settlePostWriteRefreshes\(feedId, \[/);
  assert.match(toggleMembership, /await settlePostWriteRefreshes\(view\.feedId, \[/);
  assert.match(removeFromFeed, /await settlePostWriteRefreshes\(feedId, \[/);
  assert.match(deleteEverywhere, /await settlePostWriteRefreshes\(view\.feedId, \[/);
});

test("targeted refresh invalidations queue a quiet repair for the active feed", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const requestForFeed = source.slice(source.indexOf("function requestDeferredQuietLoadForFeed"), source.indexOf("function currentPeopleView"));
  const refreshFeeds = source.slice(
    source.indexOf("async function refreshFeeds"),
    source.indexOf("async function refreshPeopleForFeed"),
  );
  const refreshPeople = source.slice(
    source.indexOf("async function refreshPeopleForFeed"),
    source.indexOf("async function refreshQueueForFeed"),
  );
  const refreshQueue = source.slice(
    source.indexOf("async function refreshQueueForFeed"),
    source.indexOf("async function refreshSessionsForFeed"),
  );
  const refreshSessions = source.slice(
    source.indexOf("async function refreshSessionsForFeed"),
    source.indexOf("function applyRefreshSessions"),
  );

  assert.match(requestForFeed, /const currentFeedId = currentDeferredLoadFeedId\(\);/);
  assert.match(requestForFeed, /if \(feedId && currentFeedId && currentFeedId !== feedId\) \{\s+return;\s+\}/);
  assert.doesNotMatch(requestForFeed, /queueViewRef\.current\.feedId && queueViewRef\.current\.feedId !== feedId/);
  assert.match(requestForFeed, /requestDeferredQuietLoad\(feedId \|\| currentFeedId \|\| undefined\);/);
  assert.match(refreshFeeds, /if \(actionMutationVersionAtStart !== actionMutationVersionRef\.current\) \{\s+requestDeferredQuietLoadForFeed\(\);\s+return;\s+\}/);
  assert.match(refreshPeople, /if \(actionMutationVersionAtStart !== actionMutationVersionRef\.current\) \{\s+requestDeferredQuietLoadForFeed\(feedId\);\s+return;\s+\}/);
  assert.match(refreshQueue, /if \(actionMutationVersionAtStart !== actionMutationVersionRef\.current\) \{\s+requestDeferredQuietLoadForFeed\(feedId\);\s+return false;\s+\}/);
  assert.match(refreshSessions, /if \(actionMutationVersionAtStart !== actionMutationVersionRef\.current\) \{\s+requestDeferredQuietLoadForFeed\(feedId\);\s+return;\s+\}/);
});

test("stale feed writes repair selected feed state", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const repairHelper = source.slice(source.indexOf("async function repairStaleFeedAction"), source.indexOf("async function refreshFeeds"));
  const saveFeed = source.slice(source.indexOf("async function saveFeedSettings"), source.indexOf("async function removeSelectedFeed"));
  const addPerson = source.slice(source.indexOf("async function addPersonToSelectedFeed"), source.indexOf("async function bulkImportPeople"));
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));
  const startRefresh = source.slice(source.indexOf("async function startRefresh"), source.indexOf("async function stopRefresh"));
  const staleFeedHelper = source.slice(source.indexOf("function isStaleFeedError"), source.indexOf("function parseBulkPeople"));

  assert.match(repairHelper, /actionMessageVersionRef\.current \+= 1;/);
  assert.match(repairHelper, /setNotice\("That feed was already removed elsewhere\. Feeds repaired\."\);/);
  assert.match(repairHelper, /setFeeds\(\(currentFeeds\) => currentFeeds\.filter\(\(feed\) => feed\.id !== feedId\)\);/);
  assert.match(repairHelper, /if \(queueViewRef\.current\.feedId === feedId \|\| selectedFeedId === feedId\) \{/);
  assert.match(repairHelper, /setSelectedFeedId\(undefined\);/);
  assert.match(repairHelper, /setBulkResult\(undefined\);/);
  assert.match(repairHelper, /await loadData\(null\);/);
  assert.match(repairHelper, /await loadData\(queueViewRef\.current\.feedId \|\| null\);/);
  assert.match(saveFeed, /catch \(nextError\) \{\s+if \(isStaleFeedError\(nextError\)\) \{\s+await repairStaleFeedAction\(feedIdAtSave\);/);
  assert.match(addPerson, /catch \(nextError\) \{\s+if \(isStaleFeedError\(nextError\)\) \{\s+await repairStaleFeedAction\(feedId\);/);
  assert.match(
    bulkImport,
    /if \(isStaleFeedError\(nextError\) \|\| \(nextError instanceof BulkImportPartialError && isStaleFeedError\(nextError\.cause\)\)\) \{\s+await repairStaleFeedAction\(feedId\);\s+return;/,
  );
  assert.match(startRefresh, /if \(isStaleFeedError\(nextError\)\) \{\s+await repairStaleFeedAction\(feedId\);\s+return;\s+\}/);
  assert.match(staleFeedHelper, /error instanceof ApiError && error\.statusCode === 404 && \/Feed not found\/i\.test\(error\.message\)/);
});

test("load data snapshots the requested queue view before async fetches", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));

  assert.match(loadData, /preferredFeedId: string \| null \| undefined = selectedFeedId/);
  assert.match(loadData, /const requestedFeedId = preferredFeedId === null \? undefined : preferredFeedId \|\| queueViewRef\.current\.feedId \|\| selectedFeedId;/);
  assert.match(loadData, /const requestedStatus = queueViewRef\.current\.status;/);
  assert.match(loadData, /const requestedSearch = peopleSearchRef\.current;/);
  assert.match(loadData, /requestedFeedId && nextFeeds\.some\(\(feed\) => feed\.id === requestedFeedId\) \? requestedFeedId : nextFeeds\[0\]\?\.id/);
  assert.match(loadData, /listPeople\(nextSelectedFeedId, requestedSearch, \{ signal: loadSignal \}\)/);
  assert.match(loadData, /getQueueView\(nextSelectedFeedId, requestedStatus, \{ limit: QUEUE_BATCH_SIZE, signal: loadSignal \}\)/);
  assert.match(loadData, /const viewChangedSinceRequest =\s+queueViewRef\.current\.status !== requestedStatus \|\| peopleSearchRef\.current !== requestedSearch;/);
  assert.match(loadData, /if \(requestIsStale \|\| viewChangedSinceRequest\) \{/);
  assert.doesNotMatch(loadData, /listPeople\(nextSelectedFeedId, peopleSearch\)/);
  assert.doesNotMatch(loadData, /getQueueView\(nextSelectedFeedId, queueStatus, \{ limit: QUEUE_BATCH_SIZE \}\)/);
});

test("load data applies the selected feed ref with the loaded snapshot", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));

  assert.match(loadData, /queueViewRef\.current = \{ feedId: nextSelectedFeedId \?\? "", status: requestedStatus \};/);
  assert.match(loadData, /peopleRefreshViewRef\.current = peopleRefreshViewKey\(nextSelectedFeedId, requestedSearch\);/);
  assert.match(loadData, /storageInfoCanApply = true;\s+applyFreshStorageInfo\(\);\s+setFeeds\(nextFeeds\);/);
  assert.ok(loadData.indexOf("queueViewRef.current = { feedId: nextSelectedFeedId ?? \"\", status: requestedStatus };") < loadData.indexOf("setSelectedFeedId(nextSelectedFeedId);"));
});

test("load data keeps feeds usable when optional storage info fails", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));

  assert.match(loadData, /let storageInfoSnapshot: StorageInfo \| undefined;/);
  assert.match(loadData, /let storageInfoCanApply = false;/);
  assert.match(loadData, /function applyFreshStorageInfo\(\)/);
  assert.match(loadData, /const storageInfoRequest = getStorageInfo\(\{ signal: loadSignal \}\)\s+\.then\(\(nextStorageInfo\) => \{\s+storageInfoSnapshot = nextStorageInfo;\s+applyFreshStorageInfo\(\);/);
  assert.match(loadData, /if \(!loadSignal\.aborted && storageInfoCanApply\) \{\s+console\.error\(error\);/);
  assert.match(loadData, /const nextFeeds = await listFeeds\(\{ signal: loadSignal \}\);/);
  assert.match(
    loadData,
    /storageInfoCanApply = true;\s+applyFreshStorageInfo\(\);\s+setFeeds\(nextFeeds\);/,
  );
  assert.match(
    loadData,
    /setQueueCounts\(nextQueueCounts\);\s+clearDeferredQuietLoadRetry\(\);\s+clearLoadDataError\(\);\s+void storageInfoRequest;/,
  );
  assert.ok(loadData.indexOf("const storageInfoRequest = getStorageInfo({ signal: loadSignal })") < loadData.indexOf("const nextFeeds = await listFeeds({ signal: loadSignal });"));
  assert.ok(loadData.indexOf("const nextFeeds = await listFeeds({ signal: loadSignal });") < loadData.indexOf("setFeeds(nextFeeds);"));
  assert.doesNotMatch(loadData, /await Promise\.all\(\[[\s\S]*getStorageInfo\(\)/);
  assert.doesNotMatch(loadData, /nextStorageInfo\]/);
});

test("load data ignores stale optional storage info responses", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));
  const storageGuard = loadData.slice(loadData.indexOf("function applyFreshStorageInfo"), loadData.indexOf("const storageInfoRequest"));

  assert.match(storageGuard, /if \(!storageInfoCanApply \|\| !storageInfoSnapshot\) \{\s+return;\s+\}/);
  assert.match(storageGuard, /const storageRequestIsCurrent = options\.quiet\s+\? requestId === quietLoadDataRequestRef\.current &&\s+foregroundRequestIdAtStart === loadDataRequestRef\.current &&\s+actionMutationVersionAtStart === actionMutationVersionRef\.current &&\s+busyKeysRef\.current\.size === 0\s+: requestId === loadDataRequestRef\.current;/);
  assert.match(storageGuard, /const storageViewStillMatches =\s+queueViewRef\.current\.status === requestedStatus && peopleSearchRef\.current === requestedSearch;/);
  assert.match(storageGuard, /if \(!loadSignal\.aborted && storageRequestIsCurrent && storageViewStillMatches\) \{\s+setStorageInfo\(storageInfoSnapshot\);/);
  assert.ok(loadData.indexOf("storageInfoCanApply = true;") > loadData.indexOf("if (requestIsStale || viewChangedSinceRequest)"));
  assert.doesNotMatch(loadData, /\.then\(\(nextStorageInfo\) => \{\s+setStorageInfo\(nextStorageInfo\);/);
});

test("load data cancels stale foreground and quiet reads", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const refs = source.slice(source.indexOf("const refreshPollPendingRef"), source.indexOf("const selectedFeed = useMemo"));
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));
  const runAction = source.slice(source.indexOf("async function runAction"), source.indexOf("async function runFeedWorkflowAction"));
  const cleanupEffect = source.slice(source.indexOf("useEffect(\n    () => () => {"), source.indexOf("useEffect(() => {\n    selectedFeedIdRef.current"));

  assert.match(refs, /const foregroundLoadAbortRef = useRef<AbortController \| undefined>\(undefined\);/);
  assert.match(refs, /const quietLoadAbortRef = useRef<AbortController \| undefined>\(undefined\);/);
  assert.match(refs, /const targetedReadAbortRef = useRef\(new Map<string, AbortController>\(\)\);/);
  assert.match(loadData, /const loadAbortController = new AbortController\(\);/);
  assert.match(loadData, /if \(options\.quiet\) \{\s+quietLoadAbortRef\.current\?\.abort\(\);\s+quietLoadAbortRef\.current = loadAbortController;\s+\} else \{\s+foregroundLoadAbortRef\.current\?\.abort\(\);\s+quietLoadAbortRef\.current\?\.abort\(\);\s+abortTargetedReads\(\);\s+foregroundLoadAbortRef\.current = loadAbortController;\s+\}/);
  assert.match(loadData, /const loadSignal = loadAbortController\.signal;/);
  assert.match(loadData, /listRefreshSessions\(undefined, \{ signal: loadSignal \}\)/);
  assert.match(loadData, /if \(options\.quiet && quietLoadAbortRef\.current === loadAbortController\) \{\s+quietLoadAbortRef\.current = undefined;\s+\}/);
  assert.match(loadData, /if \(!options\.quiet && foregroundLoadAbortRef\.current === loadAbortController\) \{\s+foregroundLoadAbortRef\.current = undefined;\s+\}/);
  assert.match(runAction, /quietLoadAbortRef\.current\?\.abort\(\);\s+abortTargetedReads\(\);/);
  assert.match(cleanupEffect, /foregroundLoadAbortRef\.current\?\.abort\(\);/);
  assert.match(cleanupEffect, /quietLoadAbortRef\.current\?\.abort\(\);/);
  assert.match(cleanupEffect, /abortTargetedReads\(\);/);
  assert.doesNotMatch(loadData, /getStorageInfo\(\)/);
  assert.doesNotMatch(loadData, /listFeeds\(\);/);
});

test("targeted desktop reads cancel stale same-scope requests", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const cancellationHelpers = source.slice(source.indexOf("function beginTargetedRead"), source.indexOf("function clearVisibleError"));
  const refreshFeeds = source.slice(
    source.indexOf("async function refreshFeeds"),
    source.indexOf("async function refreshPeopleForFeed"),
  );
  const refreshPeople = source.slice(
    source.indexOf("async function refreshPeopleForFeed"),
    source.indexOf("function refreshPeopleForMovedSearch"),
  );
  const refreshQueue = source.slice(
    source.indexOf("async function refreshQueueForFeed"),
    source.indexOf("async function refreshSessionsForFeed"),
  );
  const backfill = source.slice(
    source.indexOf("async function backfillQueueAfterStatusRemoval"),
    source.indexOf("function applyQueueStatusChange"),
  );
  const loadMore = source.slice(source.indexOf("async function loadMoreQueueItems"), source.indexOf("async function changeCounter"));
  const refreshSessions = source.slice(
    source.indexOf("async function refreshSessionsForFeed"),
    source.indexOf("async function repairRefreshSessionsForFeed"),
  );

  assert.match(source, /const targetedReadAbortRef = useRef\(new Map<string, AbortController>\(\)\);/);
  assert.match(cancellationHelpers, /function beginTargetedRead\(key: string\) \{/);
  assert.match(cancellationHelpers, /targetedReadAbortRef\.current\.get\(key\)\?\.abort\(\);/);
  assert.match(cancellationHelpers, /targetedReadAbortRef\.current\.set\(key, controller\);/);
  assert.match(cancellationHelpers, /if \(targetedReadAbortRef\.current\.get\(key\) === controller\) \{\s+targetedReadAbortRef\.current\.delete\(key\);/);
  assert.match(cancellationHelpers, /function abortTargetedReads\(\) \{\s+for \(const controller of targetedReadAbortRef\.current\.values\(\)\) \{\s+controller\.abort\(\);/);
  assert.match(cancellationHelpers, /targetedReadAbortRef\.current\.clear\(\);/);

  assert.match(refreshFeeds, /const read = beginTargetedRead\("feeds"\);/);
  assert.match(refreshFeeds, /listFeeds\(\{ signal: read\.signal \}\)/);
  assert.match(refreshFeeds, /finally \{\s+read\.finish\(\);/);
  assert.match(refreshPeople, /const read = beginTargetedRead\(`people:\$\{feedId\}`\);/);
  assert.match(refreshPeople, /listFeeds\(\{ signal: read\.signal \}\)/);
  assert.match(refreshPeople, /listPeople\(feedId, search, \{ signal: read\.signal \}\)/);
  assert.match(refreshPeople, /finally \{\s+read\.finish\(\);/);
  assert.match(source, /const read = beginTargetedRead\("feeds"\);\s+let nextFeeds: Feed\[\];\s+try \{\s+nextFeeds = await listFeeds\(\{ signal: read\.signal \}\);/);
  assert.match(refreshQueue, /const read = beginTargetedRead\(`queue:\$\{feedId\}`\);/);
  assert.match(refreshQueue, /getQueueView\(feedId, status, \{ limit: QUEUE_BATCH_SIZE, signal: read\.signal \}\)/);
  assert.match(refreshQueue, /finally \{\s+read\.finish\(\);/);
  assert.match(backfill, /const read = beginTargetedRead\(`queue:\$\{feedId\}`\);/);
  assert.match(backfill, /getQueueView\(feedId, status, \{ limit: missingCount, after: cursor, signal: read\.signal \}\)/);
  assert.match(backfill, /finally \{\s+read\.finish\(\);/);
  assert.match(loadMore, /const read = beginTargetedRead\(`queue:\$\{feedId\}`\);/);
  assert.match(loadMore, /getQueueView\(feedId, status, \{ limit: QUEUE_BATCH_SIZE, after: lastLoadedItem, signal: read\.signal \}\)/);
  assert.match(loadMore, /finally \{\s+read\.finish\(\);/);
  assert.match(refreshSessions, /const read = beginTargetedRead\(`refresh-sessions:\$\{feedId\}`\);/);
  assert.match(refreshSessions, /listRefreshSessions\(feedId, \{ signal: read\.signal \}\)/);
  assert.match(refreshSessions, /finally \{\s+read\.finish\(\);/);
});

test("targeted refresh helpers ignore stale action-era responses", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const refreshFeeds = source.slice(
    source.indexOf("async function refreshFeeds"),
    source.indexOf("async function refreshPeopleForFeed"),
  );
  const refreshPeople = source.slice(
    source.indexOf("async function refreshPeopleForFeed"),
    source.indexOf("async function refreshQueueForFeed"),
  );
  const refreshQueue = source.slice(
    source.indexOf("async function refreshQueueForFeed"),
    source.indexOf("async function refreshSessionsForFeed"),
  );
  const refreshSessions = source.slice(
    source.indexOf("async function refreshSessionsForFeed"),
    source.indexOf("function rememberRefreshSessionSignatures"),
  );

  for (const helper of [refreshFeeds, refreshPeople, refreshSessions]) {
    assert.match(helper, /const actionMutationVersionAtStart = actionMutationVersionRef\.current;/);
    assert.match(helper, /if \(actionMutationVersionAtStart !== actionMutationVersionRef\.current\) \{\s+requestDeferredQuietLoadForFeed\((feedId)?\);\s+return;\s+\}/);
  }
  assert.match(refreshQueue, /const actionMutationVersionAtStart = actionMutationVersionRef\.current;/);
  assert.match(refreshQueue, /if \(actionMutationVersionAtStart !== actionMutationVersionRef\.current\) \{\s+requestDeferredQuietLoadForFeed\(feedId\);\s+return false;\s+\}/);
  assert.ok(refreshFeeds.indexOf("return;") < refreshFeeds.indexOf("setFeeds(nextFeeds);"));
  assert.ok(refreshPeople.indexOf("return;") < refreshPeople.indexOf("setFeeds(feedResult.value);"));
  assert.ok(refreshQueue.indexOf("return false;") < refreshQueue.indexOf("replaceQueueItems(queueView.items);"));
  assert.ok(refreshSessions.indexOf("return;") < refreshSessions.indexOf("mergeRefreshSessionsForFeed(feedId, sessions);"));
  assert.match(refreshQueue, /return false;/);
  assert.match(refreshQueue, /replaceQueueItems\(queueView\.items\);\s+setQueueCounts\(queueView\.counts\);\s+return true;/);
  assert.match(refreshSessions, /const sessions = await listRefreshSessions\(feedId, \{ signal: read\.signal \}\);/);
  assert.match(refreshSessions, /rememberRefreshSessionSignaturesForFeed\(feedId, sessions\);/);
  assert.match(refreshSessions, /mergeRefreshSessionsForFeed\(feedId, sessions\);/);
});

test("feed-scoped refresh session signature updates preserve unrelated feeds", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const fullRemember = source.slice(
    source.indexOf("function rememberRefreshSessionSignatures"),
    source.indexOf("function rememberRefreshSessionSignaturesForFeed"),
  );
  const scopedRemember = source.slice(
    source.indexOf("function rememberRefreshSessionSignaturesForFeed"),
    source.indexOf("useEffect(() => {"),
  );

  assert.match(source, /const refreshSessionSignaturesRef = useRef\(new Map<string, string>\(\)\);/);
  assert.match(source, /const refreshSessionFeedIdsRef = useRef\(new Map<string, string>\(\)\);/);
  assert.match(fullRemember, /refreshSessionSignaturesRef\.current = new Map\(sessions\.map\(\(session\) => \[session\.id, refreshQueueSignature\(session\)\]\)\);/);
  assert.match(fullRemember, /refreshSessionFeedIdsRef\.current = new Map\(sessions\.map\(\(session\) => \[session\.id, session\.feedId\]\)\);/);
  assert.match(scopedRemember, /const nextSignatures = new Map\(refreshSessionSignaturesRef\.current\);/);
  assert.match(scopedRemember, /const nextFeedIds = new Map\(refreshSessionFeedIdsRef\.current\);/);
  assert.match(scopedRemember, /for \(const \[sessionId, currentFeedId\] of nextFeedIds\) \{/);
  assert.match(scopedRemember, /if \(currentFeedId === feedId\) \{\s+nextSignatures\.delete\(sessionId\);\s+nextFeedIds\.delete\(sessionId\);/);
  assert.match(scopedRemember, /nextSignatures\.set\(session\.id, refreshQueueSignature\(session\)\);/);
  assert.match(scopedRemember, /nextFeedIds\.set\(session\.id, session\.feedId\);/);
  assert.match(scopedRemember, /refreshSessionSignaturesRef\.current = nextSignatures;/);
  assert.match(scopedRemember, /refreshSessionFeedIdsRef\.current = nextFeedIds;/);
  assert.match(scopedRemember, /function rememberRefreshSessionSignaturesExceptFeed\(excludedFeedId: string, sessions: RefreshSession\[\]\)/);
  assert.match(scopedRemember, /if \(currentFeedId !== excludedFeedId\) \{\s+nextSignatures\.delete\(sessionId\);\s+nextFeedIds\.delete\(sessionId\);/);
  assert.match(scopedRemember, /if \(session\.feedId === excludedFeedId\) \{\s+continue;\s+\}/);
});

test("unchanged refresh session polls do not rewrite session state", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const applyRefreshSessions = source.slice(source.indexOf("function applyRefreshSessions"), source.indexOf("function applyRefreshCancelResult"));
  const sorting = source.slice(source.indexOf("function sortRefreshSessions"), source.indexOf("function refreshSessionListSignature"));
  const signatures = source.slice(source.indexOf("function refreshSessionListSignature"), source.indexOf("function sessionHasQueueProgress"));

  assert.match(applyRefreshSessions, /function applyRefreshSessions\(nextSessions: RefreshSession\[\]\) \{\s+updateRefreshSessions\(\(\) => nextSessions\);/);
  assert.match(applyRefreshSessions, /function updateRefreshSessions\(updater: \(currentSessions: RefreshSession\[\]\) => RefreshSession\[\]\)/);
  assert.match(applyRefreshSessions, /const nextSessions = sortRefreshSessions\(updater\(refreshSessionsRef\.current\)\);/);
  assert.match(
    applyRefreshSessions,
    /if \(refreshSessionListSignature\(nextSessions\) === refreshSessionListSignature\(refreshSessionsRef\.current\)\) \{\s+return;\s+\}/,
  );
  assert.ok(applyRefreshSessions.indexOf("refreshSessionListSignature(nextSessions)") < applyRefreshSessions.indexOf("setRefreshSessions(nextSessions);"));
  assert.match(sorting, /function sortRefreshSessions\(sessions: RefreshSession\[\]\)/);
  assert.match(sorting, /second\.createdAt\.localeCompare\(first\.createdAt\) \|\|/);
  assert.match(sorting, /refreshSessionStatusOrder\(first\.status\) - refreshSessionStatusOrder\(second\.status\) \|\|/);
  assert.match(sorting, /second\.updatedAt\.localeCompare\(first\.updatedAt\) \|\|/);
  assert.match(sorting, /first\.id\.localeCompare\(second\.id\)/);
  assert.match(sorting, /function refreshSessionStatusOrder\(status: RefreshSession\["status"\]\)/);
  assert.match(sorting, /return status === "running" \? 0 : 1;/);
  assert.match(signatures, /function refreshSessionListSignature\(sessions: RefreshSession\[\]\)/);
  assert.match(signatures, /return sortRefreshSessions\(sessions\)\.map\(refreshSessionUiSignature\)\.join\("\\n"\);/);
  assert.match(signatures, /function refreshSessionUiSignature\(session: RefreshSession\)/);
  assert.match(signatures, /const target = session\.currentTarget;/);
  assert.match(signatures, /session\.nextUrl \|\| ""/);
  assert.match(signatures, /session\.nextDelayReason/);
  assert.match(signatures, /session\.currentAttempt/);
  assert.match(signatures, /target\s+\?\s+\[/);
  assert.doesNotMatch(signatures, /session\.updatedAt/);
});

test("queue status retry recovery refreshes people counters", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const mark = source.slice(source.indexOf("async function mark"), source.indexOf("async function backfillQueueAfterStatusRemoval"));

  assert.match(source, /if \(!change\.changed && feedIdAtClick\) \{/);
  assert.match(
    mark,
    /settlePostWriteRefreshes\(feedIdAtClick, \[\s+refreshQueueForFeed\(feedIdAtClick, statusAtClick\),\s+refreshPeopleForFeed\(feedIdAtClick\),\s+\]\)/,
  );
  assert.match(mark, /if \(item\.status !== change\.status\) \{\s+const currentView = queueViewRef\.current;/);
  assert.match(mark, /if \(currentView\.feedId !== feedIdAtClick\) \{\s+requestDeferredQuietLoadForFeed\(currentView\.feedId\);/);
  assert.match(mark, /else if \(currentView\.status !== statusAtClick\) \{\s+requestDeferredQuietLoadForFeed\(feedIdAtClick\);/);
  assert.doesNotMatch(mark, /Promise\.all\(\[refreshQueueForFeed\(feedIdAtClick, statusAtClick\), refreshPeopleForFeed\(feedIdAtClick\)\]\)/);
  assert.doesNotMatch(source, /if \(!change\.changed && feedIdAtClick\) \{\s+await refreshQueueForFeed\(feedIdAtClick, statusAtClick\);/);
});

test("queue status actions only mutate rows for the tab clicked", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const mark = source.slice(source.indexOf("async function mark"), source.indexOf("async function backfillQueueAfterStatusRemoval"));
  const apply = source.slice(source.indexOf("function applyQueueStatusChange"), source.indexOf("async function loadMoreQueueItems"));

  assert.match(mark, /const statusAtClick = queueViewRef\.current\.status;/);
  assert.match(mark, /applyQueueStatusChange\(change, feedIdAtClick, statusAtClick\);/);
  assert.match(apply, /function applyQueueStatusChange\(change: QueueStatusChange, feedIdAtClick: string, statusAtClick: QueueStatus\)/);
  assert.match(apply, /const currentView = queueViewRef\.current;/);
  assert.match(apply, /if \(currentView\.feedId !== feedIdAtClick\) \{\s+requestDeferredQuietLoadForFeed\(currentView\.feedId\);\s+return;\s+\}/);
  assert.match(apply, /setQueueCounts\(\(current\) => \(\{/);
  assert.match(apply, /if \(currentView\.status !== statusAtClick\) \{\s+requestDeferredQuietLoadForFeed\(feedIdAtClick\);\s+return;\s+\}/);
  assert.match(apply, /if \(currentView\.status === statusAtClick\) \{\s+const nextItems = itemsRef\.current/);
  assert.match(apply, /\.filter\(\(currentItem\) => currentItem\.status === statusAtClick\);/);
  assert.match(apply, /replaceQueueItems\(nextItems\);/);
  assert.doesNotMatch(apply, /\.filter\(\(currentItem\) => currentItem\.status === queueViewRef\.current\.status\);/);
});

test("queue status removals update the item ref before backfill checks the visible gap", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const apply = source.slice(source.indexOf("function applyQueueStatusChange"), source.indexOf("async function loadMoreQueueItems"));
  const backfill = source.slice(source.indexOf("async function backfillQueueAfterStatusRemoval"), source.indexOf("function applyQueueStatusChange"));

  assert.match(apply, /const nextItems = itemsRef\.current\s+\.map/);
  assert.match(apply, /replaceQueueItems\(nextItems\);/);
  assert.doesNotMatch(apply, /setItems\(\(currentItems\) => \{/);
  assert.match(backfill, /const missingCount = Math\.max\(0, desiredVisibleCount - itemsRef\.current\.length\);/);
  assert.ok(apply.indexOf("replaceQueueItems(nextItems);") > apply.indexOf("const nextItems = itemsRef.current"));
});

test("queue status completions repair feed and tab switches", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const apply = source.slice(source.indexOf("function applyQueueStatusChange"), source.indexOf("async function loadMoreQueueItems"));

  assert.match(apply, /const currentView = queueViewRef\.current;/);
  assert.ok(apply.indexOf("if (change.commentCountDelta !== 0)") < apply.indexOf("if (currentView.feedId !== feedIdAtClick)"));
  assert.match(apply, /requestDeferredQuietLoadForFeed\(currentView\.feedId\);/);
  assert.match(apply, /requestDeferredQuietLoadForFeed\(feedIdAtClick\);/);
  assert.ok(apply.indexOf("setQueueCounts((current)") < apply.indexOf("if (currentView.status !== statusAtClick)"));
  assert.ok(apply.indexOf("if (currentView.status !== statusAtClick)") < apply.indexOf("replaceQueueItems(nextItems);"));
});

test("stale queue item recovery refreshes the clicked queue tab", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const mark = source.slice(source.indexOf("async function mark"), source.indexOf("async function backfillQueueAfterStatusRemoval"));

  assert.match(mark, /const statusAtClick = queueViewRef\.current\.status;/);
  assert.match(
    mark,
    /if \(isStaleQueueItemError\(nextError\) && feedIdAtClick\) \{\s+const refreshed = await refreshQueueForFeed\(feedIdAtClick, statusAtClick\)\.catch\(\(repairError\) => \{\s+if \(isRequestCanceledError\(repairError\)\) \{\s+return false;\s+\}\s+requestDeferredQuietLoadForFeed\(feedIdAtClick\);\s+return false;/,
  );
  assert.match(mark, /refreshed\s+\? "That queue item was already removed from this feed\. Queue refreshed\."\s+: "That queue item was already removed from this feed\. Queue repair queued\."/);
  assert.doesNotMatch(mark, /await refreshQueueForFeed\(feedIdAtClick, statusAtClick\);\s+setNotice/);
  assert.doesNotMatch(mark, /refreshQueueForFeed\(feedIdAtClick, queueViewRef\.current\.status\)/);
});

test("concurrent counter actions only merge the changed counter field", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const counterSnapshot = source.slice(
    source.indexOf("function applyPersonCounterSnapshot"),
    source.indexOf("function applyPersonMembershipChange"),
  );
  const changeCounter = source.slice(source.indexOf("async function changeCounter"), source.indexOf("async function openStorageFolder"));
  const personRow = source.slice(source.indexOf("function PersonRow"), source.indexOf("function Counter"));

  assert.match(counterSnapshot, /function applyPersonCounterSnapshot\(/);
  assert.match(counterSnapshot, /key: "commentCount" \| "likeCount" \| "backCommentCount"/);
  assert.match(counterSnapshot, /commentCount: key === "commentCount" \? updatedPerson\.commentCount : person\.commentCount/);
  assert.match(counterSnapshot, /likeCount: key === "likeCount" \? updatedPerson\.likeCount : person\.likeCount/);
  assert.match(counterSnapshot, /backCommentCount: key === "backCommentCount" \? updatedPerson\.backCommentCount : person\.backCommentCount/);
  assert.match(changeCounter, /if \(isFeedWorkflowBusy\(busyKeysRef\.current\)\) \{\s+setNotice\("Finish the current feed update first\."\);\s+return;\s+\}/);
  assert.match(changeCounter, /const updatedPerson = await adjustCounters\(person\.id, \{ \[key\]: delta \}\);/);
  assert.match(changeCounter, /applyPersonCounterSnapshot\(updatedPerson, key, view\);/);
  assert.match(personRow, /const rowWorkflowBusy = feedWorkflowBusy \|\| membershipBusy \|\| removeBusy \|\| deleteBusy;/);
  assert.match(personRow, /disabled=\{rowWorkflowBusy \|\| busyKeys\.has\(`counter-\$\{person\.id\}-commentCount`\)\}/);
  assert.match(personRow, /disabled=\{rowWorkflowBusy \|\| busyKeys\.has\(`counter-\$\{person\.id\}-likeCount`\)\}/);
  assert.match(personRow, /disabled=\{rowWorkflowBusy \|\| busyKeys\.has\(`counter-\$\{person\.id\}-backCommentCount`\)\}/);
  assert.doesNotMatch(changeCounter, /applyPersonSnapshot\(updatedPerson, view\);/);
});

test("stale counter actions repair visible people and queue state", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const changeCounter = source.slice(source.indexOf("async function changeCounter"), source.indexOf("async function openStorageFolder"));
  const repairHelper = source.slice(source.indexOf("async function repairStalePersonAction"), source.indexOf("async function refreshFeeds"));
  const stalePersonHelper = source.slice(source.indexOf("function isStalePersonError"), source.indexOf("function parseBulkPeople"));

  assert.match(changeCounter, /catch \(nextError\) \{/);
  assert.match(changeCounter, /if \(isStalePersonError\(nextError\) && view\.feedId\) \{/);
  assert.match(changeCounter, /await repairStalePersonAction\(person, view, queueViewRef\.current\.status\);/);
  assert.match(
    repairHelper,
    /await settlePostWriteRefreshes\(view\.feedId, \[\s+refreshFeeds\(\),\s+refreshPeopleForFeed\(view\.feedId, view\.search\),\s+refreshQueueForFeed\(view\.feedId, status\),\s+\.\.\.person\.feedIds\.map\(\(feedId\) =>\s+refreshSessionsForFeed\(feedId, \{\s+applyWhenHidden: feedId !== view\.feedId,\s+refreshQueueOnProgress: feedId !== view\.feedId,\s+\}\),\s+\),\s+\]\);/,
  );
  assert.match(repairHelper, /applyDeletedPerson\(person, view\);/);
  assert.match(changeCounter, /setNotice\("That person was already removed elsewhere\. Feed repaired\."\);/);
  assert.match(changeCounter, /throw nextError;/);
  assert.match(stalePersonHelper, /error instanceof ApiError && error\.statusCode === 404 && \/Person not found\/i\.test\(error\.message\)/);
});

test("stale membership actions repair visible people and queue state", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const removeFromFeed = source.slice(
    source.indexOf("async function removePersonFromSelectedFeed"),
    source.indexOf("async function removePersonEverywhere"),
  );
  const repairHelper = source.slice(source.indexOf("async function repairStalePersonAction"), source.indexOf("async function refreshFeeds"));

  assert.match(toggleMembership, /let updatedPerson: Person;/);
  assert.match(toggleMembership, /try \{\s+updatedPerson = await updatePersonMemberships\(person\.id, nextFeedIds, \{ knownFeedIds: person\.feedIds \}\);/);
  assert.match(toggleMembership, /if \(isStalePersonError\(nextError\)\) \{\s+await repairStalePersonAction\(person, view, status\);/);
  assert.match(toggleMembership, /setNotice\("That person was already removed elsewhere\. Feed repaired\."\);/);
  assert.match(toggleMembership, /throw nextError;/);
  assert.match(removeFromFeed, /let updatedPerson: Person;/);
  assert.match(removeFromFeed, /try \{\s+updatedPerson = await updatePersonMemberships\(/);
  assert.match(removeFromFeed, /if \(isStalePersonError\(nextError\)\) \{\s+await repairStalePersonAction\(person, view, status\);/);
  assert.match(removeFromFeed, /setNotice\("That person was already removed elsewhere\. Feed repaired\."\);/);
  assert.match(removeFromFeed, /throw nextError;/);
  assert.match(repairHelper, /applyDeletedPerson\(person, view\);/);
  assert.match(repairHelper, /refreshQueueForFeed\(view\.feedId, status\)/);
});

test("membership queue repairs do not start duplicate session-driven queue refreshes", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const refreshSessions = source.slice(
    source.indexOf("async function refreshSessionsForFeed"),
    source.indexOf("async function repairRefreshSessionsForFeed"),
  );
  const repairHelper = source.slice(source.indexOf("async function repairStalePersonAction"), source.indexOf("async function refreshFeeds"));
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const removeFromFeed = source.slice(
    source.indexOf("async function removePersonFromSelectedFeed"),
    source.indexOf("async function removePersonEverywhere"),
  );
  const deleteEverywhere = source.slice(source.indexOf("async function removePersonEverywhere"), source.indexOf("async function launchWorkspace"));

  assert.match(refreshSessions, /options: \{ applyWhenHidden\?: boolean; refreshQueueOnProgress\?: boolean \} = \{\}/);
  assert.match(refreshSessions, /const shouldRefreshQueueOnProgress = options\.refreshQueueOnProgress !== false;/);
  assert.match(
    refreshSessions,
    /if \(refreshSessionsHaveUnacknowledgedQueueProgress\(sessions, refreshSessionSignaturesRef\.current\)\) \{\s+if \(!shouldRefreshQueueOnProgress\) \{\s+return;\s+\}\s+const applied = await refreshQueueForFeed\(feedId, queueViewRef\.current\.status\);/,
  );
  assert.match(repairHelper, /refreshQueueOnProgress: feedId !== view\.feedId/);
  assert.match(toggleMembership, /refreshQueueOnProgress: !\(selectedFeedWasAffected && changedFeedId === view\.feedId\)/);
  assert.match(removeFromFeed, /refreshQueueOnProgress: changedFeedId !== feedId/);
  assert.match(deleteEverywhere, /refreshQueueOnProgress: changedFeedId !== view\.feedId/);
});

test("membership removals clear visible queue items and counters before reloads settle", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const queueRemoval = source.slice(source.indexOf("function applyPersonQueueRemoval"), source.indexOf("async function refreshFeeds"));
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const removeFromFeed = source.slice(
    source.indexOf("async function removePersonFromSelectedFeed"),
    source.indexOf("async function removePersonEverywhere"),
  );
  const deleteEverywhere = source.slice(source.indexOf("async function removePersonEverywhere"), source.indexOf("async function launchWorkspace"));
  const replaceQueue = source.slice(source.indexOf("function replaceQueueItems"), source.indexOf("function appendQueueItems"));

  assert.match(source, /const itemsRef = useRef<QueueItem\[\]>\(\[\]\);/);
  assert.match(replaceQueue, /itemsRef\.current = nextItems;\s+setItems\(nextItems\);/);
  assert.doesNotMatch(source, /useEffect\(\(\) => \{\s+itemsRef\.current = items;\s+\}, \[items\]\);/);
  assert.match(queueRemoval, /const removedItems = uniqueQueueItems\(\s+itemsRef\.current\.filter\(\(item\) => item\.personId === personId && item\.feedIds\.includes\(view\.feedId\)\),\s+\);/);
  assert.match(queueRemoval, /setQueueCounts\(\(currentCounts\) => \{/);
  assert.match(queueRemoval, /nextCounts\[item\.status\] = Math\.max\(0, nextCounts\[item\.status\] - 1\);/);
  assert.match(queueRemoval, /nextCounts\.all = Math\.max\(0, nextCounts\.all - 1\);/);
  assert.match(queueRemoval, /replaceQueueItems\(itemsRef\.current\.filter\(\(item\) => item\.personId !== personId\)\);/);
  assert.doesNotMatch(queueRemoval, /setItems\(\(currentItems\) => \{/);
  assert.match(toggleMembership, /if \(selectedFeedWasAffected\) \{\s+applyPersonQueueRemoval\(person\.id, view\);\s+\}/);
  assert.match(removeFromFeed, /applyPersonQueueRemoval\(person\.id, view\);/);
  assert.match(deleteEverywhere, /applyDeletedPerson\(person, view\);/);
});

test("membership queue removals update the item ref synchronously", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const queueRemoval = source.slice(source.indexOf("function applyPersonQueueRemoval"), source.indexOf("async function refreshFeeds"));

  assert.match(queueRemoval, /const removedItems = uniqueQueueItems\(/);
  assert.ok(queueRemoval.indexOf("setQueueCounts((currentCounts)") < queueRemoval.indexOf("replaceQueueItems(itemsRef.current.filter"));
  assert.match(queueRemoval, /replaceQueueItems\(itemsRef\.current\.filter\(\(item\) => item\.personId !== personId\)\);/);
  assert.doesNotMatch(queueRemoval, /itemsRef\.current = nextItems;/);
});

test("membership queue count optimism only counts unique items scoped to the visible feed", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const queueRemoval = source.slice(source.indexOf("function applyPersonQueueRemoval"), source.indexOf("async function refreshFeeds"));
  const uniqueHelper = source.slice(source.indexOf("function uniqueQueueItems"), source.indexOf("function refreshQueueSignature"));

  assert.match(queueRemoval, /item\.personId === personId && item\.feedIds\.includes\(view\.feedId\)/);
  assert.doesNotMatch(queueRemoval, /item\.personId === personId\);/);
  assert.match(queueRemoval, /const removedItems = uniqueQueueItems\(/);
  assert.match(uniqueHelper, /function uniqueQueueItems\(items: QueueItem\[\]\)/);
  assert.match(uniqueHelper, /const seen = new Set<string>\(\);/);
  assert.match(uniqueHelper, /if \(seen\.has\(item\.id\)\) \{\s+return false;\s+\}/);
  assert.match(uniqueHelper, /seen\.add\(item\.id\);/);
});

test("desktop membership edits preserve memberships unknown to stale people rows", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const toggleMembership = source.slice(source.indexOf("async function toggleMembership"), source.indexOf("async function removePersonFromSelectedFeed"));
  const removeFromFeed = source.slice(
    source.indexOf("async function removePersonFromSelectedFeed"),
    source.indexOf("async function removePersonEverywhere"),
  );

  assert.match(toggleMembership, /updatePersonMemberships\(person\.id, nextFeedIds, \{ knownFeedIds: person\.feedIds \}\)/);
  assert.match(removeFromFeed, /const nextFeedIds = person\.feedIds\.filter\(\(currentFeedId\) => currentFeedId !== feedId\);/);
  assert.match(removeFromFeed, /updatePersonMemberships\(\s+person\.id,\s+nextFeedIds,\s+\{ knownFeedIds: person\.feedIds \},\s+\)/);
  assert.doesNotMatch(removeFromFeed, /updatePersonMemberships\(\s+person\.id,\s+person\.feedIds\.filter/);
});

test("empty queue view can load the next batch when counts remain", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");

  assert.match(source, /items\.length === 0 && visibleQueueTotal > 0/);
  assert.match(source, /The visible batch is empty\. Load the next batch to keep working\./);
  assert.match(source, /Load \{Math\.min\(QUEUE_BATCH_SIZE, visibleQueueTotal\)\} more/);
});

test("queue status tabs clear stale visible rows immediately", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const changeStatus = source.slice(source.indexOf("function changeQueueStatus"), source.indexOf("async function addFeed"));
  const tabs = source.slice(source.indexOf("<nav className=\"queue-tabs\""), source.indexOf("<section className=\"queue\">"));

  assert.match(changeStatus, /function changeQueueStatus\(status: QueueStatus\)/);
  assert.match(changeStatus, /if \(status === queueStatus\) \{\s+return;\s+\}/);
  assert.match(changeStatus, /queueViewRef\.current = \{ feedId: selectedFeed\?\.id \?\? "", status \};/);
  assert.match(changeStatus, /setQueueStatus\(status\);/);
  assert.match(changeStatus, /replaceQueueItems\(\[\]\);/);
  assert.match(tabs, /onClick=\{\(\) => changeQueueStatus\(status\)\}/);
  assert.doesNotMatch(tabs, /onClick=\{\(\) => setQueueStatus\(status\)\}/);
});

test("queue status changes refresh only queue data", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");

  assert.match(source, /const feedId = selectedFeed\.id;\s+refreshQueueForFeed\(feedId, queueStatus\)\.catch\(\(error\) => \{\s+if \(isRequestCanceledError\(error\)\) \{\s+return;\s+\}\s+console\.error\(error\);\s+requestDeferredQuietLoadForFeed\(feedId\);/);
  assert.doesNotMatch(source, /loadData\(selectedFeed\.id, \{ quiet: true \}\)\.catch\(console\.error\);/);
});

test("feed switching updates selected feed before reload completes", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const selectFeed = source.slice(source.indexOf("function selectFeed"), source.indexOf("async function addFeed"));
  const feedList = source.slice(source.indexOf("<div className=\"feed-list\">"), source.indexOf("<form", source.indexOf("<div className=\"feed-list\">")));

  assert.match(source, /const EMPTY_QUEUE_COUNTS: QueueCounts = \{ new: 0, done: 0, skipped: 0, all: 0 \};/);
  assert.match(source, /useState<QueueCounts>\(EMPTY_QUEUE_COUNTS\)/);
  assert.match(selectFeed, /function selectFeed\(feedId: string\)/);
  assert.match(selectFeed, /if \(feedId === selectedFeed\?\.id\) \{\s+return;\s+\}/);
  assert.match(selectFeed, /setSelectedFeedId\(feedId\);/);
  assert.match(selectFeed, /queueViewRef\.current = \{ feedId, status: queueStatus \};/);
  assert.match(selectFeed, /setPeople\(\[\]\);/);
  assert.match(selectFeed, /replaceQueueItems\(\[\]\);/);
  assert.match(selectFeed, /setQueueCounts\(EMPTY_QUEUE_COUNTS\);/);
  assert.match(selectFeed, /setBulkResult\(undefined\);/);
  assert.match(selectFeed, /loadData\(feedId\)\.catch\(console\.error\);/);
  assert.match(feedList, /onClick=\{\(\) => selectFeed\(feed\.id\)\}/);
  assert.doesNotMatch(feedList, /onClick=\{\(\) => loadData\(feed\.id\)\}/);
});

test("deleting the selected feed clears stale visible state before loading the next feed", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const removeFeed = source.slice(source.indexOf("async function removeSelectedFeed"), source.indexOf("async function addPersonToSelectedFeed"));
  const loadData = source.slice(source.indexOf("async function loadData"), source.indexOf("async function runAction"));

  assert.match(removeFeed, /const deletedFeedId = selectedFeed\.id;/);
  assert.match(removeFeed, /await deleteFeed\(deletedFeedId\);/);
  assert.match(removeFeed, /setFeeds\(\(currentFeeds\) => currentFeeds\.filter\(\(feed\) => feed\.id !== deletedFeedId\)\);/);
  assert.match(removeFeed, /const currentFeedIdAfterDelete = queueViewRef\.current\.feedId;/);
  assert.match(removeFeed, /if \(currentFeedIdAfterDelete === deletedFeedId\) \{/);
  assert.match(removeFeed, /queueViewRef\.current = \{ feedId: "", status: queueStatus \};/);
  assert.match(removeFeed, /setSelectedFeedId\(undefined\);/);
  assert.match(removeFeed, /setPeople\(\[\]\);/);
  assert.match(removeFeed, /replaceQueueItems\(\[\]\);/);
  assert.match(removeFeed, /setQueueCounts\(EMPTY_QUEUE_COUNTS\);/);
  assert.match(removeFeed, /setBulkResult\(undefined\);/);
  assert.match(removeFeed, /await loadData\(null\);\s+return;/);
  assert.match(loadData, /preferredFeedId === null \? undefined : preferredFeedId \|\| queueViewRef\.current\.feedId \|\| selectedFeedId/);
  assert.doesNotMatch(removeFeed, /await loadData\(undefined\);/);
});

test("completed feed deletion preserves a feed selected while delete was in flight", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const removeFeed = source.slice(source.indexOf("async function removeSelectedFeed"), source.indexOf("async function addPersonToSelectedFeed"));

  assert.match(removeFeed, /const currentFeedIdAfterDelete = queueViewRef\.current\.feedId;/);
  assert.match(removeFeed, /if \(currentFeedIdAfterDelete === deletedFeedId\) \{/);
  assert.match(removeFeed, /await loadData\(null\);\s+return;/);
  assert.match(removeFeed, /await loadData\(currentFeedIdAfterDelete \|\| null\);/);
  assert.ok(removeFeed.indexOf("await loadData(null);") < removeFeed.indexOf("await loadData(currentFeedIdAfterDelete || null);"));
  assert.doesNotMatch(removeFeed, /await loadData\(null\);\s+\}\s+await loadData\(null\);/);
});

test("confirmed feed deletion removes the stale feed row before reload settles", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const removeFeed = source.slice(source.indexOf("async function removeSelectedFeed"), source.indexOf("async function addPersonToSelectedFeed"));

  assert.match(removeFeed, /await deleteFeed\(deletedFeedId\);/);
  assert.match(removeFeed, /setFeeds\(\(currentFeeds\) => currentFeeds\.filter\(\(feed\) => feed\.id !== deletedFeedId\)\);/);
  assert.ok(removeFeed.indexOf("await deleteFeed(deletedFeedId);") < removeFeed.indexOf("setFeeds((currentFeeds) => currentFeeds.filter((feed) => feed.id !== deletedFeedId));"));
  assert.ok(removeFeed.indexOf("setFeeds((currentFeeds) => currentFeeds.filter((feed) => feed.id !== deletedFeedId));") < removeFeed.indexOf("await loadData"));
});

test("queue load more uses a stable cursor instead of a shifting offset", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadMore = source.slice(source.indexOf("async function loadMoreQueueItems"), source.indexOf("async function changeCounter"));

  assert.match(loadMore, /const lastLoadedItem = itemsRef\.current\[itemsRef\.current\.length - 1\];/);
  assert.match(loadMore, /const actionMutationVersionAtLoadMoreStart = actionMutationVersionRef\.current;/);
  assert.match(loadMore, /const read = beginTargetedRead\(`queue:\$\{feedId\}`\);/);
  assert.match(loadMore, /getQueueView\(feedId, status, \{ limit: QUEUE_BATCH_SIZE, after: lastLoadedItem, signal: read\.signal \}\)/);
  assert.match(loadMore, /finally \{\s+read\.finish\(\);/);
  assert.match(loadMore, /actionMutationVersionAtLoadMoreStart !== actionMutationVersionRef\.current/);
  assert.doesNotMatch(loadMore, /const offset = items\.length/);
  assert.doesNotMatch(loadMore, /listQueue\(feedId, status, \{ limit: QUEUE_BATCH_SIZE, offset \}\)/);
});

test("queue load more waits for feed workflows before querying", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadMore = source.slice(source.indexOf("async function loadMoreQueueItems"), source.indexOf("async function changeCounter"));
  const emptyBatch = source.slice(source.indexOf("items.length === 0 && visibleQueueTotal > 0"), source.indexOf(") : items.length === 0 ?"));
  const loadMoreRowStart = source.indexOf("{hasMoreQueueItems &&");
  const loadMoreRow = source.slice(loadMoreRowStart, source.indexOf("</section>", loadMoreRowStart));

  assert.match(source, /const canLoadMoreQueueItems = Boolean\(selectedFeed\) && !feedWorkflowBusy && !queueStatusBusy && !loadMoreQueueBusy;/);
  assert.match(loadMore, /if \(isFeedWorkflowBusy\(busyKeysRef\.current\)\) \{\s+setNotice\("Finish the current feed update first\."\);\s+return;\s+\}/);
  assert.match(loadMore, /if \(busyKeysRef\.current\.has\(QUEUE_STATUS_BUSY_KEY\)\) \{\s+setNotice\("Finish the current queue item update first\."\);\s+return;\s+\}/);
  assert.match(emptyBatch, /disabled=\{!canLoadMoreQueueItems\}/);
  assert.match(loadMoreRow, /disabled=\{!canLoadMoreQueueItems\}/);
});

test("queue append refreshes duplicate rows with newer server data", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const merge = source.slice(source.indexOf("function mergeQueueItems"), source.indexOf("function queueAppendNeedsRepair"));
  const append = source.slice(source.indexOf("function appendQueueItems"), source.indexOf("function applyPersonSnapshot"));

  assert.match(merge, /const updates = new Map\(nextItems\.map\(\(item\) => \[item\.id, item\]\)\);/);
  assert.match(merge, /const nextItemIds = \[\.\.\.new Set\(nextItems\.map\(\(item\) => item\.id\)\)\];/);
  assert.match(merge, /const seen = new Set\(currentItems\.map\(\(item\) => item\.id\)\);/);
  assert.match(merge, /currentItems\.map\(\(item\) => updates\.get\(item\.id\) \?\? item\)/);
  assert.match(merge, /nextItemIds\s+\.filter\(\(id\) => !seen\.has\(id\)\)\s+\.map\(\(id\) => updates\.get\(id\)\)/);
  assert.match(merge, /\.filter\(\(item\): item is QueueItem => Boolean\(item\)\)/);
  assert.doesNotMatch(merge, /nextItems\.filter\(\(item\) => !seen\.has\(item\.id\)\)/);
  assert.doesNotMatch(merge, /return \[\.\.\.currentItems, \.\.\.nextItems\.filter/);
  assert.match(append, /if \(nextItems\.length === 0\) \{\s+return 0;\s+\}/);
  assert.match(append, /const existingIds = new Set\(itemsRef\.current\.map\(\(item\) => item\.id\)\);/);
  assert.match(append, /const addedCount = nextItems\.filter\(\(item\) => !existingIds\.has\(item\.id\)\)\.length;/);
  assert.match(append, /replaceQueueItems\(mergeQueueItems\(itemsRef\.current, nextItems\)\);/);
  assert.match(append, /return addedCount;/);
  assert.doesNotMatch(append, /setItems\(\(currentItems\) => \{/);
});

test("queue pagination repairs no-progress cursor pages", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const loadMore = source.slice(source.indexOf("async function loadMoreQueueItems"), source.indexOf("async function changeCounter"));
  const backfill = source.slice(source.indexOf("async function backfillQueueAfterStatusRemoval"), source.indexOf("function applyQueueStatusChange"));
  const repairHelper = source.slice(source.indexOf("function queueAppendNeedsRepair"), source.indexOf("function refreshQueueSignature"));

  assert.match(loadMore, /const addedCount = appendQueueItems\(queueView\.items\);/);
  assert.match(loadMore, /if \(queueAppendNeedsRepair\(queueView\.items, addedCount, itemsRef\.current\.length, queueView\.counts\[status\] \?\? 0\)\) \{\s+requestDeferredQuietLoadForFeed\(feedId\);/);
  assert.match(backfill, /const backfillItems = queueView\.items\.slice\(0, currentMissingCount\);/);
  assert.match(backfill, /const addedCount = appendQueueItems\(backfillItems\);/);
  assert.match(backfill, /if \(queueAppendNeedsRepair\(backfillItems, addedCount, itemsRef\.current\.length, queueView\.counts\[status\] \?\? 0\)\) \{\s+requestDeferredQuietLoadForFeed\(feedId\);/);
  assert.match(repairHelper, /function queueAppendNeedsRepair\(nextItems: QueueItem\[\], addedCount: number, visibleCount: number, totalCount: number\)/);
  assert.match(repairHelper, /return totalCount > visibleCount && \(nextItems\.length === 0 \|\| addedCount === 0\);/);
});

test("manual full reload waits for active actions to settle", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const topbarActions = source.slice(source.indexOf("<div className=\"topbar-actions\">"), source.indexOf("<button\n              className=\"primary\""));

  assert.match(source, /const actionBusy = busyKeys\.size > 0;/);
  assert.match(source, /const canManualReload = !isLoading && !actionBusy && !isLaunching;/);
  assert.match(
    source,
    /const manualReloadTitle = actionBusy\s+\? "Wait for the current action to finish before reloading\."\s+: isLaunching\s+\? "Wait for the dedicated Chrome workspace to finish opening\."\s+: undefined;/,
  );
  assert.match(topbarActions, /onClick=\{\(\) => loadData\(selectedFeed\?\.id\)\}/);
  assert.match(topbarActions, /disabled=\{!canManualReload\}/);
  assert.match(topbarActions, /title=\{manualReloadTitle\}/);
  assert.doesNotMatch(topbarActions, /disabled=\{isLoading\}/);
});

test("feed settings validate lookback drafts before saving", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const saveFeed = source.slice(source.indexOf("async function saveFeedSettings"), source.indexOf("async function removeSelectedFeed"));
  const parseLookback = source.slice(source.indexOf("function parseLookbackDraft"), source.indexOf("function queueStatusLabel"));

  assert.match(source, /const canSaveFeedSettings =\s+Boolean\(selectedFeed && feedNameDraft\.trim\(\) && isValidLookbackDraft\(lookbackDraft\)\) && !feedWorkflowBusy;/);
  assert.match(saveFeed, /if \(!feedNameDraft\.trim\(\)\) \{\s+setActionError\("Feed name is required\."\);\s+return;\s+\}/);
  assert.match(saveFeed, /if \(!isValidLookbackDraft\(lookbackDraft\)\) \{\s+setActionError\("Lookback must be a number between 1 and 365 days\."\);\s+return;\s+\}/);
  assert.match(saveFeed, /const lookbackDaysAtSave = parseLookbackDraft\(lookbackDraft\);/);
  assert.match(saveFeed, /lookbackDays: lookbackDaysAtSave,/);
  assert.doesNotMatch(saveFeed, /lookbackDays: Number\(lookbackDraft\)/);
  assert.match(parseLookback, /if \(!cleanValue \|\| !Number\.isFinite\(days\) \|\| days < 1 \|\| days > 365\) \{/);
  assert.match(parseLookback, /Lookback must be a number between 1 and 365 days\./);
  assert.match(parseLookback, /return Math\.round\(days\);/);
  assert.match(parseLookback, /function isValidLookbackDraft\(value: string\)/);
  assert.match(parseLookback, /const days = Number\(cleanValue\);/);
  assert.match(parseLookback, /return Number\.isFinite\(days\) && days >= 1 && days <= 365;/);
  assert.doesNotMatch(parseLookback, /Math\.max\(1, Math\.min\(365/);
  assert.match(source, /<button className="secondary" onClick=\{saveFeedSettings\} disabled=\{!canSaveFeedSettings\}>/);
});

test("feed settings save does not steal focus after a feed switch", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const saveFeed = source.slice(source.indexOf("async function saveFeedSettings"), source.indexOf("async function removeSelectedFeed"));

  assert.match(saveFeed, /const feedIdAtSave = selectedFeed\.id;/);
  assert.match(saveFeed, /const feedNameAtSave = feedNameDraft;/);
  assert.match(saveFeed, /const lookbackDaysAtSave = parseLookbackDraft\(lookbackDraft\);/);
  assert.match(saveFeed, /updateFeed\(feedIdAtSave, \{\s+name: feedNameAtSave,\s+lookbackDays: lookbackDaysAtSave,/);
  assert.match(saveFeed, /if \(queueViewRef\.current\.feedId === feedIdAtSave\) \{\s+await loadData\(feed\.id\);\s+return;\s+\}/);
  assert.match(saveFeed, /settlePostWriteRefreshes\(feedIdAtSave, \[\s+refreshFeeds\(\),\s+refreshSessionsForFeed\(feedIdAtSave, \{ applyWhenHidden: true \}\),\s+\]\)/);
  assert.doesNotMatch(saveFeed, /updateFeed\(selectedFeed\.id/);
});

test("refresh startup preserves Chrome launch warnings", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const startRefresh = source.slice(source.indexOf("async function startRefresh"), source.indexOf("async function stopRefresh"));

  assert.match(startRefresh, /const launchResult = await launchWorkspace\(session\.nextUrl \|\| "https:\/\/www\.linkedin\.com\/feed\/", \{ throwOnFailure: true \}\);/);
  assert.match(startRefresh, /launchResult && launchResult\.warning/);
  assert.match(startRefresh, /LinkedIn refresh started in the dedicated Chrome profile\. \$\{launchResult\.warning\}/);
  assert.doesNotMatch(startRefresh, /\},\s+"LinkedIn refresh started in the dedicated Chrome profile\.",\s+\);/);
});

test("refresh startup does not launch Chrome for replayed finished sessions", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const startRefresh = source.slice(source.indexOf("async function startRefresh"), source.indexOf("async function stopRefresh"));

  assert.match(startRefresh, /if \(session\.status !== "running"\) \{\s+await refreshQueueForFeed\(feedId\)\.catch\(\(error\) => \{\s+if \(!isRequestCanceledError\(error\)\) \{\s+requestDeferredQuietLoadForFeed\(feedId\);\s+\}\s+return false;\s+\}\);/);
  assert.match(startRefresh, /setNotice\(`LinkedIn refresh is already \$\{session\.status\}\.`\);/);
  assert.ok(startRefresh.indexOf('if (session.status !== "running")') < startRefresh.indexOf("const launchResult = await launchWorkspace"));
  assert.doesNotMatch(startRefresh, /refreshQueueForFeed\(feedId\)\.catch\(\(\) => false\)/);
});

test("refresh startup rechecks an empty-looking feed before blocking", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const startRefresh = source.slice(source.indexOf("async function startRefresh"), source.indexOf("async function stopRefresh"));
  const startButton = source.slice(source.indexOf("<button\n              className=\"primary\""), source.indexOf("Start LinkedIn Refresh"));

  assert.match(source, /const canStartRefresh = Boolean\(\s+selectedFeed && !activeRefresh && !otherActiveRefresh && !isLaunching && !feedWorkflowBusy,\s+\);/);
  assert.match(source, /selectedFeed\.peopleCount === 0\s+\? "Click to re-check feed members before refreshing LinkedIn\."/);
  assert.match(source, /isLaunching\s+\? "Wait for the dedicated Chrome workspace to finish opening\."/);
  assert.match(source, /feedWorkflowBusy\s+\? "Finish the current feed update first\."/);
  assert.match(startRefresh, /let feedForRefresh = selectedFeed;/);
  assert.match(startRefresh, /if \(feedForRefresh\.peopleCount <= 0\) \{\s+const read = beginTargetedRead\("feeds"\);\s+let nextFeeds: Feed\[\];\s+try \{\s+nextFeeds = await listFeeds\(\{ signal: read\.signal \}\);\s+\} finally \{\s+read\.finish\(\);\s+\}/);
  assert.match(startRefresh, /setFeeds\(nextFeeds\);/);
  assert.match(startRefresh, /const refreshedFeed = nextFeeds\.find\(\(feed\) => feed\.id === feedId\);/);
  assert.match(startRefresh, /feedForRefresh = refreshedFeed;/);
  assert.match(startRefresh, /if \(feedForRefresh\.peopleCount <= 0\) \{\s+setActionError\("Add at least one person to this feed before refreshing LinkedIn\."\);\s+return;\s+\}/);
  assert.match(startButton, /disabled=\{!canStartRefresh\}/);
  assert.match(startButton, /title=\{startRefreshTitle\}/);
  assert.doesNotMatch(startButton, /disabled=\{!selectedFeed \|\| Boolean\(activeRefresh \|\| otherActiveRefresh\) \|\| isBusy\("start-refresh"\)\}/);
});

test("refresh startup repairs stale non-empty feed counts when backend rejects empty feeds", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const startRefresh = source.slice(source.indexOf("async function startRefresh"), source.indexOf("async function stopRefresh"));
  const emptyFeedHelper = source.slice(source.indexOf("function isEmptyRefreshFeedError"), source.indexOf("function parseBulkPeople"));

  assert.match(startRefresh, /session = await createRefreshSession\(feedId\);/);
  assert.match(
    startRefresh,
    /if \(isEmptyRefreshFeedError\(nextError\)\) \{\s+await settlePostWriteRefreshes\(feedId, \[refreshFeeds\(\), refreshPeopleForFeed\(feedId\)\]\);\s+setActionError\("Add at least one person to this feed before refreshing LinkedIn\."\);\s+return;\s+\}/,
  );
  assert.ok(startRefresh.indexOf("isEmptyRefreshFeedError(nextError)") < startRefresh.indexOf("if (isStaleFeedError(nextError))"));
  assert.match(emptyFeedHelper, /function isEmptyRefreshFeedError\(error: unknown\)/);
  assert.match(emptyFeedHelper, /error instanceof ApiError && error\.statusCode === 400 && \/Add at least one person\/i\.test\(error\.message\)/);
});

test("refresh startup does not cancel an existing reused session when Chrome launch fails", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const startRefresh = source.slice(source.indexOf("async function startRefresh"), source.indexOf("async function stopRefresh"));
  const repairHelper = source.slice(source.indexOf("async function repairRefreshSessionsForFeed"), source.indexOf("async function settlePostWriteRefreshes"));

  assert.match(startRefresh, /if \(session\.createdByRequest !== false\) \{/);
  assert.match(startRefresh, /const stopped = await cancelRefreshSession\(session\.id\);/);
  assert.match(startRefresh, /if \(!applyRefreshCancelResult\(stopped\)\) \{\s+await repairRefreshSessionsForFeed\(feedId\);/);
  assert.match(startRefresh, /\} else \{\s+await repairRefreshSessionsForFeed\(feedId\);\s+\}/);
  assert.match(repairHelper, /async function repairRefreshSessionsForFeed\(feedId: string\) \{\s+try \{\s+await refreshSessionsForFeed\(feedId\);/);
  assert.match(repairHelper, /console\.error\(error\);\s+requestDeferredQuietLoadForFeed\(feedId\);/);
  assert.ok(startRefresh.indexOf("if (session.createdByRequest !== false)") < startRefresh.indexOf("const stopped = await cancelRefreshSession(session.id);"));
  assert.doesNotMatch(startRefresh, /refreshSessionsForFeed\(feedId\)\.catch\(\(\) => \{\}\)/);
});

test("refresh cancel results remove stale rows when a retry reports already canceled", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const helper = source.slice(source.indexOf("function applyRefreshCancelResult"), source.indexOf("function rememberRefreshSessionSignatures"));
  const stopRefresh = source.slice(source.indexOf("async function stopRefresh"), source.indexOf("async function mark"));

  assert.match(source, /RefreshCancelResult,/);
  assert.match(helper, /function applyRefreshCancelResult\(result: RefreshCancelResult\)/);
  assert.match(helper, /if \("alreadyCanceled" in result\) \{/);
  assert.match(helper, /sessions\.filter\(\(session\) => session\.id !== result\.id\)/);
  assert.match(helper, /sessions\.map\(\(current\) => \(current\.id === result\.id \? result : current\)\)/);
  assert.match(stopRefresh, /const applied = applyRefreshCancelResult\(stopped\);/);
  assert.match(stopRefresh, /if \(!applied\) \{\s+await repairRefreshSessionsForFeed\(session\.feedId\);/);
});

test("chrome launch busy state covers all open controls", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const launchWorkspace = source.slice(source.indexOf("async function launchWorkspace"), source.indexOf("async function startRefresh"));

  assert.match(source, /const launchRequestsRef = useRef\(0\);/);
  assert.match(launchWorkspace, /if \(launchRequestsRef\.current > 0\) \{\s+const message = "Dedicated Chrome workspace is already opening\. Try again in a moment\.";/);
  assert.match(launchWorkspace, /if \(options\.throwOnFailure\) \{\s+throw new Error\(message\);\s+\}/);
  assert.match(launchWorkspace, /setNotice\(message\);\s+return false;/);
  assert.match(launchWorkspace, /launchRequestsRef\.current = 1;\s+setIsLaunching\(true\);/);
  assert.match(launchWorkspace, /launchRequestsRef\.current = 0;\s+setIsLaunching\(false\);/);
  assert.ok(launchWorkspace.indexOf("if (launchRequestsRef.current > 0)") < launchWorkspace.indexOf("launchRequestsRef.current = 1;"));
  assert.match(source, /isLaunching=\{isLaunching\}/);
  assert.match(source, /<button onClick=\{onOpen\} disabled=\{isLaunching\}/);
  assert.match(source, /onClick=\{\(\) => launchWorkspace\(item\.sourceUrl\)\} disabled=\{isLaunching\}/);
});

test("desktop bridge results are validated before UI actions trust them", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const launchWorkspace = source.slice(source.indexOf("async function launchWorkspace"), source.indexOf("async function startRefresh"));
  const storageStart = source.indexOf("async function openStorageFolder");
  const storageActions = source.slice(storageStart, source.indexOf("return (", storageStart));
  const bridgeHelpers = source.slice(source.indexOf("function requireDesktopBridgeMethod"), source.indexOf("function isRequestCanceledError"));

  assert.match(source, /type ChromeLaunchBridgeResult = Awaited<ReturnType<Window\["linkedinFeed"\]\["launchChrome"\]>>;/);
  assert.match(source, /type OpenPathBridgeResult = Awaited<ReturnType<Window\["linkedinFeed"\]\["openPath"\]>>;/);
  assert.match(source, /type SaveJsonExportBridgeResult = Awaited<ReturnType<Window\["linkedinFeed"\]\["saveJsonExport"\]>>;/);
  assert.match(bridgeHelpers, /function requireDesktopBridgeMethod<K extends keyof AppBridge>\(method: K\): AppBridge\[K\]/);
  assert.match(bridgeHelpers, /const bridge = window\.linkedinFeed as Partial<AppBridge> \| undefined;/);
  assert.match(bridgeHelpers, /const bridgeMethod = bridge\?\.\[method\];/);
  assert.match(bridgeHelpers, /if \(typeof bridgeMethod !== "function"\) \{\s+throw new Error\("Desktop app bridge is unavailable\. Restart the app and try again\."\);/);
  assert.match(bridgeHelpers, /return bridgeMethod as AppBridge\[K\];/);
  assert.match(launchWorkspace, /validateChromeLaunchBridgeResult\(await requireDesktopBridgeMethod\("launchChrome"\)\(url\)\)/);
  assert.match(storageActions, /validateOpenPathBridgeResult\(await requireDesktopBridgeMethod\("openPath"\)\(storageInfo\.dataDir\)\)/);
  assert.match(storageActions, /const read = beginTargetedRead\("export-data"\);/);
  assert.match(storageActions, /getDataExport\(\{ signal: read\.signal \}\)/);
  assert.match(storageActions, /validateSaveJsonExportBridgeResult\(await requireDesktopBridgeMethod\("saveJsonExport"\)\(payload\)\)/);
  assert.match(storageActions, /finally \{\s+read\.finish\(\);/);
  assert.match(bridgeHelpers, /function validateChromeLaunchBridgeResult\(value: unknown\): ChromeLaunchBridgeResult/);
  assert.match(bridgeHelpers, /throw new Error\("Chrome launch returned an unexpected warning\."\)/);
  assert.match(bridgeHelpers, /throw new Error\("Chrome launch returned an unexpected mode\."\)/);
  assert.match(bridgeHelpers, /throw new Error\("Chrome launch returned an unexpected debug port\."\)/);
  assert.match(bridgeHelpers, /throw new Error\("Chrome launch returned unexpected opened URLs\."\)/);
  assert.match(bridgeHelpers, /function validateOpenPathBridgeResult\(value: unknown\): OpenPathBridgeResult/);
  assert.match(bridgeHelpers, /function validateSaveJsonExportBridgeResult\(value: unknown\): SaveJsonExportBridgeResult/);
  assert.match(bridgeHelpers, /throw new Error\("JSON export returned an unexpected cancellation state\."\)/);
  assert.match(bridgeHelpers, /throw new Error\("JSON export returned an unexpected file path\."\)/);
  assert.match(bridgeHelpers, /function validateBasicBridgeResult\(value: unknown, label: string\)/);
  assert.match(bridgeHelpers, /!isRecord\(value\) \|\| typeof value\.ok !== "boolean"/);
  assert.match(bridgeHelpers, /throw new Error\(`\$\{label\} returned an unexpected response\.`\)/);
  assert.match(bridgeHelpers, /value\.error !== undefined && typeof value\.error !== "string"/);
  assert.match(bridgeHelpers, /function isRecord\(value: unknown\): value is Record<string, unknown>/);
  assert.match(bridgeHelpers, /function isStringArray\(value: unknown\): value is string\[\]/);
});

test("people refresh keeps feed counts when search view changes", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const refreshPeople = source.slice(
    source.indexOf("async function refreshPeopleForFeed"),
    source.indexOf("async function refreshQueueForFeed"),
  );

  assert.match(refreshPeople, /options: \{ refreshFeeds\?: boolean \} = \{\}/);
  assert.match(refreshPeople, /const shouldRefreshFeeds = options\.refreshFeeds !== false;/);
  assert.match(refreshPeople, /const feedRefresh = shouldRefreshFeeds\s+\? listFeeds\(\{ signal: read\.signal \}\)/);
  assert.match(refreshPeople, /: Promise\.resolve\(\{ status: "fulfilled" as const, value: undefined \}\);/);
  assert.match(refreshPeople, /listPeople\(feedId, search, \{ signal: read\.signal \}\)/);
  assert.match(refreshPeople, /if \(feedResult\.status === "fulfilled" && feedResult\.value\) \{\s+setFeeds\(feedResult\.value\);\s+\}/);
  assert.match(refreshPeople, /peopleRefreshViewRef\.current = peopleRefreshViewKey\(feedId, search\);/);
  assert.ok(refreshPeople.indexOf('if (feedResult.status === "fulfilled" && feedResult.value)') < refreshPeople.indexOf("if (queueViewRef.current.feedId !== feedId"));
  assert.ok(refreshPeople.indexOf("peopleRefreshViewRef.current = peopleRefreshViewKey(feedId, search);") > refreshPeople.indexOf("if (queueViewRef.current.feedId !== feedId"));
  assert.ok(refreshPeople.indexOf("setPeople(nextPeople);") > refreshPeople.indexOf("if (queueViewRef.current.feedId !== feedId"));
});

test("people search refreshes people without reloading queue data", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const effectsEnd = source.indexOf("function changeQueueStatus");
  const searchEffectStart = source.lastIndexOf("const feedId = selectedFeed.id;", effectsEnd);
  const searchEffect = source.slice(searchEffectStart, effectsEnd);

  assert.match(searchEffect, /const feedId = selectedFeed\.id;/);
  assert.match(searchEffect, /const search = peopleSearch;/);
  assert.match(searchEffect, /if \(peopleRefreshViewRef\.current === peopleRefreshViewKey\(feedId, search\)\) \{\s+return;\s+\}/);
  assert.match(searchEffect, /window\.setTimeout\(\(\) => \{\s+if \(peopleRefreshViewRef\.current === peopleRefreshViewKey\(feedId, search\)\) \{\s+return;\s+\}/);
  assert.match(searchEffect, /window\.setTimeout\(\(\) => \{[\s\S]*refreshPeopleForFeed\(feedId, search, \{ refreshFeeds: false \}\)\.catch\(\(error\) => \{\s+if \(isRequestCanceledError\(error\)\) \{\s+return;\s+\}\s+console\.error\(error\);\s+requestDeferredQuietLoadForFeed\(feedId\);/);
  assert.doesNotMatch(searchEffect, /refreshPeopleForFeed\(feedId, search\)\.catch\(console\.error\)/);
  assert.doesNotMatch(searchEffect, /loadData\(selectedFeed\.id, \{ quiet: true \}\)/);
  assert.doesNotMatch(searchEffect, /getQueueView/);
});

test("people search skips duplicate refreshes for the already loaded view", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const helper = source.slice(source.indexOf("function peopleRefreshViewKey"), source.indexOf("function errorMessage"));
  const effectsEnd = source.indexOf("function changeQueueStatus");
  const searchEffectStart = source.lastIndexOf("const feedId = selectedFeed.id;", effectsEnd);
  const searchEffect = source.slice(searchEffectStart, effectsEnd);

  assert.match(source, /const peopleRefreshViewRef = useRef\(""\);/);
  assert.match(helper, /function peopleRefreshViewKey\(feedId: string \| undefined, search: string\)/);
  assert.match(helper, /return `\$\{feedId \|\| ""\}\\n\$\{search\.trim\(\)\.toLowerCase\(\)\}`;/);
  assert.ok(searchEffect.indexOf("if (peopleRefreshViewRef.current === peopleRefreshViewKey(feedId, search))") < searchEffect.indexOf("window.setTimeout"));
  assert.ok(searchEffect.indexOf("if (peopleRefreshViewRef.current === peopleRefreshViewKey(feedId, search))", searchEffect.indexOf("window.setTimeout")) < searchEffect.indexOf("refreshPeopleForFeed"));
});

test("people refresh applies people even when optional feed count reload fails", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const refreshPeople = source.slice(
    source.indexOf("async function refreshPeopleForFeed"),
    source.indexOf("async function refreshQueueForFeed"),
  );

  assert.match(refreshPeople, /const feedRefresh = shouldRefreshFeeds\s+\? listFeeds\(\{ signal: read\.signal \}\)/);
  assert.match(refreshPeople, /\.then\(\(value\) => \(\{ status: "fulfilled" as const, value \}\)\)/);
  assert.match(refreshPeople, /\.catch\(\(reason\) => \(\{ status: "rejected" as const, reason \}\)\)/);
  assert.match(refreshPeople, /: Promise\.resolve\(\{ status: "fulfilled" as const, value: undefined \}\);/);
  assert.match(refreshPeople, /const \[feedResult, nextPeople\] = await Promise\.all\(\[feedRefresh, listPeople\(feedId, search, \{ signal: read\.signal \}\)\]\);/);
  assert.match(refreshPeople, /if \(feedResult\.status === "rejected"\) \{\s+if \(isRequestCanceledError\(feedResult\.reason\)\) \{\s+throw feedResult\.reason;\s+\}\s+console\.error\(feedResult\.reason\);\s+requestDeferredQuietLoadForFeed\(feedId\);\s+\}/);
  assert.match(refreshPeople, /if \(feedResult\.status === "fulfilled" && feedResult\.value\) \{\s+setFeeds\(feedResult\.value\);\s+\}/);
  assert.ok(refreshPeople.indexOf('if (feedResult.status === "rejected")') < refreshPeople.indexOf("if (actionMutationVersionAtStart !== actionMutationVersionRef.current)"));
  assert.ok(refreshPeople.indexOf("setPeople(nextPeople);") > refreshPeople.indexOf('if (feedResult.status === "rejected")'));
  assert.doesNotMatch(refreshPeople, /const \[nextFeeds, nextPeople\] = await Promise\.all/);
});

test("person add workflows refresh running session targets immediately", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const addPerson = source.slice(source.indexOf("async function addPersonToSelectedFeed"), source.indexOf("async function bulkImportPeople"));
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));

  assert.match(addPerson, /await settlePostWriteRefreshes\(feedId, \[\s+refreshFeeds\(\),\s+refreshPeopleForMovedSearch\(view\),\s+refreshSessionsForFeed\(feedId, \{ applyWhenHidden: queueViewRef\.current\.feedId !== feedId \}\),\s+\]\);/);
  assert.doesNotMatch(addPerson, /await refreshFeeds\(\);\s+\}/);
  assert.match(
    bulkImport,
    /await settlePostWriteRefreshes\(feedId, \[\s+refreshPeopleForFeed\(feedId, view\.search\),\s+refreshPeopleForMovedSearch\(view\),\s+refreshSessionsForFeed\(feedId, \{ applyWhenHidden: queueViewRef\.current\.feedId !== feedId \}\),\s+\]\);/,
  );
  assert.doesNotMatch(bulkImport, /await refreshPeopleForFeed\(feedId, view\.search\);\s+\}/);
});

test("person add workflows merge hidden feed refresh sessions after feed switches", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const addPerson = source.slice(source.indexOf("async function addPersonToSelectedFeed"), source.indexOf("async function bulkImportPeople"));
  const bulkImport = source.slice(source.indexOf("async function bulkImportPeople"), source.indexOf("async function toggleMembership"));

  assert.match(addPerson, /refreshSessionsForFeed\(feedId, \{ applyWhenHidden: queueViewRef\.current\.feedId !== feedId \}\)/);
  assert.match(bulkImport, /refreshSessionsForFeed\(feedId, \{ applyWhenHidden: queueViewRef\.current\.feedId !== feedId \}\)/);
  assert.doesNotMatch(addPerson, /refreshSessionsForFeed\(feedId\)/);
  assert.doesNotMatch(bulkImport, /refreshSessionsForFeed\(feedId\)/);
});

test("refresh polling only acknowledges queue progress after queue reload succeeds", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const pollingEffect = source.slice(
    source.indexOf("const feedId = selectedFeed.id;"),
    source.indexOf("}, [selectedFeed?.id, queueStatus, hasRunningRefresh]);"),
  );

  assert.match(source, /const refreshSessionsRef = useRef<RefreshSession\[\]>\(\[\]\);/);
  assert.match(source, /const refreshPollOwnerSequenceRef = useRef\(0\);/);
  assert.match(source, /const refreshPollInFlightRef = useRef\(0\);/);
  assert.match(source, /const refreshPollPendingRef = useRef\(false\);/);
  assert.match(source, /const refreshPollKickRef = useRef<\(\) => void>\(\(\) => \{\}\);/);
  assert.match(source, /function mergeRefreshSessionsForFeed\(feedId: string, feedSessions: RefreshSession\[\]\)/);
  assert.match(source, /currentSessions\.filter\(\(session\) => session\.feedId !== feedId\)/);
  assert.match(source, /function refreshSessionsHaveUnacknowledgedQueueProgress\(\s+sessions: RefreshSession\[\],\s+previousSignatures: Map<string, string>,\s+\)/);
  assert.match(source, /let pollCanceled = false;/);
  assert.match(pollingEffect, /const handleRefreshPollError = \(error: unknown\) => \{\s+if \(pollCanceled \|\| queueViewRef\.current\.feedId !== feedId\) \{\s+return;\s+\}\s+if \(isRequestCanceledError\(error\)\) \{\s+return;\s+\}\s+console\.error\(error\);\s+requestDeferredQuietLoadForFeed\(feedId\);/);
  assert.match(pollingEffect, /if \(pollCanceled\) \{\s+return;\s+\}/);
  assert.match(pollingEffect, /if \(busyKeysRef\.current\.size > 0\) \{\s+refreshPollPendingRef\.current = true;\s+return;\s+\}/);
  assert.match(pollingEffect, /if \(refreshPollInFlightRef\.current\) \{\s+refreshPollPendingRef\.current = true;\s+return;\s+\}/);
  assert.match(pollingEffect, /refreshPollInFlightRef\.current = pollOwner;/);
  assert.match(pollingEffect, /const actionMutationVersionAtPollStart = actionMutationVersionRef\.current;/);
  assert.match(
    pollingEffect,
    /const shouldPollAllSessions = refreshSessionsRef\.current\.some\(\s+\(session\) => session\.feedId !== feedId && session\.status === "running",\s+\);/,
  );
  assert.match(pollingEffect, /let pollAbortController: AbortController \| undefined;/);
  assert.match(pollingEffect, /pollAbortController\?\.abort\(\);\s+pollAbortController = new AbortController\(\);/);
  assert.match(pollingEffect, /listRefreshSessions\(shouldPollAllSessions \? undefined : feedId, \{ signal: pollAbortController\.signal \}\)/);
  assert.match(pollingEffect, /\.then\(async \(sessions\) => \{/);
  assert.match(
    pollingEffect,
    /if \(actionMutationVersionAtPollStart !== actionMutationVersionRef\.current \|\| busyKeysRef\.current\.size > 0\) \{\s+refreshPollPendingRef\.current = true;\s+return;\s+\}/,
  );
  assert.match(pollingEffect, /const feedSessions = sessions\.filter\(\(session\) => session\.feedId === feedId\);/);
  assert.match(
    pollingEffect,
    /const queueChanged = refreshSessionsHaveUnacknowledgedQueueProgress\(\s+feedSessions,\s+refreshSessionSignaturesRef\.current,\s+\);/,
  );
  assert.match(pollingEffect, /if \(shouldPollAllSessions\) \{\s+applyRefreshSessions\(sessions\);\s+rememberRefreshSessionSignaturesExceptFeed\(feedId, sessions\);\s+\} else \{\s+mergeRefreshSessionsForFeed\(feedId, sessions\);/);
  assert.match(
    pollingEffect,
    /const applied = await refreshQueueForFeed\(feedId, queueViewRef\.current\.status\);\s+if \(applied\) \{\s+rememberRefreshSessionSignaturesForFeed\(feedId, feedSessions\);/,
  );
  assert.match(pollingEffect, /\} catch \(error\) \{\s+handleRefreshPollError\(error\);/);
  assert.match(pollingEffect, /\} else \{\s+rememberRefreshSessionSignaturesForFeed\(feedId, feedSessions\);/);
  assert.match(
    pollingEffect,
    /\.catch\(handleRefreshPollError\)\s+\.finally\(\(\) => \{\s+if \(refreshPollInFlightRef\.current === pollOwner\) \{\s+refreshPollInFlightRef\.current = 0;\s+\}/,
  );
  assert.doesNotMatch(pollingEffect, /\.catch\(\(\) => \{\}\)/);
  assert.match(
    pollingEffect,
    /if \(\s+!pollCanceled &&\s+refreshPollPendingRef\.current &&\s+queueViewRef\.current\.feedId === feedId &&\s+busyKeysRef\.current\.size === 0\s+\) \{\s+refreshPollPendingRef\.current = false;\s+window\.setTimeout\(pollRefreshSessions, 0\);/,
  );
  assert.match(pollingEffect, /refreshPollKickRef\.current = \(\) => \{/);
  assert.match(pollingEffect, /if \(pollCanceled \|\| !refreshPollPendingRef\.current \|\| queueViewRef\.current\.feedId !== feedId \|\| busyKeysRef\.current\.size > 0\) \{\s+return;\s+\}/);
  assert.ok(pollingEffect.indexOf("pollRefreshSessions();") < pollingEffect.indexOf("const timer = window.setInterval"));
  assert.match(source, /pollCanceled = true;\s+if \(refreshPollInFlightRef\.current === pollOwner\) \{\s+refreshPollInFlightRef\.current = 0;\s+\}\s+pollAbortController\?\.abort\(\);\s+refreshPollPendingRef\.current = false;\s+refreshPollKickRef\.current = \(\) => \{\};/);
  assert.ok(pollingEffect.indexOf("mergeRefreshSessionsForFeed(feedId, sessions);") < pollingEffect.indexOf("refreshQueueForFeed"));
});

test("refresh polling pauses during local actions and catches up afterward", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const runAction = source.slice(source.indexOf("async function runAction"), source.indexOf("async function runFeedWorkflowAction"));
  const pollingEffect = source.slice(
    source.indexOf("const feedId = selectedFeed.id;"),
    source.indexOf("}, [selectedFeed?.id, queueStatus, hasRunningRefresh]);"),
  );

  assert.match(source, /const refreshPollKickRef = useRef<\(\) => void>\(\(\) => \{\}\);/);
  assert.match(runAction, /if \(next\.size === 0\) \{\s+flushDeferredQuietLoad\(\);\s+refreshPollKickRef\.current\(\);/);
  assert.match(pollingEffect, /if \(busyKeysRef\.current\.size > 0\) \{\s+refreshPollPendingRef\.current = true;\s+return;\s+\}/);
  assert.match(
    pollingEffect,
    /if \(actionMutationVersionAtPollStart !== actionMutationVersionRef\.current \|\| busyKeysRef\.current\.size > 0\) \{\s+refreshPollPendingRef\.current = true;\s+return;\s+\}/,
  );
  assert.match(pollingEffect, /refreshPollKickRef\.current = \(\) => \{/);
  assert.match(pollingEffect, /refreshPollPendingRef\.current = false;\s+window\.setTimeout\(pollRefreshSessions, 0\);/);
});

test("refresh polling uses fast active cadence and quiet idle cadence", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const pollingEffect = source.slice(
    source.indexOf("const feedId = selectedFeed.id;"),
    source.indexOf("}, [selectedFeed?.id, queueStatus, hasRunningRefresh]);"),
  );

  assert.match(source, /const ACTIVE_REFRESH_POLL_MS = 3500;/);
  assert.match(source, /const IDLE_REFRESH_POLL_MS = 15000;/);
  assert.match(
    source,
    /const hasRunningRefresh = useMemo\(\s+\(\) => refreshSessions\.some\(\(session\) => session\.status === "running"\),\s+\[refreshSessions\],\s+\);/,
  );
  assert.match(pollingEffect, /const pollIntervalMs = hasRunningRefresh \? ACTIVE_REFRESH_POLL_MS : IDLE_REFRESH_POLL_MS;/);
  assert.match(pollingEffect, /const pollOwner = \+\+refreshPollOwnerSequenceRef\.current;/);
  assert.match(pollingEffect, /window\.setInterval\(\(\) => \{\s+pollRefreshSessions\(\);\s+\}, pollIntervalMs\);/);
  assert.match(source, /\}, \[selectedFeed\?\.id, queueStatus, hasRunningRefresh\]\);/);
  assert.doesNotMatch(pollingEffect, /\}, 3500\);/);
});

test("targeted refresh session reloads visible queue before acknowledging capture progress", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const refreshSessions = source.slice(
    source.indexOf("async function refreshSessionsForFeed"),
    source.indexOf("async function repairRefreshSessionsForFeed"),
  );

  assert.match(refreshSessions, /const sessions = await listRefreshSessions\(feedId, \{ signal: read\.signal \}\);/);
  assert.match(refreshSessions, /if \(queueViewRef\.current\.feedId !== feedId\) \{/);
  assert.match(refreshSessions, /mergeRefreshSessionsForFeed\(feedId, sessions\);/);
  assert.match(
    refreshSessions,
    /if \(refreshSessionsHaveUnacknowledgedQueueProgress\(sessions, refreshSessionSignaturesRef\.current\)\) \{\s+if \(!shouldRefreshQueueOnProgress\) \{\s+return;\s+\}\s+const applied = await refreshQueueForFeed\(feedId, queueViewRef\.current\.status\);\s+if \(!applied\) \{\s+return;\s+\}\s+\}/,
  );
  assert.match(refreshSessions, /rememberRefreshSessionSignaturesForFeed\(feedId, sessions\);/);
  assert.ok(refreshSessions.indexOf("mergeRefreshSessionsForFeed(feedId, sessions);") < refreshSessions.indexOf("refreshQueueForFeed"));
  assert.ok(refreshSessions.indexOf("refreshQueueForFeed") < refreshSessions.indexOf("rememberRefreshSessionSignaturesForFeed(feedId, sessions);"));
});

test("refresh polling reloads the queue only for captured item changes", () => {
  const source = fs.readFileSync(mainSourcePath, "utf8");
  const signature = source.slice(source.indexOf("function refreshQueueSignature"), source.indexOf("function sortRefreshSessions"));
  const progress = source.slice(source.indexOf("function sessionHasQueueProgress"), source.indexOf("function shouldClearBulkImportText"));

  assert.match(signature, /session\.inserted,\s+session\.updated,/);
  assert.doesNotMatch(signature, /session\.completedTargets/);
  assert.doesNotMatch(signature, /session\.skippedOlder/);
  assert.doesNotMatch(signature, /session\.failedTargets/);
  assert.doesNotMatch(signature, /session\.status/);
  assert.match(progress, /return session\.inserted > 0 \|\| session\.updated > 0;/);
  assert.match(progress, /const previousSignature = previousSignatures\.get\(session\.id\);/);
  assert.match(progress, /return previousSignature \? previousSignature !== nextSignature : sessionHasQueueProgress\(session\);/);
  assert.doesNotMatch(progress, /session\.completedTargets > 0/);
  assert.doesNotMatch(progress, /session\.status !== "running"/);
});
