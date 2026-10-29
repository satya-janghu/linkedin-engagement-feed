export type Feed = {
  id: string;
  name: string;
  lookbackDays: number;
  peopleCount: number;
  createdAt: string;
  updatedAt: string;
};

export type Person = {
  id: string;
  name: string;
  profileUrl: string;
  publicId: string;
  headline: string;
  commentCount: number;
  likeCount: number;
  backCommentCount: number;
  feedIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type QueueItem = {
  id: string;
  personId: string;
  feedIds: string[];
  feedNames: string[];
  personName: string;
  profileUrl: string;
  type: "post" | "comment";
  sourceUrl: string;
  externalId: string;
  text: string;
  activityAt: string;
  discoveredAt: string;
  status: "new" | "done" | "skipped";
};

export type QueueStatus = "new" | "done" | "skipped";

export type QueueCounts = Record<QueueStatus, number> & {
  all: number;
};

export type QueueView = {
  items: QueueItem[];
  counts: QueueCounts;
};

export type QueueStatusChange = {
  itemId: string;
  personId: string;
  previousStatus: QueueStatus;
  status: QueueStatus;
  changed: boolean;
  commentCountDelta: number;
};

export type CaptureResult = {
  received: number;
  inserted: number;
  updated: number;
  skippedOlder: number;
  skippedUntracked: number;
  skippedInvalid: number;
};

export type RefreshSession = {
  id: string;
  feedId: string;
  feedName: string;
  lookbackDays: number;
  lookbackCutoffAt: string;
  status: "running" | "done" | "canceled" | "failed";
  totalTargets: number;
  completedTargets: number;
  failedTargets: number;
  inserted: number;
  updated: number;
  skippedOlder: number;
  skippedUntracked: number;
  skippedInvalid: number;
  lastError: string;
  currentTarget?: {
    index: number;
    personId: string;
    personName: string;
    profileUrl: string;
    kind: "posts" | "comments";
    url: string;
  };
  nextUrl?: string;
  delayMs: number;
  nextDelayMs: number;
  nextDelayReason: string;
  issueStreak: number;
  rateLimitStreak: number;
  currentAttempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  createdByRequest?: boolean;
};

export type RefreshCancelResult = RefreshSession | {
  ok: true;
  id: string;
  alreadyCanceled: true;
};

export type BulkPeopleResult = {
  received: number;
  added: number;
  alreadyInFeed: number;
  updated: number;
  skippedInvalid: number;
  skippedCapacity: number;
  remainingCapacity: number;
  errors: Array<{ index: number; profileUrl: string; error: string }>;
};

export type StorageInfo = {
  dataDir: string;
  databasePath: string;
  backupPath: string;
  databaseExists: boolean;
  backupExists: boolean;
  databaseBytes: number;
  backupBytes: number;
  databaseUpdatedAt: string;
  backupUpdatedAt: string;
  corruptBackups: Array<{ path: string; bytes: number; updatedAt: string }>;
};

export type AppDataExport = {
  exportedAt: string;
  app: {
    name: "linkedin-engagement-feed";
    schemaVersion: number;
  };
  feeds: Array<{
    id: string;
    name: string;
    lookbackDays: number;
    createdAt: string;
    updatedAt: string;
  }>;
  people: Array<Omit<Person, "feedIds">>;
  feedPeople: Array<{ feedId: string; personId: string; createdAt: string }>;
  items: Array<{
    id: string;
    personId: string;
    type: "post" | "comment";
    sourceUrl: string;
    externalId: string;
    text: string;
    activityAt: string;
    discoveredAt: string;
    status: QueueStatus;
    commentCountApplied: number;
    createdAt: string;
    updatedAt: string;
  }>;
  itemFeeds: Array<{ itemId: string; feedId: string; createdAt: string }>;
  counts: {
    feeds: number;
    people: number;
    items: number;
    feedPeople: number;
    itemFeeds: number;
  };
};

let apiBaseUrlPromise: Promise<string> | undefined;
const API_IDENTITY_HEADER = "X-LinkedIn-Engagement-Feed";
const API_BASE_URL_TIMEOUT_MS = 5000;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class BulkImportPartialError extends Error {
  constructor(
    message: string,
    public readonly result: BulkPeopleResult,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BulkImportPartialError";
  }
}

class ApiIdentityError extends Error {
  constructor() {
    super("The local service is not the Engagement Feed app.");
    this.name = "ApiIdentityError";
  }
}

class ApiBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiBaseUrlError";
  }
}

class MalformedApiResponseError extends SyntaxError {
  constructor(message: string) {
    super(message);
    this.name = "MalformedApiResponseError";
  }
}

export class ApiRequestCanceledError extends Error {
  constructor() {
    super("Request was canceled.");
    this.name = "ApiRequestCanceledError";
  }
}

