import { createHash, randomUUID } from "node:crypto";
import {
  AppDatabase,
  AppError,
  CaptureResult,
  MAX_CAPTURE_ITEMS_PER_REQUEST,
  MAX_FEED_LOOKBACK_DAYS,
  normalizeLinkedInProfileUrl,
} from "./database.js";

export type RefreshTarget = {
  index: number;
  personId: string;
  personName: string;
  profileUrl: string;
  kind: "posts" | "comments";
  url: string;
};

export type RefreshSessionStatus = "running" | "done" | "canceled" | "failed";

export type RefreshSessionView = {
  id: string;
  feedId: string;
  feedName: string;
  lookbackDays: number;
  lookbackCutoffAt: string;
  status: RefreshSessionStatus;
  totalTargets: number;
  completedTargets: number;
  failedTargets: number;
  inserted: number;
  updated: number;
  skippedOlder: number;
  skippedUntracked: number;
  skippedInvalid: number;
  lastError: string;
  currentTarget?: RefreshTarget;
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

type RefreshSession = RefreshSessionView & {
  targets: RefreshTarget[];
  targetRetries: Record<number, number>;
  createRequestId?: string;
};

type PersistedRefreshSessions = {
  schemaVersion: 1;
  savedAt: string;
  sessions: RefreshSession[];
};

const DEFAULT_DELAY_MS = 2800;
const MAX_TARGET_RETRIES = 2;
const RETRY_DELAYS_MS = [6000, 18000];
const ISSUE_BACKOFF_DELAYS_MS = [6000, 10000, 16000, 24000];
const RATE_LIMIT_BACKOFF_DELAYS_MS = [45000, 90000, 180000];
const MAX_REMEMBERED_SESSIONS = 30;
const MAX_REFRESH_ERROR_MESSAGE_LENGTH = 240;
const MAX_REFRESH_SESSION_MESSAGE_LENGTH = 500;
const MAX_REFRESH_CLASSIFICATION_TEXT_LENGTH = 4000;
const DEFAULT_STALE_SESSION_MS = 45 * 60 * 1000;
const DEFAULT_HEARTBEAT_PERSIST_INTERVAL_MS = 60 * 1000;
const REFRESH_SESSIONS_STATE_KEY = "refreshSessions.v1";
const MAX_REFRESH_TARGET_REPLAY_KEY_LENGTH = 120;
const REFRESH_TARGET_REPLAY_KEY_PREFIX = "refreshTarget.";

function createRefreshSessionId() {
  return `refresh_${randomUUID()}`;
}

export type RefreshSessionManagerOptions = {
  staleSessionMs?: number;
  heartbeatPersistIntervalMs?: number;
  now?: () => Date;
};

export class RefreshSessionManager {
  private sessions: Map<string, RefreshSession>;
  private readonly staleSessionMs: number;
  private readonly heartbeatPersistIntervalMs: number;
  private readonly now: () => Date;
  private persistedSessionUpdatedAt: Map<string, string>;
  private restoredSessionsWereNormalized = false;

  constructor(
    private readonly db: AppDatabase,
    options: RefreshSessionManagerOptions = {},
  ) {
    this.staleSessionMs = options.staleSessionMs ?? DEFAULT_STALE_SESSION_MS;
    this.heartbeatPersistIntervalMs =
      options.heartbeatPersistIntervalMs ??
      Math.min(DEFAULT_HEARTBEAT_PERSIST_INTERVAL_MS, Math.max(250, Math.floor(this.staleSessionMs / 2)));
    this.now = options.now ?? (() => new Date());
    this.sessions = this.loadSessions();
    this.persistedSessionUpdatedAt = new Map(
      [...this.sessions.values()].map((session) => [session.id, session.updatedAt]),
    );
    const singleRunning = this.reconcileSingleRunningSession();
    const reconciled = this.reconcileRunningSessionsWithDatabase();
    const expired = this.expireStaleSessions();
    const pruned = this.pruneSessions();
    if (this.restoredSessionsWereNormalized || singleRunning || reconciled || expired || pruned) {
      this.persistSessions();
    }
  }

  create(feedId: string, options: { requestId?: string } = {}): RefreshSessionView {
    this.expireAndPersistStaleSessions();
    const requestId = normalizeCreateRequestId(options.requestId);
    const replayedSession = requestId ? this.sessionCreatedByRequest(feedId, requestId) : undefined;
    if (replayedSession) {
      return { ...this.toView(replayedSession), createdByRequest: true };
    }

    const feed = this.db.getFeed(feedId);
    const existing = this.runningSession();
    if (existing) {
      if (existing.feedId === feed.id) {
        return { ...this.toView(existing), createdByRequest: Boolean(requestId && existing.createRequestId === requestId) };
      }
      throw new AppError(
        `Finish or stop the running refresh for "${existing.feedName}" before refreshing "${feed.name}".`,
        409,
      );
    }

    const people = this.db.listFeedMembers(feedId);
    if (people.length === 0) {
      throw new AppError("Add at least one person to this feed before refreshing LinkedIn.", 400);
    }

    const targets = people.flatMap(refreshTargetsForPerson);

    const id = createRefreshSessionId();
    const at = this.nowIso();
    const session: RefreshSession = {
      id,
      feedId: feed.id,
      feedName: feed.name,
      lookbackDays: feed.lookbackDays,
      lookbackCutoffAt: this.lookbackCutoffIso(feed.lookbackDays),
      status: "running",
      targets: targets.map((target, index) => ({ ...target, index })),
      totalTargets: targets.length,
      completedTargets: 0,
      failedTargets: 0,
      inserted: 0,
      updated: 0,
      skippedOlder: 0,
      skippedUntracked: 0,
      skippedInvalid: 0,
      lastError: "",
      delayMs: delayForTargetCount(targets.length),
      nextDelayMs: delayForTargetCount(targets.length),
      nextDelayReason: "Standard pacing",
      issueStreak: 0,
      rateLimitStreak: 0,
      currentAttempt: 1,
      maxAttempts: MAX_TARGET_RETRIES + 1,
      targetRetries: {},
      createRequestId: requestId,
      createdAt: at,
      updatedAt: at,
    };

    this.sessions.set(id, session);
    this.pruneSessions();
    this.persistSessions();
    return { ...this.toView(session), createdByRequest: true };
  }

  list(feedId?: string): RefreshSessionView[] {
    this.expireAndPersistStaleSessions();
    return [...this.sessions.values()]
      .filter((session) => !feedId || session.feedId === feedId)
      .sort(compareRefreshSessionsNewestFirst)
      .map((session) => this.toView(session));
  }

  get(id: string): RefreshSessionView {
    this.expireAndPersistStaleSessions();
    return this.toView(this.requireSession(id));
  }

  getActive(id?: string): RefreshSessionView | undefined {
    this.expireAndPersistStaleSessions();
    if (id) {
      const session = this.sessions.get(id);
      return session ? this.toView(session) : undefined;
    }
    const running = [...this.sessions.values()]
      .filter((session) => session.status === "running")
      .sort(compareRefreshSessionsNewestFirst)[0];
    return running ? this.toView(running) : undefined;
  }

  cancel(id: string): RefreshSessionView {
    this.expireAndPersistStaleSessions();
    const session = this.requireSession(id);
    const view = this.toView(session);
    if (session.status === "running") {
      session.status = "canceled";
      setRefreshSessionLastError(session, "Refresh was stopped.");
      session.updatedAt = this.nowIso();
      this.persistSessions();
      return this.toView(session);
    }
    this.sessions.delete(id);
    this.persistSessions();
    return view;
  }

  cancelFeed(feedId: string, reason = "Refresh stopped because its feed was deleted."): RefreshSessionView[] {
    this.expireAndPersistStaleSessions();
    const canceled: RefreshSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.feedId !== feedId || session.status !== "running") {
        continue;
      }
      session.status = "canceled";
      setRefreshSessionLastError(session, reason);
      session.updatedAt = this.nowIso();
      canceled.push(session);
    }
    if (canceled.length > 0) {
      this.persistSessions();
    }
    return canceled.map((session) => this.toView(session));
  }

  reconcileRunningSessions(): RefreshSessionView[] {
    this.expireAndPersistStaleSessions();
    if (this.reconcileRunningSessionsWithDatabase()) {
      this.persistSessions();
    }
    return [...this.sessions.values()]
      .sort(compareRefreshSessionsNewestFirst)
      .map((session) => this.toView(session));
  }

  syncFeedMembership(feedId: string): RefreshSessionView[] {
    return this.syncFeedMemberships([feedId]);
  }

  syncFeedMemberships(feedIds: string[]): RefreshSessionView[] {
    this.expireAndPersistStaleSessions();
    const requestedFeedIds = uniqueRefreshFeedIds(feedIds);
    if (requestedFeedIds.length === 0) {
      return [];
    }
    const requestedFeedIdSet = new Set(requestedFeedIds);
    const runningSessionsByFeed = new Map<string, RefreshSession[]>();
    const runningSessions: RefreshSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.status !== "running" || !requestedFeedIdSet.has(session.feedId)) {
        continue;
      }
      runningSessions.push(session);
      const feedSessions = runningSessionsByFeed.get(session.feedId) || [];
      feedSessions.push(session);
      runningSessionsByFeed.set(session.feedId, feedSessions);
    }
    if (runningSessions.length === 0) {
      return [];
    }

    let changed = false;
    for (const feedId of requestedFeedIds) {
      const feedSessions = runningSessionsByFeed.get(feedId);
      if (!feedSessions?.length) {
        continue;
      }
      let activePeople: ReturnType<AppDatabase["listFeedMembers"]>;
      try {
        activePeople = this.db.listFeedMembers(feedId);
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 404) {
          for (const session of feedSessions) {
            session.status = "failed";
            setRefreshSessionLastError(
              session,
              "Refresh stopped because its feed no longer exists. Start a new refresh when ready.",
            );
            session.updatedAt = this.nowIso();
          }
          changed = true;
          continue;
        }
        throw error;
      }
      for (const session of feedSessions) {
        changed = this.syncPendingTargets(session, activePeople) || changed;
      }
    }
    if (changed) {
      this.persistSessions();
    }
    return runningSessions.sort(compareRefreshSessionsNewestFirst).map((session) => this.toView(session));
  }

  syncFeedSettings(feedId: string): RefreshSessionView[] {
    this.expireAndPersistStaleSessions();
    const feed = this.db.getFeed(feedId);
    const runningSessions = [...this.sessions.values()].filter(
      (session) => session.feedId === feedId && session.status === "running",
    );
    if (runningSessions.length === 0) {
      return [];
    }

    let changed = false;
    for (const session of runningSessions) {
      const lookbackChanged = session.lookbackDays !== feed.lookbackDays;
      if (session.feedName === feed.name && !lookbackChanged) {
        continue;
      }
      session.feedName = feed.name;
      if (lookbackChanged) {
        session.lookbackDays = feed.lookbackDays;
        session.lookbackCutoffAt = this.lookbackCutoffIso(feed.lookbackDays);
      }
      session.updatedAt = this.nowIso();
      changed = true;
    }
    if (changed) {
      this.persistSessions();
    }
    return runningSessions.sort(compareRefreshSessionsNewestFirst).map((session) => this.toView(session));
  }

  recordTargetComplete(
    id: string,
    input: { targetIndex?: number; url?: string; captureResult?: Partial<CaptureResult>; error?: string; requestId?: string },
  ): RefreshSessionView {
    this.expireAndPersistStaleSessions();
    const idempotencyKey = refreshTargetReportIdempotencyKey(id, input.requestId);
    const previousResult = idempotencyKey
      ? this.db.getValidIdempotencyState<RefreshSessionView>(idempotencyKey, (value) =>
          isRefreshSessionViewReplay(value, id),
        )
      : undefined;
    if (previousResult) {
      const replayTarget = refreshTargetReport(input.targetIndex, input.url);
      const liveSession = this.sessions.get(id);
      if (liveSession && previousResult.status === "running" && liveSession.status !== "running") {
        const liveView = this.toView(liveSession);
        this.db.setAppState(idempotencyKey, liveView);
        return liveView;
      }
      if (
        liveSession &&
        !replayTarget.conflict &&
        shouldReturnLiveRefreshTargetReplay(previousResult, liveSession, replayTarget.index)
      ) {
        const liveView = this.toView(liveSession);
        this.db.setAppState(idempotencyKey, liveView);
        return liveView;
      }
      return previousResult;
    }
    const session = this.requireSession(id);
    const rememberResult = (view: RefreshSessionView) => {
      if (idempotencyKey) {
        this.db.setAppState(idempotencyKey, view);
        return this.db.getIdempotencyState<RefreshSessionView>(idempotencyKey)?.value ?? view;
      }
      return view;
    };
    if (session.status !== "running") {
      return rememberResult(this.toView(session));
    }

    const targetReport = refreshTargetReport(input.targetIndex, input.url);
    if (targetReport.conflict) {
      return rememberResult(
        this.recordIgnoredProgressReport(
          session,
          "Refresh ignored a progress report with conflicting target identifiers. Waiting for the expected LinkedIn activity page.",
        ),
      );
    }

    const reportedTargetIndex = targetReport.index;
    if (reportedTargetIndex === undefined && !input.url) {
      return rememberResult(
        this.recordIgnoredProgressReport(
          session,
          "Refresh ignored a progress report without a target identifier. Waiting for the expected LinkedIn activity page.",
        ),
      );
    }

    const targetIndex = reportedTargetIndex ?? session.completedTargets;
    if (targetIndex < session.completedTargets) {
      return rememberResult(this.toView(session));
    }

    if (targetIndex > session.completedTargets) {
      return rememberResult(
        this.recordIgnoredProgressReport(session, "Refresh target order changed; waiting for the expected LinkedIn page."),
      );
    }

    const target = session.targets[targetIndex];
    if (!target) {
      return rememberResult(
        this.recordIgnoredProgressReport(
          session,
          "Refresh ignored a progress report for a page that is no longer in this session. Waiting for the expected LinkedIn activity page.",
        ),
      );
    }

    if (!this.db.isPersonInFeed(target.personId, session.feedId)) {
      delete session.targetRetries[targetIndex];
      session.completedTargets = Math.min(session.completedTargets + 1, session.totalTargets);
      setRefreshSessionLastError(
        session,
        `${target.personName} ${target.kind} was skipped because they are no longer in this feed.`,
      );
      session.updatedAt = this.nowIso();
      if (session.completedTargets >= session.totalTargets) {
        session.status = session.failedTargets > 0 ? "failed" : "done";
      }
      this.persistSessions();
      return rememberResult(this.toView(session));
    }

    if (input.url && !reportedUrlMatchesTarget(input.url, target)) {
      return rememberResult(
        this.recordIgnoredProgressReport(
          session,
          `${target.personName} ${target.kind} ignored a progress report from a different LinkedIn activity page. Waiting for the expected page.`,
        ),
      );
    }

    const errorMessage = normalizeRefreshError(input.error);
    if (!errorMessage && !input.captureResult) {
      return rememberResult(
        this.recordIgnoredProgressReport(
          session,
          `${target.personName} ${target.kind} ignored an empty progress report. Waiting for captured items or a page error.`,
        ),
      );
    }

    if (errorMessage) {
      const issueKind = classifyRefreshError(refreshErrorClassificationText(input.error, errorMessage));
      if (issueKind === "auth") {
        const previousMessage = session.lastError;
        setRefreshSessionLastError(
          session,
          `${target.personName} ${target.kind} is waiting because LinkedIn is asking you to sign in. Sign in to LinkedIn, then this refresh will continue.`,
        );
        session.updatedAt = this.nowIso();
        if (this.shouldPersistHeartbeat(session, previousMessage)) {
          this.persistSessions();
        }
        return rememberResult(this.toView(session));
      }
      applyRefreshIssue(session, issueKind);
      const retries = session.targetRetries[targetIndex] ?? 0;
      if (issueKind !== "permanent" && retries < MAX_TARGET_RETRIES) {
        session.targetRetries[targetIndex] = retries + 1;
        setRefreshSessionLastError(
          session,
          `${target.personName} ${target.kind} had a temporary problem: ${errorMessage}. Retrying attempt ${retries + 2}/${MAX_TARGET_RETRIES + 1}.${refreshPacingNote(session)}`,
        );
        session.updatedAt = this.nowIso();
        this.persistSessions();
        return rememberResult(this.toView(session));
      }

      const skippedTargetCount =
        issueKind === "permanent" ? skipRemainingUnavailablePersonTargets(session, targetIndex) : 1;
      session.failedTargets += skippedTargetCount;
      setRefreshSessionLastError(
        session,
        issueKind === "permanent"
          ? unavailableTargetMessage(target, skippedTargetCount, errorMessage)
          : `${target.personName} ${target.kind} was skipped after ${MAX_TARGET_RETRIES + 1} attempts: ${errorMessage}${refreshPacingNote(session)}`,
      );
      if (issueKind !== "permanent") {
        delete session.targetRetries[targetIndex];
        session.completedTargets = Math.min(session.completedTargets + 1, session.totalTargets);
      }
      session.updatedAt = this.nowIso();
      if (session.completedTargets >= session.totalTargets) {
        session.status = "failed";
      }
      this.persistSessions();
      return rememberResult(this.toView(session));
    }

    const result = normalizeCaptureResult(input.captureResult);
    if (result) {
      session.inserted += result.inserted;
      session.updated += result.updated;
      session.skippedOlder += result.skippedOlder;
      session.skippedUntracked += result.skippedUntracked;
      session.skippedInvalid += result.skippedInvalid;
    }

    delete session.targetRetries[targetIndex];
    recoverRefreshPacing(session);
    if (session.failedTargets === 0) {
      setRefreshSessionLastError(session, "");
    }
    session.completedTargets = Math.min(session.completedTargets + 1, session.totalTargets);
    session.updatedAt = this.nowIso();
    if (session.completedTargets >= session.totalTargets) {
      session.status = session.failedTargets > 0 ? "failed" : "done";
    }
    this.persistSessions();
    return rememberResult(this.toView(session));
  }

  recordHeartbeat(id: string, input: { message?: string; targetIndex?: number; url?: string } = {}): RefreshSessionView {
    this.expireAndPersistStaleSessions();
    const session = this.requireSession(id);
    if (session.status !== "running") {
      return this.toView(session);
    }

    const targetReport = refreshTargetReport(input.targetIndex, input.url);
    if (targetReport.conflict) {
      return this.toView(session);
    }

    const targetIndex = targetReport.index;
    const currentTarget = session.targets[session.completedTargets];
    if (targetIndex === undefined || !currentTarget) {
      return this.toView(session);
    }
    if (targetIndex !== currentTarget.index) {
      return this.toView(session);
    }
    if (input.url && !reportedUrlMatchesTarget(input.url, currentTarget) && !isAuthRefreshHeartbeat(input.url, input.message)) {
      return this.toView(session);
    }

    const previousMessage = session.lastError;
    const message = normalizeRefreshHeartbeatMessage(input.message);
    setRefreshSessionLastError(session, message);
    session.updatedAt = this.nowIso();
    if (this.shouldPersistHeartbeat(session, previousMessage)) {
      this.persistSessions();
    }
    return this.toView(session);
  }

  private loadSessions() {
    let state: PersistedRefreshSessions | undefined;
    try {
      state = this.db.getAppState<PersistedRefreshSessions>(REFRESH_SESSIONS_STATE_KEY)?.value;
    } catch (error) {
      console.warn(`Could not restore saved refresh sessions: ${errorMessage(error)}`);
      return new Map<string, RefreshSession>();
    }

    if (!state || state.schemaVersion !== 1 || !Array.isArray(state.sessions)) {
      return new Map<string, RefreshSession>();
    }

    const restored = state.sessions.map((session) => restoreRefreshSession(session));
    this.restoredSessionsWereNormalized = restored.some((result) => Boolean(result?.normalized));
    const sessions = restored
      .map((result) => result?.session)
      .filter((session): session is RefreshSession => Boolean(session));
    return new Map(sessions.map((session) => [session.id, session]));
  }

  private persistSessions() {
    this.db.setAppState(REFRESH_SESSIONS_STATE_KEY, {
      schemaVersion: 1,
      savedAt: this.nowIso(),
      sessions: [...this.sessions.values()].map(compactRefreshSessionForPersistence),
    } satisfies PersistedRefreshSessions);
    this.persistedSessionUpdatedAt = new Map(
      [...this.sessions.values()].map((session) => [session.id, session.updatedAt]),
    );
  }

  private shouldPersistHeartbeat(session: RefreshSession, previousMessage: string) {
    if (session.lastError !== previousMessage) {
      return true;
    }
    const lastPersistedAt = new Date(this.persistedSessionUpdatedAt.get(session.id) || session.createdAt).getTime();
    const updatedAt = new Date(session.updatedAt).getTime();
    return (
      !Number.isFinite(lastPersistedAt) ||
      !Number.isFinite(updatedAt) ||
      updatedAt - lastPersistedAt >= this.heartbeatPersistIntervalMs
    );
  }

  private expireAndPersistStaleSessions() {
    if (this.expireStaleSessions()) {
      this.persistSessions();
    }
  }

  private reconcileRunningSessionsWithDatabase() {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.status !== "running") {
        continue;
      }

      let feed: ReturnType<AppDatabase["getFeed"]>;
      try {
        feed = this.db.getFeed(session.feedId);
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 404) {
          session.status = "failed";
          setRefreshSessionLastError(
            session,
            "Refresh stopped because its feed no longer exists. Start a new refresh when ready.",
          );
          session.updatedAt = this.nowIso();
          changed = true;
          continue;
        }
        throw error;
      }

      const lookbackChanged = session.lookbackDays !== feed.lookbackDays;
      if (session.feedName !== feed.name || lookbackChanged) {
        session.feedName = feed.name;
        if (lookbackChanged) {
          session.lookbackDays = feed.lookbackDays;
          session.lookbackCutoffAt = this.lookbackCutoffIso(feed.lookbackDays);
        }
        session.updatedAt = this.nowIso();
        changed = true;
      }

      changed = this.syncPendingTargets(session, this.db.listFeedMembers(feed.id)) || changed;
    }
    return changed;
  }

  private requireSession(id: string): RefreshSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new AppError("Refresh session not found.", 404);
    }
    return session;
  }

  private recordIgnoredProgressReport(session: RefreshSession, message: string) {
    const normalizedMessage = normalizeRefreshSessionMessage(message);
    if (session.lastError === normalizedMessage) {
      return this.toView(session);
    }
    setRefreshSessionLastError(session, normalizedMessage);
    this.persistSessions();
    return this.toView(session);
  }

  private reconcileSingleRunningSession() {
    const runningSessions = [...this.sessions.values()]
      .filter((session) => session.status === "running")
      .sort(compareRefreshSessionsNewestFirst);
    if (runningSessions.length <= 1) {
      return false;
    }

    const [keptSession, ...stoppedSessions] = runningSessions;
    const at = this.nowIso();
    for (const session of stoppedSessions) {
      session.status = "failed";
      setRefreshSessionLastError(
        session,
        `Refresh stopped because "${keptSession.feedName}" was already running after app restart. Start this refresh again when ready.`,
      );
      session.updatedAt = at;
    }
    return true;
  }

  private runningSession(): RefreshSession | undefined {
    return [...this.sessions.values()]
      .filter((session) => session.status === "running")
      .sort(compareRefreshSessionsNewestFirst)[0];
  }

  private sessionCreatedByRequest(feedId: string, requestId: string): RefreshSession | undefined {
    return [...this.sessions.values()]
      .filter((session) => session.feedId === feedId && session.createRequestId === requestId)
      .sort(compareRefreshSessionsNewestFirst)[0];
  }

  private pruneSessions() {
    let pruned = false;
    const sessions = [...this.sessions.values()].sort(compareRefreshSessionsNewestFirst);
    const keep = new Set(sessions.slice(0, MAX_REMEMBERED_SESSIONS).map((session) => session.id));
    for (const session of sessions) {
      if (!keep.has(session.id) && session.status !== "running") {
        this.sessions.delete(session.id);
        pruned = true;
      }
    }
    return pruned;
  }

  private expireStaleSessions() {
    let expired = false;
    const cutoff = this.now().getTime() - this.staleSessionMs;
    for (const session of this.sessions.values()) {
      if (session.status !== "running") {
        continue;
      }
      const updatedAt = new Date(session.updatedAt).getTime();
      if (!Number.isFinite(updatedAt) || updatedAt < cutoff) {
        session.status = "failed";
        setRefreshSessionLastError(
          session,
          "Refresh expired because no LinkedIn activity page reported progress for too long. Start a new refresh when ready.",
        );
        session.updatedAt = this.nowIso();
        expired = true;
      }
    }
    return expired;
  }

  private syncPendingTargets(session: RefreshSession, activePeople: ReturnType<AppDatabase["listFeedMembers"]>) {
    const activePeopleById = new Map(activePeople.map((person) => [person.id, person]));
    const completedTargets = session.targets.slice(0, session.completedTargets);
    const pendingTargets = session.targets.slice(session.completedTargets);
    const pendingRetryCountsByTargetKey = new Map<string, number>();
    for (const target of pendingTargets) {
      const retryCount = session.targetRetries[target.index] ?? 0;
      if (retryCount > 0) {
        pendingRetryCountsByTargetKey.set(refreshTargetKey(target), retryCount);
      }
    }
    const keptPendingTargetEntries = pendingTargets
      .filter((target) => activePeopleById.has(target.personId))
      .map((target) => {
        const person = activePeopleById.get(target.personId);
        const nextTarget = person
          ? {
              ...target,
              personName: person.name,
              profileUrl: person.profileUrl,
              url: refreshTargetUrl(person.profileUrl, target.kind),
            }
          : target;
        return {
          target: nextTarget,
          refreshed:
            nextTarget.personName !== target.personName ||
            nextTarget.profileUrl !== target.profileUrl ||
            nextTarget.url !== target.url,
        };
      });
    const keptPendingTargets = keptPendingTargetEntries.map((entry) => entry.target);
    const removedCount = pendingTargets.length - keptPendingTargets.length;
    const refreshedCount = keptPendingTargetEntries.filter((entry) => entry.refreshed).length;
    const knownTargetKeys = new Set([...completedTargets, ...keptPendingTargets].map(refreshTargetKey));
    const addedTargets = activePeople
      .flatMap((person) => refreshTargetsForPerson(person))
      .filter((target) => !knownTargetKeys.has(refreshTargetKey(target)));
    const addedCount = addedTargets.length;
    const addedPersonCount = new Set(addedTargets.map((target) => target.personId)).size;

    if (removedCount === 0 && addedCount === 0 && refreshedCount === 0) {
      return false;
    }

    const nextRetries: Record<number, number> = {};
    const nextTargets = [...completedTargets, ...keptPendingTargets, ...addedTargets].map((target, index) => {
      const retryCount = pendingRetryCountsByTargetKey.get(refreshTargetKey(target)) ?? 0;
      if (retryCount > 0) {
        nextRetries[index] = retryCount;
      }
      return { ...target, index };
    });

    session.targets = nextTargets;
    session.targetRetries = nextRetries;
    session.totalTargets = nextTargets.length;
    session.completedTargets = Math.min(session.completedTargets, session.totalTargets);
    session.delayMs = delayForTargetCount(session.totalTargets);
    applyRefreshSessionRuntimeState(session);
    session.updatedAt = this.nowIso();

    if (session.completedTargets >= session.totalTargets) {
      session.status = session.failedTargets > 0 ? "failed" : "done";
      setRefreshSessionLastError(
        session,
        `Refresh finished after removing ${removedCount} pending page${removedCount === 1 ? "" : "s"} that are no longer in this feed.`,
      );
      return true;
    }

    const changes = [];
    if (removedCount > 0) {
      changes.push(`Removed ${removedCount} pending page${removedCount === 1 ? "" : "s"} that are no longer in this feed`);
    }
    if (addedCount > 0) {
      changes.push(
        `added ${addedCount} pending page${addedCount === 1 ? "" : "s"} for ${addedPersonCount} new feed member${addedPersonCount === 1 ? "" : "s"}`,
      );
    }
    if (refreshedCount > 0) {
      changes.push(
        `updated ${refreshedCount} pending page${refreshedCount === 1 ? "" : "s"} for renamed feed member${refreshedCount === 1 ? "" : "s"}`,
      );
    }
    setRefreshSessionLastError(session, `${changes.join("; ")}.`);
    return true;
  }

  private nowIso() {
    return this.now().toISOString();
  }

  private lookbackCutoffIso(lookbackDays: number) {
    return new Date(this.now().getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  }

  private toView(session: RefreshSession): RefreshSessionView {
    const runtime = refreshSessionRuntimeState(session);
    return {
      id: session.id,
      feedId: session.feedId,
      feedName: session.feedName,
      lookbackDays: session.lookbackDays,
      lookbackCutoffAt: session.lookbackCutoffAt,
      status: session.status,
      totalTargets: session.totalTargets,
      completedTargets: session.completedTargets,
      failedTargets: session.failedTargets,
      inserted: session.inserted,
      updated: session.updated,
      skippedOlder: session.skippedOlder,
      skippedUntracked: session.skippedUntracked,
      skippedInvalid: session.skippedInvalid,
      lastError: session.lastError,
      currentTarget: runtime.currentTarget,
      nextUrl: runtime.nextUrl,
      delayMs: session.delayMs,
      nextDelayMs: runtime.nextDelayMs,
      nextDelayReason: runtime.nextDelayReason,
      issueStreak: session.issueStreak,
      rateLimitStreak: session.rateLimitStreak,
      currentAttempt: runtime.currentAttempt,
      maxAttempts: MAX_TARGET_RETRIES + 1,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}

function addSessionParams(url: string, sessionId: string, targetIndex: number) {
  const parsed = new URL(url);
  parsed.searchParams.set("lefSession", sessionId);
  parsed.searchParams.set("lefTarget", String(targetIndex));
  return parsed.toString();
}

function refreshTargetsForPerson(person: { id: string; name: string; profileUrl: string }): RefreshTarget[] {
  return [
    {
      index: -1,
      personId: person.id,
      personName: person.name,
      profileUrl: person.profileUrl,
      kind: "posts",
      url: refreshTargetUrl(person.profileUrl, "posts"),
    },
    {
      index: -1,
      personId: person.id,
      personName: person.name,
      profileUrl: person.profileUrl,
      kind: "comments",
      url: refreshTargetUrl(person.profileUrl, "comments"),
    },
  ];
}

function refreshTargetKey(target: Pick<RefreshTarget, "personId" | "kind">) {
  return `${target.personId}:${target.kind}`;
}

function refreshTargetUrl(profileUrl: string, kind: RefreshTarget["kind"]) {
  return `${profileUrl}recent-activity/${kind === "comments" ? "comments" : "all"}/`;
}

function skipRemainingUnavailablePersonTargets(session: RefreshSession, targetIndex: number) {
  const target = session.targets[targetIndex];
  let skippedTargetCount = 0;
  for (let index = targetIndex; index < session.targets.length; index += 1) {
    const nextTarget = session.targets[index];
    if (!target || !nextTarget || nextTarget.personId !== target.personId) {
      break;
    }
    delete session.targetRetries[index];
    skippedTargetCount += 1;
  }
  const safeSkippedTargetCount = Math.max(1, skippedTargetCount);
  session.completedTargets = Math.min(session.completedTargets + safeSkippedTargetCount, session.totalTargets);
  return safeSkippedTargetCount;
}

function unavailableTargetMessage(target: RefreshTarget, skippedTargetCount: number, errorMessage: string) {
  if (skippedTargetCount <= 1) {
    return `${target.personName} ${target.kind} was skipped because the page is unavailable: ${errorMessage}`;
  }
  return `${target.personName} was skipped because the profile page is unavailable: ${errorMessage}. Skipped ${skippedTargetCount} pending activity pages.`;
}

function restoreRefreshSession(raw: unknown): { session: RefreshSession; normalized: boolean } | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const id = stringValue(raw.id);
  const feedId = stringValue(raw.feedId);
  const feedName = stringValue(raw.feedName) || "LinkedIn feed";
  const status = refreshSessionStatusValue(raw.status);
  const restoredTargets = Array.isArray(raw.targets)
    ? raw.targets
        .map((target) => restoreRefreshTarget(target))
        .filter((target): target is RefreshTarget => Boolean(target))
    : [];
  const restoredProgress = restoreUniqueRefreshTargets(restoredTargets, raw.completedTargets);
  const targets = restoredProgress.targets;

  if (!id || !feedId || !status || (status === "running" && targets.length === 0)) {
    return undefined;
  }

  const totalTargets =
    status === "running" ? targets.length : integerInRange(raw.totalTargets, 0, Number.MAX_SAFE_INTEGER, targets.length);
  const completedTargets =
    status === "running"
      ? Math.min(restoredProgress.completedTargets, totalTargets)
      : integerInRange(raw.completedTargets, 0, totalTargets, totalTargets);
  const failedTargets = integerInRange(raw.failedTargets, 0, completedTargets, 0);
  const lookbackDays = integerInRange(raw.lookbackDays, 1, 365, 15);
  const inserted = integerInRange(raw.inserted, 0, Number.MAX_SAFE_INTEGER, 0);
  const updated = integerInRange(raw.updated, 0, Number.MAX_SAFE_INTEGER, 0);
  const skippedOlder = integerInRange(raw.skippedOlder, 0, Number.MAX_SAFE_INTEGER, 0);
  const skippedUntracked = integerInRange(raw.skippedUntracked, 0, Number.MAX_SAFE_INTEGER, 0);
  const skippedInvalid = integerInRange(raw.skippedInvalid, 0, Number.MAX_SAFE_INTEGER, 0);
  const lastError = normalizeRefreshSessionMessage(raw.lastError);
  const delayMs = integerInRange(raw.delayMs, 500, 60000, delayForTargetCount(totalTargets));
  const issueStreak = integerInRange(raw.issueStreak, 0, ISSUE_BACKOFF_DELAYS_MS.length, 0);
  const rateLimitStreak = integerInRange(raw.rateLimitStreak, 0, RATE_LIMIT_BACKOFF_DELAYS_MS.length, 0);
  const targetRetries = restoreTargetRetries(raw.targetRetries, totalTargets);
  let restoredStatus = status;
  if (restoredStatus === "running" && completedTargets >= totalTargets) {
    restoredStatus = failedTargets > 0 ? "failed" : "done";
  }
  const createdAt = dateStringValue(raw.createdAt, "1970-01-01T00:00:00.000Z");
  const lookbackCutoffAt = dateStringValue(raw.lookbackCutoffAt, createdAt);
  const updatedAt = dateStringValue(raw.updatedAt, createdAt);

  const session: RefreshSession = {
    id,
    feedId,
    feedName,
    lookbackDays,
    lookbackCutoffAt,
    status: restoredStatus,
    targets,
    totalTargets,
    completedTargets,
    failedTargets,
    inserted,
    updated,
    skippedOlder,
    skippedUntracked,
    skippedInvalid,
    lastError,
    currentTarget: undefined,
    nextUrl: undefined,
    delayMs,
    nextDelayMs: delayMs,
    nextDelayReason: "Standard pacing",
    issueStreak,
    rateLimitStreak,
    currentAttempt: 1,
    maxAttempts: MAX_TARGET_RETRIES + 1,
    targetRetries,
    createRequestId: normalizeCreateRequestId(raw.createRequestId),
    createdAt,
    updatedAt,
  };
  const normalized =
    restoredProgress.normalized ||
    refreshTargetsWereNormalized(raw.targets, targets) ||
    refreshTargetRetriesWereNormalized(raw.targetRetries, targetRetries) ||
    id !== raw.id ||
    feedId !== raw.feedId ||
    feedName !== raw.feedName ||
    lookbackDays !== raw.lookbackDays ||
    lookbackCutoffAt !== raw.lookbackCutoffAt ||
    restoredStatus !== raw.status ||
    totalTargets !== raw.totalTargets ||
    completedTargets !== raw.completedTargets ||
    failedTargets !== raw.failedTargets ||
    inserted !== raw.inserted ||
    updated !== raw.updated ||
    skippedOlder !== raw.skippedOlder ||
    skippedUntracked !== raw.skippedUntracked ||
    skippedInvalid !== raw.skippedInvalid ||
    lastError !== raw.lastError ||
    delayMs !== raw.delayMs ||
    delayMs !== raw.nextDelayMs ||
    raw.nextDelayReason !== "Standard pacing" ||
    issueStreak !== raw.issueStreak ||
    rateLimitStreak !== raw.rateLimitStreak ||
    raw.currentAttempt !== 1 ||
    raw.maxAttempts !== MAX_TARGET_RETRIES + 1 ||
    session.createRequestId !== raw.createRequestId ||
    createdAt !== raw.createdAt ||
    updatedAt !== raw.updatedAt;
  return {
    session,
    normalized,
  };
}

function restoreUniqueRefreshTargets(restoredTargets: RefreshTarget[], rawCompletedTargets: unknown) {
  const completedTargetCount = integerInRange(rawCompletedTargets, 0, restoredTargets.length, 0);
  const completedTargetKeys = new Set(
    restoredTargets
      .slice(0, completedTargetCount)
      .map(refreshTargetKey),
  );
  const seen = new Set<string>();
  const targets: RefreshTarget[] = [];
  let completedTargets = 0;
  let normalized = false;
  for (const target of restoredTargets) {
    const key = refreshTargetKey(target);
    if (seen.has(key)) {
      normalized = true;
      continue;
    }
    seen.add(key);
    if (completedTargetKeys.has(key)) {
      completedTargets += 1;
    }
    if (target.index !== targets.length) {
      normalized = true;
    }
    targets.push({ ...target, index: targets.length });
  }
  return { targets, completedTargets, normalized };
}

function refreshTargetsWereNormalized(rawTargets: unknown, targets: RefreshTarget[]) {
  if (!Array.isArray(rawTargets)) {
    return targets.length > 0;
  }
  if (rawTargets.length !== targets.length) {
    return true;
  }
  return targets.some((target, index) => {
    const rawTarget = rawTargets[index];
    return (
      !isRecord(rawTarget) ||
      rawTarget.index !== target.index ||
      rawTarget.personId !== target.personId ||
      rawTarget.personName !== target.personName ||
      rawTarget.profileUrl !== target.profileUrl ||
      normalizeLinkedInProfileUrl(stringValue(rawTarget.profileUrl)) !== target.profileUrl ||
      refreshTargetKindValue(rawTarget.kind) !== target.kind ||
      rawTarget.url !== target.url
    );
  });
}

function refreshTargetRetriesWereNormalized(rawRetries: unknown, targetRetries: Record<number, number>) {
  if (!isRecord(rawRetries)) {
    return rawRetries !== undefined || Object.keys(targetRetries).length > 0;
  }
  return JSON.stringify(rawRetries) !== JSON.stringify(targetRetries);
}

function compactRefreshSessionForPersistence(session: RefreshSession): RefreshSession {
  if (session.status === "running") {
    return {
      ...session,
      ...refreshSessionRuntimeState(session),
    };
  }
  return {
    ...session,
    targets: [],
    targetRetries: {},
    currentTarget: undefined,
    nextUrl: undefined,
    currentAttempt: 1,
  };
}

function applyRefreshSessionRuntimeState(session: RefreshSession) {
  Object.assign(session, refreshSessionRuntimeState(session));
}

function refreshSessionRuntimeState(session: RefreshSession) {
  const currentTarget = session.status === "running" ? session.targets[session.completedTargets] : undefined;
  const retryCount = session.status === "running" && currentTarget ? (session.targetRetries[currentTarget.index] ?? 0) : 0;
  const retryDelayMs = session.status === "running" && retryCount > 0 ? retryDelayForRetryCount(retryCount) : 0;
  const adaptiveDelay = adaptiveDelayForSession(session);
  const nextDelayMs = Math.max(session.delayMs, retryDelayMs, adaptiveDelay.delayMs);
  const nextDelayReason =
    session.status !== "running"
      ? ""
      : adaptiveDelay.delayMs >= retryDelayMs && adaptiveDelay.reason
        ? adaptiveDelay.reason
        : retryDelayMs > 0
          ? "Retry backoff after a temporary page issue"
          : "Standard pacing";
  return {
    currentTarget,
    nextUrl: currentTarget && session.status === "running" ? addSessionParams(currentTarget.url, session.id, currentTarget.index) : undefined,
    nextDelayMs,
    nextDelayReason,
    currentAttempt: Math.min(retryCount + 1, MAX_TARGET_RETRIES + 1),
    maxAttempts: MAX_TARGET_RETRIES + 1,
  };
}

function restoreRefreshTarget(raw: unknown): RefreshTarget | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const personId = stringValue(raw.personId);
  const personName = stringValue(raw.personName) || "LinkedIn member";
  const profileUrl = normalizeLinkedInProfileUrl(stringValue(raw.profileUrl));
  const kind = refreshTargetKindValue(raw.kind);
  if (!personId || !profileUrl || !kind) {
    return undefined;
  }
  return {
    index: 0,
    personId,
    personName,
    profileUrl,
    kind,
    url: refreshTargetUrl(profileUrl, kind),
  };
}

