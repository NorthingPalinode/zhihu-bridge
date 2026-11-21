import type { Check, Decision, Evidence, Term, Variant } from "./types";

export type BridgeColor = "red" | "amber" | "violet" | "brand" | "slate";
export type BridgeMarker = "✕" | "!" | "✓" | "?";

export interface BridgeRow {
  term: Term;
  landing: string;
  removed: boolean;
  removedSpan: string | null;
  check: Check | undefined;
  supported: boolean;
  color: BridgeColor;
  marker: BridgeMarker;
  dashed: boolean;
}

const AVOID_CLAUSE = /^(?:避免|不要写|不要用|不写|不用|勿用|切忌|禁用|avoid\b|do not use\b|don't use\b)/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findInText(candidate: string, haystack: string): string | null {
  const clean = candidate.trim().replace(/^["'`“”‘’「」『』(\[]+|["'`“”‘’「」『』)\].:;!?]+$/g, "").trim();
  if (clean.length < 2) return null;
  if (/^[\p{Script=Latin}0-9\s'’\-/]+$/u.test(clean)) {
    const pat = new RegExp(`(?<![\\p{Script=Latin}0-9])${escapeRegex(clean)}(?![\\p{Script=Latin}0-9])`, "iu");
    const m = haystack.match(pat);
    return m ? m[0] : null;
  }
  const idx = haystack.toLowerCase().indexOf(clean.toLowerCase());
  return idx >= 0 ? haystack.slice(idx, idx + clean.length) : null;
}

/** 从决策 choice 文案中提取实际落在译文里的目标语言短语，跳过“避免 XXX”类否定子句。 */
export function extractPhraseFromChoice(choice: string, haystack: string): string | null {
  if (!choice || !haystack) return null;
  const candidates: string[] = [];
  for (const clause of choice.split(/[，。；;,\n]+/)) {
    const trimmed = clause.trim();
    if (!trimmed || AVOID_CLAUSE.test(trimmed)) continue;
    const latin = trimmed.match(/[\p{Script=Latin}0-9][\p{Script=Latin}0-9\s'’\-/]*[\p{Script=Latin}0-9]|[\p{Script=Latin}0-9]{2,}/gu) ?? [];
    for (const part of latin) {
      for (const sub of part.split(/\s*\/\s*|\s+or\s+/i)) {
        const s = sub.trim();
        if (s.length >= 2) candidates.push(s);
      }
    }
    const quoted = trimmed.match(/[「『“"]([^」』”"]+)[」』”"]/g) ?? [];
    for (const q of quoted) {
      const inner = q.slice(1, -1).trim();
      if (inner.length >= 2) candidates.push(inner);
    }
    const nonLatin = trimmed.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Cyrillic}][\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Cyrillic}\s・ー\-]*/gu) ?? [];
    for (const part of nonLatin) {
      const s = part.trim();
      if (s.length >= 2) candidates.push(s);
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  for (const cand of candidates) {
    const hit = findInText(cand, haystack);
    if (hit) return hit;
  }
  return null;
}

export function buildBridgeRows(
  variant: Variant,
  terms: Term[],
  decisions: Decision[],
  evidence: Evidence[],
): BridgeRow[] {
  const fullText = variant.segments.map((s) => s.text).join("").trim();
  const evById = new Map(evidence.map((e) => [e.id, e]));

  return terms.map((term) => {
    const dedicated = variant.segments.filter((s) => s.termIds.length === 1 && s.termIds[0] === term.id);
    const shared = variant.segments.filter((s) => s.termIds.length > 1 && s.termIds.includes(term.id));
    const termDecisions = decisions.filter(
      (d) => d.termId === term.id && (!d.levels.length || d.levels.includes(variant.level)),
    );
    const termChecks = variant.checks.filter((c) => c.termId === term.id && c.status !== "pass");
    const check = termChecks.find((c) => c.status === "fail") ?? termChecks[0];

    let landing = "";
    let removed = false;
    let removedSpan: string | null = null;

    if (dedicated.length > 0) {
      landing = dedicated.map((s) => s.text.trim()).filter(Boolean).join(" … ");
    } else if (shared.length > 0) {
      const sharedText = shared.map((s) => s.text.trim()).filter(Boolean).join(" … ");
      const fromChoice = termDecisions
        .map((d) => extractPhraseFromChoice(d.choice, sharedText))
        .find((x): x is string => Boolean(x));
      if (fromChoice) {
        landing = fromChoice;
      } else {
        const coversMostOfSentence =
          fullText.length > 0 && sharedText.length > 50 && sharedText.length >= fullText.length * 0.6;
        landing = coversMostOfSentence && termDecisions[0]?.choice.trim()
          ? termDecisions[0].choice.trim()
          : sharedText;
      }
    } else if (check?.status === "fail" && check.action === "remove") {
      removed = true;
      removedSpan = check.span || term.surface;
    } else if (termDecisions.length > 0) {
      const fromChoice = termDecisions
        .map((d) => extractPhraseFromChoice(d.choice, fullText))
        .find((x): x is string => Boolean(x));
      landing = fromChoice ?? termDecisions[0].choice.trim();
    }

    const hasValidEvidence = (ids: string[], requireTermMatch: boolean): boolean =>
      ids.some((id) => {
        const ev = evById.get(id);
        if (!ev || ev.status === "rejected") return false;
        if (!requireTermMatch) return true;
        return ev.termIds.length === 0 || ev.termIds.includes(term.id);
      });

    const supported =
      dedicated.some((s) => hasValidEvidence(s.evidenceIds, false)) ||
      shared.some((s) => hasValidEvidence(s.evidenceIds, true)) ||
      termDecisions.some((d) => hasValidEvidence(d.evidenceIds, false));

    const color: BridgeColor =
      check?.status === "fail"
        ? "red"
        : check
          ? "amber"
          : supported
            ? term.kind === "culture"
              ? "violet"
              : "brand"
            : "slate";
    const marker: BridgeMarker =
      color === "red" ? "✕" : color === "amber" ? "!" : color === "slate" ? "?" : "✓";
    const dashed = color === "slate" || color === "amber";

    return { term, landing, removed, removedSpan, check, supported, color, marker, dashed };
  });
}