function getApiBaseUrlFromBridge() {
  const bridge = window.linkedinFeed as Partial<AppBridge> | undefined;
  if (typeof bridge?.getApiBaseUrl !== "function") {
    return Promise.reject(new ApiBaseUrlError("The desktop bridge is unavailable."));
  }
  try {
    return Promise.resolve(bridge.getApiBaseUrl());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function apiBaseUrl(options: { refresh?: boolean } = {}) {
  if (options.refresh) {
    apiBaseUrlPromise = undefined;
  }
  if (apiBaseUrlPromise) {
    return apiBaseUrlPromise;
  }
  const lookupPromise = withTimeout(getApiBaseUrlFromBridge(), API_BASE_URL_TIMEOUT_MS).catch((error) => {
    if (apiBaseUrlPromise === lookupPromise) {
      apiBaseUrlPromise = undefined;
    }
    if (error instanceof ApiBaseUrlError) {
      throw error;
    }
    throw new ApiBaseUrlError(error instanceof Error ? error.message : "Unable to find the local app service.");
  });
  apiBaseUrlPromise = lookupPromise;
  return apiBaseUrlPromise;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
const WRITE_REQUEST_TIMEOUT_MS = 20000;
const LONG_REQUEST_TIMEOUT_MS = 60000;
const MAX_REQUEST_TIMEOUT_MS = 60000;
const SAFE_API_ATTEMPTS = 3;
const SAFE_API_RETRY_DELAYS_MS = [300, 900];
const MAX_RETRY_AFTER_MS = 5000;
const MAX_PEOPLE_PER_FEED = 200;
const BULK_PEOPLE_REQUEST_MAX_CHUNK_SIZE = 500;
const BULK_PEOPLE_REQUEST_MAX_BYTES = 512 * 1024;
const MAX_BULK_PEOPLE_ERROR_DETAILS = 50;
const MAX_BULK_ERROR_PROFILE_URL_LENGTH = 240;

type ApiValidator<T> = (value: unknown) => T;

type ApiRequestInit<T = unknown> = RequestInit & {
  retry?: boolean;
  timeoutMs?: number;
  validate?: ApiValidator<T>;
};

type ApiCallOptions = {
  signal?: AbortSignal;
};

export async function api<T>(path: string, options: ApiRequestInit<T> = {}): Promise<T> {
  const { retry, timeoutMs, validate, signal, ...fetchOptions } = options;
  const method = String(options.method || "GET").toUpperCase();
  assertRetryIsSafe(method, Boolean(retry), fetchOptions.body);
  const attempts = method === "GET" || retry ? SAFE_API_ATTEMPTS : 1;
  const requestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  let lastError: unknown;
  let refreshBaseUrl = false;
  let requestWasCanceled = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let timer = 0;
    let removeAbortListener: (() => void) | undefined;
    try {
      const baseUrl = await waitForApiBaseUrl(apiBaseUrl({ refresh: refreshBaseUrl }), signal);
      refreshBaseUrl = false;
      const controller = new AbortController();
      if (signal?.aborted) {
        requestWasCanceled = true;
        controller.abort();
      } else if (signal) {
        const abortFromCaller = () => {
          requestWasCanceled = true;
          controller.abort();
        };
        signal.addEventListener("abort", abortFromCaller, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abortFromCaller);
      }
      timer = window.setTimeout(() => controller.abort(), requestTimeoutMs);
      const response = await fetch(`${baseUrl}${path}`, {
        ...fetchOptions,
        method,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(fetchOptions.headers || {}),
        },
      });

      if (response.headers.get(API_IDENTITY_HEADER) !== "1") {
        throw new ApiIdentityError();
      }
      const text = await response.text();
      const data = (text ? JSON.parse(text) : {}) as T | { error: string };
      const hasError = typeof data === "object" && data !== null && "error" in data;
      if (!response.ok || hasError) {
        throw new ApiError(
          hasError ? data.error : `Request failed: ${response.status}`,
          response.status,
          retryAfterDelayMs(response.headers.get("Retry-After")),
        );
      }
      return validate ? validate(data) : (data as T);
    } catch (error) {
      lastError = error;
      if (error instanceof ApiRequestCanceledError) {
        requestWasCanceled = true;
        break;
      }
      const shouldRetry = attempt < attempts - 1 && !requestWasCanceled && isRetryableLocalApiError(error);
      if (shouldRetry) {
        if (isLocalApiConnectionError(error) || isMalformedApiResponseError(error)) {
          apiBaseUrlPromise = undefined;
          refreshBaseUrl = true;
        }
        const retryDelayCompleted = await waitForRetryDelay(retryDelayMsForAttempt(attempt, error), signal);
        if (!retryDelayCompleted) {
          requestWasCanceled = true;
          break;
        }
        continue;
      }
      break;
    } finally {
      removeAbortListener?.();
      if (timer) {
        window.clearTimeout(timer);
      }
    }
  }

  if (requestWasCanceled) {
    throw new ApiRequestCanceledError();
  }
  if (isAbortError(lastError)) {
    throw new Error("The local Engagement Feed app did not respond. Try Reload, then restart the app if it continues.");
  }
  if (lastError instanceof SyntaxError) {
    throw new Error("The local Engagement Feed app returned an invalid response. Try Reload.");
  }
  if (lastError instanceof TypeError) {
    throw new Error("Cannot reach the local Engagement Feed app. Make sure the desktop app is still running.");
  }
  if (lastError instanceof ApiIdentityError) {
    throw new Error("The configured local service is not the Engagement Feed app. Try Reload, then restart the app if it continues.");
  }
  if (lastError instanceof ApiBaseUrlError) {
    throw new Error("Cannot find the local Engagement Feed service. Try Reload, then restart the app if it continues.");
  }
  throw lastError instanceof Error ? lastError : new Error("Something went wrong.");
}

function isRetryableLocalApiError(error: unknown) {
  return isLocalApiConnectionError(error) || isMalformedApiResponseError(error) || isRetryableApiError(error);
}

function assertRetryIsSafe(method: string, retry: boolean, body: BodyInit | null | undefined) {
  if (!retry || method === "GET" || method === "HEAD" || method === "DELETE") {
    return;
  }
  if (!retryBodyHasRequestId(body)) {
    throw new Error(`${method} requests with retry enabled must include a stable requestId in the JSON body.`);
  }
}

function retryBodyHasRequestId(body: BodyInit | null | undefined) {
  if (typeof body !== "string") {
    return false;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { requestId?: unknown }).requestId === "string" &&
        (parsed as { requestId: string }).requestId.trim(),
    );
  } catch {
    return false;
  }
}

function isLocalApiConnectionError(error: unknown) {
  return error instanceof TypeError || error instanceof ApiIdentityError || error instanceof ApiBaseUrlError || isAbortError(error);
}

function isMalformedApiResponseError(error: unknown) {
  return error instanceof MalformedApiResponseError || error instanceof SyntaxError;
}

function isRetryableApiError(error: unknown) {
  return error instanceof ApiError && (error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500);
}

function retryDelayMsForAttempt(attempt: number, error?: unknown) {
  if (error instanceof ApiError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return SAFE_API_RETRY_DELAYS_MS[Math.min(attempt, SAFE_API_RETRY_DELAYS_MS.length - 1)];
}

function waitForRetryDelay(ms: number, signal?: AbortSignal | null) {
  if (!signal) {
    return new Promise<boolean>((resolve) => window.setTimeout(() => resolve(true), ms));
  }
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abortDelay);
      resolve(true);
    }, ms);
    const abortDelay = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abortDelay);
      resolve(false);
    };
    signal.addEventListener("abort", abortDelay, { once: true });
  });
}

function waitForApiBaseUrl(promise: Promise<string>, signal?: AbortSignal | null) {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new ApiRequestCanceledError());
  }
  return new Promise<string>((resolve, reject) => {
    const abortLookup = () => {
      reject(new ApiRequestCanceledError());
    };
    signal.addEventListener("abort", abortLookup, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abortLookup));
  });
}

function normalizeRequestTimeoutMs(value: number | undefined) {
  if (value === undefined) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  return Math.max(1000, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.round(timeoutMs)));
}

function isAbortError(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error("Timed out while locating the local app service."));
    }, timeoutMs);
    promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

