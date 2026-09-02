// Answers the one-tap-apply profile questions using the user's config bank.
// If a question name is unknown and the question is required, the application
// will be skipped (the engine logs it).

import type { Config } from "./config.js";
import type { ApplyAnswer, OneTapProfileQuestion, HiringGeneratedQuestion } from "./types.js";

export interface AnswerPlan {
  answers: ApplyAnswer[];
  missing: OneTapProfileQuestion[];
}

export function buildAnswers(questions: OneTapProfileQuestion[], bank: Config["answers"]): AnswerPlan {
  const answers: ApplyAnswer[] = [];
  const missing: OneTapProfileQuestion[] = [];

  for (const q of questions) {
    if (q.isAlreadyFilled) continue;

    const provided = bank[q.name];
    if (provided === undefined || provided === null) {
      // Required vs optional is signalled by responseRequirement === 'REQUIRED' in
      // captured traffic. Anything we don't know how to answer goes in `missing`.
      missing.push(q);
      continue;
    }
    answers.push({ QuestionName: q.name, answer: provided as ApplyAnswer["answer"] });
  }

  return { answers, missing };
}

export function isBlocking(missing: OneTapProfileQuestion[]): boolean {
  return missing.some((q) => (q.responseRequirement ?? "REQUIRED") === "REQUIRED");
}

// Auto-pick answers for job screening questions (getJobHiringQuestions.generatedQuestions).
// Strategy: SINGLE_CHOICE -> last responseOption (usually the "best": "More than 5 years",
// "Expert"); MULTIPLE_CHOICE -> all options. A per-question override in the config bank
// (keyed by question name) wins over the auto-pick.
export function pickGeneratedAnswers(
  generated: HiringGeneratedQuestion[],
  overrides: Config["answers"] = {},
): ApplyAnswer[] {
  const out: ApplyAnswer[] = [];
  for (const q of generated) {
    if (q.name in overrides) {
      out.push({ QuestionName: q.name, answer: overrides[q.name] as ApplyAnswer["answer"] });
      continue;
    }
    const opts = (q.responseOptions ?? []).map((o) => o.value).filter((v) => v != null);
    if (opts.length === 0) continue;
    // Drop "Other / not listed" catch-alls: selecting them can force a free-text follow-up.
    const isCatchAll = (v: string) => /not listed|^other\b/i.test(v);
    let answer: ApplyAnswer["answer"];
    if (q.type === "MULTIPLE_CHOICE") {
      const multi = opts.filter((v) => !isCatchAll(v));
      answer = multi.length > 0 ? multi : opts;
    } else {
      answer = opts[opts.length - 1]!;
    }
    out.push({ QuestionName: q.name, answer });
  }
  return out;
}
