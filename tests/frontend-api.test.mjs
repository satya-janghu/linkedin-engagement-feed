import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const apiSourcePath = path.resolve("src", "api.ts");

test("desktop api retries only explicitly safe write operations", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const apiFunction = source.slice(source.indexOf("export async function api"), source.indexOf("function isRetryableLocalApiError"));

  assert.match(source, /type ApiValidator<T> = \(value: unknown\) => T;/);
  assert.match(source, /type ApiRequestInit<T = unknown> = RequestInit & \{\s+retry\?: boolean;\s+timeoutMs\?: number;\s+validate\?: ApiValidator<T>;\s+\};/);
  assert.match(source, /type ApiCallOptions = \{\s+signal\?: AbortSignal;\s+\};/);
  assert.match(source, /const DEFAULT_REQUEST_TIMEOUT_MS = 12000;/);
  assert.match(source, /const WRITE_REQUEST_TIMEOUT_MS = 20000;/);
  assert.match(source, /const LONG_REQUEST_TIMEOUT_MS = 60000;/);
  assert.match(source, /const MAX_REQUEST_TIMEOUT_MS = 60000;/);
  assert.match(source, /const API_BASE_URL_TIMEOUT_MS = 5000;/);
  assert.match(source, /const SAFE_API_ATTEMPTS = 3;/);
  assert.match(source, /const SAFE_API_RETRY_DELAYS_MS = \[300, 900\];/);
  assert.match(source, /const MAX_RETRY_AFTER_MS = 5000;/);
  assert.match(source, /const \{ retry, timeoutMs, validate, signal, \.\.\.fetchOptions \} = options;/);
  assert.match(source, /assertRetryIsSafe\(method, Boolean\(retry\), fetchOptions\.body\);/);
  assert.match(source, /const attempts = method === "GET" \|\| retry \? SAFE_API_ATTEMPTS : 1;/);
  assert.match(source, /const requestTimeoutMs = normalizeRequestTimeoutMs\(timeoutMs\);/);
  assert.match(source, /retryDelayMsForAttempt\(attempt, error\)/);
  assert.match(source, /function retryDelayMsForAttempt\(attempt: number, error\?: unknown\)/);
  assert.match(source, /function waitForRetryDelay\(ms: number, signal\?: AbortSignal \| null\)/);
  assert.match(source, /error instanceof ApiError && error\.retryAfterMs !== undefined/);
  assert.match(source, /\.\.\.fetchOptions,/);
  assert.doesNotMatch(source, /\.\.\.options,/);
  assert.doesNotMatch(apiFunction, /\.\.\.fetchOptions,[\s\S]*validate,/);
});

test("desktop api requires idempotency keys before retrying stateful writes", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const apiFunction = source.slice(source.indexOf("export async function api"), source.indexOf("function isRetryableLocalApiError"));
  const retrySafety = source.slice(source.indexOf("function assertRetryIsSafe"), source.indexOf("function isLocalApiConnectionError"));
  const writeApis = source.slice(source.indexOf("export const createFeed"), source.indexOf("export const listQueue"));

  assert.match(apiFunction, /assertRetryIsSafe\(method, Boolean\(retry\), fetchOptions\.body\);/);
  assert.ok(apiFunction.indexOf("assertRetryIsSafe") < apiFunction.indexOf("const attempts = method === \"GET\" || retry ? SAFE_API_ATTEMPTS : 1;"));
  assert.match(retrySafety, /function assertRetryIsSafe\(method: string, retry: boolean, body: BodyInit \| null \| undefined\)/);
  assert.match(retrySafety, /if \(!retry \|\| method === "GET" \|\| method === "HEAD" \|\| method === "DELETE"\) \{/);
  assert.match(retrySafety, /if \(!retryBodyHasRequestId\(body\)\) \{/);
  assert.match(retrySafety, /requests with retry enabled must include a stable requestId/);
  assert.match(retrySafety, /function retryBodyHasRequestId\(body: BodyInit \| null \| undefined\)/);
  assert.match(retrySafety, /if \(typeof body !== "string"\) \{\s+return false;\s+\}/);
  assert.match(retrySafety, /const parsed = JSON\.parse\(body\) as unknown;/);
  assert.match(retrySafety, /typeof \(parsed as \{ requestId\?: unknown \}\)\.requestId === "string"/);
  assert.match(retrySafety, /\(parsed as \{ requestId: string \}\)\.requestId\.trim\(\)/);
  assert.match(writeApis, /method: "POST",\s+retry: true,[\s\S]*requestId: createClientRequestId\(\)/);
  assert.match(writeApis, /method: "PATCH",\s+retry: true,[\s\S]*requestId: createClientRequestId\(\)/);
  assert.match(writeApis, /method: "DELETE",\s+retry: true,/);
});

test("desktop api supports per-workflow request timeouts", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const apiFunction = source.slice(source.indexOf("export async function api"), source.indexOf("function isRetryableLocalApiError"));
  const fetchOptions = apiFunction.slice(apiFunction.indexOf("const response = await fetch"), apiFunction.indexOf("if (response.headers"));
  const timeoutHelper = source.slice(source.indexOf("function normalizeRequestTimeoutMs"), source.indexOf("function isAbortError"));
  const getExport = source.slice(source.indexOf("export const getDataExport"), source.indexOf("export const createFeed"));
  const createFeed = source.slice(source.indexOf("export const createFeed"), source.indexOf("export const updateFeed"));
  const bulkImport = source.slice(source.indexOf("export async function bulkAddPeopleToFeed"), source.indexOf("export const deletePerson"));

  assert.match(apiFunction, /timer = window\.setTimeout\(\(\) => controller\.abort\(\), requestTimeoutMs\);/);
  assert.doesNotMatch(fetchOptions, /timeoutMs/);
  assert.match(fetchOptions, /signal: controller\.signal,/);
  assert.match(timeoutHelper, /if \(value === undefined\) \{\s+return DEFAULT_REQUEST_TIMEOUT_MS;\s+\}/);
  assert.match(timeoutHelper, /if \(!Number\.isFinite\(timeoutMs\)\) \{\s+return DEFAULT_REQUEST_TIMEOUT_MS;\s+\}/);
  assert.match(timeoutHelper, /Math\.max\(1000, Math\.min\(MAX_REQUEST_TIMEOUT_MS, Math\.round\(timeoutMs\)\)\)/);
  assert.match(getExport, /timeoutMs: LONG_REQUEST_TIMEOUT_MS/);
  assert.match(createFeed, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS/);
  assert.match(bulkImport, /timeoutMs: LONG_REQUEST_TIMEOUT_MS/);
});