function retryAfterDelayMs(value: string | null) {
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

function validateFeeds(value: unknown): Feed[] {
  if (!Array.isArray(value)) {
    throw malformedApiResponse("The local feeds response was not a list.");
  }
  const feeds = value.map(validateFeed);
  const feedIds = feeds.map((feed) => feed.id);
  if (new Set(feedIds).size !== feedIds.length) {
    throw malformedApiResponse("The local feeds response has duplicate feed ids.");
  }
  return feeds;
}

function validateFeed(value: unknown): Feed {
  const feed = requireApiRecord(value, "feed");
  requireApiNonEmptyString(feed, "id", "feed");
  requireApiNonEmptyString(feed, "name", "feed");
  requireApiIntegerInRange(feed, "lookbackDays", "feed", 1, 365);
  requireApiIntegerInRange(feed, "peopleCount", "feed", 0, MAX_PEOPLE_PER_FEED);
  requireApiDateString(feed, "createdAt", "feed");
  requireApiDateString(feed, "updatedAt", "feed");
  return feed as Feed;
}

function validatePeople(value: unknown): Person[] {
  if (!Array.isArray(value)) {
    throw malformedApiResponse("The local people response was not a list.");
  }
  const people = value.map(validatePerson);
  const personIds = people.map((person) => person.id);
  if (new Set(personIds).size !== personIds.length) {
    throw malformedApiResponse("The local people response has duplicate person ids.");
  }
  return people;
}

function validatePerson(value: unknown): Person {
  const person = requireApiRecord(value, "person");
  requireApiNonEmptyString(person, "id", "person");
  requireApiNonEmptyString(person, "name", "person");
  requireApiLinkedInProfileUrl(person, "profileUrl", "person");
  requireApiNonEmptyString(person, "publicId", "person");
  requireApiString(person, "headline", "person");
  requireApiNumber(person, "commentCount", "person");
  requireApiNumber(person, "likeCount", "person");
  requireApiNumber(person, "backCommentCount", "person");
  requireApiUniqueStringArray(person, "feedIds", "person");
  requireApiDateString(person, "createdAt", "person");
  requireApiDateString(person, "updatedAt", "person");
  return person as Person;
}

function validatePersonSaveResult(value: unknown): { person?: Person; feedIds: string[] } {
  const result = requireApiRecord(value, "person save");
  if (result.person !== undefined) {
    validatePerson(result.person);
  }
  requireApiUniqueStringArray(result, "feedIds", "person save");
  return result as { person?: Person; feedIds: string[] };
}

function validateBulkPeopleResult(value: unknown): BulkPeopleResult {
  const result = requireApiRecord(value, "bulk people");
  for (const key of [
    "received",
    "added",
    "alreadyInFeed",
    "updated",
    "skippedInvalid",
    "skippedCapacity",
    "remainingCapacity",
  ] as const) {
    requireApiNumber(result, key, "bulk people");
  }
  const received = result.received as number;
  const added = result.added as number;
  const alreadyInFeed = result.alreadyInFeed as number;
  const updated = result.updated as number;
  const skippedInvalid = result.skippedInvalid as number;
  const skippedCapacity = result.skippedCapacity as number;
  const totalSkipped = skippedInvalid + skippedCapacity;
  const remainingCapacity = result.remainingCapacity as number;
  if (remainingCapacity > MAX_PEOPLE_PER_FEED) {
    throw malformedApiResponse("The local bulk people response has impossible remaining capacity.");
  }
  if (added + alreadyInFeed + skippedInvalid + skippedCapacity !== received) {
    throw malformedApiResponse("The local bulk people response has inconsistent totals.");
  }
  if (updated > alreadyInFeed) {
    throw malformedApiResponse("The local bulk people response has inconsistent update totals.");
  }
  const errors = result.errors;
  if (!Array.isArray(errors)) {
    throw malformedApiResponse('The local bulk people response is missing "errors".');
  }
  if (errors.length > MAX_BULK_PEOPLE_ERROR_DETAILS) {
    throw malformedApiResponse("The local bulk people response has too many error details.");
  }
  if (errors.length > totalSkipped) {
    throw malformedApiResponse("The local bulk people response has impossible error details.");
  }
  const seenErrorIndexes = new Set<number>();
  for (const error of errors) {
    const entry = requireApiRecord(error, "bulk people error");
    requireApiNumber(entry, "index", "bulk people error");
    requireApiString(entry, "profileUrl", "bulk people error");
    requireApiString(entry, "error", "bulk people error");
    if ((entry.index as number) >= received) {
      throw malformedApiResponse("The local bulk people response has an out-of-range error index.");
    }
    if (seenErrorIndexes.has(entry.index as number)) {
      throw malformedApiResponse("The local bulk people response has duplicate error details.");
    }
    seenErrorIndexes.add(entry.index as number);
  }
  return result as BulkPeopleResult;
}

function validateDeleteFeedResult(value: unknown): { ok: boolean; canceledRefreshSessions: number; alreadyDeleted?: boolean } {
  const result = requireApiRecord(value, "feed delete");
  requireApiBoolean(result, "ok", "feed delete");
  if (result.ok !== true) {
    throw malformedApiResponse("The local feed delete response was not confirmed.");
  }
  requireApiNumber(result, "canceledRefreshSessions", "feed delete");
  if (result.alreadyDeleted !== undefined) {
    requireApiBoolean(result, "alreadyDeleted", "feed delete");
  }
  return result as { ok: boolean; canceledRefreshSessions: number; alreadyDeleted?: boolean };
}

function validateDeletePersonResult(value: unknown): { ok: boolean; alreadyDeleted?: boolean } {
  const result = requireApiRecord(value, "person delete");
  requireApiBoolean(result, "ok", "person delete");
  if (result.ok !== true) {
    throw malformedApiResponse("The local person delete response was not confirmed.");
  }
  if (result.alreadyDeleted !== undefined) {
    requireApiBoolean(result, "alreadyDeleted", "person delete");
  }
  return result as { ok: boolean; alreadyDeleted?: boolean };
}

function validateStorageInfo(value: unknown): StorageInfo {
  const info = requireApiRecord(value, "storage info");
  for (const key of ["dataDir", "databasePath", "backupPath", "databaseUpdatedAt", "backupUpdatedAt"] as const) {
    requireApiString(info, key, "storage info");
  }
  for (const key of ["databaseExists", "backupExists"] as const) {
    requireApiBoolean(info, key, "storage info");
  }
  for (const key of ["databaseBytes", "backupBytes"] as const) {
    requireApiNumber(info, key, "storage info");
  }
  if (info.databaseExists) {
    requireApiDateString(info, "databaseUpdatedAt", "storage info");
  }
  if (info.backupExists) {
    requireApiDateString(info, "backupUpdatedAt", "storage info");
  }
  const corruptBackups = info.corruptBackups;
  if (!Array.isArray(corruptBackups)) {
    throw malformedApiResponse('The local storage info response is missing "corruptBackups".');
  }
  for (const backup of corruptBackups) {
    const entry = requireApiRecord(backup, "corrupt backup");
    requireApiString(entry, "path", "corrupt backup");
    requireApiNumber(entry, "bytes", "corrupt backup");
    requireApiDateString(entry, "updatedAt", "corrupt backup");
  }
  return info as StorageInfo;
}

function validateDataExport(value: unknown): AppDataExport {
  const exported = requireApiRecord(value, "data export");
  requireApiDateString(exported, "exportedAt", "data export");
  const app = requireApiRecord(exported.app, "data export app");
  if (app.name !== "linkedin-engagement-feed") {
    throw malformedApiResponse("The local data export response has an unknown app name.");
  }
  requireApiIntegerInRange(app, "schemaVersion", "data export app", 1, 1);
  const feeds = requireApiArray(exported, "feeds", "data export").map(validateExportFeed);
  const people = requireApiArray(exported, "people", "data export").map(validateExportPerson);
  const feedPeople = requireApiArray(exported, "feedPeople", "data export").map(validateExportFeedPerson);
  const items = requireApiArray(exported, "items", "data export").map(validateExportItem);
  const itemFeeds = requireApiArray(exported, "itemFeeds", "data export").map(validateExportItemFeed);
  const feedIds = requireUniqueExportIds(feeds, "feed");
  const personIds = requireUniqueExportIds(people, "person");
  const itemIds = requireUniqueExportIds(items, "item");
  requireExportMembershipReferences(feedPeople, feedIds, personIds);
  requireExportItemReferences(items, personIds);
  requireExportItemFeedReferences(itemFeeds, itemIds, feedIds);
  const counts = requireApiRecord(exported.counts, "data export counts");
  const expectedCounts = {
    feeds: feeds.length,
    people: people.length,
    items: items.length,
    feedPeople: feedPeople.length,
    itemFeeds: itemFeeds.length,
  };
  for (const key of ["feeds", "people", "items", "feedPeople", "itemFeeds"] as const) {
    requireApiNumber(counts, key, "data export counts");
    if (counts[key] !== expectedCounts[key]) {
      throw malformedApiResponse(`The local data export response has an inconsistent "${key}" count.`);
    }
  }
  return exported as AppDataExport;
}

function validateExportFeed(value: unknown) {
  const feed = requireApiRecord(value, "data export feed");
  requireApiNonEmptyString(feed, "id", "data export feed");
  requireApiNonEmptyString(feed, "name", "data export feed");
  requireApiIntegerInRange(feed, "lookbackDays", "data export feed", 1, 365);
  requireApiDateString(feed, "createdAt", "data export feed");
  requireApiDateString(feed, "updatedAt", "data export feed");
  return feed as AppDataExport["feeds"][number];
}

function validateExportPerson(value: unknown) {
  const person = requireApiRecord(value, "data export person");
  requireApiNonEmptyString(person, "id", "data export person");
  requireApiNonEmptyString(person, "name", "data export person");
  requireApiLinkedInProfileUrl(person, "profileUrl", "data export person");
  requireApiNonEmptyString(person, "publicId", "data export person");
  requireApiString(person, "headline", "data export person");
  requireApiNumber(person, "commentCount", "data export person");
  requireApiNumber(person, "likeCount", "data export person");
  requireApiNumber(person, "backCommentCount", "data export person");
  requireApiDateString(person, "createdAt", "data export person");
  requireApiDateString(person, "updatedAt", "data export person");
  return person as AppDataExport["people"][number];
}

function validateExportFeedPerson(value: unknown) {
  const membership = requireApiRecord(value, "data export feed membership");
  requireApiNonEmptyString(membership, "feedId", "data export feed membership");
  requireApiNonEmptyString(membership, "personId", "data export feed membership");
  requireApiDateString(membership, "createdAt", "data export feed membership");
  return membership as AppDataExport["feedPeople"][number];
}

function validateExportItem(value: unknown) {
  const item = requireApiRecord(value, "data export item");
  requireApiNonEmptyString(item, "id", "data export item");
  requireApiNonEmptyString(item, "personId", "data export item");
  requireQueueItemType(item.type);
  requireApiLinkedInUrl(item, "sourceUrl", "data export item");
  requireApiNonEmptyString(item, "externalId", "data export item");
  requireApiString(item, "text", "data export item");
  requireApiDateString(item, "activityAt", "data export item");
  requireApiDateString(item, "discoveredAt", "data export item");
  requireQueueStatus(item.status);
  requireApiIntegerInRange(item, "commentCountApplied", "data export item", 0, 1);
  requireApiDateString(item, "createdAt", "data export item");
  requireApiDateString(item, "updatedAt", "data export item");
  return item as AppDataExport["items"][number];
}

function validateExportItemFeed(value: unknown) {
  const itemFeed = requireApiRecord(value, "data export item feed");
  requireApiNonEmptyString(itemFeed, "itemId", "data export item feed");
  requireApiNonEmptyString(itemFeed, "feedId", "data export item feed");
  requireApiDateString(itemFeed, "createdAt", "data export item feed");
  return itemFeed as AppDataExport["itemFeeds"][number];
}

function requireUniqueExportIds<T extends { id: string }>(entries: T[], label: string) {
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw malformedApiResponse(`The local data export response has duplicate ${label} ids.`);
  }
  return new Set(ids);
}

