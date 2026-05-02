// Unofficial Glints mobile API client. Reverse-engineered from the Android app
// v1.106.2 traffic captured via HTTP Toolkit.

import {
  Q_GET_ME,
  Q_GET_ENABLED_FEATURE_FLAGS,
  Q_CHECK_VERSION,
  Q_ONE_TAP_APPLY_QUESTIONS,
  Q_GET_BOOKMARKED_JOBS,
  Q_IS_QUALIFIED_TO_APP_REVIEW,
  Q_GET_MESSAGING_INTRO_MESSAGE,
  M_UPDATE_ME,
  M_UPDATE_MESSAGING_INTRO_MESSAGE,
} from "./queries.js";
import type {
  ApplyAnswer,
  ApplyResponse,
  ChatChannelStartResponse,
  ChatMessageResponse,
  EAppPlatform,
  MeFragment,
  MessagingIntroMessage,
  OAuthTokenResponse,
  OneTapApplyQuestionsResponse,
  RecommendedJob,
  RecommendedJobsResponse,
  UserRole,
} from "./types.js";

export interface GlintsClientOptions {
  username?: string;
  password?: string;
  deviceId: string;
  accessToken?: string;
  refreshToken?: string;
  baseUrl?: string;
  chatUrl?: string;
  clientId?: string;
  appVersion?: string;
  appPlatform?: EAppPlatform;
  osVersion?: string;
  countryCode?: string;
  language?: string;
  userAgent?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  role?: UserRole;
  host?: "api" | "chat";
  retryOn401?: boolean;
  op?: string;
}

const DEFAULTS = {
  baseUrl: "https://api.glints.com",
  chatUrl: "https://chat.glints.com",
  clientId: "5e5c566a-5ac6-44e3-b286-3246fbc97bfb",
  appVersion: "1.106.2",
  appPlatform: "ANDROID" as EAppPlatform,
  osVersion: "9",
  countryCode: "ID",
  language: "id",
  userAgent: "Dart/3.9 (dart:io)",
  timeoutMs: 30_000,
};

export class GlintsApiError extends Error {
  status?: number;
  body?: unknown;
  op?: string;
  constructor(message: string, opts: { status?: number; body?: unknown; op?: string } = {}) {
    super(message);
    this.name = "GlintsApiError";
    this.status = opts.status;
    this.body = opts.body;
    this.op = opts.op;
  }
}

export class GlintsClient {
  username?: string;
  password?: string;
  deviceId: string;
  accessToken: string | null;
  refreshToken: string | null;

  baseUrl: string;
  chatUrl: string;
  clientId: string;
  appVersion: string;
  appPlatform: EAppPlatform;
  osVersion: string;
  countryCode: string;
  language: string;
  userAgent: string;
  timeoutMs: number;

  private _fetch: typeof fetch;

  constructor(opts: GlintsClientOptions) {
    if (!opts.deviceId) throw new Error("GlintsClient: deviceId is required");
    this.username = opts.username;
    this.password = opts.password;
    this.deviceId = opts.deviceId;
    this.accessToken = opts.accessToken ?? null;
    this.refreshToken = opts.refreshToken ?? null;

    this.baseUrl = opts.baseUrl ?? DEFAULTS.baseUrl;
    this.chatUrl = opts.chatUrl ?? DEFAULTS.chatUrl;
    this.clientId = opts.clientId ?? DEFAULTS.clientId;
    this.appVersion = opts.appVersion ?? DEFAULTS.appVersion;
    this.appPlatform = opts.appPlatform ?? DEFAULTS.appPlatform;
    this.osVersion = opts.osVersion ?? DEFAULTS.osVersion;
    this.countryCode = opts.countryCode ?? DEFAULTS.countryCode;
    this.language = opts.language ?? DEFAULTS.language;
    this.userAgent = opts.userAgent ?? DEFAULTS.userAgent;
    this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;

    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error("GlintsClient: fetch is unavailable — use Node 18+");
    this._fetch = f;
  }