function restoreTargetRetries(raw: unknown, totalTargets: number) {
  if (!isRecord(raw)) {
    return {};
  }
  const retries: Record<number, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const index = Number(key);
    if (!isSafeInteger(index) || index < 0 || index >= totalTargets) {
      continue;
    }
    const retryCount = integerInRange(value, 0, MAX_TARGET_RETRIES, 0);
    if (retryCount > 0) {
      retries[index] = retryCount;
    }
  }
  return retries;
}

function refreshTargetReport(targetIndex?: number, url?: string) {
  const bodyTargetIndex = normalizeTargetIndexValue(targetIndex);
  const urlTarget = refreshTargetIndexFromUrl(url);
  if (urlTarget.hasTargetParam && urlTarget.index === undefined) {
    return { index: undefined, conflict: true };
  }
  if (bodyTargetIndex !== undefined && urlTarget.hasTargetParam && bodyTargetIndex !== urlTarget.index) {
    return { index: undefined, conflict: true };
  }
  return { index: bodyTargetIndex ?? urlTarget.index, conflict: false };
}

function normalizeTargetIndexValue(targetIndex?: number) {
  if (isSafeInteger(targetIndex) && targetIndex >= 0) {
    return targetIndex;
  }
  return undefined;
}

function refreshTargetIndexFromUrl(url?: string) {
  if (!url) {
    return { hasTargetParam: false, index: undefined };
  }
  try {
    const parsed = new URL(url);
    const value = parsed.searchParams.get("lefTarget");
    if (value === null || value.trim() === "") {
      return { hasTargetParam: value !== null, index: undefined };
    }
    const fromUrl = Number(value);
    return {
      hasTargetParam: true,
      index: isSafeInteger(fromUrl) && fromUrl >= 0 ? fromUrl : undefined,
    };
  } catch {
    return { hasTargetParam: false, index: undefined };
  }
}