function requireExportMembershipReferences(
  feedPeople: AppDataExport["feedPeople"],
  feedIds: Set<string>,
  personIds: Set<string>,
) {
  const pairs = new Set<string>();
  for (const entry of feedPeople) {
    if (!feedIds.has(entry.feedId) || !personIds.has(entry.personId)) {
      throw malformedApiResponse("The local data export response has an orphan feed membership.");
    }
    const pair = `${entry.feedId}\n${entry.personId}`;
    if (pairs.has(pair)) {
      throw malformedApiResponse("The local data export response has duplicate feed memberships.");
    }
    pairs.add(pair);
  }
}

function requireExportItemReferences(items: AppDataExport["items"], personIds: Set<string>) {
  for (const item of items) {
    if (!personIds.has(item.personId)) {
      throw malformedApiResponse("The local data export response has an orphan item.");
    }
  }
}

function requireExportItemFeedReferences(
  itemFeeds: AppDataExport["itemFeeds"],
  itemIds: Set<string>,
  feedIds: Set<string>,
) {
  const pairs = new Set<string>();
  for (const entry of itemFeeds) {
    if (!itemIds.has(entry.itemId) || !feedIds.has(entry.feedId)) {
      throw malformedApiResponse("The local data export response has an orphan item feed link.");
    }
    const pair = `${entry.itemId}\n${entry.feedId}`;
    if (pairs.has(pair)) {
      throw malformedApiResponse("The local data export response has duplicate item feed links.");
    }
    pairs.add(pair);
  }
}

export const listFeeds = (options: ApiCallOptions = {}) =>
  api<Feed[]>("/api/feeds", { signal: options.signal, validate: validateFeeds });

export const getStorageInfo = (options: ApiCallOptions = {}) =>
  api<StorageInfo>("/api/storage", { signal: options.signal, validate: validateStorageInfo });

export const getDataExport = (options: ApiCallOptions = {}) => api<AppDataExport>("/api/export", {
  signal: options.signal,
  timeoutMs: LONG_REQUEST_TIMEOUT_MS,
  validate: validateDataExport,
});

export const createFeed = (name: string, lookbackDays = 15) =>
  api<Feed>("/api/feeds/get-or-create", {
    method: "POST",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validateFeed,
    body: JSON.stringify({ name, lookbackDays, requestId: createClientRequestId() }),
  });

export const updateFeed = (feedId: string, patch: Partial<Pick<Feed, "name" | "lookbackDays">>) =>
  api<Feed>(`/api/feeds/${encodeURIComponent(feedId)}`, {
    method: "PATCH",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validateFeed,
    body: JSON.stringify({ ...patch, requestId: createClientRequestId() }),
  });

export const deleteFeed = (feedId: string) =>
  api<{ ok: boolean; canceledRefreshSessions: number; alreadyDeleted?: boolean }>(`/api/feeds/${encodeURIComponent(feedId)}`, {
    method: "DELETE",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validateDeleteFeedResult,
  });

export const listPeople = (feedId?: string, query = "", options: ApiCallOptions = {}) => {
  const params = new URLSearchParams();
  if (feedId) {
    params.set("feedId", feedId);
  }
  if (query.trim()) {
    params.set("query", query.trim());
  }
  const suffix = params.toString();
  return api<Person[]>(suffix ? `/api/people?${suffix}` : "/api/people", {
    signal: options.signal,
    validate: validatePeople,
  });
};

export const upsertPerson = (input: { name: string; profileUrl: string }) =>
  api<{ person?: Person; feedIds: string[] }>("/api/people", {
    method: "POST",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validatePersonSaveResult,
    body: JSON.stringify({ ...input, requestId: createClientRequestId() }),
  });