  // ---------- low-level ----------

  private _baseHeaders({ json = false, role }: { json?: boolean; role?: UserRole } = {}): Record<string, string> {
    const h: Record<string, string> = {
      "user-agent": this.userAgent,
      "accept-encoding": "gzip",
      "accept-language": this.language,
      "x-app-platform": this.appPlatform,
      "x-app-version": this.appVersion,
      "x-os-version": this.osVersion,
      "x-glints-country-code": this.countryCode,
      "x-device-id": this.deviceId,
    };
    if (json) h["content-type"] = "application/json";
    if (role) h["x-user-role"] = role;
    if (this.accessToken) h.authorization = `Bearer ${this.accessToken}`;
    return h;
  }

  async _request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, headers, role, host = "api", retryOn401 = true, op } = opts;
    const base = host === "chat" ? this.chatUrl : this.baseUrl;
    const url = path.startsWith("http") ? path : `${base}${path}`;
    const isJson = body !== undefined && typeof body !== "string";

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this._fetch(url, {
        method,
        headers: { ...this._baseHeaders({ json: isJson, role }), ...(headers ?? {}) },
        body: isJson ? JSON.stringify(body) : (body as string | undefined),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }

    if (res.status === 401 && retryOn401 && this.username && this.password) {
      await this.login();
      return this._request(path, { ...opts, retryOn401: false });
    }

    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

    if (!res.ok) {
      throw new GlintsApiError(`HTTP ${res.status} ${method} ${url}`, {
        status: res.status,
        body: parsed,
        op,
      });
    }
    return parsed as T;
  }

  private async _gql<T>(path: string, operationName: string, query: string, variables: Record<string, unknown> = {}, opts: { role?: UserRole } = {}): Promise<T> {
    const data = await this._request<{ data?: T; errors?: unknown }>(`${path}?op=${operationName}`, {
      method: "POST",
      body: { operationName, variables, query },
      role: opts.role,
      op: operationName,
    });
    if (data && (data as { errors?: unknown }).errors) {
      throw new GlintsApiError(`GraphQL error in ${operationName}`, {
        body: (data as { errors: unknown }).errors,
        op: operationName,
      });
    }
    return (data?.data) as T;
  }

  gql<T = unknown>(operationName: string, query: string, variables?: Record<string, unknown>, opts?: { role?: UserRole }): Promise<T> {
    return this._gql<T>("/api/graphql", operationName, query, variables, opts);
  }

  gqlV2<T = unknown>(operationName: string, query: string, variables?: Record<string, unknown>, opts?: { role?: UserRole }): Promise<T> {
    return this._gql<T>("/v2/api/graphql", operationName, query, variables, opts);
  }

  // ---------- auth ----------

  async login(): Promise<OAuthTokenResponse> {
    if (!this.username || !this.password) {
      throw new Error("GlintsClient.login: username and password required");
    }
    const prev = this.accessToken;
    this.accessToken = null;
    try {
      const data = await this._request<OAuthTokenResponse>("/oauth2/token", {
        method: "POST",
        body: {
          username: this.username,
          password: this.password,
          grant_type: "password",
          client_id: this.clientId,
          sessionId: this.deviceId,
        },
        retryOn401: false,
        op: "login",
      });
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token ?? null;
      return data;
    } catch (e) {
      this.accessToken = prev;
      throw e;
    }
  }

  async ensureAuth(): Promise<void> {
    if (!this.accessToken) await this.login();
  }

  // ---------- profile ----------

  async getMe(): Promise<MeFragment> {
    await this.ensureAuth();
    const d = await this.gql<{ getMe: MeFragment }>("getMe", Q_GET_ME);
    return d.getMe;
  }

  async updateMe(input: Record<string, unknown>): Promise<unknown> {
    await this.ensureAuth();
    return this.gql("updateMe", M_UPDATE_ME, { me: input });
  }

  async getEnabledFeatureFlags(): Promise<unknown> {
    return this.gqlV2("getEnabledFeatureFlags", Q_GET_ENABLED_FEATURE_FLAGS);
  }

  async checkAppVersion(version = this.appVersion, platform: EAppPlatform = this.appPlatform): Promise<unknown> {
    return this.gql("checkMobileAppVersionCompatibility", Q_CHECK_VERSION, { version, platform });
  }

  // ---------- jobs ----------

  async getRecommendedJobs(args: { page?: number; pageSize?: number; pageName?: string; recentlyAdded?: boolean } = {}): Promise<RecommendedJobsResponse> {
    await this.ensureAuth();
    const { page = 1, pageSize = 10, pageName = "for_you", recentlyAdded = false } = args;
    const qs = new URLSearchParams({
      pageSize: String(pageSize),
      page: String(page),
      page_name: pageName,
      recentlyAdded: String(recentlyAdded),
    });
    return this._request<RecommendedJobsResponse>(`/v2/api/v3/me/recommend/es/jobs?${qs}`, {
      role: "CANDIDATE",
      op: "getRecommendedJobs",
    });
  }

  async getJob(jobId: string, opts: { source?: string; traceInfo?: string } = {}): Promise<{ data: RecommendedJob }> {
    await this.ensureAuth();
    const { source = "for_you", traceInfo } = opts;
    const qs = new URLSearchParams({ source });
    if (traceInfo) qs.set("traceInfo", traceInfo);
    return this._request(`/v2/api/job/${jobId}?${qs}`, {
      role: "CANDIDATE",
      op: "getJob",
    });
  }

  async getOneTapApplyQuestions(jobId: string): Promise<OneTapApplyQuestionsResponse> {
    await this.ensureAuth();
    return this.gqlV2("getOneTapJobApplyQuestions", Q_ONE_TAP_APPLY_QUESTIONS, { jobId });
  }

  async getNearbyJobs(args: { latitude: number; longitude: number; page?: number; pageSize?: number; jobCategoryId?: string }): Promise<RecommendedJobsResponse> {
    await this.ensureAuth();
    const { latitude, longitude, page = 1, pageSize = 10, jobCategoryId } = args;
    const qs = new URLSearchParams({
      pageSize: String(pageSize),
      page: String(page),
      latitude: String(latitude),
      longitude: String(longitude),
    });
    if (jobCategoryId) qs.set("jobCategoryId", jobCategoryId);
    return this._request(`/v2/api/nearby/jobs?${qs}`, {
      role: "CANDIDATE",
      op: "getNearbyJobs",
    });
  }

  async applyToJob(jobId: string, args: { resume: string; answers?: ApplyAnswer[]; source?: string; traceInfo?: string }): Promise<ApplyResponse> {
    await this.ensureAuth();
    const { resume, answers = [], source = "FOR_YOU", traceInfo } = args;
    if (!resume) throw new Error("applyToJob: resume id required");
    const body: Record<string, unknown> = {
      data: { resume, answers },
      source,
    };
    if (traceInfo) body.traceInfo = traceInfo;
    return this._request<ApplyResponse>(`/v2/api/v2/jobs/${jobId}/applications`, {
      method: "POST",
      role: "CANDIDATE",
      body,
      op: "applyToJob",
    });
  }

  // ---------- bookmarks ----------

  async getExperiences(source = "PROFILE"): Promise<{ data?: { works?: Array<{ jobTitle?: string; jobRoleName?: string; orgName?: string; skills?: Array<{ name: string }> }> } } & Record<string, unknown>> {
    await this.ensureAuth();
    const qs = new URLSearchParams({ source });
    return this._request(`/v2/api/experiences?${qs}`, {
      role: "CANDIDATE",
      op: "getExperiences",
    });
  }

  async jobRolePreferences(): Promise<{ jobRolePreferences: Array<{ id: string; HierarchicalJobCategoryId?: string; hierarchicalJobCategory?: { id: string; name: string; level: number } }> }> {
    await this.ensureAuth();
    const { Q_JOB_ROLE_PREFERENCES_FULL } = await import("./queries.js");
    return this.gql("jobRolePreferences", Q_JOB_ROLE_PREFERENCES_FULL);
  }

  async getBookmarkedJobs(args: { limit?: number; offset?: number } = {}): Promise<{ getBookmarkedJobs: { totalJobs: number } }> {
    await this.ensureAuth();
    const { limit = 50, offset = 0 } = args;
    return this.gqlV2("getBookmarkedJobs", Q_GET_BOOKMARKED_JOBS, { data: { limit, offset } });
  }

  async isQualifiedToAppReview(actionType = "APPLY_JOB"): Promise<unknown> {
    return this.gql("isQualifiedToAppReview", Q_IS_QUALIFIED_TO_APP_REVIEW, { actionType });
  }

  // ---------- chat (post-apply) ----------

  /**
   * Returns the user's saved intro message (the same template the app sends as
   * the first message after applying).
   */
  async getMessagingIntroMessage(): Promise<MessagingIntroMessage | null> {
    await this.ensureAuth();
    const d = await this.gql<{ getMessagingIntroMessage: MessagingIntroMessage | null }>(
      "getMessagingIntroMessage", Q_GET_MESSAGING_INTRO_MESSAGE
    );
    return d?.getMessagingIntroMessage ?? null;
  }

  async updateMessagingIntroMessage(message: string): Promise<unknown> {
    await this.ensureAuth();
    return this.gql("updateMessagingIntroMessage", M_UPDATE_MESSAGING_INTRO_MESSAGE, { message });
  }

  /**
   * Open the chat channel for an application (returns the channel id, an
   * auto-attached CV exchange request, and the company member info).
   *
   * `applicationId` is the `data.id` from `applyToJob`'s response.
   */
  async startChatChannel(applicationId: string): Promise<ChatChannelStartResponse> {
    await this.ensureAuth();
    return this._request<ChatChannelStartResponse>("/api/channel/start", {
      method: "POST",
      role: "CANDIDATE",
      host: "chat",
      body: { applicationID: applicationId },
      op: "startChatChannel",
    });
  }

  async getChatMessages(channelId: string, { limit = 1000 }: { limit?: number } = {}): Promise<unknown> {
    await this.ensureAuth();
    const qs = new URLSearchParams({ channelID: channelId, limit: String(limit) });
    return this._request(`/api/messages?${qs}`, {
      role: "CANDIDATE",
      host: "chat",
      op: "getChatMessages",
    });
  }

  /**
   * Send a chat message. The Android app uses `type: 'INTRO_MESSAGE'` for the
   * first auto-message after apply, and a plain text type for subsequent
   * messages.
   */
  async sendChatMessage(args: {
    channelId: string;
    text: string;
    type?: "INTRO_MESSAGE" | "TEXT" | string;
  }): Promise<ChatMessageResponse> {
    await this.ensureAuth();
    const { channelId, text, type = "INTRO_MESSAGE" } = args;
    return this._request<ChatMessageResponse>("/api/message", {
      method: "POST",
      role: "CANDIDATE",
      host: "chat",
      body: {
        channelID: channelId,
        contentType: "TEXT",
        content: {
          text,
          type,
          lokaliseID: null,
          namedArgs: null,
          extra: null,
          runtimeType: "text",
        },
      },
      op: "sendChatMessage",
    });
  }

  // ---------- session ----------

  exportSession() {
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      deviceId: this.deviceId,
    };
  }

  importSession(s: { accessToken?: string | null; refreshToken?: string | null; deviceId?: string }) {
    if (s.accessToken !== undefined) this.accessToken = s.accessToken;
    if (s.refreshToken !== undefined) this.refreshToken = s.refreshToken;
    if (s.deviceId) this.deviceId = s.deviceId;
  }
}

export default GlintsClient;