test("desktop api reacquires the local base url after connection failures", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");

  assert.match(source, /const API_IDENTITY_HEADER = "X-LinkedIn-Engagement-Feed";/);
  assert.match(source, /class ApiIdentityError extends Error/);
  assert.match(source, /class ApiBaseUrlError extends Error/);
  assert.match(source, /export class ApiRequestCanceledError extends Error/);
  assert.match(source, /if \(response\.headers\.get\(API_IDENTITY_HEADER\) !== "1"\) \{\s+throw new ApiIdentityError\(\);/);
  assert.match(source, /function getApiBaseUrlFromBridge\(\)/);
  assert.match(source, /const bridge = window\.linkedinFeed as Partial<AppBridge> \| undefined;/);
  assert.match(source, /if \(typeof bridge\?\.getApiBaseUrl !== "function"\) \{\s+return Promise\.reject\(new ApiBaseUrlError\("The desktop bridge is unavailable\."\)\);/);
  assert.match(source, /return Promise\.resolve\(bridge\.getApiBaseUrl\(\)\);/);
  assert.match(source, /async function apiBaseUrl\(options: \{ refresh\?: boolean \} = \{\}\)/);
  assert.match(source, /if \(options\.refresh\) \{\s+apiBaseUrlPromise = undefined;\s+\}/);
  assert.match(source, /if \(apiBaseUrlPromise\) \{\s+return apiBaseUrlPromise;\s+\}/);
  assert.match(source, /const lookupPromise = withTimeout\(getApiBaseUrlFromBridge\(\), API_BASE_URL_TIMEOUT_MS\)\.catch\(\(error\) => \{/);
  assert.match(source, /if \(apiBaseUrlPromise === lookupPromise\) \{\s+apiBaseUrlPromise = undefined;\s+\}/);
  assert.match(source, /if \(error instanceof ApiBaseUrlError\) \{\s+throw error;\s+\}/);
  assert.match(source, /apiBaseUrlPromise = lookupPromise;\s+return apiBaseUrlPromise;/);
  assert.match(source, /throw new ApiBaseUrlError\(error instanceof Error \? error\.message : "Unable to find the local app service\."\);/);
  assert.match(source, /let refreshBaseUrl = false;/);
  assert.match(source, /try \{\s+const baseUrl = await waitForApiBaseUrl\(apiBaseUrl\(\{ refresh: refreshBaseUrl \}\), signal\);/);
  assert.match(source, /if \(error instanceof ApiRequestCanceledError\) \{\s+requestWasCanceled = true;\s+break;\s+\}/);
  assert.match(source, /const shouldRetry = attempt < attempts - 1 && !requestWasCanceled && isRetryableLocalApiError\(error\);/);
  assert.match(source, /if \(shouldRetry\) \{\s+if \(isLocalApiConnectionError\(error\) \|\| isMalformedApiResponseError\(error\)\) \{\s+apiBaseUrlPromise = undefined;\s+refreshBaseUrl = true;/);
  assert.match(source, /const retryDelayCompleted = await waitForRetryDelay\(retryDelayMsForAttempt\(attempt, error\), signal\);/);
  assert.match(source, /if \(!retryDelayCompleted\) \{\s+requestWasCanceled = true;\s+break;\s+\}\s+continue;/);
  assert.match(source, /lastError instanceof ApiIdentityError/);
  assert.match(source, /lastError instanceof ApiBaseUrlError/);
  assert.match(source, /not the Engagement Feed app\. Try Reload/);
  assert.match(source, /Cannot find the local Engagement Feed service\. Try Reload/);
  assert.match(source, /function isRetryableLocalApiError\(error: unknown\) \{\s+return isLocalApiConnectionError\(error\) \|\| isMalformedApiResponseError\(error\) \|\| isRetryableApiError\(error\);/);
  assert.match(source, /return error instanceof TypeError \|\| error instanceof ApiIdentityError \|\| error instanceof ApiBaseUrlError \|\| isAbortError\(error\);/);
  assert.match(source, /class MalformedApiResponseError extends SyntaxError/);
  assert.match(source, /this\.name = "MalformedApiResponseError";/);
  assert.match(source, /function isMalformedApiResponseError\(error: unknown\) \{\s+return error instanceof MalformedApiResponseError \|\| error instanceof SyntaxError;\s+\}/);
  assert.match(source, /return error instanceof ApiError && \(error\.statusCode === 408 \|\| error\.statusCode === 429 \|\| error\.statusCode >= 500\);/);
  assert.match(source, /retryAfterDelayMs\(response\.headers\.get\("Retry-After"\)\)/);
  assert.match(source, /function retryAfterDelayMs\(value: string \| null\)/);
  assert.match(source, /Math\.max\(0, Math\.min\(MAX_RETRY_AFTER_MS, Math\.round\(seconds \* 1000\)\)\)/);
  assert.match(source, /Math\.max\(0, Math\.min\(MAX_RETRY_AFTER_MS, timestamp - Date\.now\(\)\)\)/);
});

test("desktop api retries malformed local responses only through safe attempts", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const apiFunction = source.slice(source.indexOf("export async function api"), source.indexOf("function isRetryableLocalApiError"));
  const retryHelpers = source.slice(source.indexOf("function isRetryableLocalApiError"), source.indexOf("function retryDelayMsForAttempt"));

  assert.match(apiFunction, /const attempts = method === "GET" \|\| retry \? SAFE_API_ATTEMPTS : 1;/);
  assert.match(apiFunction, /const data = \(text \? JSON\.parse\(text\) : \{\}\) as T \| \{ error: string \};/);
  assert.match(apiFunction, /return validate \? validate\(data\) : \(data as T\);/);
  assert.match(apiFunction, /const shouldRetry = attempt < attempts - 1 && !requestWasCanceled && isRetryableLocalApiError\(error\);/);
  assert.match(apiFunction, /isLocalApiConnectionError\(error\) \|\| isMalformedApiResponseError\(error\)/);
  assert.match(apiFunction, /apiBaseUrlPromise = undefined;\s+refreshBaseUrl = true;/);
  assert.match(apiFunction, /lastError instanceof SyntaxError/);
  assert.match(retryHelpers, /isMalformedApiResponseError\(error\) \|\| isRetryableApiError\(error\)/);
  assert.match(retryHelpers, /function isMalformedApiResponseError\(error: unknown\)/);
  assert.doesNotMatch(apiFunction, /const attempts = SAFE_API_ATTEMPTS;/);
});

test("desktop api times out stuck base-url lookups before fetch", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const baseUrlHelper = source.slice(source.indexOf("async function apiBaseUrl"), source.indexOf("const DEFAULT_REQUEST_TIMEOUT_MS"));
  const timeoutHelper = source.slice(source.indexOf("function withTimeout"), source.indexOf("function retryAfterDelayMs"));

  assert.match(source, /const API_BASE_URL_TIMEOUT_MS = 5000;/);
  assert.match(baseUrlHelper, /const lookupPromise = withTimeout\(getApiBaseUrlFromBridge\(\), API_BASE_URL_TIMEOUT_MS\)/);
  assert.match(baseUrlHelper, /if \(apiBaseUrlPromise === lookupPromise\) \{\s+apiBaseUrlPromise = undefined;\s+\}/);
  assert.match(baseUrlHelper, /if \(error instanceof ApiBaseUrlError\) \{\s+throw error;\s+\}/);
  assert.match(baseUrlHelper, /apiBaseUrlPromise = lookupPromise;/);
  assert.match(timeoutHelper, /function withTimeout<T>\(promise: Promise<T>, timeoutMs: number\)/);
  assert.match(timeoutHelper, /window\.setTimeout\(\(\) => \{\s+reject\(new Error\("Timed out while locating the local app service\."\)\);/);
  assert.match(timeoutHelper, /promise\.then\(resolve, reject\)\.finally\(\(\) => window\.clearTimeout\(timer\)\)/);
});

test("desktop api base-url lookup respects caller cancellation", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const apiFunction = source.slice(source.indexOf("export async function api"), source.indexOf("function isRetryableLocalApiError"));
  const waitForBaseUrl = source.slice(source.indexOf("function waitForApiBaseUrl"), source.indexOf("function normalizeRequestTimeoutMs"));

  assert.match(apiFunction, /waitForApiBaseUrl\(apiBaseUrl\(\{ refresh: refreshBaseUrl \}\), signal\)/);
  assert.match(apiFunction, /if \(error instanceof ApiRequestCanceledError\) \{\s+requestWasCanceled = true;\s+break;\s+\}/);
  assert.match(waitForBaseUrl, /function waitForApiBaseUrl\(promise: Promise<string>, signal\?: AbortSignal \| null\)/);
  assert.match(waitForBaseUrl, /if \(!signal\) \{\s+return promise;\s+\}/);
  assert.match(waitForBaseUrl, /if \(signal\.aborted\) \{\s+return Promise\.reject\(new ApiRequestCanceledError\(\)\);/);
  assert.match(waitForBaseUrl, /const abortLookup = \(\) => \{\s+reject\(new ApiRequestCanceledError\(\)\);/);
  assert.match(waitForBaseUrl, /signal\.addEventListener\("abort", abortLookup, \{ once: true \}\);/);
  assert.match(waitForBaseUrl, /promise\.then\(resolve, reject\)\.finally\(\(\) => signal\.removeEventListener\("abort", abortLookup\)\);/);
  assert.match(source, /if \(requestWasCanceled\) \{\s+throw new ApiRequestCanceledError\(\);/);
});

test("desktop api stale base-url lookup failures cannot clear newer lookups", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const baseUrlHelper = source.slice(source.indexOf("async function apiBaseUrl"), source.indexOf("const DEFAULT_REQUEST_TIMEOUT_MS"));

  assert.match(baseUrlHelper, /if \(options\.refresh\) \{\s+apiBaseUrlPromise = undefined;\s+\}/);
  assert.match(baseUrlHelper, /if \(apiBaseUrlPromise\) \{\s+return apiBaseUrlPromise;\s+\}/);
  assert.match(baseUrlHelper, /const lookupPromise = withTimeout\(getApiBaseUrlFromBridge\(\), API_BASE_URL_TIMEOUT_MS\)\.catch\(\(error\) => \{/);
  assert.match(baseUrlHelper, /if \(apiBaseUrlPromise === lookupPromise\) \{\s+apiBaseUrlPromise = undefined;\s+\}/);
  assert.match(baseUrlHelper, /if \(error instanceof ApiBaseUrlError\) \{\s+throw error;\s+\}/);
  assert.ok(baseUrlHelper.indexOf("const lookupPromise") < baseUrlHelper.indexOf("apiBaseUrlPromise = lookupPromise;"));
  assert.doesNotMatch(baseUrlHelper, /\.catch\(\(error\) => \{\s+apiBaseUrlPromise = undefined;/);
});

test("desktop api clears timeout only after a fetch timer is created", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const apiFunction = source.slice(source.indexOf("export async function api"), source.indexOf("function isRetryableLocalApiError"));
  const abortHelper = source.slice(source.indexOf("function isAbortError"), source.indexOf("function retryAfterDelayMs"));

  assert.match(apiFunction, /let timer = 0;/);
  assert.match(apiFunction, /let removeAbortListener: \(\(\) => void\) \| undefined;\s+try \{/);
  assert.match(apiFunction, /let removeAbortListener: \(\(\) => void\) \| undefined;/);
  assert.match(apiFunction, /if \(signal\?\.aborted\) \{\s+requestWasCanceled = true;\s+controller\.abort\(\);/);
  assert.match(apiFunction, /const abortFromCaller = \(\) => \{\s+requestWasCanceled = true;\s+controller\.abort\(\);/);
  assert.match(apiFunction, /signal\.addEventListener\("abort", abortFromCaller, \{ once: true \}\);/);
  assert.match(apiFunction, /removeAbortListener = \(\) => signal\.removeEventListener\("abort", abortFromCaller\);/);
  assert.match(apiFunction, /timer = window\.setTimeout\(\(\) => controller\.abort\(\), requestTimeoutMs\);/);
  assert.match(apiFunction, /const shouldRetry = attempt < attempts - 1 && !requestWasCanceled && isRetryableLocalApiError\(error\);/);
  assert.match(apiFunction, /finally \{\s+removeAbortListener\?\.\(\);/);
  assert.match(apiFunction, /if \(timer\) \{\s+window\.clearTimeout\(timer\);/);
  assert.match(apiFunction, /if \(requestWasCanceled\) \{\s+throw new ApiRequestCanceledError\(\);/);
  assert.match(apiFunction, /if \(isAbortError\(lastError\)\) \{\s+throw new Error\("The local Engagement Feed app did not respond\. Try Reload, then restart the app if it continues\."\);/);
  assert.match(abortHelper, /error && typeof error === "object" && "name" in error && error\.name === "AbortError"/);
  assert.doesNotMatch(abortHelper, /instanceof DOMException/);
});

test("desktop api retry backoff respects caller cancellation", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const apiFunction = source.slice(source.indexOf("export async function api"), source.indexOf("function isRetryableLocalApiError"));
  const retryDelay = source.slice(source.indexOf("function waitForRetryDelay"), source.indexOf("function normalizeRequestTimeoutMs"));

  assert.match(apiFunction, /const retryDelayCompleted = await waitForRetryDelay\(retryDelayMsForAttempt\(attempt, error\), signal\);/);
  assert.match(apiFunction, /if \(!retryDelayCompleted\) \{\s+requestWasCanceled = true;\s+break;\s+\}/);
  assert.match(apiFunction, /if \(requestWasCanceled\) \{\s+throw new ApiRequestCanceledError\(\);/);
  assert.match(retryDelay, /function waitForRetryDelay\(ms: number, signal\?: AbortSignal \| null\)/);
  assert.match(retryDelay, /if \(!signal\) \{\s+return new Promise<boolean>\(\(resolve\) => window\.setTimeout\(\(\) => resolve\(true\), ms\)\);/);
  assert.match(retryDelay, /if \(signal\.aborted\) \{\s+return Promise\.resolve\(false\);/);
  assert.match(retryDelay, /const timer = window\.setTimeout\(\(\) => \{\s+signal\.removeEventListener\("abort", abortDelay\);\s+resolve\(true\);/);
  assert.match(retryDelay, /const abortDelay = \(\) => \{\s+window\.clearTimeout\(timer\);\s+signal\.removeEventListener\("abort", abortDelay\);\s+resolve\(false\);/);
  assert.match(retryDelay, /signal\.addEventListener\("abort", abortDelay, \{ once: true \}\);/);
  assert.doesNotMatch(apiFunction, /await new Promise\(\(resolve\) => window\.setTimeout\(resolve, retryDelayMsForAttempt\(attempt, error\)\)\);/);
});

test("desktop feed creation is retry-safe and idempotent", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");

  assert.match(source, /export const createFeed = \(name: string, lookbackDays = 15\) =>\s+api<Feed>\("\/api\/feeds\/get-or-create", \{\s+method: "POST",\s+retry: true,/);
  assert.match(source, /export const createFeed = \(name: string, lookbackDays = 15\) =>\s+api<Feed>\("\/api\/feeds\/get-or-create", \{\s+method: "POST",\s+retry: true,\s+timeoutMs: WRITE_REQUEST_TIMEOUT_MS,\s+validate: validateFeed,/);
  assert.match(source, /body: JSON\.stringify\(\{ name, lookbackDays, requestId: createClientRequestId\(\) \}\),/);
  assert.doesNotMatch(source, /export const createFeed = \(name: string, lookbackDays = 15\) =>\s+api<Feed>\("\/api\/feeds", \{/);
});

test("desktop exact person membership upserts retry safely", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const upsertPerson = source.slice(source.indexOf("export const upsertPerson"), source.indexOf("export const createOrUpdatePerson"));
  const createOrUpdatePerson = source.slice(source.indexOf("export const createOrUpdatePerson"), source.indexOf("export const addPersonToFeed"));
  const addPersonToFeed = source.slice(source.indexOf("export const addPersonToFeed"), source.indexOf("export const updatePersonMemberships"));
  const updateMemberships = source.slice(source.indexOf("export const updatePersonMemberships"), source.indexOf("export async function bulkAddPeopleToFeed"));

  assert.match(createOrUpdatePerson, /\/api\/people/);
  assert.match(createOrUpdatePerson, /method: "POST",\s+retry: true,/);
  assert.match(createOrUpdatePerson, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(createOrUpdatePerson, /validate: validatePersonSaveResult,/);
  assert.match(createOrUpdatePerson, /body: JSON\.stringify\(\{ \.\.\.input, requestId: createClientRequestId\(\) \}\),/);
  assert.match(upsertPerson, /method: "POST",\s+retry: true,/);
  assert.match(upsertPerson, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(upsertPerson, /validate: validatePersonSaveResult,/);
  assert.match(upsertPerson, /body: JSON\.stringify\(\{ \.\.\.input, requestId: createClientRequestId\(\) \}\),/);
  assert.match(addPersonToFeed, /method: "POST",\s+retry: true,/);
  assert.match(addPersonToFeed, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(addPersonToFeed, /validate: validatePerson,/);
  assert.match(addPersonToFeed, /body: JSON\.stringify\(\{ \.\.\.input, requestId: createClientRequestId\(\) \}\),/);
  assert.match(updateMemberships, /options: \{ knownFeedIds\?: string\[\] \} = \{\}/);
  assert.match(updateMemberships, /method: "POST",\s+retry: true,/);
  assert.match(updateMemberships, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(updateMemberships, /validate: validatePerson,/);
  assert.match(updateMemberships, /body: JSON\.stringify\(\{ feedIds, knownFeedIds: options\.knownFeedIds, requestId: createClientRequestId\(\) \}\)/);
});

test("desktop exact feed settings saves retry safely", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const updateFeed = source.slice(source.indexOf("export const updateFeed"), source.indexOf("export const deleteFeed"));

  assert.match(updateFeed, /method: "PATCH",\s+retry: true,/);
  assert.match(updateFeed, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(updateFeed, /validate: validateFeed,/);
  assert.match(updateFeed, /body: JSON\.stringify\(\{ \.\.\.patch, requestId: createClientRequestId\(\) \}\),/);
});

test("desktop delete and bulk import calls are retry-safe", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const deleteFeed = source.slice(source.indexOf("export const deleteFeed"), source.indexOf("export const listPeople"));
  const bulkImport = source.slice(source.indexOf("export async function bulkAddPeopleToFeed"), source.indexOf("export const deletePerson"));
  const deletePerson = source.slice(source.indexOf("export const deletePerson"), source.indexOf("export const listQueue"));

  assert.match(deleteFeed, /method: "DELETE",\s+retry: true,/);
  assert.match(deleteFeed, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(deleteFeed, /validate: validateDeleteFeedResult,/);
  assert.match(deleteFeed, /alreadyDeleted\?: boolean/);
  assert.match(source, /const BULK_PEOPLE_REQUEST_MAX_CHUNK_SIZE = 500;/);
  assert.match(source, /const BULK_PEOPLE_REQUEST_MAX_BYTES = 512 \* 1024;/);
  assert.match(source, /const MAX_PEOPLE_PER_FEED = 200;/);
  assert.match(source, /const MAX_BULK_PEOPLE_ERROR_DETAILS = 50;/);
  assert.match(bulkImport, /export async function bulkAddPeopleToFeed/);
  assert.match(bulkImport, /options: \{ knownRemainingCapacity\?: number \} = \{\},/);
  assert.match(bulkImport, /const prepared = prepareBulkPeopleForImport\(people\);/);
  assert.match(bulkImport, /const chunks = chunkPreparedBulkPeople\(prepared\.people\);/);
  assert.match(bulkImport, /return mergePreparedBulkImportResult\(emptyBulkPeopleResult\(options\.knownRemainingCapacity\), prepared\);/);
  assert.match(source, /export class BulkImportPartialError extends Error/);
  assert.match(source, /public readonly result: BulkPeopleResult/);
  assert.match(bulkImport, /chunk\.items\.map\(\(entry\) => entry\.person\)/);
  assert.match(bulkImport, /chunk\.items\.map\(\(entry\) => entry\.originalIndex\)/);
  assert.match(bulkImport, /aggregate \? mergeBulkPeopleResult\(aggregate, result\) : result/);
  assert.match(bulkImport, /catch \(error\) \{\s+if \(aggregate\) \{/);
  assert.match(bulkImport, /const failedAtOriginalIndex = chunk\.items\[0\]\?\.originalIndex \?\? people\.length;/);
  assert.match(bulkImport, /const partialResult = mergePreparedBulkImportResult\(aggregate, prepared, \{ beforeOriginalIndex: failedAtOriginalIndex \}\);/);
  assert.match(bulkImport, /bulkImportPartialErrorMessage\(partialResult, error\)/);
  assert.match(bulkImport, /partialResult,\s+error,/);
  assert.match(bulkImport, /return mergePreparedBulkImportResult\(aggregate!, prepared\);/);
  assert.match(bulkImport, /function bulkAddPeopleChunk/);
  assert.match(bulkImport, /method: "POST",\s+retry: true,/);
  assert.match(bulkImport, /timeoutMs: LONG_REQUEST_TIMEOUT_MS,/);
  assert.match(bulkImport, /validate: validateBulkPeopleResult,/);
  assert.match(bulkImport, /body: JSON\.stringify\(\{ people, requestId: createClientRequestId\(\) \}\),/);
  assert.match(deletePerson, /method: "DELETE",\s+retry: true,/);
  assert.match(deletePerson, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(deletePerson, /validate: validateDeletePersonResult,/);
  assert.match(deletePerson, /alreadyDeleted\?: boolean/);
});

test("feed and people api validates local response shapes before updating the UI", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const validators = source.slice(source.indexOf("function validateFeeds"), source.indexOf("export const listFeeds"));
  const arrayHelper = source.slice(source.indexOf("function requireApiStringArray"), source.indexOf("function requireQueueItemType"));
  const feedAndPeopleApi = source.slice(source.indexOf("export const listFeeds"), source.indexOf("export const deletePerson"));

  assert.match(validators, /function validateFeeds\(value: unknown\): Feed\[\]/);
  assert.match(validators, /if \(!Array\.isArray\(value\)\) \{\s+throw malformedApiResponse\("The local feeds response was not a list\."\);/);
  assert.match(validators, /const feeds = value\.map\(validateFeed\);/);
  assert.match(validators, /const feedIds = feeds\.map\(\(feed\) => feed\.id\);/);
  assert.match(validators, /if \(new Set\(feedIds\)\.size !== feedIds\.length\) \{\s+throw malformedApiResponse\("The local feeds response has duplicate feed ids\."\);/);
  assert.match(validators, /return feeds;/);
  assert.match(validators, /function validateFeed\(value: unknown\): Feed/);
  assert.match(validators, /requireApiNonEmptyString\(feed, "id", "feed"\);/);
  assert.match(validators, /requireApiNonEmptyString\(feed, "name", "feed"\);/);
  assert.match(validators, /requireApiIntegerInRange\(feed, "lookbackDays", "feed", 1, 365\);/);
  assert.match(validators, /requireApiIntegerInRange\(feed, "peopleCount", "feed", 0, MAX_PEOPLE_PER_FEED\);/);
  assert.match(validators, /function validatePeople\(value: unknown\): Person\[\]/);
  assert.match(validators, /const people = value\.map\(validatePerson\);/);
  assert.match(validators, /const personIds = people\.map\(\(person\) => person\.id\);/);
  assert.match(validators, /if \(new Set\(personIds\)\.size !== personIds\.length\) \{\s+throw malformedApiResponse\("The local people response has duplicate person ids\."\);/);
  assert.match(validators, /return people;/);
  assert.match(validators, /function validatePerson\(value: unknown\): Person/);
  assert.match(validators, /requireApiNonEmptyString\(person, "id", "person"\);/);
  assert.match(validators, /requireApiNonEmptyString\(person, "name", "person"\);/);
  assert.match(validators, /requireApiLinkedInProfileUrl\(person, "profileUrl", "person"\);/);
  assert.match(validators, /requireApiNonEmptyString\(person, "publicId", "person"\);/);
  assert.match(validators, /requireApiNumber\(person, "commentCount", "person"\);/);
  assert.match(validators, /requireApiNumber\(person, "likeCount", "person"\);/);
  assert.match(validators, /requireApiNumber\(person, "backCommentCount", "person"\);/);
  assert.match(validators, /requireApiUniqueStringArray\(person, "feedIds", "person"\);/);
  assert.match(validators, /function validatePersonSaveResult\(value: unknown\): \{ person\?: Person; feedIds: string\[\] \}/);
  assert.match(validators, /if \(result\.person !== undefined\) \{\s+validatePerson\(result\.person\);/);
  assert.match(validators, /requireApiUniqueStringArray\(result, "feedIds", "person save"\);/);
  assert.match(arrayHelper, /function requireApiStringArray\(record: Record<string, unknown>, key: string, context: string\)/);
  assert.match(arrayHelper, /value\.some\(\(entry\) => typeof entry !== "string" \|\| !entry\.trim\(\) \|\| entry !== entry\.trim\(\)\)/);
  assert.match(arrayHelper, /function requireApiUniqueStringArray\(record: Record<string, unknown>, key: string, context: string\)/);
  assert.match(arrayHelper, /new Set\(value\)\.size !== value\.length/);
  assert.match(validators, /function validateBulkPeopleResult\(value: unknown\): BulkPeopleResult/);
  assert.match(validators, /for \(const key of \[/);
  assert.match(validators, /"remainingCapacity",/);
  assert.match(validators, /const received = result\.received as number;/);
  assert.match(validators, /const remainingCapacity = result\.remainingCapacity as number;/);
  assert.match(validators, /if \(remainingCapacity > MAX_PEOPLE_PER_FEED\) \{\s+throw malformedApiResponse\("The local bulk people response has impossible remaining capacity\."\);/);
  assert.match(validators, /if \(added \+ alreadyInFeed \+ skippedInvalid \+ skippedCapacity !== received\) \{\s+throw malformedApiResponse\("The local bulk people response has inconsistent totals\."\);/);
  assert.match(validators, /if \(updated > alreadyInFeed\) \{\s+throw malformedApiResponse\("The local bulk people response has inconsistent update totals\."\);/);
  assert.match(validators, /if \(!Array\.isArray\(errors\)\) \{\s+throw malformedApiResponse\('The local bulk people response is missing "errors"\.'\);/);
  assert.match(validators, /const totalSkipped = skippedInvalid \+ skippedCapacity;/);
  assert.match(validators, /if \(errors\.length > MAX_BULK_PEOPLE_ERROR_DETAILS\) \{\s+throw malformedApiResponse\("The local bulk people response has too many error details\."\);/);
  assert.match(validators, /if \(errors\.length > totalSkipped\) \{\s+throw malformedApiResponse\("The local bulk people response has impossible error details\."\);/);
  assert.match(validators, /const seenErrorIndexes = new Set<number>\(\);/);
  assert.match(validators, /const entry = requireApiRecord\(error, "bulk people error"\);/);
  assert.match(validators, /requireApiNumber\(entry, "index", "bulk people error"\);/);
  assert.match(validators, /if \(\(entry\.index as number\) >= received\) \{\s+throw malformedApiResponse\("The local bulk people response has an out-of-range error index\."\);/);
  assert.match(validators, /if \(seenErrorIndexes\.has\(entry\.index as number\)\) \{\s+throw malformedApiResponse\("The local bulk people response has duplicate error details\."\);/);
  assert.match(validators, /seenErrorIndexes\.add\(entry\.index as number\);/);
  assert.match(feedAndPeopleApi, /export const listFeeds = \(options: ApiCallOptions = \{\}\) =>\s+api<Feed\[\]>\("\/api\/feeds", \{ signal: options\.signal, validate: validateFeeds \}\);/);
  assert.match(feedAndPeopleApi, /validate: validateFeed,/);
  assert.match(feedAndPeopleApi, /export const listPeople = \(feedId\?: string, query = "", options: ApiCallOptions = \{\}\) => \{/);
  assert.match(feedAndPeopleApi, /return api<Person\[\]>\(suffix \? `\/api\/people\?\$\{suffix\}` : "\/api\/people", \{\s+signal: options\.signal,\s+validate: validatePeople,\s+\}\);/);
  assert.match(feedAndPeopleApi, /validate: validatePersonSaveResult,/);
  assert.match(feedAndPeopleApi, /validate: validatePerson,/);
  assert.match(feedAndPeopleApi, /validate: validateBulkPeopleResult,/);
});

test("desktop api rejects unsafe count-like response fields", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const numberHelper = source.slice(source.indexOf("function requireApiNumber"), source.indexOf("function requireApiIntegerInRange"));
  const rangeHelper = source.slice(source.indexOf("function requireApiIntegerInRange"), source.indexOf("function requireApiBoolean"));
  const validators = source.slice(source.indexOf("function validateFeeds"), source.indexOf("export const listFeeds"));
  const refreshValidators = source.slice(source.indexOf("function validateRefreshSessions"), source.indexOf("export const setItemStatus"));
  const queueStatusValidator = source.slice(source.indexOf("function validateQueueStatusChange"), source.indexOf("function validateRefreshSessions"));

  assert.match(numberHelper, /!isSafeApiInteger\(value\) \|\| value < 0/);
  assert.match(rangeHelper, /!isSafeApiInteger\(value\) \|\| value < minimum \|\| value > maximum/);
  assert.match(source, /function isSafeApiInteger\(value: unknown\): value is number \{\s+return typeof value === "number" && Number\.isSafeInteger\(value\);/);
  assert.doesNotMatch(numberHelper, /Number\.isInteger\(value\)/);
  assert.doesNotMatch(rangeHelper, /Number\.isInteger\(value\)/);
  assert.match(validators, /requireApiIntegerInRange\(feed, "lookbackDays", "feed", 1, 365\);/);
  assert.match(validators, /requireApiIntegerInRange\(feed, "peopleCount", "feed", 0, MAX_PEOPLE_PER_FEED\);/);
  assert.match(validators, /requireApiDateString\(feed, "createdAt", "feed"\);/);
  assert.match(validators, /requireApiDateString\(feed, "updatedAt", "feed"\);/);
  assert.match(validators, /requireApiNumber\(person, "commentCount", "person"\);/);
  assert.match(validators, /requireApiUniqueStringArray\(person, "feedIds", "person"\);/);
  assert.match(validators, /requireApiDateString\(person, "createdAt", "person"\);/);
  assert.match(validators, /requireApiDateString\(person, "updatedAt", "person"\);/);
  assert.match(validators, /requireApiNumber\(entry, "index", "bulk people error"\);/);
  assert.match(validators, /seenErrorIndexes\.has\(entry\.index as number\)/);
  assert.match(queueStatusValidator, /requireApiIntegerInRange\(change, "commentCountDelta", "queue status change", -1, 1\);/);
  assert.match(refreshValidators, /requireApiIntegerInRange\(session, "lookbackDays", "refresh session", 1, 365\);/);
  assert.match(refreshValidators, /requireApiNumber\(target, "index", "refresh target"\);/);
  assert.match(refreshValidators, /requireApiNumber\(session, key, "refresh session"\);/);
});

test("delete and recovery api validates acknowledgements before mutating local UI state", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const validators = source.slice(source.indexOf("function validateFeeds"), source.indexOf("export const listFeeds"));
  const feedAndPeopleApi = source.slice(source.indexOf("export const listFeeds"), source.indexOf("export const deletePerson"));
  const deletePerson = source.slice(source.indexOf("export const deletePerson"), source.indexOf("export const listQueue"));

  assert.match(validators, /function validateDeleteFeedResult\(value: unknown\): \{ ok: boolean; canceledRefreshSessions: number; alreadyDeleted\?: boolean \}/);
  assert.match(validators, /const result = requireApiRecord\(value, "feed delete"\);/);
  assert.match(validators, /requireApiBoolean\(result, "ok", "feed delete"\);/);
  assert.match(validators, /if \(result\.ok !== true\) \{\s+throw malformedApiResponse\("The local feed delete response was not confirmed\."\);/);
  assert.match(validators, /requireApiNumber\(result, "canceledRefreshSessions", "feed delete"\);/);
  assert.match(validators, /function validateDeletePersonResult\(value: unknown\): \{ ok: boolean; alreadyDeleted\?: boolean \}/);
  assert.match(validators, /const result = requireApiRecord\(value, "person delete"\);/);
  assert.match(validators, /if \(result\.ok !== true\) \{\s+throw malformedApiResponse\("The local person delete response was not confirmed\."\);/);
  assert.match(validators, /function validateStorageInfo\(value: unknown\): StorageInfo/);
  assert.match(validators, /\["dataDir", "databasePath", "backupPath", "databaseUpdatedAt", "backupUpdatedAt"\] as const/);
  assert.match(validators, /\["databaseExists", "backupExists"\] as const/);
  assert.match(validators, /\["databaseBytes", "backupBytes"\] as const/);
  assert.match(validators, /if \(info\.databaseExists\) \{\s+requireApiDateString\(info, "databaseUpdatedAt", "storage info"\);/);
  assert.match(validators, /if \(info\.backupExists\) \{\s+requireApiDateString\(info, "backupUpdatedAt", "storage info"\);/);
  assert.match(validators, /if \(!Array\.isArray\(corruptBackups\)\) \{\s+throw malformedApiResponse\('The local storage info response is missing "corruptBackups"\.'\);/);
  assert.match(validators, /requireApiDateString\(entry, "updatedAt", "corrupt backup"\);/);
  assert.match(validators, /function validateDataExport\(value: unknown\): AppDataExport/);
  assert.match(validators, /requireApiDateString\(exported, "exportedAt", "data export"\);/);
  assert.match(validators, /if \(app\.name !== "linkedin-engagement-feed"\)/);
  assert.match(validators, /requireApiIntegerInRange\(app, "schemaVersion", "data export app", 1, 1\);/);
  assert.match(validators, /const feeds = requireApiArray\(exported, "feeds", "data export"\)\.map\(validateExportFeed\);/);
  assert.match(validators, /const people = requireApiArray\(exported, "people", "data export"\)\.map\(validateExportPerson\);/);
  assert.match(validators, /const feedPeople = requireApiArray\(exported, "feedPeople", "data export"\)\.map\(validateExportFeedPerson\);/);
  assert.match(validators, /const items = requireApiArray\(exported, "items", "data export"\)\.map\(validateExportItem\);/);
  assert.match(validators, /const itemFeeds = requireApiArray\(exported, "itemFeeds", "data export"\)\.map\(validateExportItemFeed\);/);
  assert.match(validators, /const feedIds = requireUniqueExportIds\(feeds, "feed"\);/);
  assert.match(validators, /const personIds = requireUniqueExportIds\(people, "person"\);/);
  assert.match(validators, /const itemIds = requireUniqueExportIds\(items, "item"\);/);
  assert.match(validators, /requireExportMembershipReferences\(feedPeople, feedIds, personIds\);/);
  assert.match(validators, /requireExportItemReferences\(items, personIds\);/);
  assert.match(validators, /requireExportItemFeedReferences\(itemFeeds, itemIds, feedIds\);/);
  assert.match(validators, /\["feeds", "people", "items", "feedPeople", "itemFeeds"\] as const/);
  assert.match(validators, /if \(counts\[key\] !== expectedCounts\[key\]\) \{\s+throw malformedApiResponse\(`The local data export response has an inconsistent "\$\{key\}" count\.`\);/);
  assert.match(validators, /function validateExportFeed\(value: unknown\)/);
  assert.match(validators, /requireApiIntegerInRange\(feed, "lookbackDays", "data export feed", 1, 365\);/);
  assert.match(validators, /function validateExportPerson\(value: unknown\)/);
  assert.match(validators, /requireApiLinkedInProfileUrl\(person, "profileUrl", "data export person"\);/);
  assert.match(validators, /function validateExportItem\(value: unknown\)/);
  assert.match(validators, /requireQueueItemType\(item\.type\);/);
  assert.match(validators, /requireApiIntegerInRange\(item, "commentCountApplied", "data export item", 0, 1\);/);
  assert.match(validators, /function requireUniqueExportIds<T extends \{ id: string \}>/);
  assert.match(validators, /throw malformedApiResponse\(`The local data export response has duplicate \$\{label\} ids\.`\);/);
  assert.match(validators, /function requireExportMembershipReferences\(/);
  assert.match(validators, /throw malformedApiResponse\("The local data export response has an orphan feed membership\."\);/);
  assert.match(validators, /function requireExportItemReferences\(items: AppDataExport\["items"\], personIds: Set<string>\)/);
  assert.match(validators, /throw malformedApiResponse\("The local data export response has an orphan item\."\);/);
  assert.match(validators, /function requireExportItemFeedReferences\(/);
  assert.match(validators, /throw malformedApiResponse\("The local data export response has an orphan item feed link\."\);/);
  assert.match(source, /function requireApiArray\(record: Record<string, unknown>, key: string, context: string\): unknown\[\]/);
  assert.match(feedAndPeopleApi, /export const getStorageInfo = \(options: ApiCallOptions = \{\}\) =>\s+api<StorageInfo>\("\/api\/storage", \{ signal: options\.signal, validate: validateStorageInfo \}\);/);
  assert.match(feedAndPeopleApi, /export const getDataExport = \(options: ApiCallOptions = \{\}\) => api<AppDataExport>\("\/api\/export", \{\s+signal: options\.signal,\s+timeoutMs: LONG_REQUEST_TIMEOUT_MS,\s+validate: validateDataExport,\s+\}\);/);
  assert.match(feedAndPeopleApi, /validate: validateDeleteFeedResult,/);
  assert.match(deletePerson, /validate: validateDeletePersonResult,/);
});

test("desktop read APIs accept caller cancellation signals", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const feedAndPeopleApi = source.slice(source.indexOf("export const listFeeds"), source.indexOf("export const upsertPerson"));
  const queueApi = source.slice(source.indexOf("export const listQueue"), source.indexOf("function validateQueueStatusChange"));
  const refreshApi = source.slice(source.indexOf("export const createRefreshSession"), source.indexOf("export const cancelRefreshSession"));

  assert.match(source, /type ApiCallOptions = \{\s+signal\?: AbortSignal;\s+\};/);
  assert.match(feedAndPeopleApi, /export const listFeeds = \(options: ApiCallOptions = \{\}\)/);
  assert.match(feedAndPeopleApi, /export const getStorageInfo = \(options: ApiCallOptions = \{\}\)/);
  assert.match(feedAndPeopleApi, /export const getDataExport = \(options: ApiCallOptions = \{\}\)/);
  assert.match(feedAndPeopleApi, /export const listPeople = \(feedId\?: string, query = "", options: ApiCallOptions = \{\}\)/);
  assert.match(queueApi, /signal\?: AbortSignal;/);
  assert.match(queueApi, /api<QueueItem\[\]>\(`\/api\/queue\?\$\{params\.toString\(\)\}`, \{\s+signal: options\.signal,\s+validate: \(value\) => validateQueueItems\(value, status\),\s+\}\)/);
  assert.match(queueApi, /api<QueueView>\(`\/api\/queue-view\?\$\{params\.toString\(\)\}`, \{\s+signal: options\.signal,\s+validate: \(value\) => validateQueueView\(value, status\),\s+\}\)/);
  assert.match(refreshApi, /export const listRefreshSessions = \(feedId\?: string, options: ApiCallOptions = \{\}\) =>/);
  assert.match(refreshApi, /signal: options\.signal,\s+validate: validateRefreshSessions,/);
  assert.doesNotMatch(feedAndPeopleApi, /listFeeds = \(\) => api/);
  assert.doesNotMatch(refreshApi, /listRefreshSessions = \(feedId\?: string\) =>/);
});

test("desktop bulk import chunks large pastes without losing result indexes", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const bulkImport = source.slice(source.indexOf("export async function bulkAddPeopleToFeed"), source.indexOf("export const deletePerson"));

  assert.match(bulkImport, /if \(chunks\.length === 0\) \{\s+return mergePreparedBulkImportResult\(emptyBulkPeopleResult\(options\.knownRemainingCapacity\), prepared\);/);
  assert.doesNotMatch(bulkImport, /bulkAddPeopleChunk\(feedId, \[\], \[\]\)/);
  assert.match(bulkImport, /function emptyBulkPeopleResult\(knownRemainingCapacity = MAX_PEOPLE_PER_FEED\): BulkPeopleResult/);
  assert.match(bulkImport, /remainingCapacity: normalizeKnownBulkImportRemainingCapacity\(knownRemainingCapacity\),/);
  assert.match(bulkImport, /function normalizeKnownBulkImportRemainingCapacity\(value: number\)/);
  assert.match(bulkImport, /Math\.max\(0, Math\.min\(MAX_PEOPLE_PER_FEED, Math\.round\(capacity\)\)\)/);
  assert.match(bulkImport, /for \(const chunk of chunks\) \{/);
  assert.match(bulkImport, /function prepareBulkPeopleForImport\(people: Array<\{ name\?: string; profileUrl: string \}>\)/);
  assert.match(bulkImport, /if \(bulkPeopleRequestByteLength\(\[person\]\) > BULK_PEOPLE_REQUEST_MAX_BYTES\) \{/);
  assert.match(bulkImport, /profileUrl: truncateBulkImportErrorProfileUrl\(person\.profileUrl\),/);
  assert.match(bulkImport, /error: "Profile row is too large to import\.",/);
  assert.match(bulkImport, /preparedPeople\.push\(\{ person, originalIndex: index \}\);/);
  assert.match(bulkImport, /function bulkAddPeopleChunk\(feedId: string, people: Array<\{ name\?: string; profileUrl: string \}>, originalIndexes: number\[\]\)/);
  assert.match(bulkImport, /errors: result\.errors\.map\(\(error\) => \(\{ \.\.\.error, index: originalIndexes\[error\.index\] \?\? error\.index \}\)\),/);
  assert.match(bulkImport, /received: current\.received \+ next\.received,/);
  assert.match(bulkImport, /added: current\.added \+ next\.added,/);
  assert.match(bulkImport, /alreadyInFeed: current\.alreadyInFeed \+ next\.alreadyInFeed,/);
  assert.match(bulkImport, /updated: current\.updated \+ next\.updated,/);
  assert.match(bulkImport, /skippedInvalid: current\.skippedInvalid \+ next\.skippedInvalid,/);
  assert.match(bulkImport, /skippedCapacity: current\.skippedCapacity \+ next\.skippedCapacity,/);
  assert.match(bulkImport, /remainingCapacity: next\.remainingCapacity,/);
  assert.match(bulkImport, /errors: \[\.\.\.current\.errors, \.\.\.next\.errors\]\.slice\(0, MAX_BULK_PEOPLE_ERROR_DETAILS\),/);
  assert.match(bulkImport, /function chunkPreparedBulkPeople\(/);
  assert.match(bulkImport, /const wouldExceedRowLimit = nextItems\.length > BULK_PEOPLE_REQUEST_MAX_CHUNK_SIZE;/);
  assert.match(bulkImport, /bulkPeopleRequestByteLength\(nextItems\.map\(\(current\) => current\.person\)\) > BULK_PEOPLE_REQUEST_MAX_BYTES/);
  assert.match(bulkImport, /chunks\.push\(\{ items \}\);/);
  assert.match(bulkImport, /function bulkPeopleRequestByteLength\(people: Array<\{ name\?: string; profileUrl: string \}>\)/);
  assert.match(bulkImport, /JSON\.stringify\(\{ people, requestId: "req_"\.padEnd\(80, "x"\) \}\)/);
  assert.match(bulkImport, /new TextEncoder\(\)\.encode\(payload\)\.length/);
  assert.match(bulkImport, /function truncateBulkImportErrorProfileUrl\(profileUrl: string\)/);
  assert.match(bulkImport, /MAX_BULK_ERROR_PROFILE_URL_LENGTH/);
  assert.match(bulkImport, /function bulkImportPartialErrorMessage\(result: BulkPeopleResult, error: unknown\)/);
  assert.match(bulkImport, /Bulk import stopped after processing/);
});

test("desktop bulk import preserves duplicate-row semantics across chunks", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const bulkImport = source.slice(source.indexOf("export async function bulkAddPeopleToFeed"), source.indexOf("export const deletePerson"));

  assert.match(bulkImport, /const seenProfileKeys = new Set<string>\(\);/);
  assert.match(bulkImport, /const profileKey = bulkImportProfileDuplicateKey\(person\.profileUrl\);/);
  assert.match(bulkImport, /if \(profileKey && seenProfileKeys\.has\(profileKey\)\) \{/);
  assert.match(bulkImport, /const skippedRows: BulkPeopleResult\["errors"\] = \[\];/);
  assert.match(bulkImport, /error: "Duplicate profile in this import\.",/);
  assert.match(bulkImport, /continue;/);
  assert.match(bulkImport, /skippedRows,/);
  assert.match(bulkImport, /options: \{ beforeOriginalIndex\?: number \} = \{\},/);
  assert.match(bulkImport, /const skippedRows = prepared\.skippedRows\.filter\(/);
  assert.match(bulkImport, /entry\.index < options\.beforeOriginalIndex/);
  assert.match(bulkImport, /received: result\.received \+ skippedRows\.length,/);
  assert.match(bulkImport, /skippedInvalid: result\.skippedInvalid \+ skippedRows\.length,/);
  assert.match(bulkImport, /\[\.\.\.result\.errors, \.\.\.skippedRows\]\s+\.sort\(\(first, second\) => first\.index - second\.index\)\s+\.slice\(0, MAX_BULK_PEOPLE_ERROR_DETAILS\)/);
  assert.match(bulkImport, /function bulkImportProfileDuplicateKey\(profileUrl: string\)/);
  assert.match(bulkImport, /return decodeURIComponent\(match\[1\]\)\.toLowerCase\(\);/);
  assert.match(bulkImport, /function normalizeBulkImportLinkedInProfileUrl\(profileUrl: string\)/);
  assert.match(bulkImport, /hostname !== "linkedin\.com" && !hostname\.endsWith\("\.linkedin\.com"\)/);
});

test("desktop refresh creation carries a stable client request id for safe retries", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const createRefresh = source.slice(source.indexOf("export const createRefreshSession"), source.indexOf("export const listRefreshSessions"));
  const listRefresh = source.slice(source.indexOf("export const listRefreshSessions"), source.indexOf("export const cancelRefreshSession"));
  const cancelRefresh = source.slice(source.indexOf("export const cancelRefreshSession"), source.indexOf("function createClientRequestId"));

  assert.match(createRefresh, /method: "POST",\s+retry: true,/);
  assert.match(createRefresh, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(createRefresh, /validate: validateRefreshSession,/);
  assert.match(createRefresh, /body: JSON\.stringify\(\{ feedId, requestId: createClientRequestId\(\) \}\),/);
  assert.match(listRefresh, /api<RefreshSession\[\]>\(feedId \? `\/api\/refresh-sessions\?feedId=\$\{encodeURIComponent\(feedId\)\}` : "\/api\/refresh-sessions", \{\s+signal: options\.signal,\s+validate: validateRefreshSessions,\s+\}\)/);
  assert.match(source, /export type RefreshCancelResult = RefreshSession \| \{/);
  assert.match(cancelRefresh, /api<RefreshCancelResult>/);
  assert.match(cancelRefresh, /method: "DELETE",\s+retry: true,/);
  assert.match(cancelRefresh, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(cancelRefresh, /validate: validateRefreshCancelResult,/);
  assert.match(source, /function createClientRequestId\(\)/);
  assert.match(source, /browserCrypto\.randomUUID/);
});

test("client retry request ids use browser crypto instead of math random", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const requestIdHelpers = source.slice(source.indexOf("let lastResortClientRequestCounter"), source.length);

  assert.match(requestIdHelpers, /let lastResortClientRequestCounter = 0;/);
  assert.match(requestIdHelpers, /const browserCrypto = globalThis\.crypto;/);
  assert.match(requestIdHelpers, /browserCrypto\?\.randomUUID/);
  assert.match(requestIdHelpers, /return `req_\$\{browserCrypto\.randomUUID\(\)\}`;/);
  assert.match(requestIdHelpers, /browserCrypto\?\.getRandomValues/);
  assert.match(requestIdHelpers, /browserCrypto\.getRandomValues\(bytes\);/);
  assert.match(requestIdHelpers, /bytes\[6\] = \(bytes\[6\] & 0x0f\) \| 0x40;/);
  assert.match(requestIdHelpers, /bytes\[8\] = \(bytes\[8\] & 0x3f\) \| 0x80;/);
  assert.match(requestIdHelpers, /function formatClientRequestUuidBytes\(bytes: Uint8Array\)/);
  assert.match(requestIdHelpers, /lastResortClientRequestCounter = \(lastResortClientRequestCounter \+ 1\) % Number\.MAX_SAFE_INTEGER;/);
  assert.doesNotMatch(requestIdHelpers, /Math\.random/);
});

test("counter saves and idempotent adjustments retry safely", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const updateCounters = source.slice(source.indexOf("export const updateCounters"), source.indexOf("export const adjustCounters"));
  const adjustCounters = source.slice(source.indexOf("export const adjustCounters"), source.indexOf("export const createRefreshSession"));

  assert.match(updateCounters, /\/counters/);
  assert.match(updateCounters, /method: "PATCH",\s+retry: true,/);
  assert.match(updateCounters, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(updateCounters, /validate: validatePerson,/);
  assert.match(updateCounters, /body: JSON\.stringify\(\{ \.\.\.patch, requestId: createClientRequestId\(\) \}\),/);
  assert.match(adjustCounters, /\/counters\/adjust/);
  assert.match(adjustCounters, /method: "PATCH",\s+retry: true,/);
  assert.match(adjustCounters, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(adjustCounters, /validate: validatePerson,/);
  assert.match(adjustCounters, /body: JSON\.stringify\(\{ \.\.\.delta, requestId: createClientRequestId\(\) \}\),/);
});

test("queue api supports stable cursor pagination", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const listQueue = source.slice(source.indexOf("export const listQueue"), source.indexOf("export const getQueueCounts"));
  const queueParams = source.slice(source.indexOf("function queueParams"), source.indexOf("export const setItemStatus"));

  assert.match(listQueue, /after\?: Pick<QueueItem, "activityAt" \| "discoveredAt" \| "id">/);
  assert.match(listQueue, /export const getQueueView = \(/);
  assert.match(listQueue, /validate: \(value\) => validateQueueView\(value, status\),/);
  assert.match(queueParams, /if \(options\.offset !== undefined && !options\.after\) \{\s+params\.set\("offset", String\(options\.offset\)\);/);
  assert.match(queueParams, /params\.set\("afterActivityAt", options\.after\.activityAt\);/);
  assert.match(queueParams, /params\.set\("afterDiscoveredAt", options\.after\.discoveredAt\);/);
  assert.match(queueParams, /params\.set\("afterId", options\.after\.id\);/);
  assert.doesNotMatch(queueParams, /if \(options\.offset !== undefined\) \{\s+params\.set\("offset", String\(options\.offset\)\);/);
});

test("queue api validates local response shapes before updating the UI", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const validators = source.slice(source.indexOf("function validateQueueItems"), source.indexOf("export const listQueue"));
  const listQueue = source.slice(source.indexOf("export const listQueue"), source.indexOf("function queueParams"));

  assert.match(validators, /function validateQueueItems\(value: unknown, expectedStatus\?: QueueStatus\): QueueItem\[\]/);
  assert.match(validators, /if \(!Array\.isArray\(value\)\) \{\s+throw malformedApiResponse\("The local queue response was not a list\."\);/);
  assert.match(validators, /const items = value\.map\(validateQueueItem\);/);
  assert.match(validators, /const itemIds = items\.map\(\(item\) => item\.id\);/);
  assert.match(validators, /if \(new Set\(itemIds\)\.size !== itemIds\.length\) \{\s+throw malformedApiResponse\("The local queue response has duplicate item ids\."\);/);
  assert.match(validators, /if \(expectedStatus && items\.some\(\(item\) => item\.status !== expectedStatus\)\) \{\s+throw malformedApiResponse\(`The local queue response included items outside the \$\{expectedStatus\} tab\.`\);/);
  assert.match(validators, /return items;/);
  assert.match(validators, /function validateQueueItem\(value: unknown\): QueueItem/);
  assert.match(validators, /requireApiNonEmptyString\(item, "id", "queue item"\);/);
  assert.match(validators, /requireApiNonEmptyString\(item, "personId", "queue item"\);/);
  assert.match(validators, /requireApiNonEmptyString\(item, "personName", "queue item"\);/);
  assert.match(validators, /requireApiLinkedInProfileUrl\(item, "profileUrl", "queue item"\);/);
  assert.match(validators, /requireApiLinkedInUrl\(item, "sourceUrl", "queue item"\);/);
  assert.match(validators, /requireApiNonEmptyString\(item, "externalId", "queue item"\);/);
  assert.match(validators, /requireApiDateString\(item, "activityAt", "queue item"\);/);
  assert.match(validators, /requireApiDateString\(item, "discoveredAt", "queue item"\);/);
  assert.match(validators, /requireQueueItemType\(item\.type\);/);
  assert.match(validators, /requireQueueStatus\(item\.status\);/);
  assert.match(validators, /requireApiUniqueStringArray\(item, "feedIds", "queue item"\);/);
  assert.match(validators, /requireApiStringArray\(item, "feedNames", "queue item"\);/);
  assert.match(validators, /\(item\.feedNames as string\[\]\)\.length !== \(item\.feedIds as string\[\]\)\.length/);
  assert.match(validators, /The local queue item response has mismatched feed tags/);
  assert.match(validators, /function validateQueueView\(value: unknown, expectedStatus\?: QueueStatus\): QueueView/);
  assert.match(validators, /items: validateQueueItems\(view\.items, expectedStatus\),\s+counts: validateQueueCounts\(view\.counts\),/);
  assert.match(validators, /function validateQueueCounts\(value: unknown\): QueueCounts/);
  assert.match(validators, /for \(const key of \["new", "done", "skipped", "all"\] as const\)/);
  assert.match(validators, /requireApiNumber\(counts, key, "queue counts"\);/);
  assert.match(validators, /const total = \(counts\.new as number\) \+ \(counts\.done as number\) \+ \(counts\.skipped as number\);/);
  assert.match(validators, /if \(counts\.all !== total\) \{\s+throw malformedApiResponse\("The local queue counts response has inconsistent totals\."\);/);
  assert.match(validators, /function malformedApiResponse\(message: string\) \{\s+return new MalformedApiResponseError\(message\);/);
  assert.match(validators, /function requireApiNonEmptyString\(record: Record<string, unknown>, key: string, context: string\)/);
  assert.match(validators, /requireApiString\(record, key, context\);\s+if \(!\(record\[key\] as string\)\.trim\(\)\)/);
  assert.match(validators, /function requireApiDateString\(record: Record<string, unknown>, key: string, context: string\)/);
  assert.match(validators, /requireApiNonEmptyString\(record, key, context\);\s+if \(!Number\.isFinite\(Date\.parse\(record\[key\] as string\)\)\)/);
  assert.match(validators, /function requireApiLinkedInProfileUrl\(record: Record<string, unknown>, key: string, context: string\)/);
  assert.match(validators, /if \(!normalizeLinkedInProfileUrl\(record\[key\] as string\)\)/);
  assert.match(validators, /function requireApiLinkedInUrl\(record: Record<string, unknown>, key: string, context: string\)/);
  assert.match(validators, /const parsed = new URL\(record\[key\] as string, "https:\/\/www\.linkedin\.com"\);/);
  assert.match(validators, /!isLinkedInHost\(parsed\.hostname\) \|\| \(parsed\.protocol !== "https:" && parsed\.protocol !== "http:"\)/);
  assert.match(validators, /function requireApiStringArray\(record: Record<string, unknown>, key: string, context: string\)/);
  assert.match(validators, /value\.some\(\(entry\) => typeof entry !== "string" \|\| !entry\.trim\(\) \|\| entry !== entry\.trim\(\)\)/);
  assert.match(listQueue, /api<QueueItem\[\]>\(`\/api\/queue\?\$\{params\.toString\(\)\}`, \{\s+signal: options\.signal,\s+validate: \(value\) => validateQueueItems\(value, status\),\s+\}\)/);
  assert.match(listQueue, /api<QueueView>\(`\/api\/queue-view\?\$\{params\.toString\(\)\}`, \{\s+signal: options\.signal,\s+validate: \(value\) => validateQueueView\(value, status\),\s+\}\)/);
  assert.match(listQueue, /export const getQueueCounts = \(feedId\?: string, options: ApiCallOptions = \{\}\)/);
  assert.match(listQueue, /api<QueueCounts>\(feedId \? `\/api\/queue-counts\?feedId=\$\{encodeURIComponent\(feedId\)\}` : "\/api\/queue-counts", \{\s+signal: options\.signal,\s+validate: validateQueueCounts,\s+\}\)/);
});

test("queue status writes include a retry idempotency key", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const setItemStatus = source.slice(source.indexOf("export const setItemStatus"), source.indexOf("export const updateCounters"));

  assert.match(setItemStatus, /method: "POST",\s+retry: true,/);
  assert.match(setItemStatus, /timeoutMs: WRITE_REQUEST_TIMEOUT_MS,/);
  assert.match(setItemStatus, /validate: \(value\) => validateQueueStatusChange\(value, \{ itemId, status \}\),/);
  assert.match(setItemStatus, /body: JSON\.stringify\(\{ status, feedId: options\.feedId, requestId: createClientRequestId\(\) \}\),/);
});

test("refresh and action api validates local response shapes before updating the UI", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const validators = source.slice(source.indexOf("function validateQueueStatusChange"), source.indexOf("export const setItemStatus"));
  const actionApi = source.slice(source.indexOf("export const setItemStatus"), source.indexOf("function createClientRequestId"));

  assert.match(validators, /function validateQueueStatusChange\(\s+value: unknown,\s+expected: \{ itemId\?: string; status\?: QueueStatus \} = \{\},\s+\): QueueStatusChange/);
  assert.match(validators, /requireApiNonEmptyString\(change, "itemId", "queue status change"\);/);
  assert.match(validators, /requireApiNonEmptyString\(change, "personId", "queue status change"\);/);
  assert.match(validators, /requireQueueStatus\(change\.previousStatus\);/);
  assert.match(validators, /requireQueueStatus\(change\.status\);/);
  assert.match(validators, /requireApiBoolean\(change, "changed", "queue status change"\);/);
  assert.match(validators, /requireApiIntegerInRange\(change, "commentCountDelta", "queue status change", -1, 1\);/);
  assert.match(validators, /if \(change\.changed === false && change\.previousStatus !== change\.status\) \{\s+throw malformedApiResponse\("The local queue status change response is inconsistent\."\);/);
  assert.match(validators, /if \(change\.changed === false && change\.commentCountDelta !== 0\) \{\s+throw malformedApiResponse\("The local queue status change response has an impossible counter delta\."\);/);
  assert.match(validators, /if \(change\.changed === true && change\.previousStatus === change\.status\) \{\s+throw malformedApiResponse\("The local queue status change response has an impossible status transition\."\);/);
  assert.match(validators, /if \(expected\.itemId !== undefined && change\.itemId !== expected\.itemId\) \{\s+throw malformedApiResponse\("The local queue status change response has the wrong item id\."\);/);
  assert.match(validators, /if \(expected\.status !== undefined && change\.status !== expected\.status\) \{\s+throw malformedApiResponse\("The local queue status change response has the wrong status\."\);/);
  assert.match(validators, /queueStatusTransitionHasValidCounterDelta\(/);
  assert.match(validators, /throw malformedApiResponse\("The local queue status change response has an impossible counter transition\."\);/);
  assert.match(validators, /function queueStatusTransitionHasValidCounterDelta\(previousStatus: QueueStatus, status: QueueStatus, commentCountDelta: number\)/);
  assert.match(validators, /previousStatus === "done" && status !== "done"/);
  assert.match(validators, /previousStatus !== "done" && status === "done"/);
  assert.match(validators, /function validateRefreshSessions\(value: unknown\): RefreshSession\[\]/);
  assert.match(validators, /const sessions = value\.map\(validateRefreshSession\);/);
  assert.match(validators, /const sessionIds = sessions\.map\(\(session\) => session\.id\);/);
  assert.match(validators, /if \(new Set\(sessionIds\)\.size !== sessionIds\.length\) \{\s+throw malformedApiResponse\("The local refresh sessions response has duplicate session ids\."\);/);
  assert.match(validators, /return sessions;/);
  assert.match(validators, /function validateRefreshSession\(value: unknown\): RefreshSession/);
  assert.match(validators, /requireApiNonEmptyString\(session, "id", "refresh session"\);/);
  assert.match(validators, /requireApiNonEmptyString\(session, "feedId", "refresh session"\);/);
  assert.match(validators, /requireApiNonEmptyString\(session, "feedName", "refresh session"\);/);
  assert.match(validators, /requireApiDateString\(session, "lookbackCutoffAt", "refresh session"\);/);
  assert.match(validators, /requireRefreshStatus\(session\.status\);/);
  assert.match(validators, /"totalTargets",/);
  assert.match(validators, /"currentAttempt",/);
  assert.match(validators, /"maxAttempts",/);
  assert.match(validators, /const totalTargets = session\.totalTargets as number;/);
  assert.match(validators, /const completedTargets = session\.completedTargets as number;/);
  assert.match(validators, /const failedTargets = session\.failedTargets as number;/);
  assert.match(validators, /const currentAttempt = session\.currentAttempt as number;/);
  assert.match(validators, /const maxAttempts = session\.maxAttempts as number;/);
  assert.match(validators, /if \(completedTargets > totalTargets \|\| failedTargets > completedTargets\) \{\s+throw malformedApiResponse\("The local refresh session response has inconsistent progress\."\);/);
  assert.match(validators, /if \(currentAttempt < 1 \|\| maxAttempts < 1 \|\| currentAttempt > maxAttempts\) \{\s+throw malformedApiResponse\("The local refresh session response has inconsistent retry state\."\);/);
  assert.match(validators, /if \(\(status === "done" \|\| status === "failed"\) && completedTargets !== totalTargets\) \{\s+throw malformedApiResponse\("The local refresh session response has an impossible finished progress state\."\);/);
  assert.match(validators, /requireApiDateString\(session, "createdAt", "refresh session"\);/);
  assert.match(validators, /requireApiDateString\(session, "updatedAt", "refresh session"\);/);
  assert.match(validators, /if \(session\.nextUrl !== undefined && typeof session\.nextUrl !== "string"\)/);
  assert.match(validators, /if \(session\.createdByRequest !== undefined && typeof session\.createdByRequest !== "boolean"\)/);
  assert.match(validators, /let currentTarget: NonNullable<RefreshSession\["currentTarget"\]> \| undefined;/);
  assert.match(validators, /if \(session\.currentTarget !== undefined\) \{\s+currentTarget = validateRefreshTarget\(session\.currentTarget\);/);
  assert.match(validators, /if \(currentTarget\.index >= totalTargets\) \{\s+throw malformedApiResponse\("The local refresh session response has an out-of-range current target\."\);/);
  assert.match(validators, /if \(status === "running"\) \{/);
  assert.match(validators, /!currentTarget \|\| currentTarget\.index !== completedTargets/);
  assert.match(validators, /!refreshUrlMatchesTarget\(session\.nextUrl, currentTarget, \{ sessionId: session\.id as string, targetIndex: currentTarget\.index \}\)/);
  assert.match(validators, /throw malformedApiResponse\("The local refresh session response has stale navigation details\."\);/);
  assert.match(validators, /function validateRefreshTarget\(value: unknown\): NonNullable<RefreshSession\["currentTarget"\]>/);
  assert.match(validators, /requireApiNonEmptyString\(target, "personId", "refresh target"\);/);
  assert.match(validators, /requireApiNonEmptyString\(target, "personName", "refresh target"\);/);
  assert.match(validators, /requireApiLinkedInProfileUrl\(target, "profileUrl", "refresh target"\);/);
  assert.match(validators, /requireApiNonEmptyString\(target, "url", "refresh target"\);/);
  assert.match(validators, /if \(target\.kind !== "posts" && target\.kind !== "comments"\)/);
  assert.match(validators, /if \(!refreshUrlMatchesTarget\(target\.url, target as NonNullable<RefreshSession\["currentTarget"\]>\)\)/);
  assert.match(validators, /function refreshUrlMatchesTarget\(/);
  assert.match(validators, /parsed\.searchParams\.get\("lefSession"\) !== options\.sessionId/);
  assert.match(validators, /parsed\.searchParams\.get\("lefTarget"\) !== String\(options\.targetIndex\)/);
  assert.match(validators, /function normalizeLinkedInProfileUrl\(value: string\)/);
  assert.match(validators, /function refreshActivityKindFromPath\(pathname: string\)/);
  assert.match(validators, /function validateRefreshCancelResult\(value: unknown\): RefreshCancelResult/);
  assert.match(validators, /if \(result\.ok === true \|\| result\.alreadyCanceled === true\)/);
  assert.match(validators, /requireApiNonEmptyString\(result, "id", "refresh cancel"\);/);
  assert.match(validators, /return validateRefreshSession\(result\);/);
  assert.match(validators, /function requireRefreshStatus\(value: unknown\)/);
  assert.match(actionApi, /validate: \(value\) => validateQueueStatusChange\(value, \{ itemId, status \}\),/);
  assert.match(actionApi, /validate: validatePerson,/);
  assert.match(actionApi, /validate: validateRefreshSession,/);
  assert.match(actionApi, /validate: validateRefreshSessions,/);
  assert.match(actionApi, /validate: validateRefreshCancelResult,/);
  assert.match(source, /function requireApiIntegerInRange\(\s+record: Record<string, unknown>,\s+key: string,\s+context: string,\s+minimum: number,\s+maximum: number,\s+\)/);
  assert.match(source, /function requireApiBoolean\(record: Record<string, unknown>, key: string, context: string\)/);
});

test("data export item contract includes done counter application state", () => {
  const source = fs.readFileSync(apiSourcePath, "utf8");
  const appDataExport = source.slice(source.indexOf("export type AppDataExport"), source.indexOf("let apiBaseUrlPromise"));

  assert.match(appDataExport, /status: QueueStatus;/);
  assert.match(appDataExport, /commentCountApplied: number;/);
});