export const createOrUpdatePerson = (input: { name: string; profileUrl: string; feedIds: string[] }) =>
  api<{ person?: Person; feedIds: string[] }>("/api/people", {
    method: "POST",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validatePersonSaveResult,
    body: JSON.stringify({ ...input, requestId: createClientRequestId() }),
  });

export const addPersonToFeed = (feedId: string, input: { name: string; profileUrl: string }) =>
  api<Person>(`/api/feeds/${encodeURIComponent(feedId)}/people`, {
    method: "POST",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validatePerson,
    body: JSON.stringify({ ...input, requestId: createClientRequestId() }),
  });

export const updatePersonMemberships = (personId: string, feedIds: string[], options: { knownFeedIds?: string[] } = {}) =>
  api<Person>(`/api/people/${encodeURIComponent(personId)}/memberships`, {
    method: "POST",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validatePerson,
    body: JSON.stringify({ feedIds, knownFeedIds: options.knownFeedIds, requestId: createClientRequestId() }),
  });

export async function bulkAddPeopleToFeed(
  feedId: string,
  people: Array<{ name?: string; profileUrl: string }>,
  options: { knownRemainingCapacity?: number } = {},
) {
  const prepared = prepareBulkPeopleForImport(people);
  const chunks = chunkPreparedBulkPeople(prepared.people);
  if (chunks.length === 0) {
    return mergePreparedBulkImportResult(emptyBulkPeopleResult(options.knownRemainingCapacity), prepared);
  }

  let aggregate: BulkPeopleResult | undefined;
  for (const chunk of chunks) {
    try {
      const result = await bulkAddPeopleChunk(
        feedId,
        chunk.items.map((entry) => entry.person),
        chunk.items.map((entry) => entry.originalIndex),
      );
      aggregate = aggregate ? mergeBulkPeopleResult(aggregate, result) : result;
    } catch (error) {
      if (aggregate) {
        const failedAtOriginalIndex = chunk.items[0]?.originalIndex ?? people.length;
        const partialResult = mergePreparedBulkImportResult(aggregate, prepared, { beforeOriginalIndex: failedAtOriginalIndex });
        throw new BulkImportPartialError(
          bulkImportPartialErrorMessage(partialResult, error),
          partialResult,
          error,
        );
      }
      throw error;
    }
  }
  return mergePreparedBulkImportResult(aggregate!, prepared);
}

function emptyBulkPeopleResult(knownRemainingCapacity = MAX_PEOPLE_PER_FEED): BulkPeopleResult {
  return {
    received: 0,
    added: 0,
    alreadyInFeed: 0,
    updated: 0,
    skippedInvalid: 0,
    skippedCapacity: 0,
    remainingCapacity: normalizeKnownBulkImportRemainingCapacity(knownRemainingCapacity),
    errors: [],
  };
}

function prepareBulkPeopleForImport(people: Array<{ name?: string; profileUrl: string }>) {
  const seenProfileKeys = new Set<string>();
  const preparedPeople: Array<{ person: { name?: string; profileUrl: string }; originalIndex: number }> = [];
  const skippedRows: BulkPeopleResult["errors"] = [];

  for (const [index, person] of people.entries()) {
    if (bulkPeopleRequestByteLength([person]) > BULK_PEOPLE_REQUEST_MAX_BYTES) {
      skippedRows.push({
        index,
        profileUrl: truncateBulkImportErrorProfileUrl(person.profileUrl),
        error: "Profile row is too large to import.",
      });
      continue;
    }
    const profileKey = bulkImportProfileDuplicateKey(person.profileUrl);
    if (profileKey && seenProfileKeys.has(profileKey)) {
      skippedRows.push({
        index,
        profileUrl: truncateBulkImportErrorProfileUrl(person.profileUrl),
        error: "Duplicate profile in this import.",
      });
      continue;
    }
    if (profileKey) {
      seenProfileKeys.add(profileKey);
    }
    preparedPeople.push({ person, originalIndex: index });
  }

  return {
    received: people.length,
    people: preparedPeople,
    skippedRows,
  };
}

function bulkAddPeopleChunk(feedId: string, people: Array<{ name?: string; profileUrl: string }>, originalIndexes: number[]) {
  return api<BulkPeopleResult>(`/api/feeds/${encodeURIComponent(feedId)}/people/bulk`, {
    method: "POST",
    retry: true,
    timeoutMs: LONG_REQUEST_TIMEOUT_MS,
    validate: validateBulkPeopleResult,
    body: JSON.stringify({ people, requestId: createClientRequestId() }),
  }).then((result) => ({
    ...result,
    errors: result.errors.map((error) => ({ ...error, index: originalIndexes[error.index] ?? error.index })),
  }));
}

function mergePreparedBulkImportResult(
  result: BulkPeopleResult,
  prepared: ReturnType<typeof prepareBulkPeopleForImport>,
  options: { beforeOriginalIndex?: number } = {},
): BulkPeopleResult {
  const skippedRows = prepared.skippedRows.filter(
    (entry) => options.beforeOriginalIndex === undefined || entry.index < options.beforeOriginalIndex,
  );
  return {
    ...result,
    received: result.received + skippedRows.length,
    skippedInvalid: result.skippedInvalid + skippedRows.length,
    errors: [...result.errors, ...skippedRows]
      .sort((first, second) => first.index - second.index)
      .slice(0, MAX_BULK_PEOPLE_ERROR_DETAILS),
  };
}

function mergeBulkPeopleResult(current: BulkPeopleResult, next: BulkPeopleResult): BulkPeopleResult {
  return {
    received: current.received + next.received,
    added: current.added + next.added,
    alreadyInFeed: current.alreadyInFeed + next.alreadyInFeed,
    updated: current.updated + next.updated,
    skippedInvalid: current.skippedInvalid + next.skippedInvalid,
    skippedCapacity: current.skippedCapacity + next.skippedCapacity,
    remainingCapacity: next.remainingCapacity,
    errors: [...current.errors, ...next.errors].slice(0, MAX_BULK_PEOPLE_ERROR_DETAILS),
  };
}

function normalizeKnownBulkImportRemainingCapacity(value: number) {
  const capacity = Number(value);
  if (!Number.isFinite(capacity)) {
    return MAX_PEOPLE_PER_FEED;
  }
  return Math.max(0, Math.min(MAX_PEOPLE_PER_FEED, Math.round(capacity)));
}

function bulkImportPartialErrorMessage(result: BulkPeopleResult, error: unknown) {
  const processedCount = result.received;
  const savedCount = result.added + result.alreadyInFeed;
  const detail = error instanceof Error ? error.message : "The local app stopped responding.";
  return `Bulk import stopped after processing ${processedCount} profile${processedCount === 1 ? "" : "s"} and saving ${savedCount}. ${detail}`;
}

