// Answers the one-tap-apply profile questions using the user's config bank.
// If a question name is unknown and the question is required, the application
// will be skipped (the engine logs it).

import type { Config } from "./config.js";
import type { ApplyAnswer, OneTapProfileQuestion } from "./types.js";

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
