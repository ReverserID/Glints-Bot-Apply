import type { Config } from "./config.js";
import type { RecommendedJob } from "./types.js";

export interface FilterDecision {
  ok: boolean;
  reason?: string;
}

export function decideJob(job: RecommendedJob, cfg: Config["filters"]): FilterDecision {
  if (cfg.skipFraudFlagged && job.fraudReportFlag) {
    return { ok: false, reason: "fraud-flagged" };
  }
  if (cfg.skipApplied && job.isApplied) {
    return { ok: false, reason: "already-applied" };
  }
  if (job.status && job.status !== "OPEN") {
    return { ok: false, reason: `status=${job.status}` };
  }
  if (cfg.remoteOnly && !job.isRemote) {
    return { ok: false, reason: "not-remote" };
  }
  if (cfg.jobTypes.length && !cfg.jobTypes.includes(job.type)) {
    return { ok: false, reason: `type=${job.type}` };
  }
  if (cfg.workArrangements.length && !cfg.workArrangements.includes(job.workArrangementOption)) {
    return { ok: false, reason: `arrangement=${job.workArrangementOption}` };
  }
  if (typeof job.minYearsOfExperience === "number" && job.minYearsOfExperience > cfg.minYearsOfExperienceMax) {
    return { ok: false, reason: `min-exp=${job.minYearsOfExperience}` };
  }

  const haystack = `${job.title ?? ""} ${job.Company?.displayName ?? ""}`.toLowerCase();
  if (cfg.excludeKeywords.length) {
    const hit = cfg.excludeKeywords.find((k) => k && haystack.includes(k.toLowerCase()));
    if (hit) return { ok: false, reason: `excluded:${hit}` };
  }
  if (cfg.includeKeywords.length) {
    const ok = cfg.includeKeywords.some((k) => k && haystack.includes(k.toLowerCase()));
    if (!ok) return { ok: false, reason: "no-include-keyword" };
  }
  return { ok: true };
}