function chunkPreparedBulkPeople(
  entries: Array<{ person: { name?: string; profileUrl: string }; originalIndex: number }>,
) {
  const chunks: Array<{ items: typeof entries }> = [];
  let items: typeof entries = [];
  for (const entry of entries) {
    const nextItems = [...items, entry];
    const wouldExceedRowLimit = nextItems.length > BULK_PEOPLE_REQUEST_MAX_CHUNK_SIZE;
    const wouldExceedByteLimit =
      items.length > 0 && bulkPeopleRequestByteLength(nextItems.map((current) => current.person)) > BULK_PEOPLE_REQUEST_MAX_BYTES;
    if (wouldExceedRowLimit || wouldExceedByteLimit) {
      chunks.push({ items });
      items = [];
    }
    items.push(entry);
  }
  if (items.length > 0) {
    chunks.push({ items });
  }
  return chunks;
}

function bulkPeopleRequestByteLength(people: Array<{ name?: string; profileUrl: string }>) {
  const payload = JSON.stringify({ people, requestId: "req_".padEnd(80, "x") });
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(payload).length;
  }
  return payload.length * 2;
}

function truncateBulkImportErrorProfileUrl(profileUrl: string) {
  const cleanProfileUrl = String(profileUrl || "");
  return cleanProfileUrl.length > MAX_BULK_ERROR_PROFILE_URL_LENGTH
    ? `${cleanProfileUrl.slice(0, MAX_BULK_ERROR_PROFILE_URL_LENGTH - 3)}...`
    : cleanProfileUrl;
}

function bulkImportProfileDuplicateKey(profileUrl: string) {
  const normalized = normalizeBulkImportLinkedInProfileUrl(profileUrl);
  const match = normalized.match(/\/in\/([^/?#]+)\/?/i);
  if (!match) {
    return "";
  }
  try {
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return match[1].toLowerCase();
  }
}

function normalizeBulkImportLinkedInProfileUrl(profileUrl: string) {
  const cleanUrl = String(profileUrl || "")
    .trim()
    .replace(/^[<([{\s]+/, "")
    .replace(/[>\])}\s]+$/, "")
    .replace(/[.,;:!]+$/, "")
    .replace(/[>\])}\s]+$/, "");
  if (!cleanUrl) {
    return "";
  }
  try {
    const withScheme = cleanUrl.startsWith("//")
      ? `https:${cleanUrl}`
      : /^https?:\/\//i.test(cleanUrl)
        ? cleanUrl
        : /^(?:www\.)?linkedin\.com\//i.test(cleanUrl)
          ? `https://${cleanUrl}`
          : `https://www.linkedin.com${cleanUrl}`;
    const parsed = new URL(withScheme);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) {
      return "";
    }
    const match = parsed.pathname.match(/\/in\/([^/?#]+)/i);
    if (!match) {
      return "";
    }
    return `https://www.linkedin.com/in/${encodeURIComponent(decodeURIComponent(match[1]))}/`;
  } catch {
    return "";
  }
}

export const deletePerson = (personId: string) =>
  api<{ ok: boolean; alreadyDeleted?: boolean }>(`/api/people/${encodeURIComponent(personId)}`, {
    method: "DELETE",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validateDeletePersonResult,
  });

function validateQueueItems(value: unknown, expectedStatus?: QueueStatus): QueueItem[] {
  if (!Array.isArray(value)) {
    throw malformedApiResponse("The local queue response was not a list.");
  }
  const items = value.map(validateQueueItem);
  const itemIds = items.map((item) => item.id);
  if (new Set(itemIds).size !== itemIds.length) {
    throw malformedApiResponse("The local queue response has duplicate item ids.");
  }
  if (expectedStatus && items.some((item) => item.status !== expectedStatus)) {
    throw malformedApiResponse(`The local queue response included items outside the ${expectedStatus} tab.`);
  }
  return items;
}

function validateQueueItem(value: unknown): QueueItem {
  const item = requireApiRecord(value, "queue item");
  requireApiNonEmptyString(item, "id", "queue item");
  requireApiNonEmptyString(item, "personId", "queue item");
  requireApiNonEmptyString(item, "personName", "queue item");
  requireApiLinkedInProfileUrl(item, "profileUrl", "queue item");
  requireQueueItemType(item.type);
  requireApiLinkedInUrl(item, "sourceUrl", "queue item");
  requireApiNonEmptyString(item, "externalId", "queue item");
  requireApiString(item, "text", "queue item");
  requireApiDateString(item, "activityAt", "queue item");
  requireApiDateString(item, "discoveredAt", "queue item");
  requireQueueStatus(item.status);
  requireApiUniqueStringArray(item, "feedIds", "queue item");
  requireApiStringArray(item, "feedNames", "queue item");
  if ((item.feedNames as string[]).length !== (item.feedIds as string[]).length) {
    throw malformedApiResponse("The local queue item response has mismatched feed tags.");
  }
  return item as QueueItem;
}

function validateQueueView(value: unknown, expectedStatus?: QueueStatus): QueueView {
  const view = requireApiRecord(value, "queue view");
  return {
    items: validateQueueItems(view.items, expectedStatus),
    counts: validateQueueCounts(view.counts),
  };
}

function validateQueueCounts(value: unknown): QueueCounts {
  const counts = requireApiRecord(value, "queue counts");
  for (const key of ["new", "done", "skipped", "all"] as const) {
    requireApiNumber(counts, key, "queue counts");
  }
  const total = (counts.new as number) + (counts.done as number) + (counts.skipped as number);
  if (counts.all !== total) {
    throw malformedApiResponse("The local queue counts response has inconsistent totals.");
  }
  return counts as QueueCounts;
}

function requireApiRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedApiResponse(`The local ${context} response was malformed.`);
  }
  return value as Record<string, unknown>;
}

function requireApiString(record: Record<string, unknown>, key: string, context: string) {
  if (typeof record[key] !== "string") {
    throw malformedApiResponse(`The local ${context} response is missing "${key}".`);
  }
}

function requireApiNonEmptyString(record: Record<string, unknown>, key: string, context: string) {
  requireApiString(record, key, context);
  if (!(record[key] as string).trim()) {
    throw malformedApiResponse(`The local ${context} response is missing "${key}".`);
  }
}

function requireApiDateString(record: Record<string, unknown>, key: string, context: string) {
  requireApiNonEmptyString(record, key, context);
  if (!Number.isFinite(Date.parse(record[key] as string))) {
    throw malformedApiResponse(`The local ${context} response has an invalid "${key}".`);
  }
}

function requireApiLinkedInProfileUrl(record: Record<string, unknown>, key: string, context: string) {
  requireApiNonEmptyString(record, key, context);
  if (!normalizeLinkedInProfileUrl(record[key] as string)) {
    throw malformedApiResponse(`The local ${context} response has an invalid "${key}".`);
  }
}

function requireApiLinkedInUrl(record: Record<string, unknown>, key: string, context: string) {
  requireApiNonEmptyString(record, key, context);
  try {
    const parsed = new URL(record[key] as string, "https://www.linkedin.com");
    if (!isLinkedInHost(parsed.hostname) || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new Error("Invalid LinkedIn URL.");
    }
  } catch {
    throw malformedApiResponse(`The local ${context} response has an invalid "${key}".`);
  }
}

function requireApiNumber(record: Record<string, unknown>, key: string, context: string) {
  const value = record[key];
  if (!isSafeApiInteger(value) || value < 0) {
    throw malformedApiResponse(`The local ${context} response is missing "${key}".`);
  }
}