function reportedUrlMatchesTarget(url: string, target: RefreshTarget) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) {
      return false;
    }
    if (normalizeLinkedInProfileUrl(parsed.toString()) !== normalizeLinkedInProfileUrl(target.profileUrl)) {
      return false;
    }
    return activityKindFromPath(parsed.pathname) === target.kind;
  } catch {
    return false;
  }
}

function activityKindFromPath(pathname: string): RefreshTarget["kind"] | undefined {
  const cleanPath = pathname.toLowerCase();
  if (/\/recent-activity\/comments\/?$/.test(cleanPath)) {
    return "comments";
  }
  if (/\/recent-activity\/(?:all\/?)?$/.test(cleanPath)) {
    return "posts";
  }
  return undefined;
}

function delayForTargetCount(targetCount: number) {
  if (targetCount >= 160) {
    return 3600;
  }
  if (targetCount >= 80) {
    return 3200;
  }
  return DEFAULT_DELAY_MS;
}

function classifyRefreshError(message: string) {
  if (/too many requests|unusual traffic|temporarily restricted|rate limit|rate limiting/i.test(message)) {
    return "rate-limit" as const;
  }
  if (
    /profile unavailable|profile (?:is not|isn(?:['\u2019])?t) available|this linkedin profile page is unavailable|page (?:not found|doesn(?:['\u2019])?t exist|isn(?:['\u2019])?t available)|member unavailable/i.test(
      message,
    )
  ) {
    return "permanent" as const;
  }
  if (/sign in|login|checkpoint/i.test(message)) {
    return "auth" as const;
  }
  return "temporary" as const;
}

function isAuthRefreshHeartbeat(url: string, message: unknown) {
  return isLinkedInAuthGateUrl(url) && classifyRefreshError(refreshErrorClassificationText(message)) === "auth";
}

function isLinkedInAuthGateUrl(url: string) {
  try {
    const parsed = new URL(url);
    return /(^|\.)linkedin\.com$/i.test(parsed.hostname) && /\/login|checkpoint|uas\/login/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function applyRefreshIssue(session: RefreshSession, kind: ReturnType<typeof classifyRefreshError>) {
  if (kind === "permanent" || kind === "auth") {
    return;
  }
  session.issueStreak = Math.min(session.issueStreak + 1, ISSUE_BACKOFF_DELAYS_MS.length);
  if (kind === "rate-limit") {
    session.rateLimitStreak = Math.min(session.rateLimitStreak + 1, RATE_LIMIT_BACKOFF_DELAYS_MS.length);
  }
}

function recoverRefreshPacing(session: RefreshSession) {
  session.issueStreak = Math.max(0, session.issueStreak - 1);
  session.rateLimitStreak = Math.max(0, session.rateLimitStreak - 1);
}

function adaptiveDelayForSession(session: Pick<RefreshSession, "issueStreak" | "rateLimitStreak">) {
  if (session.rateLimitStreak > 0) {
    const delayMs = RATE_LIMIT_BACKOFF_DELAYS_MS[Math.min(session.rateLimitStreak, RATE_LIMIT_BACKOFF_DELAYS_MS.length) - 1];
    return {
      delayMs,
      reason: `Rate-limit cooldown after ${session.rateLimitStreak} recent signal${session.rateLimitStreak === 1 ? "" : "s"}`,
    };
  }
  if (session.issueStreak > 0) {
    const delayMs = ISSUE_BACKOFF_DELAYS_MS[Math.min(session.issueStreak, ISSUE_BACKOFF_DELAYS_MS.length) - 1];
    return {
      delayMs,
      reason: `Stability cooldown after ${session.issueStreak} recent issue${session.issueStreak === 1 ? "" : "s"}`,
    };
  }
  return { delayMs: 0, reason: "" };
}

function refreshPacingNote(session: RefreshSession) {
  const adaptiveDelay = adaptiveDelayForSession(session);
  return adaptiveDelay.reason ? ` ${adaptiveDelay.reason}.` : "";
}

function retryDelayForRetryCount(retryCount: number) {
  return RETRY_DELAYS_MS[Math.min(Math.max(retryCount, 1), RETRY_DELAYS_MS.length) - 1];
}

function normalizeRefreshError(error: string | undefined) {
  const clean = String(error || "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, MAX_REFRESH_ERROR_MESSAGE_LENGTH) : "";
}

function refreshErrorClassificationText(error: unknown, fallback = "") {
  const clean = String(error || fallback || "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, MAX_REFRESH_CLASSIFICATION_TEXT_LENGTH) : fallback;
}

function normalizeRefreshHeartbeatMessage(message: string | undefined) {
  const clean = String(message || "").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, MAX_REFRESH_ERROR_MESSAGE_LENGTH) : "Refresh is still waiting for LinkedIn.";
}

function setRefreshSessionLastError(session: Pick<RefreshSession, "lastError">, message: unknown) {
  session.lastError = normalizeRefreshSessionMessage(message);
}

function normalizeRefreshSessionMessage(message: unknown) {
  const clean = String(message || "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, MAX_REFRESH_SESSION_MESSAGE_LENGTH) : "";
}

function normalizeCreateRequestId(requestId: unknown) {
  return normalizeRefreshRequestId(requestId, 120) || undefined;
}

function refreshTargetReportIdempotencyKey(sessionId: string, requestId: unknown) {
  const cleanSessionId = normalizeRefreshRequestId(sessionId, 48);
  const maxRequestIdLength = Math.max(
    8,
    MAX_REFRESH_TARGET_REPLAY_KEY_LENGTH - REFRESH_TARGET_REPLAY_KEY_PREFIX.length - cleanSessionId.length - 1,
  );
  const cleanRequestId = normalizeRefreshRequestId(requestId, maxRequestIdLength);
  return cleanRequestId ? `${REFRESH_TARGET_REPLAY_KEY_PREFIX}${cleanSessionId}.${cleanRequestId}` : "";
}

function normalizeRefreshRequestId(requestId: unknown, maxLength: number) {
  const clean = String(requestId || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length <= maxLength) {
    return clean;
  }
  const hash = createHash("sha256").update(clean).digest("hex").slice(0, 20);
  const prefixLength = Math.max(8, maxLength - hash.length - 1);
  return `${clean.slice(0, prefixLength)}.${hash}`;
}

function shouldReturnLiveRefreshTargetReplay(
  previousResult: RefreshSessionView,
  liveSession: RefreshSession,
  targetIndex: number | undefined,
) {
  if (previousResult.status !== "running" || targetIndex === undefined) {
    return false;
  }

  const previousCurrentTarget = previousResult.currentTarget;
  if (!previousCurrentTarget || previousCurrentTarget.index !== targetIndex) {
    return false;
  }

  if (liveSession.completedTargets > targetIndex) {
    return true;
  }

  if (previousResult.currentAttempt <= 1) {
    return false;
  }

  if (liveSession.status !== "running" || liveSession.completedTargets !== targetIndex) {
    return false;
  }

  const liveRetryCount = liveSession.targetRetries[targetIndex] ?? 0;
  return liveRetryCount + 1 > previousResult.currentAttempt;
}

function isRefreshSessionViewReplay(value: unknown, sessionId: string): value is RefreshSessionView {
  if (!isRecord(value)) {
    return false;
  }
  if (
    stringValue(value.id) !== sessionId ||
    !stringValue(value.feedId) ||
    !stringValue(value.feedName) ||
    !refreshSessionStatusValue(value.status)
  ) {
    return false;
  }
  const totalTargets = nonNegativeInteger(value.totalTargets);
  const completedTargets = nonNegativeInteger(value.completedTargets);
  const failedTargets = nonNegativeInteger(value.failedTargets);
  if (
    totalTargets === undefined ||
    completedTargets === undefined ||
    failedTargets === undefined ||
    completedTargets > totalTargets ||
    failedTargets > completedTargets
  ) {
    return false;
  }
  if (integerInRangeValue(value.lookbackDays, 1, MAX_FEED_LOOKBACK_DAYS) === undefined) {
    return false;
  }
  for (const key of [
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
    if (nonNegativeInteger(value[key]) === undefined) {
      return false;
    }
  }
  const currentAttempt = nonNegativeInteger(value.currentAttempt);
  const maxAttempts = nonNegativeInteger(value.maxAttempts);
  const status = refreshSessionStatusValue(value.status);
  if (
    currentAttempt === undefined ||
    maxAttempts === undefined ||
    currentAttempt < 1 ||
    maxAttempts < 1 ||
    currentAttempt > maxAttempts
  ) {
    return false;
  }
  if ((status === "done" || status === "failed") && completedTargets !== totalTargets) {
    return false;
  }
  if (
    !dateStringValue(value.lookbackCutoffAt, "") ||
    typeof value.lastError !== "string" ||
    typeof value.nextDelayReason !== "string" ||
    !dateStringValue(value.createdAt, "") ||
    !dateStringValue(value.updatedAt, "")
  ) {
    return false;
  }
  const currentTarget = value.currentTarget;
  if (currentTarget !== undefined && !isRefreshTargetReplay(currentTarget)) {
    return false;
  }
  if (status === "running") {
    if (
      !isRefreshTargetReplay(currentTarget) ||
      currentTarget.index !== completedTargets ||
      !refreshSessionNextUrlMatchesReplayTarget(value.nextUrl, currentTarget, sessionId)
    ) {
      return false;
    }
  } else {
    if (currentTarget !== undefined || value.nextUrl !== undefined) {
      return false;
    }
  }
  if (value.createdByRequest !== undefined && typeof value.createdByRequest !== "boolean") {
    return false;
  }
  return true;
}

function isRefreshTargetReplay(value: unknown): value is RefreshTarget {
  if (!isRecord(value)) {
    return false;
  }
  return (
    nonNegativeInteger(value.index) !== undefined &&
    typeof value.personId === "string" &&
    typeof value.personName === "string" &&
    Boolean(normalizeLinkedInProfileUrl(stringValue(value.profileUrl))) &&
    Boolean(refreshTargetKindValue(value.kind)) &&
    refreshTargetUrlMatchesReplayTarget(value)
  );
}

function refreshTargetUrlMatchesReplayTarget(value: Record<string, unknown>) {
  const profileUrl = normalizeLinkedInProfileUrl(stringValue(value.profileUrl));
  const kind = refreshTargetKindValue(value.kind);
  const url = stringValue(value.url);
  if (!profileUrl || !kind || !url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return normalizeLinkedInProfileUrl(parsed.toString()) === profileUrl && activityKindFromPath(parsed.pathname) === kind;
  } catch {
    return false;
  }
}

function refreshSessionNextUrlMatchesReplayTarget(url: unknown, target: RefreshTarget, sessionId: string) {
  if (typeof url !== "string") {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (
      normalizeLinkedInProfileUrl(parsed.toString()) !== normalizeLinkedInProfileUrl(target.profileUrl) ||
      activityKindFromPath(parsed.pathname) !== target.kind
    ) {
      return false;
    }
    return parsed.searchParams.get("lefSession") === sessionId && parsed.searchParams.get("lefTarget") === String(target.index);
  } catch {
    return false;
  }
}

function normalizeCaptureResult(result: Partial<CaptureResult> | undefined) {
  if (!result) {
    return undefined;
  }
  const received = normalizeOptionalCaptureReceived(result.received);
  const maxCount = received ?? MAX_CAPTURE_ITEMS_PER_REQUEST;
  const normalized = {
    inserted: normalizeCaptureCount(result.inserted, maxCount),
    updated: normalizeCaptureCount(result.updated, maxCount),
    skippedOlder: normalizeCaptureCount(result.skippedOlder, maxCount),
    skippedUntracked: normalizeCaptureCount(result.skippedUntracked, maxCount),
    skippedInvalid: normalizeCaptureCount(result.skippedInvalid, maxCount),
  };
  if (received !== undefined && captureResultProcessedCount(normalized) > received) {
    return emptyNormalizedCaptureResult();
  }
  return normalized;
}

function normalizeOptionalCaptureReceived(value: unknown) {
  return value === undefined ? undefined : normalizeCaptureCount(value, Number.MAX_SAFE_INTEGER);
}

function captureResultProcessedCount(result: ReturnType<typeof emptyNormalizedCaptureResult>) {
  return result.inserted + result.updated + result.skippedOlder + result.skippedUntracked + result.skippedInvalid;
}

function emptyNormalizedCaptureResult() {
  return {
    inserted: 0,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  };
}

function compareRefreshSessionsNewestFirst(first: RefreshSession, second: RefreshSession) {
  return (
    second.createdAt.localeCompare(first.createdAt) ||
    refreshSessionStatusOrder(first.status) - refreshSessionStatusOrder(second.status) ||
    second.updatedAt.localeCompare(first.updatedAt) ||
    first.id.localeCompare(second.id)
  );
}

function uniqueRefreshFeedIds(feedIds: string[]) {
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const feedId of feedIds) {
    const cleanFeedId = String(feedId || "").trim();
    if (cleanFeedId && !seen.has(cleanFeedId)) {
      uniqueIds.push(cleanFeedId);
      seen.add(cleanFeedId);
    }
  }
  return uniqueIds;
}

function refreshSessionStatusOrder(status: RefreshSessionStatus) {
  return status === "running" ? 0 : 1;
}

function normalizeCaptureCount(value: unknown, maximum = MAX_CAPTURE_ITEMS_PER_REQUEST) {
  const count = Number(value);
  if (!Number.isFinite(count)) {
    return 0;
  }
  return Math.max(0, Math.min(maximum, Math.round(count)));
}

function nonNegativeInteger(value: unknown) {
  return isSafeInteger(value) && value >= 0 ? value : undefined;
}

function integerInRangeValue(value: unknown, min: number, max: number) {
  return isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function refreshSessionStatusValue(value: unknown): RefreshSessionStatus | undefined {
  return value === "running" || value === "done" || value === "canceled" || value === "failed" ? value : undefined;
}

function refreshTargetKindValue(value: unknown): RefreshTarget["kind"] | undefined {
  return value === "posts" || value === "comments" ? value : undefined;
}

function integerInRange(value: unknown, min: number, max: number, fallback: number) {
  if (!isSafeInteger(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function dateStringValue(value: unknown, fallback: string) {
  const timestamp = new Date(stringValue(value)).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
