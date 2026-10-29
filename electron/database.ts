import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import initSqlJs, { Database } from "sql.js";

const require = createRequire(import.meta.url);

export const MAX_PEOPLE_PER_FEED = 200;
export const MAX_FEED_LOOKBACK_DAYS = 365;
export const MAX_CAPTURE_ITEMS_PER_REQUEST = 120;
export const MAX_COUNTER_VALUE = 9999;
export const MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX = 500;
export const MAX_PROFILE_STATUS_BATCH_SIZE = MAX_PEOPLE_PER_FEED;
export const MAX_CAPTURE_FEEDS_PER_REQUEST = 20;
export const MAX_BULK_PEOPLE_PER_REQUEST = 500;
const MAX_PEOPLE_SEARCH_QUERY_LENGTH = 240;
const MAX_BULK_PEOPLE_ERROR_DETAILS = 50;

export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

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

export type ProfileStatus = {
  person?: Person;
  feedIds: string[];
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

export type QueueStatusFilter = "new" | "done" | "skipped" | "all";

export type QueueCounts = {
  new: number;
  done: number;
  skipped: number;
  all: number;
};

export type QueueView = {
  items: QueueItem[];
  counts: QueueCounts;
};

export type QueueStatusChange = {
  itemId: string;
  personId: string;
  previousStatus: "new" | "done" | "skipped";
  status: "new" | "done" | "skipped";
  changed: boolean;
  commentCountDelta: number;
};

export type QueueListOptions = {
  limit?: number;
  offset?: number;
  after?: {
    activityAt: string;
    discoveredAt: string;
    id: string;
  };
};

type QueueReadOptions = QueueListOptions & {
  skipFeedValidation?: boolean;
};

export type CapturedItem = {
  personName: string;
  profileUrl: string;
  ownerProfileUrl?: string;
  type: "post" | "comment";
  sourceUrl: string;
  externalId?: string;
  text?: string;
  activityAt?: string;
};

type ExistingCapturedItem = {
  id: string;
  text: string;
  sourceUrl: string;
  externalId: string;
  activityAt: string;
  discoveredAt: string;
};

type FeedMember = {
  id: string;
  name: string;
  profileUrl: string;
};

type NormalizedCapturedItem = {
  member: FeedMember;
  type: "post" | "comment";
  sourceUrl: string;
  externalId: string;
  text: string;
  activityAt: string;
  capturedAt: string;
  personName: string;
};

export type BulkPersonInput = {
  name?: string;
  profileUrl: string;
};

type NormalizedBulkPersonInput = {
  index: number;
  name?: string;
  profileUrl: string;
  publicId: string;
  duplicateKey: string;
};

type PersonUpsertResult = {
  person: Person;
  changed: boolean;
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

export type CaptureResult = {
  received: number;
  inserted: number;
  updated: number;
  skippedOlder: number;
  skippedUntracked: number;
  skippedInvalid: number;
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

export type AppStateValue<T = unknown> = {
  key: string;
  value: T;
  updatedAt: string;
};

export type AppDataExport = {
  exportedAt: string;
  app: {
    name: "linkedin-engagement-feed";
    schemaVersion: 1;
  };
  feeds: Array<{
    id: string;
    name: string;
    lookbackDays: number;
    createdAt: string;
    updatedAt: string;
  }>;
  people: Array<Omit<Person, "feedIds">>;
  feedPeople: Array<{
    feedId: string;
    personId: string;
    createdAt: string;
  }>;
  items: Array<{
    id: string;
    personId: string;
    type: "post" | "comment";
    sourceUrl: string;
    externalId: string;
    text: string;
    activityAt: string;
    discoveredAt: string;
    status: "new" | "done" | "skipped";
    commentCountApplied: number;
    createdAt: string;
    updatedAt: string;
  }>;
  itemFeeds: Array<{
    itemId: string;
    feedId: string;
    createdAt: string;
  }>;
  counts: {
    feeds: number;
    people: number;
    items: number;
    feedPeople: number;
    itemFeeds: number;
  };
};

const nowIso = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
const DEFAULT_QUEUE_LIMIT = 150;
const MAX_QUEUE_LIMIT = 500;

export class AppDatabase {
  private db!: Database;
  private transactionDepth = 0;
  private dirty = false;
  private isOpen = false;
  private idempotencyPrefixCounts = new Map<string, number>();

  constructor(private readonly dbPath: string) {}

  async open() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });
    const createDatabase = (bytes: Buffer) => new SQL.Database(bytes);

    recoverPendingSave({
      createDatabase,
      dbPath: this.dbPath,
    });

    if (fs.existsSync(this.dbPath)) {
      try {
        this.db = createDatabase(fs.readFileSync(this.dbPath));
        assertDatabaseHealthy(this.db);
      } catch (error) {
        this.db = restoreDatabaseFromBackup({
          createDatabase,
          dbPath: this.dbPath,
          primaryError: error,
        });
      }
    } else {
      this.db = new SQL.Database();
    }
    this.isOpen = true;

    this.migrate();
    this.ensureDefaultFeed();
    this.save();
  }

  close() {
    if (!this.isOpen) {
      return;
    }
    if (this.dirty) {
      this.save();
      this.dirty = false;
    }
    this.db.close();
    this.isOpen = false;
  }

  getStorageInfo(): StorageInfo {
    const backupPath = backupPathFor(this.dbPath);
    const databaseInfo = fileInfoFields(this.dbPath);
    const backupInfo = fileInfoFields(backupPath);
    return {
      dataDir: path.dirname(this.dbPath),
      databasePath: this.dbPath,
      backupPath,
      databaseExists: databaseInfo.exists,
      backupExists: backupInfo.exists,
      databaseBytes: databaseInfo.bytes,
      backupBytes: backupInfo.bytes,
      databaseUpdatedAt: databaseInfo.updatedAt,
      backupUpdatedAt: backupInfo.updatedAt,
      corruptBackups: listCorruptDatabaseFiles(this.dbPath),
    };
  }

  getAppState<T = unknown>(key: string): AppStateValue<T> | undefined {
    const cleanKey = normalizeStateKey(key);
    const row = this.one<{ value: string; updatedAt: string }>(
      "SELECT value, updated_at AS updatedAt FROM app_state WHERE key = ?",
      [cleanKey],
    );
    if (!row) {
      return undefined;
    }
    try {
      return {
        key: cleanKey,
        value: JSON.parse(row.value) as T,
        updatedAt: row.updatedAt,
      };
    } catch (error) {
      throw new AppError(`Saved local app state "${cleanKey}" is not valid JSON. ${errorMessage(error)}`, 500);
    }
  }

  getIdempotencyState<T = unknown>(key: string): AppStateValue<T> | undefined {
    const cleanKey = normalizeStateKey(key);
    const prefix = idempotencyStatePrefixForKey(cleanKey);
    if (!prefix) {
      return this.getAppState<T>(cleanKey);
    }
    try {
      return this.getAppState<T>(cleanKey);
    } catch {
      this.deleteIdempotencyState(cleanKey);
      return undefined;
    }
  }

  setAppState(key: string, value: unknown): AppStateValue {
    const cleanKey = normalizeStateKey(key);
    const serializedValue = JSON.stringify(value);
    return this.withTransaction(() => {
      const existing = this.one<{ value: string; updatedAt: string }>(
        "SELECT value, updated_at AS updatedAt FROM app_state WHERE key = ?",
        [cleanKey],
      );
      if (existing?.value === serializedValue) {
        return { key: cleanKey, value, updatedAt: existing.updatedAt };
      }
      const at = nowIso();
      this.db.run(
        `
        INSERT INTO app_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `,
        [cleanKey, serializedValue, at],
      );
      this.markDirty();
      if (!existing) {
        this.incrementIdempotencyPrefixCount(cleanKey);
      }
      this.pruneIdempotencyState(cleanKey);
      return { key: cleanKey, value, updatedAt: at };
    });
  }

  deleteAppState(key: string) {
    this.withTransaction(() => {
      const cleanKey = normalizeStateKey(key);
      const prefix = idempotencyStatePrefixForKey(cleanKey);
      this.db.run("DELETE FROM app_state WHERE key = ?", [cleanKey]);
      if (this.db.getRowsModified() > 0) {
        if (prefix) {
          this.decrementIdempotencyPrefixCount(prefix);
        }
        this.markDirty();
      }
    });
  }

  getDataExport(): AppDataExport {
    const feeds = this.all<AppDataExport["feeds"][number]>(`
      SELECT id, name, lookback_days AS lookbackDays, created_at AS createdAt, updated_at AS updatedAt
      FROM feeds
      ORDER BY created_at ASC
    `);
    const people = this.all<AppDataExport["people"][number]>(`
      SELECT id, name, profile_url AS profileUrl, public_id AS publicId, headline,
        comment_count AS commentCount, like_count AS likeCount, back_comment_count AS backCommentCount,
        created_at AS createdAt, updated_at AS updatedAt
      FROM people
      ORDER BY name COLLATE NOCASE ASC
    `);
    const feedPeople = this.all<AppDataExport["feedPeople"][number]>(`
      SELECT feed_id AS feedId, person_id AS personId, created_at AS createdAt
      FROM feed_people
      ORDER BY created_at ASC
    `);
    const items = this.all<AppDataExport["items"][number]>(`
      SELECT id, person_id AS personId, type, source_url AS sourceUrl, external_id AS externalId,
        text, activity_at AS activityAt, discovered_at AS discoveredAt, status,
        comment_count_applied AS commentCountApplied,
        created_at AS createdAt, updated_at AS updatedAt
      FROM items
      ORDER BY activity_at DESC, discovered_at DESC
    `);
    const itemFeeds = this.all<AppDataExport["itemFeeds"][number]>(`
      SELECT item_id AS itemId, feed_id AS feedId, created_at AS createdAt
      FROM item_feeds
      ORDER BY created_at ASC
    `);

    return {
      exportedAt: nowIso(),
      app: {
        name: "linkedin-engagement-feed",
        schemaVersion: 1,
      },
      feeds,
      people,
      feedPeople,
      items,
      itemFeeds,
      counts: {
        feeds: feeds.length,
        people: people.length,
        items: items.length,
        feedPeople: feedPeople.length,
        itemFeeds: itemFeeds.length,
      },
    };
  }

  listFeeds(): Feed[] {
    return this.all<Feed>(`
      SELECT f.id, f.name, f.lookback_days AS lookbackDays,
        (
          SELECT COUNT(*) AS count
          FROM feed_people INDEXED BY idx_feed_people_feed
          WHERE feed_id = f.id
        ) AS peopleCount,
        f.created_at AS createdAt, f.updated_at AS updatedAt
      FROM feeds f
      ORDER BY f.created_at ASC
    `);
  }

  getFeed(id: string): Feed {
    const feed = this.one<Feed>(
      `
      SELECT f.id, f.name, f.lookback_days AS lookbackDays,
        (
          SELECT COUNT(*) AS count
          FROM feed_people INDEXED BY idx_feed_people_feed
          WHERE feed_id = f.id
        ) AS peopleCount,
        f.created_at AS createdAt, f.updated_at AS updatedAt
      FROM feeds f
      WHERE f.id = ?
      `,
      [id],
    );
    if (!feed) {
      throw new AppError("Feed not found.", 404);
    }
    return feed;
  }

  private assertFeedExists(id: string) {
    const found = this.one<{ found: number }>("SELECT 1 AS found FROM feeds WHERE id = ? LIMIT 1", [id])?.found;
    if (!found) {
      throw new AppError("Feed not found.", 404);
    }
  }

  createFeed(name: string, lookbackDays = 15, options: { requestId?: string } = {}): Feed {
    return this.withTransaction(() => {
      const idempotencyKey = feedCreateIdempotencyKey(options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<Feed>(idempotencyKey, isFeedReplay)
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      const cleanName = normalizeFeedName(name);
      this.assertFeedNameAvailable(cleanName);
      const id = createId("feed");
      const at = nowIso();
      this.db.run(
        "INSERT INTO feeds (id, name, lookback_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [id, cleanName, normalizeLookbackDays(lookbackDays), at, at],
      );
      this.markDirty();
      const feed = this.getFeed(id);
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, feed);
      }
      return feed;
    });
  }

  getOrCreateFeed(name: string, lookbackDays = 15, options: { requestId?: string } = {}): Feed {
    return this.withTransaction(() => {
      const idempotencyKey = feedCreateIdempotencyKey(options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<Feed>(idempotencyKey, isFeedReplay)
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      const cleanName = normalizeFeedName(name);
      const existing = this.feedByName(cleanName);
      if (existing) {
        if (idempotencyKey) {
          this.setAppState(idempotencyKey, existing);
        }
        return existing;
      }
      return this.createFeed(cleanName, lookbackDays, options);
    });
  }

  updateFeed(id: string, patch: { name?: string; lookbackDays?: number }, options: { requestId?: string } = {}): Feed {
    return this.withTransaction(() => {
      const idempotencyKey = feedUpdateIdempotencyKey(id, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<Feed>(idempotencyKey, (value) => isFeedReplay(value, id))
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      const existing = this.getFeed(id);
      const nextName = patch.name === undefined ? existing.name : normalizeFeedName(patch.name);
      if (nextName.toLocaleLowerCase() !== existing.name.toLocaleLowerCase()) {
        this.assertFeedNameAvailable(nextName, id);
      }
      const lookbackDays =
        patch.lookbackDays === undefined ? existing.lookbackDays : normalizeLookbackDays(patch.lookbackDays);
      if (nextName === existing.name && lookbackDays === existing.lookbackDays) {
        if (idempotencyKey) {
          this.setAppState(idempotencyKey, existing);
        }
        return existing;
      }
      this.db.run("UPDATE feeds SET name = ?, lookback_days = ?, updated_at = ? WHERE id = ?", [
        nextName,
        lookbackDays,
        nowIso(),
        id,
      ]);
      this.markDirty();
      const feed = this.getFeed(id);
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, feed);
      }
      return feed;
    });
  }

  deleteFeed(id: string) {
    this.withTransaction(() => {
      this.getFeed(id);
      this.db.run(
        `
        DELETE FROM items
        WHERE EXISTS (
          SELECT 1
          FROM item_feeds deleted_scope
          WHERE deleted_scope.item_id = items.id AND deleted_scope.feed_id = ?
        )
          AND NOT EXISTS (
            SELECT 1
            FROM item_feeds other_scope
            WHERE other_scope.item_id = items.id AND other_scope.feed_id != ?
          )
        `,
        [id, id],
      );
      this.db.run("DELETE FROM feed_people WHERE feed_id = ?", [id]);
      this.db.run("DELETE FROM item_feeds WHERE feed_id = ?", [id]);
      this.db.run("DELETE FROM feeds WHERE id = ?", [id]);
      this.markDirty();
      if (this.listFeeds().length === 0) {
        this.createFeed("SEO Thought Leaders", 15);
      }
    });
  }

  listPeople(query = "", feedId?: string): Person[] {
    const cleanQuery = normalizePeopleSearchQuery(query);
    const normalizedQuery = `%${escapeSqlLikePattern(cleanQuery)}%`;
    const where: string[] = [];

    if (cleanQuery) {
      where.push(
        "(lower(p.name) LIKE ? ESCAPE '^' OR lower(p.profile_url) LIKE ? ESCAPE '^' OR lower(p.public_id) LIKE ? ESCAPE '^')",
      );
    }

    if (feedId) {
      this.assertFeedExists(feedId);
      const params: unknown[] = [feedId];
      if (cleanQuery) {
        params.push(normalizedQuery, normalizedQuery, normalizedQuery);
      }
      return this.all<Person & { feedIds: string }>(
        `
        SELECT p.id, p.name, p.profile_url AS profileUrl, p.public_id AS publicId, p.headline,
          p.comment_count AS commentCount, p.like_count AS likeCount,
          p.back_comment_count AS backCommentCount, p.created_at AS createdAt, p.updated_at AS updatedAt,
          ${orderedPersonFeedIdsSql("p.id")} AS feedIds
        FROM feed_people scope INDEXED BY idx_feed_people_feed
        JOIN people p ON p.id = scope.person_id
        WHERE scope.feed_id = ? ${where.length ? `AND ${where.join(" AND ")}` : ""}
        ORDER BY p.name COLLATE NOCASE ASC
        `,
        params,
      ).map((person) => ({
        ...person,
        feedIds: splitGroupConcat(person.feedIds),
      }));
    }

    const params: unknown[] = cleanQuery ? [normalizedQuery, normalizedQuery, normalizedQuery] : [];
    return this.all<Person & { feedIds: string }>(
      `
      SELECT p.id, p.name, p.profile_url AS profileUrl, p.public_id AS publicId, p.headline,
        p.comment_count AS commentCount, p.like_count AS likeCount,
        p.back_comment_count AS backCommentCount, p.created_at AS createdAt, p.updated_at AS updatedAt,
        ${orderedPersonFeedIdsSql("p.id")} AS feedIds
      FROM people p
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY p.name COLLATE NOCASE ASC
      `,
      params,
    ).map((person) => ({
      ...person,
      feedIds: splitGroupConcat(person.feedIds),
    }));
  }

  listFeedMembers(feedId: string): FeedMember[] {
    this.assertFeedExists(feedId);
    return this.all<FeedMember>(
      `
      SELECT p.id, p.name, p.profile_url AS profileUrl
      FROM feed_people scope INDEXED BY idx_feed_people_feed
      JOIN people p ON p.id = scope.person_id
      WHERE scope.feed_id = ?
      ORDER BY p.name COLLATE NOCASE ASC
      `,
      [feedId],
    );
  }

  getPerson(id: string): Person {
    const person = this.personByWhere("p.id = ?", [id]);
    if (!person) {
      throw new AppError("Person not found.", 404);
    }
    return person;
  }

  upsertPerson(input: { name: string; profileUrl: string; headline?: string }, options: { requestId?: string } = {}): Person {
    return this.withTransaction(() => {
      const profileUrl = normalizeLinkedInProfileUrl(input.profileUrl);
      if (!profileUrl || !profileUrl.includes("linkedin.com/in/")) {
        throw new AppError("A valid LinkedIn profile URL is required.", 400);
      }
      const idempotencyKey = personUpsertIdempotencyKey(profileUrl, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<Person>(idempotencyKey, (value): value is Person => {
            if (!isPersonReplay(value)) {
              return false;
            }
            return normalizeLinkedInProfileUrl(value.profileUrl) === profileUrl;
          })
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      const { person, changed } = this.upsertPersonUnsafe({ ...input, profileUrl });
      if (changed) {
        this.markDirty();
      }
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, person);
      }
      return person;
    });
  }

  deletePerson(id: string) {
    this.withTransaction(() => {
      this.getPerson(id);
      this.db.run("DELETE FROM feed_people WHERE person_id = ?", [id]);
      this.db.run("DELETE FROM item_feeds WHERE item_id IN (SELECT id FROM items WHERE person_id = ?)", [id]);
      this.db.run("DELETE FROM items WHERE person_id = ?", [id]);
      this.db.run("DELETE FROM people WHERE id = ?", [id]);
      this.markDirty();
    });
  }

  setPersonFeedMembership(
    personId: string,
    feedIds: string[],
    options: { knownFeedIds?: string[]; requestId?: string } = {},
  ): Person {
    return this.withTransaction(() => {
      const idempotencyKey = personMembershipIdempotencyKey(personId, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<Person>(idempotencyKey, (value) => isPersonReplay(value, { personId }))
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      const existing = this.getPerson(personId);
      const currentFeedIds = this.feedIdsForPerson(personId);
      const mergedFeedIds = mergeKnownFeedMemberships(feedIds, currentFeedIds, options.knownFeedIds);
      const cleanFeedIds = this.validateFeedIds(mergedFeedIds);
      this.assertFeedCapacity(cleanFeedIds, personId);
      if (sameStringSet(currentFeedIds, cleanFeedIds)) {
        if (idempotencyKey) {
          this.setAppState(idempotencyKey, existing);
        }
        return existing;
      }
      const removedFeedIds = currentFeedIds.filter((feedId) => !cleanFeedIds.includes(feedId));
      this.db.run("DELETE FROM feed_people WHERE person_id = ?", [personId]);
      const at = nowIso();
      for (const feedId of cleanFeedIds) {
        this.db.run("INSERT INTO feed_people (feed_id, person_id, created_at) VALUES (?, ?, ?)", [feedId, personId, at]);
      }
      this.unlinkPersonItemsFromFeeds(personId, removedFeedIds);
      this.markDirty();
      const person = this.getPerson(personId);
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, person);
      }
      return person;
    });
  }

  upsertPersonWithMembership(
    input: { name: string; profileUrl: string; headline?: string; feedIds: string[] },
    options: { ignoreMissingFeedIds?: boolean; knownFeedIds?: string[]; requestId?: string } = {},
  ): ProfileStatus {
    return this.withTransaction(() => {
      const profileUrl = normalizeLinkedInProfileUrl(input.profileUrl);
      if (!profileUrl || !profileUrl.includes("linkedin.com/in/")) {
        throw new AppError("A valid LinkedIn profile URL is required.", 400);
      }
      const idempotencyKey = profileMembershipIdempotencyKey(profileUrl, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<ProfileStatus>(idempotencyKey, (value) =>
            isProfileStatusReplay(value, profileUrl, { allowMissingPerson: Boolean(options.ignoreMissingFeedIds) }),
          )
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      const publicId = publicIdFromProfileUrl(profileUrl);
      const existing = this.findPersonByProfileUrl(profileUrl) || (publicId ? this.findPersonByPublicId(publicId) : undefined);
      const currentFeedIds = existing ? this.feedIdsForPerson(existing.id) : [];
      const mergedFeedIds = mergeKnownFeedMemberships(input.feedIds, currentFeedIds, options.knownFeedIds);
      const cleanFeedIds = this.validateFeedIds(mergedFeedIds, options);
      if (options.ignoreMissingFeedIds && cleanFeedIds.length === 0 && input.feedIds.length > 0) {
        const status = this.getProfileStatus(profileUrl);
        if (idempotencyKey) {
          this.setAppState(idempotencyKey, status);
        }
        return status;
      }
      const { person, changed: personChanged } = this.upsertPersonUnsafe({ ...input, profileUrl });
      this.assertFeedCapacity(cleanFeedIds, person.id);
      const savedCurrentFeedIds = existing?.id === person.id ? currentFeedIds : this.feedIdsForPerson(person.id);
      const membershipChanged = !sameStringSet(savedCurrentFeedIds, cleanFeedIds);
      if (membershipChanged) {
        const removedFeedIds = savedCurrentFeedIds.filter((feedId) => !cleanFeedIds.includes(feedId));
        this.db.run("DELETE FROM feed_people WHERE person_id = ?", [person.id]);
        const at = nowIso();
        for (const feedId of cleanFeedIds) {
          this.db.run("INSERT INTO feed_people (feed_id, person_id, created_at) VALUES (?, ?, ?)", [feedId, person.id, at]);
        }
        this.unlinkPersonItemsFromFeeds(person.id, removedFeedIds);
      }
      if (personChanged || membershipChanged) {
        this.markDirty();
      }
      const status = this.getProfileStatus(person.profileUrl);
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, status);
      }
      return status;
    });
  }

  addPersonToFeed(
    feedId: string,
    input: { name: string; profileUrl: string; headline?: string },
    options: { requestId?: string } = {},
  ): Person {
    return this.withTransaction(() => {
      const idempotencyKey = addPersonToFeedIdempotencyKey(feedId, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<Person>(idempotencyKey, (value) => isPersonReplay(value, { feedId }))
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      this.assertFeedExists(feedId);
      const profileUrl = normalizeLinkedInProfileUrl(input.profileUrl);
      if (!profileUrl || !profileUrl.includes("linkedin.com/in/")) {
        throw new AppError("A valid LinkedIn profile URL is required.", 400);
      }
      const publicId = publicIdFromProfileUrl(profileUrl);
      const existing = this.findPersonByProfileUrl(profileUrl) || (publicId ? this.findPersonByPublicId(publicId) : undefined);
      this.assertFeedCapacity([feedId], existing?.id ?? "");
      const { person, changed: personChanged } = this.upsertPersonUnsafe({ ...input, profileUrl });
      this.db.run("INSERT OR IGNORE INTO feed_people (feed_id, person_id, created_at) VALUES (?, ?, ?)", [
        feedId,
        person.id,
        nowIso(),
      ]);
      const membershipInserted = this.db.getRowsModified() > 0;
      if (personChanged || membershipInserted) {
        this.markDirty();
      }
      const savedPerson = this.getPerson(person.id);
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, savedPerson);
      }
      return savedPerson;
    });
  }

  bulkAddPeopleToFeed(feedId: string, people: BulkPersonInput[], options: { requestId?: string } = {}): BulkPeopleResult {
    return this.withTransaction(() => {
      const idempotencyKey = bulkPeopleIdempotencyKey(feedId, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<BulkPeopleResult>(idempotencyKey, isBulkPeopleResultReplay)
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      if (!Array.isArray(people)) {
        throw new AppError("People must be an array.", 400);
      }
      if (people.length > MAX_BULK_PEOPLE_PER_REQUEST) {
        throw new AppError(`Bulk people requests are limited to ${MAX_BULK_PEOPLE_PER_REQUEST} profiles.`, 400);
      }
      const feed = this.getFeed(feedId);

      const result: BulkPeopleResult = {
        received: people.length,
        added: 0,
        alreadyInFeed: 0,
        updated: 0,
        skippedInvalid: 0,
        skippedCapacity: 0,
        remainingCapacity: this.remainingFeedCapacity(feed.id),
        errors: [],
      };
      const seenPublicIds = new Set<string>();
      const feedMemberIds = this.personIdsInFeed(feed.id);
      const peopleToProcess: NormalizedBulkPersonInput[] = [];

      for (const [index, raw] of people.entries()) {
        const profileUrl = normalizeLinkedInProfileUrl(raw?.profileUrl || "");
        if (!profileUrl || !profileUrl.includes("linkedin.com/in/")) {
          result.skippedInvalid += 1;
          appendBulkPeopleError(result, {
            index,
            profileUrl: raw?.profileUrl || "",
            error: "Valid LinkedIn profile URL required.",
          });
          continue;
        }
        const publicId = publicIdFromProfileUrl(profileUrl);
        const duplicateKey = publicId.toLowerCase();
        if (seenPublicIds.has(duplicateKey)) {
          result.skippedInvalid += 1;
          appendBulkPeopleError(result, { index, profileUrl, error: "Duplicate profile in this import." });
          continue;
        }
        seenPublicIds.add(duplicateKey);
        peopleToProcess.push({
          index,
          name: raw.name,
          profileUrl,
          publicId,
          duplicateKey,
        });
      }

      const existingPeopleByProfileUrl = this.peopleByProfileUrls(peopleToProcess.map((person) => person.profileUrl));
      const peopleNeedingPublicIdFallback = peopleToProcess.filter(
        (person) => !existingPeopleByProfileUrl.has(person.profileUrl),
      );
      const existingPeopleByPublicId =
        peopleNeedingPublicIdFallback.length > 0
          ? this.peopleByPublicIds(peopleNeedingPublicIdFallback.map((person) => person.publicId))
          : new Map<string, Person>();

      for (const raw of peopleToProcess) {
        const existing =
          existingPeopleByProfileUrl.get(raw.profileUrl) ||
          existingPeopleByPublicId.get(raw.duplicateKey);
        if (existing && feedMemberIds.has(existing.id)) {
          const nextName = normalizePersonName(raw.name || existing.name, raw.publicId);
          const existingPersonChanged =
            existing.name !== nextName || existing.profileUrl !== raw.profileUrl || existing.publicId !== raw.publicId;
          if (existingPersonChanged) {
            try {
              const { person: updatedPerson, changed: personChanged } = this.upsertPersonUnsafe({
                name: raw.name || existing.name,
                profileUrl: raw.profileUrl,
              });
              existingPeopleByPublicId.set(raw.duplicateKey, updatedPerson);
              existingPeopleByProfileUrl.set(updatedPerson.profileUrl, updatedPerson);
              if (personChanged) {
                this.markDirty();
                result.updated += 1;
              }
            } catch {
              // The existing membership remains useful even if a display-name refresh fails.
            }
          }
          result.alreadyInFeed += 1;
          continue;
        }

        if (result.remainingCapacity <= 0) {
          result.skippedCapacity += 1;
          appendBulkPeopleError(result, {
            index: raw.index,
            profileUrl: raw.profileUrl,
            error: `"${feed.name}" is full. Remove someone before adding more people.`,
          });
          continue;
        }

        let person: Person;
        let personChanged = false;
        try {
          const upserted = this.upsertPersonUnsafe({
            name: raw.name || raw.publicId,
            profileUrl: raw.profileUrl,
          });
          person = upserted.person;
          personChanged = upserted.changed;
          existingPeopleByPublicId.set(raw.duplicateKey, person);
          existingPeopleByProfileUrl.set(person.profileUrl, person);
        } catch (error) {
          result.skippedInvalid += 1;
          appendBulkPeopleError(result, {
            index: raw.index,
            profileUrl: raw.profileUrl,
            error: error instanceof Error ? error.message : "Could not save person.",
          });
          continue;
        }

        this.db.run("INSERT OR IGNORE INTO feed_people (feed_id, person_id, created_at) VALUES (?, ?, ?)", [
          feed.id,
          person.id,
          nowIso(),
        ]);
        const membershipInserted = this.db.getRowsModified() > 0;
        if (membershipInserted) {
          feedMemberIds.add(person.id);
          result.added += 1;
          result.remainingCapacity -= 1;
        } else {
          result.alreadyInFeed += 1;
        }
        if (personChanged || membershipInserted) {
          this.markDirty();
        }
      }

      if (idempotencyKey) {
        this.setAppState(idempotencyKey, result);
      }
      return result;
    });
  }

  getProfileStatus(profileUrl: string): ProfileStatus {
    const normalized = normalizeLinkedInProfileUrl(profileUrl);
    const publicId = publicIdFromProfileUrl(normalized);
    const person = this.findPersonByProfileUrl(normalized) || (publicId ? this.findPersonByPublicId(publicId) : undefined);
    return {
      person,
      feedIds: person ? person.feedIds : [],
    };
  }

  getProfileStatuses(profileUrls: string[]): Record<string, ProfileStatus> {
    if (!Array.isArray(profileUrls)) {
      throw new AppError("Profile urls must be an array.", 400);
    }
    const normalizedProfileUrls = [
      ...new Set(profileUrls.map((profileUrl) => normalizeLinkedInProfileUrl(profileUrl)).filter(Boolean)),
    ];
    if (normalizedProfileUrls.length > MAX_PROFILE_STATUS_BATCH_SIZE) {
      throw new AppError(`Profile status batches are limited to ${MAX_PROFILE_STATUS_BATCH_SIZE} urls.`, 400);
    }
    const statuses: Record<string, ProfileStatus> = {};
    for (const profileUrl of normalizedProfileUrls) {
      statuses[profileUrl] = { feedIds: [] };
    }
    if (normalizedProfileUrls.length === 0) {
      return statuses;
    }

    const peopleByProfileUrl = this.peopleByProfileUrls(normalizedProfileUrls);
    const profileUrlsNeedingPublicIdFallback = normalizedProfileUrls.filter((profileUrl) => !peopleByProfileUrl.has(profileUrl));
    const peopleByPublicId =
      profileUrlsNeedingPublicIdFallback.length > 0
        ? this.peopleByPublicIds(profileUrlsNeedingPublicIdFallback.map(publicIdFromProfileUrl).filter(Boolean))
        : new Map<string, Person>();
    for (const profileUrl of normalizedProfileUrls) {
      const publicId = publicIdFromProfileUrl(profileUrl);
      const person = peopleByProfileUrl.get(profileUrl) || (publicId ? peopleByPublicId.get(publicId.toLowerCase()) : undefined);
      statuses[profileUrl] = {
        person,
        feedIds: person ? person.feedIds : [],
      };
    }
    return statuses;
  }

  updateCounters(
    personId: string,
    patch: Partial<Pick<Person, "commentCount" | "likeCount" | "backCommentCount">>,
    options: { requestId?: string } = {},
  ): Person {
    return this.withTransaction(() => {
      const idempotencyKey = counterUpdateIdempotencyKey(personId, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<Person>(idempotencyKey, (value) => isPersonReplay(value, { personId }))
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      const existing = this.getPerson(personId);
      const commentCount = normalizeCounter(patch.commentCount ?? existing.commentCount);
      const likeCount = normalizeCounter(patch.likeCount ?? existing.likeCount);
      const backCommentCount = normalizeCounter(patch.backCommentCount ?? existing.backCommentCount);
      if (
        commentCount === existing.commentCount &&
        likeCount === existing.likeCount &&
        backCommentCount === existing.backCommentCount
      ) {
        if (idempotencyKey) {
          this.setAppState(idempotencyKey, existing);
        }
        return existing;
      }
      this.db.run(
        "UPDATE people SET comment_count = ?, like_count = ?, back_comment_count = ?, updated_at = ? WHERE id = ?",
        [commentCount, likeCount, backCommentCount, nowIso(), personId],
      );
      this.markDirty();
      const person = this.getPerson(personId);
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, person);
      }
      return person;
    });
  }

  adjustCounters(
    personId: string,
    delta: Partial<Pick<Person, "commentCount" | "likeCount" | "backCommentCount">>,
    options: { requestId?: string } = {},
  ): Person {
    return this.withTransaction(() => {
      const idempotencyKey = counterAdjustmentIdempotencyKey(personId, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<Person>(idempotencyKey, (value) => isPersonReplay(value, { personId }))
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      const existing = this.getPerson(personId);
      const commentCount = normalizeCounter(existing.commentCount + normalizeCounterDelta(delta.commentCount ?? 0));
      const likeCount = normalizeCounter(existing.likeCount + normalizeCounterDelta(delta.likeCount ?? 0));
      const backCommentCount = normalizeCounter(
        existing.backCommentCount + normalizeCounterDelta(delta.backCommentCount ?? 0),
      );
      if (
        commentCount === existing.commentCount &&
        likeCount === existing.likeCount &&
        backCommentCount === existing.backCommentCount
      ) {
        if (idempotencyKey) {
          this.setAppState(idempotencyKey, existing);
        }
        return existing;
      }
      this.db.run(
        "UPDATE people SET comment_count = ?, like_count = ?, back_comment_count = ?, updated_at = ? WHERE id = ?",
        [commentCount, likeCount, backCommentCount, nowIso(), personId],
      );
      this.markDirty();
      const person = this.getPerson(personId);
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, person);
      }
      return person;
    });
  }

  listQueue(feedId?: string, status: QueueStatusFilter = "new", options: QueueReadOptions = {}): QueueItem[] {
    const limit = normalizeQueueLimit(options.limit);
    const after = normalizeQueueCursor(options.after);
    const offset = after ? 0 : normalizeQueueOffset(options.offset);
    const afterSql = after
      ? "(i.activity_at < ? OR (i.activity_at = ? AND i.discovered_at < ?) OR (i.activity_at = ? AND i.discovered_at = ? AND i.id > ?))"
      : "";
    const statusSql = queueStatusSql(status);
    const pageParams: unknown[] = [];
    const pushAfterParams = () => {
      if (!after) {
        return;
      }
      pageParams.push(after.activityAt, after.activityAt, after.discoveredAt, after.activityAt, after.discoveredAt, after.id);
    };
    const pageSql = feedId
      ? (() => {
          if (!options.skipFeedValidation) {
            this.assertFeedExists(feedId);
          }
          pageParams.push(feedId);
          if (statusSql) {
            pageParams.push(status);
          }
          pushAfterParams();
          const itemIndex = statusSql ? "idx_items_status_activity_discovered" : "idx_items_activity_discovered";
          return `
            SELECT i.id, i.activity_at, i.discovered_at
            FROM items i INDEXED BY ${itemIndex}
            JOIN item_feeds scope ON scope.item_id = i.id AND scope.feed_id = ?
            WHERE 1 = 1 ${statusSql ? `AND ${statusSql}` : ""} ${afterSql ? `AND ${afterSql}` : ""}
            ORDER BY i.activity_at DESC, i.discovered_at DESC, i.id ASC
            LIMIT ? OFFSET ?
          `;
        })()
      : (() => {
          if (statusSql) {
            pageParams.push(status);
          }
          pushAfterParams();
          const whereSql = [statusSql, afterSql].filter(Boolean).join(" AND ");
          const itemIndex = statusSql ? "idx_items_status_activity_discovered" : "idx_items_activity_discovered";
          return `
            SELECT i.id, i.activity_at, i.discovered_at
            FROM items i INDEXED BY ${itemIndex}
            ${whereSql ? `WHERE ${whereSql}` : ""}
            ORDER BY i.activity_at DESC, i.discovered_at DESC, i.id ASC
            LIMIT ? OFFSET ?
          `;
        })();

    return this.all<QueueItem & { feedIds: string; feedNames: string }>(
      `
      WITH page AS (
        ${pageSql}
      ),
      feed_tags AS (
        SELECT item_id, GROUP_CONCAT(feed_id) AS feedIds, GROUP_CONCAT(feed_name_hex) AS feedNames
        FROM (
          SELECT scoped_feed.item_id, scoped_feed.feed_id, hex(scoped_name.name) AS feed_name_hex
          FROM item_feeds scoped_feed
          JOIN page ON page.id = scoped_feed.item_id
          JOIN feeds scoped_name ON scoped_name.id = scoped_feed.feed_id
          ORDER BY scoped_feed.item_id ASC, scoped_name.name COLLATE NOCASE ASC, scoped_feed.feed_id ASC
        )
        GROUP BY item_id
      )
      SELECT i.id, i.person_id AS personId, p.name AS personName, p.profile_url AS profileUrl, i.type,
        i.source_url AS sourceUrl, i.external_id AS externalId, i.text,
        i.activity_at AS activityAt, i.discovered_at AS discoveredAt, i.status,
        feed_tags.feedIds, feed_tags.feedNames
      FROM page
      JOIN items i ON i.id = page.id
      JOIN people p ON p.id = i.person_id
      LEFT JOIN feed_tags ON feed_tags.item_id = i.id
      ORDER BY page.activity_at DESC, page.discovered_at DESC, page.id ASC
      `,
      [...pageParams, limit, offset],
    ).map((item) => ({
      ...item,
      feedIds: splitGroupConcat(item.feedIds),
      feedNames: splitHexGroupConcat(item.feedNames),
    }));
  }

  getQueueView(feedId?: string, status: QueueStatusFilter = "new", options: QueueListOptions = {}): QueueView {
    if (feedId) {
      this.assertFeedExists(feedId);
    }
    return {
      items: this.listQueue(feedId, status, { ...options, skipFeedValidation: Boolean(feedId) }),
      counts: this.getQueueCounts(feedId, { skipFeedValidation: Boolean(feedId) }),
    };
  }

  getQueueCounts(feedId?: string, options: { skipFeedValidation?: boolean } = {}): QueueCounts {
    const rows = this.all<{ status: "new" | "done" | "skipped"; count: number }>(
      feedId
        ? (() => {
            if (!options.skipFeedValidation) {
              this.assertFeedExists(feedId);
            }
            return `
              SELECT i.status, COUNT(*) AS count
              FROM item_feeds scope INDEXED BY idx_item_feeds_feed_item
              CROSS JOIN items i
              WHERE scope.feed_id = ? AND i.id = scope.item_id
              GROUP BY i.status
            `;
          })()
        : `
          SELECT i.status, COUNT(*) AS count
          FROM items i INDEXED BY idx_items_status_activity
          GROUP BY i.status
        `,
      feedId ? [feedId] : [],
    );
    const counts: QueueCounts = { new: 0, done: 0, skipped: 0, all: 0 };
    for (const row of rows) {
      counts[row.status] = Number(row.count || 0);
      counts.all += Number(row.count || 0);
    }
    return counts;
  }

  setItemStatus(
    itemId: string,
    status: "new" | "done" | "skipped",
    options: { feedId?: string; requestId?: string } = {},
  ): QueueStatusChange {
    return this.withTransaction(() => {
      if (status !== "new" && status !== "done" && status !== "skipped") {
        throw new AppError("Unsupported queue item status.", 400);
      }
      const idempotencyKey = queueStatusIdempotencyKey(itemId, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<QueueStatusChange>(idempotencyKey, (value) =>
            isQueueStatusChangeReplay(value, itemId),
          )
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      const item = this.one<{
        personId: string;
        status: "new" | "done" | "skipped";
        commentCount: number;
        commentCountApplied: number;
      }>(
        `
        SELECT i.person_id AS personId, i.status, i.comment_count_applied AS commentCountApplied,
          p.comment_count AS commentCount
        FROM items i
        JOIN people p ON p.id = i.person_id
        WHERE i.id = ?
        `,
        [itemId],
      );
      if (!item) {
        throw new AppError("Queue item not found.", 404);
      }
      if (options.feedId) {
        this.assertFeedExists(options.feedId);
        const inFeed = this.one<{ found: number }>(
          "SELECT 1 AS found FROM item_feeds WHERE item_id = ? AND feed_id = ? LIMIT 1",
          [itemId, options.feedId],
        )?.found;
        if (!inFeed) {
          throw new AppError("Queue item is no longer in this feed. Refresh the queue and try again.", 409);
        }
      }

      if (item.status === status) {
        const change = {
          itemId,
          personId: item.personId,
          previousStatus: item.status,
          status,
          changed: false,
          commentCountDelta: 0,
        };
        if (idempotencyKey) {
          this.setAppState(idempotencyKey, change);
        }
        return change;
      }

      let commentCountApplied = Number(item.commentCountApplied || 0) ? 1 : 0;
      let commentCountDelta = 0;
      if (status === "done" && item.status !== "done") {
        if (item.commentCount < MAX_COUNTER_VALUE) {
          commentCountDelta = 1;
          commentCountApplied = 1;
        } else {
          commentCountApplied = 0;
        }
      } else if (item.status === "done" && status !== "done") {
        commentCountDelta = commentCountApplied && item.commentCount > 0 ? -1 : 0;
        commentCountApplied = 0;
      }
      const at = nowIso();
      this.db.run("UPDATE items SET status = ?, comment_count_applied = ?, updated_at = ? WHERE id = ?", [
        status,
        commentCountApplied,
        at,
        itemId,
      ]);
      if (commentCountDelta !== 0) {
        this.db.run("UPDATE people SET comment_count = comment_count + ?, updated_at = ? WHERE id = ?", [
          commentCountDelta,
          at,
          item.personId,
        ]);
      }
      this.markDirty();
      const change = {
        itemId,
        personId: item.personId,
        previousStatus: item.status,
        status,
        changed: true,
        commentCountDelta,
      };
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, change);
      }
      return change;
    });
  }

  captureItems(feedId: string, items: CapturedItem[], options: { requestId?: string } = {}): CaptureResult {
    return this.withTransaction(() => {
      const idempotencyKey = captureItemsIdempotencyKey(feedId, options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<CaptureResult>(idempotencyKey, (value) =>
            isCaptureResultReplay(value, { maxProcessedItems: MAX_CAPTURE_ITEMS_PER_REQUEST }),
          )
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      if (!Array.isArray(items)) {
        throw new AppError("Captured items must be an array.", 400);
      }
      const feed = this.getFeed(feedId);
      const capturedAt = nowIso();
      const capturedAtTimestamp = new Date(capturedAt).getTime();
      const cutoff = capturedAtTimestamp - feed.lookbackDays * 24 * 60 * 60 * 1000;
      const feedMemberIndex = this.feedMemberIndex(feedId);
      const result: CaptureResult = {
        received: items.length,
        inserted: 0,
        updated: 0,
        skippedOlder: 0,
        skippedUntracked: 0,
        skippedInvalid: 0,
      };

      const itemsToProcess = items.slice(0, MAX_CAPTURE_ITEMS_PER_REQUEST);
      const skippedOverflow = items.length - itemsToProcess.length;
      if (skippedOverflow > 0) {
        result.skippedInvalid += skippedOverflow;
      }
      const updatedPersonSnapshots = new Set<string>();
      const normalizedItems: NormalizedCapturedItem[] = [];
      const batchItemsByExternalId = new Map<string, NormalizedCapturedItem>();

      for (const rawItem of itemsToProcess) {
        if (!isRecord(rawItem)) {
          result.skippedInvalid += 1;
          continue;
        }
        const raw = rawItem as Partial<CapturedItem>;
        const normalizedProfileUrl = normalizeLinkedInProfileUrl(raw.profileUrl || raw.ownerProfileUrl || "");
        const normalizedOwnerProfileUrl = normalizeLinkedInProfileUrl(raw.ownerProfileUrl || "");
        const member = this.feedMemberForCapturedProfile(feedMemberIndex, normalizedProfileUrl, normalizedOwnerProfileUrl);

        if (!member) {
          result.skippedUntracked += 1;
          continue;
        }

        const type = raw.type === "comment" || raw.type === "post" ? raw.type : undefined;
        const activityAt = normalizeActivityDate(raw.activityAt, capturedAt);
        const text = normalizeCapturedText(raw.text || "");
        const sourceUrl = normalizeLinkedInSourceUrl(raw.sourceUrl || "");
        if (!type || !sourceUrl || !activityAt) {
          result.skippedInvalid += 1;
          continue;
        }

        const candidate: NormalizedCapturedItem = {
          member,
          type,
          sourceUrl,
          externalId: stableExternalId(raw.externalId, {
            personProfileUrl: member.profileUrl,
            sourceUrl,
            type,
            activityAt,
            text,
          }),
          text,
          activityAt,
          capturedAt,
          personName: raw.personName || "",
        };
        const duplicate = batchItemsByExternalId.get(candidate.externalId);
        if (duplicate) {
          mergeBatchCapturedItem(duplicate, candidate);
          continue;
        }

        batchItemsByExternalId.set(candidate.externalId, candidate);
        normalizedItems.push(candidate);
      }

      const existingItemsByExternalId = this.existingCapturedItemsByExternalId(
        normalizedItems.map((item) => item.externalId),
      );

      for (const item of normalizedItems) {
        const { member, type, sourceUrl, externalId, text, activityAt } = item;
        const existing =
          existingItemsByExternalId.get(externalId) ||
          (type === "comment"
            ? this.findExpandableCommentDuplicate({
                personId: member.id,
                sourceUrl,
                activityAt,
                text,
              })
            : type === "post"
              ? this.findImprovedPostSourceDuplicate({
                  personId: member.id,
                  sourceUrl,
                  activityAt,
                  text,
                })
              : undefined);

        if (new Date(activityAt).getTime() < cutoff) {
          if (existing) {
            const itemRowUpdated = this.updateExistingCapturedItem(existing, {
              text,
              sourceUrl,
              externalId,
              activityAt,
              updatedAt: capturedAt,
            });
            const feedLinkRemoved = this.unlinkItemFromFeed(existing.id, feedId);
            if (itemRowUpdated || feedLinkRemoved) {
              result.updated += 1;
              this.markDirty();
            }
          }
          result.skippedOlder += 1;
          continue;
        }

        let personSnapshotChanged = false;
        if (!updatedPersonSnapshots.has(member.id)) {
          personSnapshotChanged = this.updatePersonSnapshot(member.id, item.personName || "", member.profileUrl);
          updatedPersonSnapshots.add(member.id);
        }

        if (existing) {
          this.db.run("INSERT OR IGNORE INTO item_feeds (item_id, feed_id, created_at) VALUES (?, ?, ?)", [
            existing.id,
            feedId,
            capturedAt,
          ]);
          const feedLinkInserted = this.db.getRowsModified() > 0;
          const itemRowUpdated = this.updateExistingCapturedItem(existing, {
            text,
            sourceUrl,
            externalId,
            activityAt,
            updatedAt: capturedAt,
          });
          if (feedLinkInserted || itemRowUpdated) {
            result.updated += 1;
          }
          if (personSnapshotChanged || feedLinkInserted || itemRowUpdated) {
            this.markDirty();
          }
          continue;
        }

        const itemId = createId("item");
        const at = capturedAt;
        this.db.run(
          `INSERT INTO items
            (id, person_id, type, source_url, external_id, text, activity_at, discovered_at, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
          [itemId, member.id, type, sourceUrl, externalId, text, activityAt, at, at, at],
        );
        this.db.run("INSERT INTO item_feeds (item_id, feed_id, created_at) VALUES (?, ?, ?)", [itemId, feedId, at]);
        result.inserted += 1;
        this.markDirty();
      }

      if (idempotencyKey) {
        this.setAppState(idempotencyKey, result);
      }
      return result;
    });
  }

  captureItemsForFeeds(feedIds: string[], items: CapturedItem[], options: { requestId?: string } = {}): CaptureResult {
    return this.withTransaction(() => {
      const idempotencyKey = captureItemsForFeedsIdempotencyKey(options.requestId);
      const previousResult = idempotencyKey
        ? this.getValidIdempotencyState<CaptureResult>(idempotencyKey, isCaptureResultReplay)
        : undefined;
      if (previousResult) {
        return previousResult;
      }
      if (!Array.isArray(feedIds)) {
        throw new AppError("Feed ids must be an array.", 400);
      }
      const cleanFeedIds = [...new Set(feedIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
      if (cleanFeedIds.length === 0) {
        throw new AppError("At least one feed is required for capture.", 400);
      }
      if (cleanFeedIds.length > MAX_CAPTURE_FEEDS_PER_REQUEST) {
        throw new AppError(`Capture feed batches are limited to ${MAX_CAPTURE_FEEDS_PER_REQUEST} feeds.`, 400);
      }
      if (!Array.isArray(items)) {
        throw new AppError("Captured items must be an array.", 400);
      }

      const existingFeedIds = this.existingCaptureFeedIds(cleanFeedIds);
      if (existingFeedIds.length === 0) {
        throw new AppError("Feed not found.", 404);
      }

      const results: CaptureResult[] = [];
      for (const feedId of existingFeedIds) {
        results.push(this.captureItems(feedId, items));
      }
      const result = aggregateCaptureResults(results);
      if (idempotencyKey) {
        this.setAppState(idempotencyKey, result);
      }
      return result;
    });
  }

  private upsertPersonUnsafe(input: { name: string; profileUrl: string; headline?: string }): PersonUpsertResult {
    const profileUrl = normalizeLinkedInProfileUrl(input.profileUrl);
    if (!profileUrl || !profileUrl.includes("linkedin.com/in/")) {
      throw new AppError("A valid LinkedIn profile URL is required.", 400);
    }

    const publicId = publicIdFromProfileUrl(profileUrl);
    const name = normalizePersonName(input.name, publicId);
    const at = nowIso();
    const existing = this.findPersonByProfileUrl(profileUrl) || (publicId ? this.findPersonByPublicId(publicId) : undefined);

    if (existing) {
      const nextName = shouldPreserveExistingPersonName(existing.name, input.name, name, publicId) ? existing.name : name;
      const nextHeadline = input.headline?.trim() || existing.headline;
      if (
        existing.name === nextName &&
        existing.profileUrl === profileUrl &&
        existing.publicId === publicId &&
        existing.headline === nextHeadline
      ) {
        return { person: existing, changed: false };
      }
      this.db.run(
        "UPDATE people SET name = ?, profile_url = ?, public_id = ?, headline = ?, updated_at = ? WHERE id = ?",
        [nextName, profileUrl, publicId, nextHeadline, at, existing.id],
      );
      const changed = this.db.getRowsModified() > 0;
      return { person: this.getPerson(existing.id), changed };
    }

    const id = createId("person");
    this.db.run(
      `INSERT INTO people
        (id, name, profile_url, public_id, headline, comment_count, like_count, back_comment_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      [id, name, profileUrl, publicId, input.headline?.trim() ?? "", at, at],
    );
    return { person: this.getPerson(id), changed: true };
  }

  private updatePersonSnapshot(personId: string, nextName: string, profileUrl: string) {
    if (!String(nextName || "").trim()) {
      return false;
    }
    const publicId = publicIdFromProfileUrl(profileUrl);
    const cleanName = normalizePersonName(nextName, publicId);
    const existing = this.one<{ name: string }>("SELECT name FROM people WHERE id = ?", [personId]);
    if (!existing || shouldPreserveExistingPersonName(existing.name, nextName, cleanName, publicId)) {
      return false;
    }
    this.db.run("UPDATE people SET name = ?, updated_at = ? WHERE id = ? AND name != ?", [
      cleanName,
      nowIso(),
      personId,
      cleanName,
    ]);
    return this.db.getRowsModified() > 0;
  }

  private updateExistingCapturedItem(
    existing: ExistingCapturedItem,
    next: { text: string; sourceUrl: string; externalId: string; activityAt: string; updatedAt: string },
  ) {
    const nextText = shouldImproveCapturedText(existing.text, next.text) ? next.text : existing.text;
    const nextActivityAt = shouldImproveCapturedActivityAt(existing, next.activityAt) ? next.activityAt : existing.activityAt;
    const nextSourceUrl = shouldImproveCapturedSourceUrl(existing.sourceUrl, next.sourceUrl) ? next.sourceUrl : existing.sourceUrl;
    const nextExternalId = nextSourceUrl === next.sourceUrl ? next.externalId : existing.externalId;
    if (
      nextText === existing.text &&
      nextActivityAt === existing.activityAt &&
      nextSourceUrl === existing.sourceUrl &&
      nextExternalId === existing.externalId
    ) {
      return false;
    }

    this.db.run(
      "UPDATE items SET text = ?, source_url = ?, external_id = ?, activity_at = ?, updated_at = ? WHERE id = ?",
      [nextText, nextSourceUrl, nextExternalId, nextActivityAt, next.updatedAt, existing.id],
    );
    return this.db.getRowsModified() > 0;
  }

  private existingCapturedItemsByExternalId(externalIds: string[]) {
    const items = new Map<string, ExistingCapturedItem>();
    const uniqueExternalIds = [...new Set(externalIds.filter(Boolean))];
    for (const externalIdsChunk of chunkStrings(uniqueExternalIds)) {
      const rows = this.all<ExistingCapturedItem>(
        `
        SELECT id, text, source_url AS sourceUrl, external_id AS externalId, activity_at AS activityAt, discovered_at AS discoveredAt
        FROM items
        WHERE external_id IN (${placeholdersFor(externalIdsChunk)})
        `,
        externalIdsChunk,
      );
      for (const row of rows) {
        items.set(row.externalId, row);
      }
    }
    return items;
  }

  private unlinkItemFromFeed(itemId: string, feedId: string) {
    this.db.run("DELETE FROM item_feeds WHERE item_id = ? AND feed_id = ?", [itemId, feedId]);
    const removed = this.db.getRowsModified() > 0;
    if (removed) {
      this.db.run(
        `
        DELETE FROM items
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM item_feeds WHERE item_feeds.item_id = items.id)
        `,
        [itemId],
      );
    }
    return removed;
  }

  private findExpandableCommentDuplicate({
    personId,
    sourceUrl,
    activityAt,
    text,
  }: {
    personId: string;
    sourceUrl: string;
    activityAt: string;
    text: string;
  }) {
    const candidates = this.all<ExistingCapturedItem>(
      `
      SELECT id, text, source_url AS sourceUrl, external_id AS externalId, activity_at AS activityAt, discovered_at AS discoveredAt
      FROM items
      WHERE person_id = ?
        AND type = 'comment'
        AND source_url = ?
        AND activity_at >= ?
        AND activity_at < ?
      ORDER BY length(text) DESC, discovered_at DESC
      LIMIT 20
      `,
      [personId, sourceUrl, activityDayStartIso(activityAt), activityNextDayStartIso(activityAt)],
    );
    return candidates.find((candidate) => commentTextsLookLikeSameCapture(candidate.text, text));
  }

  private findImprovedPostSourceDuplicate({
    personId,
    sourceUrl,
    activityAt,
    text,
  }: {
    personId: string;
    sourceUrl: string;
    activityAt: string;
    text: string;
  }) {
    if (!isStableLinkedInItemSource(sourceUrl)) {
      return undefined;
    }
    const candidates = this.all<ExistingCapturedItem>(
      `
      SELECT id, text, source_url AS sourceUrl, external_id AS externalId, activity_at AS activityAt, discovered_at AS discoveredAt
      FROM items
      WHERE person_id = ?
        AND type = 'post'
        AND activity_at >= ?
        AND activity_at < ?
      ORDER BY discovered_at DESC
      LIMIT 20
      `,
      [personId, activityDayStartIso(activityAt), activityNextDayStartIso(activityAt)],
    );
    return candidates.find(
      (candidate) =>
        !isStableLinkedInItemSource(candidate.sourceUrl) &&
        shouldImproveCapturedSourceUrl(candidate.sourceUrl, sourceUrl) &&
        postTextsLookLikeSameCapture(candidate.text, text),
    );
  }

  private findPersonByProfileUrl(profileUrl: string): Person | undefined {
    return this.personByWhere("p.profile_url = ?", [profileUrl]);
  }

  private findPersonByPublicId(publicId: string): Person | undefined {
    return this.personByWhere("p.public_id = ? COLLATE NOCASE", [publicId]);
  }

  private peopleByPublicIds(publicIds: string[]): Map<string, Person> {
    const uniquePublicIds = [...new Set(publicIds.map((publicId) => publicId.toLowerCase()).filter(Boolean))];
    const people = new Map<string, Person>();
    for (let index = 0; index < uniquePublicIds.length; index += 400) {
      const chunk = uniquePublicIds.slice(index, index + 400);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.all<Omit<Person, "feedIds">>(
        `
        SELECT p.id, p.name, p.profile_url AS profileUrl, p.public_id AS publicId, p.headline,
          p.comment_count AS commentCount, p.like_count AS likeCount,
          p.back_comment_count AS backCommentCount, p.created_at AS createdAt, p.updated_at AS updatedAt
        FROM people p
        WHERE p.public_id COLLATE NOCASE IN (${placeholders})
        `,
        chunk,
      );
      const feedIdsByPersonId = this.feedIdsByPersonIds(rows.map((row) => row.id));
      for (const row of rows) {
        const person = { ...row, feedIds: feedIdsByPersonId.get(row.id) ?? [] };
        const key = person.publicId.toLowerCase();
        if (!people.has(key)) {
          people.set(key, person);
        }
      }
    }
    return people;
  }

  private peopleByProfileUrls(profileUrls: string[]): Map<string, Person> {
    const uniqueProfileUrls = [...new Set(profileUrls.map((profileUrl) => normalizeLinkedInProfileUrl(profileUrl)).filter(Boolean))];
    const people = new Map<string, Person>();
    for (let index = 0; index < uniqueProfileUrls.length; index += 400) {
      const chunk = uniqueProfileUrls.slice(index, index + 400);
      const rows = this.all<Omit<Person, "feedIds">>(
        `
        SELECT p.id, p.name, p.profile_url AS profileUrl, p.public_id AS publicId, p.headline,
          p.comment_count AS commentCount, p.like_count AS likeCount,
          p.back_comment_count AS backCommentCount, p.created_at AS createdAt, p.updated_at AS updatedAt
        FROM people p
        WHERE p.profile_url IN (${placeholdersFor(chunk)})
        `,
        chunk,
      );
      const feedIdsByPersonId = this.feedIdsByPersonIds(rows.map((row) => row.id));
      for (const row of rows) {
        const person = { ...row, feedIds: feedIdsByPersonId.get(row.id) ?? [] };
        people.set(person.profileUrl, person);
      }
    }
    return people;
  }

  private feedIdsByPersonIds(personIds: string[]) {
    const feedIdsByPersonId = new Map<string, string[]>();
    const uniquePersonIds = [...new Set(personIds.filter(Boolean))];
    for (const personIdsChunk of chunkStrings(uniquePersonIds)) {
      const rows = this.all<{ personId: string; feedId: string }>(
        `
        SELECT fp.person_id AS personId, fp.feed_id AS feedId
        FROM feed_people fp INDEXED BY idx_feed_people_person
        JOIN feeds f ON f.id = fp.feed_id
        WHERE fp.person_id IN (${placeholdersFor(personIdsChunk)})
        ORDER BY f.name COLLATE NOCASE ASC, fp.feed_id ASC
        `,
        personIdsChunk,
      );
      for (const row of rows) {
        const feedIds = feedIdsByPersonId.get(row.personId) ?? [];
        feedIds.push(row.feedId);
        feedIdsByPersonId.set(row.personId, feedIds);
      }
    }
    return feedIdsByPersonId;
  }

  private personByWhere(where: string, params: unknown[]): Person | undefined {
    const row = this.one<Person & { feedIds: string }>(
      `
      SELECT p.id, p.name, p.profile_url AS profileUrl, p.public_id AS publicId, p.headline,
        p.comment_count AS commentCount, p.like_count AS likeCount,
        p.back_comment_count AS backCommentCount, p.created_at AS createdAt, p.updated_at AS updatedAt,
        ${orderedPersonFeedIdsSql("p.id")} AS feedIds
      FROM people p
      WHERE ${where}
      `,
      params,
    );
    return row ? { ...row, feedIds: splitGroupConcat(row.feedIds) } : undefined;
  }

  private feedIdsForPerson(personId: string): string[] {
    return this.all<{ feedId: string }>(
      `
      SELECT fp.feed_id AS feedId
      FROM feed_people fp INDEXED BY idx_feed_people_person
      JOIN feeds f ON f.id = fp.feed_id
      WHERE fp.person_id = ?
      ORDER BY f.name COLLATE NOCASE ASC, fp.feed_id ASC
      `,
      [personId],
    ).map((row) => row.feedId);
  }

  private personIdsInFeed(feedId: string) {
    return new Set(
      this.all<{ personId: string }>(
        "SELECT person_id AS personId FROM feed_people INDEXED BY idx_feed_people_feed WHERE feed_id = ?",
        [feedId],
      ).map((row) => row.personId),
    );
  }

  private unlinkPersonItemsFromFeeds(personId: string, feedIds: string[]) {
    if (feedIds.length === 0) {
      return;
    }
    for (const feedIdsChunk of chunkStrings(feedIds)) {
      this.db.run(
        `
        DELETE FROM item_feeds
        WHERE feed_id IN (${placeholdersFor(feedIdsChunk)})
          AND item_id IN (SELECT id FROM items WHERE person_id = ?)
        `,
        [...feedIdsChunk, personId],
      );
    }
    this.db.run(
      `
      DELETE FROM items
      WHERE person_id = ?
        AND NOT EXISTS (SELECT 1 FROM item_feeds WHERE item_feeds.item_id = items.id)
      `,
      [personId],
    );
  }

  private feedMemberIndex(feedId: string) {
    const rows = this.all<{ id: string; name: string; profileUrl: string }>(
      `
      SELECT p.id, p.name, p.profile_url AS profileUrl
      FROM feed_people scope INDEXED BY idx_feed_people_feed
      JOIN people p ON p.id = scope.person_id
      WHERE scope.feed_id = ?
      `,
      [feedId],
    );
    const byProfileUrl = new Map<string, FeedMember>();
    const byPublicId = new Map<string, FeedMember>();
    for (const row of rows) {
      const profileUrl = normalizeLinkedInProfileUrl(row.profileUrl);
      if (!profileUrl) {
        continue;
      }
      const member = { ...row, profileUrl };
      byProfileUrl.set(profileUrl, member);
      const publicId = publicIdFromProfileUrl(profileUrl).toLowerCase();
      if (publicId && !byPublicId.has(publicId)) {
        byPublicId.set(publicId, member);
      }
    }
    return { byProfileUrl, byPublicId };
  }

  private feedMemberForCapturedProfile(
    index: { byProfileUrl: Map<string, FeedMember>; byPublicId: Map<string, FeedMember> },
    profileUrl: string,
    ownerProfileUrl: string,
  ) {
    const profilePublicId = publicIdFromProfileUrl(profileUrl).toLowerCase();
    const ownerPublicId = publicIdFromProfileUrl(ownerProfileUrl).toLowerCase();
    return (
      index.byProfileUrl.get(profileUrl) ||
      (ownerProfileUrl ? index.byProfileUrl.get(ownerProfileUrl) : undefined) ||
      (profilePublicId ? index.byPublicId.get(profilePublicId) : undefined) ||
      (ownerPublicId ? index.byPublicId.get(ownerPublicId) : undefined)
    );
  }

  isPersonInFeed(personId: string, feedId: string) {
    return Boolean(
      this.one<{ found: number }>(
        "SELECT 1 AS found FROM feed_people WHERE feed_id = ? AND person_id = ? LIMIT 1",
        [feedId, personId],
      )?.found,
    );
  }

  private remainingFeedCapacity(feedId: string) {
    const count =
      this.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM feed_people INDEXED BY idx_feed_people_feed WHERE feed_id = ?",
        [feedId],
      )?.count ?? 0;
    return Math.max(0, MAX_PEOPLE_PER_FEED - count);
  }

  private validateFeedIds(feedIds: string[], options: { ignoreMissingFeedIds?: boolean } = {}): string[] {
    if (!Array.isArray(feedIds)) {
      throw new AppError("Feed memberships must be an array.", 400);
    }
    const cleanFeedIds = [...new Set(feedIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
    if (cleanFeedIds.length === 0) {
      return [];
    }

    const existing = this.existingFeedIdSet(cleanFeedIds);
    const missing = cleanFeedIds.filter((id) => !existing.has(id));
    if (missing.length > 0) {
      if (options.ignoreMissingFeedIds) {
        return cleanFeedIds.filter((id) => existing.has(id));
      }
      throw new AppError("One or more selected feeds no longer exist.", 404);
    }
    return cleanFeedIds;
  }

  private existingFeedIdSet(feedIds: string[]) {
    const existing = new Set<string>();
    for (const feedIdsChunk of chunkStrings(feedIds)) {
      const rows = this.all<{ id: string }>(
        `SELECT id FROM feeds WHERE id IN (${placeholdersFor(feedIdsChunk)})`,
        feedIdsChunk,
      );
      for (const row of rows) {
        existing.add(row.id);
      }
    }
    return existing;
  }

  private existingCaptureFeedIds(feedIds: string[]) {
    const existing = this.existingFeedIdSet(feedIds);
    return feedIds.filter((feedId) => existing.has(feedId));
  }

  private assertFeedCapacity(feedIds: string[], personId: string) {
    for (const feedIdsChunk of chunkStrings(feedIds)) {
      const fullFeed = this.one<{ id: string; name: string; count: number }>(
        `
        SELECT f.id, f.name, COUNT(fp.person_id) AS count
        FROM feeds f
        LEFT JOIN feed_people fp ON fp.feed_id = f.id AND fp.person_id != ?
        WHERE f.id IN (${placeholdersFor(feedIdsChunk)})
        GROUP BY f.id
        HAVING count >= ?
        ORDER BY f.name COLLATE NOCASE ASC
        LIMIT 1
        `,
        [personId, ...feedIdsChunk, MAX_PEOPLE_PER_FEED],
      );
      if (fullFeed) {
        throw new AppError(`"${fullFeed.name}" already has ${MAX_PEOPLE_PER_FEED} people. Remove someone before adding more.`, 409);
      }
    }
  }

  private assertFeedNameAvailable(name: string, exceptFeedId?: string) {
    const duplicate = this.one<{ id: string }>("SELECT id FROM feeds WHERE lower(name) = lower(?)", [name]);
    if (duplicate && duplicate.id !== exceptFeedId) {
      throw new AppError("A feed with that name already exists.", 409);
    }
  }

  private feedByName(name: string): Feed | undefined {
    const feed = this.one<Feed>(
      `
      SELECT f.id, f.name, f.lookback_days AS lookbackDays,
        (
          SELECT COUNT(*) AS count
          FROM feed_people INDEXED BY idx_feed_people_feed
          WHERE feed_id = f.id
        ) AS peopleCount,
        f.created_at AS createdAt, f.updated_at AS updatedAt
      FROM feeds f
      WHERE lower(f.name) = lower(?)
      `,
      [name],
    );
    return feed || undefined;
  }

  private ensureDefaultFeed() {
    const count = this.one<{ count: number }>("SELECT COUNT(*) AS count FROM feeds")?.count ?? 0;
    if (count === 0) {
      this.createFeed("SEO Thought Leaders", 15);
    }
  }

  private migrate() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS feeds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lookback_days INTEGER NOT NULL DEFAULT 15,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        profile_url TEXT NOT NULL UNIQUE,
        public_id TEXT NOT NULL,
        headline TEXT NOT NULL DEFAULT '',
        comment_count INTEGER NOT NULL DEFAULT 0,
        like_count INTEGER NOT NULL DEFAULT 0,
        back_comment_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feed_people (
        feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (feed_id, person_id)
      );

      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('post', 'comment')),
        source_url TEXT NOT NULL,
        external_id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL DEFAULT '',
        activity_at TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done', 'skipped')),
        comment_count_applied INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_feeds (
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (item_id, feed_id)
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_feed_people_feed ON feed_people(feed_id);
      CREATE INDEX IF NOT EXISTS idx_feed_people_person ON feed_people(person_id);
      CREATE INDEX IF NOT EXISTS idx_items_status_activity ON items(status, activity_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_status_activity_discovered ON items(status, activity_at DESC, discovered_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_items_activity_discovered ON items(activity_at DESC, discovered_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_items_person ON items(person_id);
      CREATE INDEX IF NOT EXISTS idx_items_person_type_activity ON items(person_id, type, activity_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_comment_source_day ON items(person_id, type, source_url, activity_at DESC);
      CREATE INDEX IF NOT EXISTS idx_item_feeds_feed ON item_feeds(feed_id);
      CREATE INDEX IF NOT EXISTS idx_item_feeds_feed_item ON item_feeds(feed_id, item_id);
      CREATE INDEX IF NOT EXISTS idx_people_public_id ON people(public_id);
      CREATE INDEX IF NOT EXISTS idx_people_public_id_nocase ON people(public_id COLLATE NOCASE);
    `);
    if (this.ensureColumn("items", "comment_count_applied", "INTEGER NOT NULL DEFAULT 0")) {
      this.db.run("UPDATE items SET comment_count_applied = 1 WHERE status = 'done' AND comment_count_applied = 0");
    }
  }

  private ensureColumn(tableName: string, columnName: string, definition: string) {
    const columns = this.all<{ name: string }>(`PRAGMA table_info(${tableName})`);
    if (columns.some((column) => column.name === columnName)) {
      return false;
    }
    this.db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    return true;
  }

  private all<T>(sql: string, params: unknown[] = []): T[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows: T[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  private one<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  private withTransaction<T>(work: () => T): T {
    const isOuter = this.transactionDepth === 0;
    let committed = false;
    if (isOuter) {
      this.db.run("BEGIN");
    }
    this.transactionDepth += 1;

    try {
      const result = work();
      if (isOuter) {
        this.db.run("COMMIT");
        committed = true;
        if (this.dirty) {
          this.save();
          this.dirty = false;
        }
      }
      return result;
    } catch (error) {
      if (isOuter && !committed) {
        try {
          this.db.run("ROLLBACK");
        } finally {
          this.dirty = false;
        }
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private markDirty() {
    this.dirty = true;
    if (this.transactionDepth === 0) {
      this.save();
      this.dirty = false;
    }
  }

  private pruneIdempotencyState(key: string) {
    const prefix = idempotencyStatePrefixForKey(key);
    if (!prefix) {
      return;
    }
    const count = this.idempotencyPrefixCount(prefix);
    if (count <= MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX) {
      return;
    }
    const prefixPattern = `${escapeSqlLikePattern(prefix)}%`;
    this.db.run(
      `
      DELETE FROM app_state
      WHERE key IN (
        SELECT key
        FROM app_state
        WHERE key LIKE ? ESCAPE '^'
        ORDER BY updated_at DESC, key DESC
        LIMIT -1 OFFSET ?
      )
      `,
      [prefixPattern, MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX],
    );
    const deleted = this.db.getRowsModified();
    if (deleted > 0) {
      this.idempotencyPrefixCounts.set(prefix, Math.max(0, count - deleted));
      this.markDirty();
    }
  }

  getValidIdempotencyState<T>(key: string, isValid: (value: unknown) => value is T): T | undefined {
    const state = this.getIdempotencyState<T>(key);
    if (!state) {
      return undefined;
    }
    if (isValid(state.value)) {
      return state.value;
    }
    this.deleteIdempotencyState(key);
    return undefined;
  }

  private deleteIdempotencyState(key: string) {
    const cleanKey = normalizeStateKey(key);
    const prefix = idempotencyStatePrefixForKey(cleanKey);
    this.db.run("DELETE FROM app_state WHERE key = ?", [cleanKey]);
    if (this.db.getRowsModified() > 0) {
      if (prefix) {
        this.decrementIdempotencyPrefixCount(prefix);
      }
      this.markDirty();
    }
  }

  private idempotencyPrefixCount(prefix: string) {
    const cached = this.idempotencyPrefixCounts.get(prefix);
    if (cached !== undefined) {
      return cached;
    }
    const prefixPattern = `${escapeSqlLikePattern(prefix)}%`;
    const count =
      this.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM app_state WHERE key LIKE ? ESCAPE '^'",
        [prefixPattern],
      )?.count ?? 0;
    this.idempotencyPrefixCounts.set(prefix, count);
    return count;
  }

  private incrementIdempotencyPrefixCount(key: string) {
    const prefix = idempotencyStatePrefixForKey(key);
    if (!prefix) {
      return;
    }
    this.idempotencyPrefixCounts.set(prefix, this.idempotencyPrefixCount(prefix) + 1);
  }

  private decrementIdempotencyPrefixCount(prefix: string) {
    const cached = this.idempotencyPrefixCounts.get(prefix);
    if (cached !== undefined) {
      this.idempotencyPrefixCounts.set(prefix, Math.max(0, cached - 1));
    }
  }

  private save() {
    const bytes = Buffer.from(this.db.export());
    const tempPath = tempPathFor(this.dbPath);
    try {
      fs.writeFileSync(tempPath, bytes);
      replaceFile(tempPath, this.dbPath);
      writeBackup(this.dbPath, bytes);
    } catch (error) {
      safeRemoveFile(tempPath);
      throw error;
    }
  }
}

function recoverPendingSave({
  createDatabase,
  dbPath,
}: {
  createDatabase: (bytes: Buffer) => Database;
  dbPath: string;
}) {
  const tempPath = tempPathFor(dbPath);
  if (!fs.existsSync(tempPath)) {
    return;
  }

  const tempInfo = fs.statSync(tempPath);
  const primaryInfo = fs.existsSync(dbPath) ? fs.statSync(dbPath) : undefined;
  if (primaryInfo && tempInfo.mtimeMs < primaryInfo.mtimeMs) {
    safeRemoveFile(tempPath);
    return;
  }

  try {
    const tempDb = createDatabase(fs.readFileSync(tempPath));
    assertDatabaseHealthy(tempDb);
    replaceFile(tempPath, dbPath);
  } catch (error) {
    safeRemoveFile(tempPath);
    console.warn(`Ignored pending database save: ${errorMessage(error)}`);
  }
}

function restoreDatabaseFromBackup({
  createDatabase,
  dbPath,
  primaryError,
}: {
  createDatabase: (bytes: Buffer) => Database;
  dbPath: string;
  primaryError: unknown;
}) {
  const backupPaths = backupPathsFor(dbPath).filter((backupPath) => fs.existsSync(backupPath));
  if (backupPaths.length === 0) {
    throw new AppError(
      `Could not open the local database and no backup was available. ${errorMessage(primaryError)}`,
      500,
    );
  }

  const backupErrors: string[] = [];
  for (const backupPath of backupPaths) {
    try {
      const backupDb = createDatabase(fs.readFileSync(backupPath));
      assertDatabaseHealthy(backupDb);
      quarantineCorruptDatabase(dbPath);
      return backupDb;
    } catch (backupError) {
      backupErrors.push(`${path.basename(backupPath)}: ${errorMessage(backupError)}`);
      quarantineCorruptBackup(backupPath, dbPath);
    }
  }

  throw new AppError(
    `Could not open the local database or any backup. Primary: ${errorMessage(primaryError)} Backups: ${backupErrors.join(" | ")}`,
    500,
  );
}

function assertDatabaseHealthy(db: Database) {
  const result = db.exec("PRAGMA integrity_check");
  const value = result[0]?.values?.[0]?.[0];
  if (value !== "ok") {
    throw new Error(`SQLite integrity check failed: ${String(value || "unknown")}`);
  }
}

function writeBackup(dbPath: string, bytes: Buffer) {
  const backupPath = backupPathFor(dbPath);
  const backupTempPath = `${backupPath}.tmp`;
  try {
    fs.writeFileSync(backupTempPath, bytes);
    rotateBackupChain(dbPath);
    replaceFile(backupTempPath, backupPath);
  } catch (error) {
    safeRemoveFile(backupTempPath);
    console.warn(`Could not write database backup: ${errorMessage(error)}`);
  }
}

function replaceFile(sourcePath: string, destinationPath: string) {
  const retryDelaysMs = [20, 50, 100, 200, 400];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      fs.renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isTransientFileReplaceError(error) || attempt === retryDelaysMs.length) {
        throw error;
      }
      sleepSync(retryDelaysMs[attempt]);
    }
  }
}

function isTransientFileReplaceError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rotateBackupChain(dbPath: string) {
  const backupPaths = backupPathsFor(dbPath);
  for (let index = backupPaths.length - 1; index > 0; index -= 1) {
    const destination = backupPaths[index];
    const source = backupPaths[index - 1];
    safeRemoveFile(destination);
    if (fs.existsSync(source)) {
      replaceFile(source, destination);
    }
  }
}

function quarantineCorruptDatabase(dbPath: string) {
  quarantineDatabaseFile(dbPath, dbPath, "database");
}

function quarantineCorruptBackup(backupPath: string, dbPath: string) {
  quarantineDatabaseFile(backupPath, dbPath, "backup");
}

function quarantineDatabaseFile(filePath: string, dbPath: string, label: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const baseName = path.basename(dbPath);
  const fileName = path.basename(filePath);
  const suffix = fileName === baseName ? "" : `-${fileName.slice(baseName.length).replace(/[^a-z0-9.-]/gi, "_")}`;
  const corruptPath = `${dbPath}.corrupt-${Date.now()}${suffix}`;
  try {
    fs.renameSync(filePath, corruptPath);
  } catch (error) {
    console.warn(`Could not quarantine corrupt ${label}: ${errorMessage(error)}`);
  }
}

function backupPathFor(dbPath: string) {
  return `${dbPath}.bak`;
}

function tempPathFor(dbPath: string) {
  return `${dbPath}.tmp`;
}

function backupPathsFor(dbPath: string) {
  const backupPath = backupPathFor(dbPath);
  return [backupPath, `${backupPath}.1`, `${backupPath}.2`];
}

function safeRemoveFile(filePath: string) {
  try {
    if (fs.existsSync(filePath)) {
      removeFile(filePath);
    }
  } catch (error) {
    console.warn(`Could not remove file ${filePath}: ${errorMessage(error)}`);
  }
}

function removeFile(filePath: string) {
  const retryDelaysMs = [20, 50, 100, 200, 400];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      fs.rmSync(filePath, { force: true });
      return;
    } catch (error) {
      if (!isTransientFileReplaceError(error) || attempt === retryDelaysMs.length) {
        throw error;
      }
      sleepSync(retryDelaysMs[attempt]);
    }
  }
}

function fileInfoFields(filePath: string) {
  const exists = fs.existsSync(filePath);
  const stats = exists ? fs.statSync(filePath) : undefined;
  return {
    exists,
    bytes: stats?.size ?? 0,
    updatedAt: stats?.mtime.toISOString() ?? "",
  };
}

function listCorruptDatabaseFiles(dbPath: string) {
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((file) => file.startsWith(`${base}.corrupt-`))
    .map((file) => {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      return {
        path: filePath,
        bytes: stats.size,
        updatedAt: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function normalizeLinkedInProfileUrl(url: string) {
  const cleanUrl = normalizeLinkedInProfileInput(url);
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
    if (!isLinkedInHost(parsed.hostname)) {
      return "";
    }
    const match = parsed.pathname.match(/\/in\/([^/?#]+)/i);
    if (!match) {
      return "";
    }
    const publicId = normalizeLinkedInPublicId(decodeURIComponent(match[1]));
    return publicId ? `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/` : "";
  } catch {
    return "";
  }
}

function isLinkedInHost(hostname: string) {
  const cleanHostname = hostname.toLowerCase();
  return cleanHostname === "linkedin.com" || cleanHostname.endsWith(".linkedin.com");
}

function normalizeLinkedInSourceUrl(url: string) {
  const cleanUrl = normalizeLinkedInUrlInput(url);
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
    if (!isLinkedInHost(parsed.hostname)) {
      return "";
    }
    if (!isLinkedInEngagementSourcePath(parsed.pathname)) {
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

function isLinkedInEngagementSourcePath(pathname: string) {
  const cleanPath = pathname.toLowerCase();
  return (
    /^\/feed\/update\/[^/]+/i.test(cleanPath) ||
    /^\/posts\/[^/]+/i.test(cleanPath) ||
    /^\/pulse\/[^/]+/i.test(cleanPath) ||
    /^\/comments\/[^/]+/i.test(cleanPath) ||
    /^\/in\/[^/]+\/recent-activity\/(?:all|comments)\/?$/i.test(cleanPath)
  );
}

function publicIdFromProfileUrl(url: string) {
  const match = url.match(/\/in\/([^/?#]+)\/?/i);
  if (!match) {
    return "";
  }
  try {
    return normalizeLinkedInPublicId(decodeURIComponent(match[1]));
  } catch {
    return normalizeLinkedInPublicId(match[1]);
  }
}

function normalizeLinkedInProfileInput(url: string) {
  return normalizeLinkedInUrlInput(url);
}

function normalizeLinkedInUrlInput(url: string) {
  return String(url || "")
    .trim()
    .replace(/^[<([{\s]+/, "")
    .replace(/[>\])}\s]+$/, "")
    .replace(/[.,;:!]+$/, "")
    .replace(/[>\])}\s]+$/, "");
}

function normalizeLinkedInPublicId(publicId: string) {
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

function normalizePeopleSearchQuery(query: string) {
  const cleanQuery = String(query || "").replace(/\s+/g, " ").trim();
  if (!cleanQuery) {
    return "";
  }
  const normalizedProfileUrl = normalizeLinkedInProfileUrl(cleanQuery);
  return (normalizedProfileUrl || cleanQuery.slice(0, MAX_PEOPLE_SEARCH_QUERY_LENGTH)).toLowerCase();
}

function normalizeFeedName(name: string) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim();
  if (!cleanName) {
    throw new AppError("Feed name is required.", 400);
  }
  if (cleanName.length > 80) {
    throw new AppError("Feed names must be 80 characters or fewer.", 400);
  }
  return cleanName;
}

function normalizeLookbackDays(value: unknown) {
  if (value === null || value === "" || typeof value === "boolean") {
    throw new AppError("Lookback days must be a number.", 400);
  }
  const days = Number(value);
  if (!Number.isFinite(days)) {
    throw new AppError("Lookback days must be a number.", 400);
  }
  return Math.max(1, Math.min(MAX_FEED_LOOKBACK_DAYS, Math.round(days)));
}

function escapeSqlLikePattern(value: string) {
  return value.replace(/[\^%_]/g, "^$&");
}

function normalizeQueueLimit(value: number | undefined) {
  if (value === undefined) {
    return DEFAULT_QUEUE_LIMIT;
  }
  const limit = Number(value);
  if (!Number.isFinite(limit)) {
    throw new AppError("Queue limit must be a number.", 400);
  }
  if (!Number.isSafeInteger(limit)) {
    throw new AppError("Queue limit must be a safe whole number.", 400);
  }
  if (limit < 1) {
    throw new AppError("Queue limit must be at least 1.", 400);
  }
  return Math.min(MAX_QUEUE_LIMIT, limit);
}

function normalizeQueueOffset(value: number | undefined) {
  if (value === undefined) {
    return 0;
  }
  const offset = Number(value);
  if (!Number.isFinite(offset)) {
    throw new AppError("Queue offset must be a number.", 400);
  }
  if (!Number.isSafeInteger(offset)) {
    throw new AppError("Queue offset must be a safe whole number.", 400);
  }
  if (offset < 0) {
    throw new AppError("Queue offset must be at least 0.", 400);
  }
  return offset;
}

function normalizeQueueCursor(cursor: QueueListOptions["after"]) {
  if (!cursor) {
    return undefined;
  }
  const activityAt = String(cursor.activityAt || "").trim();
  const discoveredAt = String(cursor.discoveredAt || "").trim();
  const id = normalizeQueueCursorId(cursor.id);
  if (!activityAt || !discoveredAt || !id) {
    throw new AppError("Queue cursor must include activityAt, discoveredAt, and id.", 400);
  }
  return {
    activityAt: normalizeQueueCursorDate(activityAt),
    discoveredAt: normalizeQueueCursorDate(discoveredAt),
    id,
  };
}

function normalizeQueueCursorDate(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new AppError("Queue cursor dates are invalid.", 400);
  }
  return new Date(timestamp).toISOString();
}

function normalizeQueueCursorId(value: unknown) {
  const id = String(value || "").trim();
  if (!id) {
    return "";
  }
  if (id.length > 80) {
    throw new AppError("Queue cursor id must be 80 characters or fewer.", 400);
  }
  if (/[/\\?#\x00-\x1f\x7f]/.test(id)) {
    throw new AppError("Queue cursor id contains unsupported characters.", 400);
  }
  return id;
}

function queueStatusSql(status: QueueStatusFilter) {
  if (status === "all") {
    return "";
  }
  if (status !== "new" && status !== "done" && status !== "skipped") {
    throw new AppError("Unsupported queue filter.", 400);
  }
  return "i.status = ?";
}

function isFeedReplay(value: unknown, feedId?: string): value is Feed {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const feed = value as Partial<Feed>;
  return (
    (!feedId || feed.id === feedId) &&
    typeof feed.id === "string" &&
    typeof feed.name === "string" &&
    isIntegerInRange(feed.lookbackDays, 1, MAX_FEED_LOOKBACK_DAYS) &&
    isIntegerInRange(feed.peopleCount, 0, MAX_PEOPLE_PER_FEED) &&
    typeof feed.createdAt === "string" &&
    typeof feed.updatedAt === "string"
  );
}

function isPersonReplay(value: unknown, options: { personId?: string; feedId?: string } = {}): value is Person {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const person = value as Partial<Person>;
  const profileUrl = normalizeLinkedInProfileUrl(String(person.profileUrl || ""));
  const publicId = profileUrl ? publicIdFromProfileUrl(profileUrl) : "";
  return (
    (!options.personId || person.id === options.personId) &&
    typeof person.id === "string" &&
    typeof person.name === "string" &&
    profileUrl === person.profileUrl &&
    publicId === person.publicId &&
    typeof person.headline === "string" &&
    isNonNegativeInteger(person.commentCount) &&
    isNonNegativeInteger(person.likeCount) &&
    isNonNegativeInteger(person.backCommentCount) &&
    isCleanStringArray(person.feedIds) &&
    hasUniqueStrings(person.feedIds) &&
    (!options.feedId || person.feedIds.includes(options.feedId)) &&
    typeof person.createdAt === "string" &&
    typeof person.updatedAt === "string"
  );
}

function isProfileStatusReplay(
  value: unknown,
  profileUrl: string,
  options: { allowMissingPerson?: boolean } = {},
): value is ProfileStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const status = value as Partial<ProfileStatus>;
  if (!isStringArray(status.feedIds) || !hasUniqueStrings(status.feedIds)) {
    return false;
  }
  if (status.person === undefined) {
    return Boolean(options.allowMissingPerson) && status.feedIds.length === 0;
  }
  return (
    isPersonReplay(status.person) &&
    normalizeLinkedInProfileUrl(status.person.profileUrl) === profileUrl &&
    sameStringSet(status.person.feedIds, status.feedIds)
  );
}

function isQueueStatusChangeReplay(value: unknown, itemId: string): value is QueueStatusChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const change = value as Partial<QueueStatusChange>;
  if (
    change.itemId !== itemId ||
    typeof change.personId !== "string" ||
    !isQueueStatusValue(change.previousStatus) ||
    !isQueueStatusValue(change.status) ||
    typeof change.changed !== "boolean" ||
    !isQueueStatusCommentDelta(change.commentCountDelta)
  ) {
    return false;
  }
  return isQueueStatusTransitionReplayConsistent(
    change.previousStatus,
    change.status,
    change.changed,
    change.commentCountDelta,
  );
}

function isQueueStatusTransitionReplayConsistent(
  previousStatus: "new" | "done" | "skipped",
  status: "new" | "done" | "skipped",
  changed: boolean,
  commentCountDelta: -1 | 0 | 1,
) {
  if (!changed) {
    return previousStatus === status && commentCountDelta === 0;
  }
  if (previousStatus === status) {
    return false;
  }
  if (previousStatus === "done" && status !== "done") {
    return commentCountDelta === 0 || commentCountDelta === -1;
  }
  if (previousStatus !== "done" && status === "done") {
    return commentCountDelta === 0 || commentCountDelta === 1;
  }
  return commentCountDelta === 0;
}

function isQueueStatusCommentDelta(value: unknown): value is -1 | 0 | 1 {
  return isIntegerInRange(value, -1, 1);
}

function isQueueStatusValue(value: unknown): value is "new" | "done" | "skipped" {
  return value === "new" || value === "done" || value === "skipped";
}

function isCaptureResultReplay(
  value: unknown,
  options: { maxProcessedItems?: number } = {},
): value is CaptureResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<CaptureResult>;
  const received = isNonNegativeInteger(result.received) ? result.received : undefined;
  if (received === undefined) {
    return false;
  }
  const rawCounts = [result.inserted, result.updated, result.skippedOlder, result.skippedUntracked, result.skippedInvalid];
  if (!rawCounts.every((count) => isNonNegativeInteger(count) && count <= received)) {
    return false;
  }
  const counts = rawCounts as number[];
  const processed = counts.reduce((total, count) => total + Number(count || 0), 0);
  if (processed > received) {
    return false;
  }
  if (options.maxProcessedItems !== undefined) {
    const nonOverflowProcessed = counts.slice(0, 4).reduce((total, count) => total + count, 0);
    const overflowCount = Math.max(0, received - options.maxProcessedItems);
    if (nonOverflowProcessed > options.maxProcessedItems || (result.skippedInvalid as number) < overflowCount) {
      return false;
    }
  }
  return true;
}

function isBulkPeopleResultReplay(value: unknown): value is BulkPeopleResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Partial<BulkPeopleResult>;
  const received = isNonNegativeInteger(result.received) ? result.received : undefined;
  const added = isNonNegativeInteger(result.added) ? result.added : undefined;
  const alreadyInFeed = isNonNegativeInteger(result.alreadyInFeed) ? result.alreadyInFeed : undefined;
  const updated = isNonNegativeInteger(result.updated) ? result.updated : undefined;
  const skippedInvalid = isNonNegativeInteger(result.skippedInvalid) ? result.skippedInvalid : undefined;
  const skippedCapacity = isNonNegativeInteger(result.skippedCapacity) ? result.skippedCapacity : undefined;
  const remainingCapacity = isNonNegativeInteger(result.remainingCapacity) ? result.remainingCapacity : undefined;
  if (
    received === undefined ||
    added === undefined ||
    alreadyInFeed === undefined ||
    updated === undefined ||
    skippedInvalid === undefined ||
    skippedCapacity === undefined ||
    remainingCapacity === undefined ||
    received > MAX_BULK_PEOPLE_PER_REQUEST ||
    remainingCapacity > MAX_PEOPLE_PER_FEED
  ) {
    return false;
  }
  const processedCount = added + alreadyInFeed + skippedInvalid + skippedCapacity;
  const totalSkipped = skippedInvalid + skippedCapacity;
  return (
    processedCount === received &&
    updated <= alreadyInFeed &&
    Array.isArray(result.errors) &&
    result.errors.length <= MAX_BULK_PEOPLE_ERROR_DETAILS &&
    result.errors.length <= totalSkipped &&
    hasUniqueBulkPeopleErrorIndexes(result.errors) &&
    result.errors.every((error) => isBulkPeopleErrorReplay(error, received))
  );
}

function hasUniqueBulkPeopleErrorIndexes(errors: unknown[]) {
  const indexes = new Set<number>();
  for (const error of errors) {
    if (!error || typeof error !== "object" || Array.isArray(error)) {
      return false;
    }
    const index = (error as Partial<BulkPeopleResult["errors"][number]>).index;
    if (!isNonNegativeInteger(index) || indexes.has(index)) {
      return false;
    }
    indexes.add(index);
  }
  return true;
}

function isBulkPeopleErrorReplay(value: unknown, received: number): value is BulkPeopleResult["errors"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const error = value as Partial<BulkPeopleResult["errors"][number]>;
  return (
    isNonNegativeInteger(error.index) &&
    error.index < received &&
    typeof error.profileUrl === "string" &&
    typeof error.error === "string"
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isCleanStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && Boolean(entry.trim()));
}

function hasUniqueStrings(value: string[]) {
  return new Set(value).size === value.length;
}

function appendBulkPeopleError(result: BulkPeopleResult, error: BulkPeopleResult["errors"][number]) {
  if (result.errors.length < MAX_BULK_PEOPLE_ERROR_DETAILS) {
    result.errors.push(error);
  }
}

function normalizePersonName(name: string, fallback: string) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim();
  return (cleanName || fallback || "LinkedIn member").slice(0, 120);
}

function shouldPreserveExistingPersonName(existingName: string, rawName: string, normalizedName: string, fallbackName: string) {
  const cleanRawName = String(rawName || "").replace(/\s+/g, " ").trim();
  if (!cleanRawName) {
    return true;
  }
  const existingLooksUseful = !isGenericPersonName(existingName) && !isFallbackPersonName(existingName, fallbackName);
  return existingLooksUseful && (isGenericPersonName(normalizedName) || isFallbackPersonName(normalizedName, fallbackName));
}

function isGenericPersonName(name: string) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim().toLowerCase();
  return cleanName === "" || cleanName === "linkedin member";
}

function isFallbackPersonName(name: string, fallbackName: string) {
  const cleanName = String(name || "").replace(/\s+/g, " ").trim().toLowerCase();
  const cleanFallbackName = String(fallbackName || "").replace(/\s+/g, " ").trim().toLowerCase();
  return Boolean(cleanFallbackName) && cleanName === cleanFallbackName;
}

function normalizeCounter(value: number) {
  const counter = Number(value);
  if (!Number.isFinite(counter)) {
    throw new AppError("Counters must be numbers.", 400);
  }
  return Math.max(0, Math.min(MAX_COUNTER_VALUE, Math.round(counter)));
}

function normalizeCounterDelta(value: number) {
  const delta = Number(value);
  if (!Number.isFinite(delta)) {
    throw new AppError("Counter adjustments must be numbers.", 400);
  }
  return Math.round(delta);
}

function normalizeStateKey(key: string) {
  const cleanKey = String(key || "").replace(/\s+/g, " ").trim();
  if (!cleanKey) {
    throw new AppError("App state key is required.", 400);
  }
  if (cleanKey.length > 120) {
    throw new AppError("App state keys must be 120 characters or fewer.", 400);
  }
  return cleanKey;
}

function emptyCaptureResult(): CaptureResult {
  return {
    received: 0,
    inserted: 0,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  };
}

function aggregateCaptureResults(results: CaptureResult[]): CaptureResult {
  return results.reduce((summary, result) => {
    summary.received += Number(result.received || 0);
    summary.inserted += Number(result.inserted || 0);
    summary.updated += Number(result.updated || 0);
    summary.skippedOlder += Number(result.skippedOlder || 0);
    summary.skippedUntracked += Number(result.skippedUntracked || 0);
    summary.skippedInvalid += Number(result.skippedInvalid || 0);
    return summary;
  }, emptyCaptureResult());
}

function mergeKnownFeedMemberships(requestedFeedIds: string[], currentFeedIds: string[], knownFeedIds: string[] | undefined) {
  if (!Array.isArray(knownFeedIds)) {
    return requestedFeedIds;
  }
  const known = new Set(knownFeedIds.filter((feedId) => typeof feedId === "string" && feedId.trim()));
  const requested = new Set(requestedFeedIds.filter((feedId) => typeof feedId === "string" && feedId.trim()));
  const preservedUnknownCurrent = currentFeedIds.filter((feedId) => !known.has(feedId));
  return [...preservedUnknownCurrent, ...requested];
}

function counterAdjustmentIdempotencyKey(personId: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `counterAdjust.${shortHash(personId)}.${cleanRequestId}` : "";
}

function counterUpdateIdempotencyKey(personId: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `counterUpdate.${shortHash(personId)}.${cleanRequestId}` : "";
}

function queueStatusIdempotencyKey(itemId: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `queueStatus.${shortHash(itemId)}.${cleanRequestId}` : "";
}

function captureItemsIdempotencyKey(feedId: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `captureItems.${shortHash(feedId)}.${cleanRequestId}` : "";
}

function captureItemsForFeedsIdempotencyKey(requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `captureItemsMulti.${cleanRequestId}` : "";
}

function feedCreateIdempotencyKey(requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `feedCreate.${cleanRequestId}` : "";
}

function feedUpdateIdempotencyKey(feedId: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `feedUpdate.${shortHash(feedId)}.${cleanRequestId}` : "";
}

function personMembershipIdempotencyKey(personId: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `personMembership.${shortHash(personId)}.${cleanRequestId}` : "";
}

function personUpsertIdempotencyKey(profileUrl: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `personUpsert.${shortHash(profileUrl)}.${cleanRequestId}` : "";
}

function profileMembershipIdempotencyKey(profileUrl: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `profileMembership.${shortHash(profileUrl)}.${cleanRequestId}` : "";
}

function addPersonToFeedIdempotencyKey(feedId: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `feedPerson.${shortHash(feedId)}.${cleanRequestId}` : "";
}

function bulkPeopleIdempotencyKey(feedId: string, requestId: unknown) {
  const cleanRequestId = normalizeIdempotencyRequestId(requestId);
  return cleanRequestId ? `bulkPeople.${shortHash(feedId)}.${cleanRequestId}` : "";
}

function normalizeIdempotencyRequestId(requestId: unknown, maxLength = 80) {
  const clean = String(requestId || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length <= maxLength) {
    return clean;
  }
  const hash = shortHash(clean);
  const prefixLength = Math.max(8, maxLength - hash.length - 1);
  return `${clean.slice(0, prefixLength)}.${hash}`;
}

function idempotencyStatePrefixForKey(key: string) {
  if (key.startsWith("counterAdjust.")) {
    return "counterAdjust.";
  }
  if (key.startsWith("counterUpdate.")) {
    return "counterUpdate.";
  }
  if (key.startsWith("queueStatus.")) {
    return "queueStatus.";
  }
  if (key.startsWith("captureItems.")) {
    return "captureItems.";
  }
  if (key.startsWith("captureItemsMulti.")) {
    return "captureItemsMulti.";
  }
  if (key.startsWith("feedCreate.")) {
    return "feedCreate.";
  }
  if (key.startsWith("feedUpdate.")) {
    return "feedUpdate.";
  }
  if (key.startsWith("personMembership.")) {
    return "personMembership.";
  }
  if (key.startsWith("personUpsert.")) {
    return "personUpsert.";
  }
  if (key.startsWith("profileMembership.")) {
    return "profileMembership.";
  }
  if (key.startsWith("feedPerson.")) {
    return "feedPerson.";
  }
  if (key.startsWith("refreshTarget.")) {
    return "refreshTarget.";
  }
  if (key.startsWith("bulkPeople.")) {
    return "bulkPeople.";
  }
  return "";
}

function normalizeCapturedText(text: string) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 3000);
}

function mergeBatchCapturedItem(target: NormalizedCapturedItem, next: NormalizedCapturedItem) {
  if (!String(target.personName || "").trim() && String(next.personName || "").trim()) {
    target.personName = next.personName;
  }
  if (shouldImproveCapturedText(target.text, next.text)) {
    target.text = next.text;
  }
  if (shouldImproveCapturedActivityAt({ activityAt: target.activityAt, discoveredAt: target.capturedAt }, next.activityAt)) {
    target.activityAt = next.activityAt;
  }
}

function shouldImproveCapturedText(existingText: string, nextText: string) {
  return (!existingText && Boolean(nextText)) || (nextText.length > existingText.length && nextText.length <= 3000);
}

function shouldImproveCapturedActivityAt(
  existing: { activityAt: string; discoveredAt: string },
  nextActivityAt: string,
) {
  const existingActivityAt = new Date(existing.activityAt).getTime();
  const existingDiscoveredAt = new Date(existing.discoveredAt).getTime();
  const nextActivityTime = new Date(nextActivityAt).getTime();
  if (!Number.isFinite(existingActivityAt) || !Number.isFinite(existingDiscoveredAt) || !Number.isFinite(nextActivityTime)) {
    return false;
  }
  const existingLooksLikeDiscoveryFallback = Math.abs(existingActivityAt - existingDiscoveredAt) <= 1000;
  return existingLooksLikeDiscoveryFallback && nextActivityTime < existingActivityAt;
}

function shouldImproveCapturedSourceUrl(existingSourceUrl: string, nextSourceUrl: string) {
  return !isStableLinkedInItemSource(existingSourceUrl) && isStableLinkedInItemSource(nextSourceUrl);
}

function isStableLinkedInItemSource(sourceUrl: string) {
  try {
    const parsed = new URL(sourceUrl);
    return isLinkedInHost(parsed.hostname) && /^\/(?:feed\/update|posts|pulse|comments)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function commentTextsLookLikeSameCapture(existingText: string, nextText: string) {
  const existing = normalizeCapturedText(existingText).toLowerCase();
  const next = normalizeCapturedText(nextText).toLowerCase();
  if (!existing || !next) {
    return false;
  }
  if (existing === next) {
    return true;
  }
  const shorter = existing.length <= next.length ? existing : next;
  const longer = existing.length > next.length ? existing : next;
  return shorter.length >= 12 && longer.includes(shorter);
}

function postTextsLookLikeSameCapture(existingText: string, nextText: string) {
  const existing = normalizeCapturedText(existingText).toLowerCase();
  const next = normalizeCapturedText(nextText).toLowerCase();
  if (!existing || !next) {
    return false;
  }
  if (existing === next) {
    return existing.length >= 24;
  }
  const shorter = existing.length <= next.length ? existing : next;
  const longer = existing.length > next.length ? existing : next;
  return shorter.length >= 80 && longer.includes(shorter);
}

function normalizeActivityDate(value: string | undefined, capturedAt: string) {
  if (!value) {
    return capturedAt;
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const capturedAtTimestamp = new Date(capturedAt).getTime();
  if (timestamp > capturedAtTimestamp) {
    return capturedAt;
  }
  return new Date(timestamp).toISOString();
}

function activityDayStartIso(value: string) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function activityNextDayStartIso(value: string) {
  const date = new Date(activityDayStartIso(value));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function stableExternalId(
  rawExternalId: string | undefined,
  item: { personProfileUrl: string; sourceUrl: string; type: "post" | "comment"; activityAt: string; text: string },
) {
  const normalizedRaw = normalizeLinkedInSourceUrl(rawExternalId || "");
  const sourceKey = item.sourceUrl || normalizedRaw;
  const sourceLooksStable = isStableLinkedInItemSource(sourceKey);
  if (sourceLooksStable) {
    if (item.type === "comment") {
      return `comment:${item.personProfileUrl}:${sourceKey}:${shortHash(item.text || item.activityAt)}`;
    }
    return `post:${sourceKey}`;
  }

  const activityDay = item.activityAt.slice(0, 10);
  return `${item.type}:${item.personProfileUrl}:${activityDay}:${shortHash(item.text || item.sourceUrl)}`;
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function splitGroupConcat(value: string | null | undefined) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function orderedPersonFeedIdsSql(personIdExpression: string) {
  return `
    (
      SELECT GROUP_CONCAT(feed_id)
      FROM (
        SELECT fp.feed_id
        FROM feed_people fp
        JOIN feeds f ON f.id = fp.feed_id
        WHERE fp.person_id = ${personIdExpression}
        ORDER BY f.name COLLATE NOCASE ASC, fp.feed_id ASC
      )
    )
  `;
}

function splitHexGroupConcat(value: string | null | undefined) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return Buffer.from(entry, "hex").toString("utf8");
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function sameStringSet(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length || leftSet.size !== rightSet.size) {
    return false;
  }
  return [...leftSet].every((value) => rightSet.has(value));
}

function chunkStrings(values: string[], size = 400) {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    const chunk = values.slice(index, index + size).filter(Boolean);
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

function placeholdersFor(values: string[]) {
  return values.map(() => "?").join(",");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