function requireApiIntegerInRange(
  record: Record<string, unknown>,
  key: string,
  context: string,
  minimum: number,
  maximum: number,
) {
  const value = record[key];
  if (!isSafeApiInteger(value) || value < minimum || value > maximum) {
    throw malformedApiResponse(`The local ${context} response is missing "${key}".`);
  }
}

function isSafeApiInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function requireApiBoolean(record: Record<string, unknown>, key: string, context: string) {
  if (typeof record[key] !== "boolean") {
    throw malformedApiResponse(`The local ${context} response is missing "${key}".`);
  }
}

function requireApiArray(record: Record<string, unknown>, key: string, context: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw malformedApiResponse(`The local ${context} response is missing "${key}".`);
  }
  return value;
}

function requireApiStringArray(record: Record<string, unknown>, key: string, context: string) {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry !== entry.trim())) {
    throw malformedApiResponse(`The local ${context} response is missing "${key}".`);
  }
}

function requireApiUniqueStringArray(record: Record<string, unknown>, key: string, context: string) {
  requireApiStringArray(record, key, context);
  const value = record[key] as string[];
  if (new Set(value).size !== value.length) {
    throw malformedApiResponse(`The local ${context} response has duplicate "${key}".`);
  }
}

function requireQueueItemType(value: unknown) {
  if (value !== "post" && value !== "comment") {
    throw malformedApiResponse("The local queue item response has an unknown item type.");
  }
}

function requireQueueStatus(value: unknown) {
  if (value !== "new" && value !== "done" && value !== "skipped") {
    throw malformedApiResponse("The local queue item response has an unknown status.");
  }
}

function malformedApiResponse(message: string) {
  return new MalformedApiResponseError(message);
}

export const listQueue = (
  feedId?: string,
  status: QueueStatus = "new",
  options: {
    limit?: number;
    offset?: number;
    after?: Pick<QueueItem, "activityAt" | "discoveredAt" | "id">;
    signal?: AbortSignal;
  } = {},
) => {
  const params = queueParams(feedId, status, options);
  return api<QueueItem[]>(`/api/queue?${params.toString()}`, {
    signal: options.signal,
    validate: (value) => validateQueueItems(value, status),
  });
};

export const getQueueView = (
  feedId?: string,
  status: QueueStatus = "new",
  options: {
    limit?: number;
    offset?: number;
    after?: Pick<QueueItem, "activityAt" | "discoveredAt" | "id">;
    signal?: AbortSignal;
  } = {},
) => {
  const params = queueParams(feedId, status, options);
  return api<QueueView>(`/api/queue-view?${params.toString()}`, {
    signal: options.signal,
    validate: (value) => validateQueueView(value, status),
  });
};

export const getQueueCounts = (feedId?: string, options: ApiCallOptions = {}) =>
  api<QueueCounts>(feedId ? `/api/queue-counts?feedId=${encodeURIComponent(feedId)}` : "/api/queue-counts", {
    signal: options.signal,
    validate: validateQueueCounts,
  });

function queueParams(
  feedId?: string,
  status: QueueStatus = "new",
  options: { limit?: number; offset?: number; after?: Pick<QueueItem, "activityAt" | "discoveredAt" | "id"> } = {},
) {
  const params = new URLSearchParams({ status });
  if (feedId) {
    params.set("feedId", feedId);
  }
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.offset !== undefined && !options.after) {
    params.set("offset", String(options.offset));
  }
  if (options.after) {
    params.set("afterActivityAt", options.after.activityAt);
    params.set("afterDiscoveredAt", options.after.discoveredAt);
    params.set("afterId", options.after.id);
  }
  return params;
}

function validateQueueStatusChange(
  value: unknown,
  expected: { itemId?: string; status?: QueueStatus } = {},
): QueueStatusChange {
  const change = requireApiRecord(value, "queue status change");
  requireApiNonEmptyString(change, "itemId", "queue status change");
  requireApiNonEmptyString(change, "personId", "queue status change");
  requireQueueStatus(change.previousStatus);
  requireQueueStatus(change.status);
  requireApiBoolean(change, "changed", "queue status change");
  requireApiIntegerInRange(change, "commentCountDelta", "queue status change", -1, 1);
  if (change.changed === false && change.previousStatus !== change.status) {
    throw malformedApiResponse("The local queue status change response is inconsistent.");
  }
  if (change.changed === false && change.commentCountDelta !== 0) {
    throw malformedApiResponse("The local queue status change response has an impossible counter delta.");
  }
  if (change.changed === true && change.previousStatus === change.status) {
    throw malformedApiResponse("The local queue status change response has an impossible status transition.");
  }
  if (expected.itemId !== undefined && change.itemId !== expected.itemId) {
    throw malformedApiResponse("The local queue status change response has the wrong item id.");
  }
  if (expected.status !== undefined && change.status !== expected.status) {
    throw malformedApiResponse("The local queue status change response has the wrong status.");
  }
  if (
    !queueStatusTransitionHasValidCounterDelta(
      change.previousStatus as QueueStatus,
      change.status as QueueStatus,
      change.commentCountDelta as number,
    )
  ) {
    throw malformedApiResponse("The local queue status change response has an impossible counter transition.");
  }
  return change as QueueStatusChange;
}

function queueStatusTransitionHasValidCounterDelta(previousStatus: QueueStatus, status: QueueStatus, commentCountDelta: number) {
  if (previousStatus === status) {
    return commentCountDelta === 0;
  }
  if (previousStatus === "done" && status !== "done") {
    return commentCountDelta === 0 || commentCountDelta === -1;
  }
  if (previousStatus !== "done" && status === "done") {
    return commentCountDelta === 0 || commentCountDelta === 1;
  }
  return commentCountDelta === 0;
}

function validateRefreshSessions(value: unknown): RefreshSession[] {
  if (!Array.isArray(value)) {
    throw malformedApiResponse("The local refresh sessions response was not a list.");
  }
  const sessions = value.map(validateRefreshSession);
  const sessionIds = sessions.map((session) => session.id);
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw malformedApiResponse("The local refresh sessions response has duplicate session ids.");
  }
  return sessions;
}

function validateRefreshSession(value: unknown): RefreshSession {
  const session = requireApiRecord(value, "refresh session");
  requireApiNonEmptyString(session, "id", "refresh session");
  requireApiNonEmptyString(session, "feedId", "refresh session");
  requireApiNonEmptyString(session, "feedName", "refresh session");
  requireApiIntegerInRange(session, "lookbackDays", "refresh session", 1, 365);
  requireApiDateString(session, "lookbackCutoffAt", "refresh session");
  requireRefreshStatus(session.status);
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
  ] as const) {
    requireApiNumber(session, key, "refresh session");
  }
  const totalTargets = session.totalTargets as number;
  const completedTargets = session.completedTargets as number;
  const failedTargets = session.failedTargets as number;
  const currentAttempt = session.currentAttempt as number;
  const maxAttempts = session.maxAttempts as number;
  const status = session.status as RefreshSession["status"];
  if (completedTargets > totalTargets || failedTargets > completedTargets) {
    throw malformedApiResponse("The local refresh session response has inconsistent progress.");
  }
  if (currentAttempt < 1 || maxAttempts < 1 || currentAttempt > maxAttempts) {
    throw malformedApiResponse("The local refresh session response has inconsistent retry state.");
  }
  if ((status === "done" || status === "failed") && completedTargets !== totalTargets) {
    throw malformedApiResponse("The local refresh session response has an impossible finished progress state.");
  }
  requireApiString(session, "lastError", "refresh session");
  requireApiString(session, "nextDelayReason", "refresh session");
  requireApiDateString(session, "createdAt", "refresh session");
  requireApiDateString(session, "updatedAt", "refresh session");
  if (session.nextUrl !== undefined && typeof session.nextUrl !== "string") {
    throw malformedApiResponse('The local refresh session response is missing "nextUrl".');
  }
  if (session.createdByRequest !== undefined && typeof session.createdByRequest !== "boolean") {
    throw malformedApiResponse('The local refresh session response is missing "createdByRequest".');
  }
  let currentTarget: NonNullable<RefreshSession["currentTarget"]> | undefined;
  if (session.currentTarget !== undefined) {
    currentTarget = validateRefreshTarget(session.currentTarget);
    if (currentTarget.index >= totalTargets) {
      throw malformedApiResponse("The local refresh session response has an out-of-range current target.");
    }
  }
  if (status === "running") {
    if (!currentTarget || currentTarget.index !== completedTargets) {
      throw malformedApiResponse("The local refresh session response has an inconsistent current target.");
    }
    if (
      typeof session.nextUrl !== "string" ||
      !refreshUrlMatchesTarget(session.nextUrl, currentTarget, { sessionId: session.id as string, targetIndex: currentTarget.index })
    ) {
      throw malformedApiResponse("The local refresh session response has an invalid next URL.");
    }
  } else if (currentTarget || session.nextUrl !== undefined) {
    throw malformedApiResponse("The local refresh session response has stale navigation details.");
  }
  return session as RefreshSession;
}

function validateRefreshTarget(value: unknown): NonNullable<RefreshSession["currentTarget"]> {
  const target = requireApiRecord(value, "refresh target");
  requireApiNumber(target, "index", "refresh target");
  requireApiNonEmptyString(target, "personId", "refresh target");
  requireApiNonEmptyString(target, "personName", "refresh target");
  requireApiLinkedInProfileUrl(target, "profileUrl", "refresh target");
  if (target.kind !== "posts" && target.kind !== "comments") {
    throw malformedApiResponse("The local refresh target response has an unknown kind.");
  }
  requireApiNonEmptyString(target, "url", "refresh target");
  if (!refreshUrlMatchesTarget(target.url, target as NonNullable<RefreshSession["currentTarget"]>)) {
    throw malformedApiResponse("The local refresh target response has an invalid URL.");
  }
  return target as NonNullable<RefreshSession["currentTarget"]>;
}

function refreshUrlMatchesTarget(
  url: unknown,
  target: Pick<NonNullable<RefreshSession["currentTarget"]>, "profileUrl" | "kind">,
  options: { sessionId?: string; targetIndex?: number } = {},
) {
  if (typeof url !== "string") {
    return false;
  }
  try {
    const parsed = new URL(url, "https://www.linkedin.com");
    if (!isLinkedInHost(parsed.hostname)) {
      return false;
    }
    if (normalizeLinkedInProfileUrl(parsed.toString()) !== normalizeLinkedInProfileUrl(target.profileUrl)) {
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

function normalizeLinkedInProfileUrl(value: string) {
  try {
    const parsed = new URL(value, "https://www.linkedin.com");
    if (!isLinkedInHost(parsed.hostname)) {
      return "";
    }
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)\/?/i);
    return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}/` : "";
  } catch {
    return "";
  }
}

function refreshActivityKindFromPath(pathname: string): NonNullable<RefreshSession["currentTarget"]>["kind"] | undefined {
  const cleanPath = pathname.toLowerCase();
  if (/\/recent-activity\/comments\/?$/.test(cleanPath)) {
    return "comments";
  }
  if (/\/recent-activity\/(?:all\/?)?$/.test(cleanPath)) {
    return "posts";
  }
  return undefined;
}

function isLinkedInHost(hostname: string) {
  const cleanHostname = hostname.toLowerCase();
  return cleanHostname === "linkedin.com" || cleanHostname.endsWith(".linkedin.com");
}

function validateRefreshCancelResult(value: unknown): RefreshCancelResult {
  const result = requireApiRecord(value, "refresh cancel");
  if (result.ok === true || result.alreadyCanceled === true) {
    requireApiNonEmptyString(result, "id", "refresh cancel");
    if (result.ok !== true || result.alreadyCanceled !== true) {
      throw malformedApiResponse("The local refresh cancel response was malformed.");
    }
    return result as RefreshCancelResult;
  }
  return validateRefreshSession(result);
}

function requireRefreshStatus(value: unknown) {
  if (value !== "running" && value !== "done" && value !== "canceled" && value !== "failed") {
    throw malformedApiResponse("The local refresh session response has an unknown status.");
  }
}

export const setItemStatus = (itemId: string, status: QueueStatus, options: { feedId?: string } = {}) =>
  api<QueueStatusChange>(`/api/items/${encodeURIComponent(itemId)}/status`, {
    method: "POST",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: (value) => validateQueueStatusChange(value, { itemId, status }),
    body: JSON.stringify({ status, feedId: options.feedId, requestId: createClientRequestId() }),
  });

export const updateCounters = (
  personId: string,
  patch: Partial<Pick<Person, "commentCount" | "likeCount" | "backCommentCount">>,
) =>
  api<Person>(`/api/people/${encodeURIComponent(personId)}/counters`, {
    method: "PATCH",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validatePerson,
    body: JSON.stringify({ ...patch, requestId: createClientRequestId() }),
  });

export const adjustCounters = (
  personId: string,
  delta: Partial<Pick<Person, "commentCount" | "likeCount" | "backCommentCount">>,
) =>
  api<Person>(`/api/people/${encodeURIComponent(personId)}/counters/adjust`, {
    method: "PATCH",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validatePerson,
    body: JSON.stringify({ ...delta, requestId: createClientRequestId() }),
  });

export const createRefreshSession = (feedId: string) =>
  api<RefreshSession>("/api/refresh-sessions", {
    method: "POST",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validateRefreshSession,
    body: JSON.stringify({ feedId, requestId: createClientRequestId() }),
  });

export const listRefreshSessions = (feedId?: string, options: ApiCallOptions = {}) =>
  api<RefreshSession[]>(feedId ? `/api/refresh-sessions?feedId=${encodeURIComponent(feedId)}` : "/api/refresh-sessions", {
    signal: options.signal,
    validate: validateRefreshSessions,
  });

export const cancelRefreshSession = (sessionId: string) =>
  api<RefreshCancelResult>(`/api/refresh-sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    retry: true,
    timeoutMs: WRITE_REQUEST_TIMEOUT_MS,
    validate: validateRefreshCancelResult,
  });

let lastResortClientRequestCounter = 0;

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

function formatClientRequestUuidBytes(bytes: Uint8Array) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
    .slice(8, 10)
    .join("")}-${hex.slice(10, 16).join("")}`;
}
