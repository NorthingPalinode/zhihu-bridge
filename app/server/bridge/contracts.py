"""前后端契约（V6 §6.4）。导出到 app/contracts/*.schema.json，前端类型见 web/src/lib/types.ts。

相对 V6 的扩展字段（均为诚实标注或展示所需，不改变 V6 语义）：
- mode 增加 "dev_stub"；新增 provenance: real_run | dev_stub —— 开发占位必须与回放、实时严格区分。
- Decision 增加 title / levels；Term 增加 kind；Check 增加 label / termId；RunSnapshot 增加 notices / frozenAt。
- QuestionDraft 增加 existingNote / recommendationReason / provenance。
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Level = Literal["literal", "plain", "light", "balanced", "technical", "genre", "single"]
Mode = Literal["live", "replay", "degraded", "dev_stub"]
Provenance = Literal["real_run", "dev_stub"]
EvidenceSource = Literal["zhihu_live", "zhihu_cached", "zhihu_curated", "other", "none"]
Attribution = Literal["zhihu", "other", "model", "editor"]
ExportState = Literal["exportable", "draft", "needs_data"]
TargetLanguageCode = Literal["en", "ja", "ko", "es", "pt", "id", "th", "vi", "de", "fr", "ar", "ru"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Evidence(Model):
    id: str
    provider: Literal["zhihu", "other"]
    sourceMode: EvidenceSource
    contentType: Literal["answer", "article", "question", "glossary", "other"]
    title: Optional[str] = None
    author: Optional[str] = None
    url: str
    summary: str
    role: Literal["setting", "context", "usage", "counterexample", "audience_insight"]
    supports: str
    limits: str
    termIds: list[str]
    fetchedAt: Optional[str] = None
    status: Literal["reviewed", "candidate", "rejected"]


class Term(Model):
    id: str
    surface: str
    start: int
    end: int
    keyPointIds: list[str]
    kind: Literal["culture", "claim", "scene", "context"] = "culture"


class SourceSegment(Model):
    text: str
    termId: Optional[str] = None


class KeyPoint(Model):
    id: str
    text: str
    short: str = ""


class Decision(Model):
    id: str
    termId: str
    title: str = ""
    choice: str
    rationale: str
    evidenceIds: list[str]
    attribution: Attribution
    levels: list[Level] = Field(default_factory=list)


RiskCategory = Literal["legal", "custom"]


class Check(Model):
    id: str
    kind: Literal["fidelity", "claim"]
    label: Optional[str] = None
    keyPointId: Optional[str] = None
    termId: Optional[str] = None
    rule: Optional[str] = None
    span: Optional[str] = None
    status: Literal["pass", "warn", "fail"]
    action: Literal["none", "remove", "rewrite", "needs_data", "review"]
    reason: str
    evidenceIds: list[str] = Field(default_factory=list)
    finalText: Optional[str] = None
    riskCategory: Optional[RiskCategory] = None
    jurisdiction: Optional[str] = None
    suggestion: Optional[str] = None


class ComplianceRule(Model):
    ruleId: str
    category: RiskCategory
    subcategory: str = "general"
    title: str
    markets: list[str] = Field(default_factory=lambda: ["*"])
    jurisdiction: str
    severity: Literal["block", "warn"] = "block"
    action: Literal["rewrite", "remove", "review"] = "rewrite"
    patterns: list[str] = Field(default_factory=list)
    zhCues: list[str] = Field(default_factory=list)
    reason: str
    suggestion: str = ""
    enabled: bool = True
    builtin: bool = True


class ComplianceRuleCreate(Model):
    category: RiskCategory
    title: str = Field(min_length=2, max_length=60)
    markets: list[str] = Field(default_factory=lambda: ["*"], min_length=1)
    jurisdiction: str = Field(min_length=2, max_length=100)
    severity: Literal["block", "warn"] = "block"
    patterns: list[str] = Field(min_length=1)
    zhCues: list[str] = Field(default_factory=list)
    reason: str = Field(min_length=4, max_length=300)
    suggestion: str = Field(default="", max_length=300)


class Segment(Model):
    text: str
    termIds: list[str] = Field(default_factory=list)
    evidenceIds: list[str] = Field(default_factory=list)
    decisionId: Optional[str] = None


class Note(Model):
    text: str
    evidenceIds: list[str] = Field(default_factory=list)


class Variant(Model):
    level: Level
    segments: list[Segment]
    notes: list[Note] = Field(default_factory=list)
    checks: list[Check] = Field(default_factory=list)
    exportState: ExportState
    candidateText: Optional[str] = None  # 守门改写前的候选句（仅在发生改写时出现）


class RunSnapshot(Model):
    runId: str
    revision: int
    caseId: Optional[str]
    audienceId: str
    targetLanguage: TargetLanguageCode = "en"
    mode: Mode
    provenance: Provenance
    degradedReason: Optional[str] = None
    evidenceSource: EvidenceSource
    sourceSegments: list[SourceSegment]
    terms: list[Term]
    keyPoints: list[KeyPoint]
    evidence: list[Evidence]
    decisions: list[Decision]
    recommendedLevel: Level
    recommendationReason: str
    variants: list[Variant]
    modelVersion: str
    promptVersion: str
    corpusVersion: str
    createdAt: str
    frozenAt: Optional[str] = None
    notices: list[str] = Field(default_factory=list)


class Judgment(Model):
    keyPointId: str
    verdict: Literal["hit", "missing", "contradicted"]
    quote: str


class Reader(Model):
    personaId: str
    personaLabel: str
    simulated: Literal[True] = True
    version: Literal["literal", "selected"]
    status: Literal["ok", "failed"] = "ok"
    retelling: Optional[str] = None
    judgments: list[Judgment] = Field(default_factory=list)


class Tally(Model):
    hit: int
    valid: int


class TestSummary(Model):
    literal: Tally
    selected: Tally


class TestResult(Model):
    testId: str
    runId: str
    revision: int
    level: Level
    keyPointIds: list[str]
    expected: int
    completed: int
    readers: list[Reader]
    summary: TestSummary
    mode: Mode
    provenance: Provenance
    judgeError: Optional[str] = None


DraftTarget = Literal["answer", "question", "article", "pin"]


class QuestionSource(Model):
    kind: Literal["reader_misreading", "manual", "example", "guard_gap"]
    text: str = Field(min_length=1, max_length=1000)
    testId: Optional[str] = None
    keyPointId: Optional[str] = None


class QuestionDraftRequest(Model):
    source: QuestionSource
    caseId: Optional[str] = None
    runId: Optional[str] = None
    termIds: list[str] = Field(default_factory=list)
    targetType: Optional[DraftTarget] = None


class ExistingItem(Model):
    title: str
    url: str


class DraftBody(Model):
    title: str
    body: str


class FlowbackDestination(Model):
    targetType: DraftTarget
    label: str
    description: str
    url: str
    primary: bool = False


SourceLabel = Literal["模拟读者误解（非真实用户）", "用户粘贴", "示例输入", "守门待补材料"]


class QuestionDraft(Model):
    draftId: str
    query: str
    existing: list[ExistingItem]
    existingSource: Literal["zhihu_live", "cache", "replay", "none", "failed"]
    existingNote: str = ""
    recommendation: Literal["answer_existing", "new_question"]
    recommendationReason: str = ""
    targetType: DraftTarget = "question"
    recommendedTarget: DraftTarget = "question"
    destinations: list[FlowbackDestination] = Field(default_factory=list)
    draft: DraftBody
    sourceLabel: SourceLabel
    mode: Mode
    provenance: Provenance


class RunRequest(Model):
    text: str = Field(max_length=4000)
    audienceId: str
    caseId: Optional[str] = None
    targetLanguage: TargetLanguageCode = "en"
    mode: Literal["auto", "replay"] = "auto"
    useGlobalSearch: bool = False
    knowledgeBaseIds: list[str] = Field(default_factory=list)


class GlobalSearchRequest(Model):
    query: str = Field(min_length=1, max_length=200)
    count: int = Field(default=6, ge=1, le=20)
    filter: str = Field(default="", max_length=300)
    searchDb: Literal["all", "realtime", "static"] = "all"


class ZhidaAskRequest(Model):
    query: str = Field(min_length=1, max_length=600)
    model: Literal["zhida-fast-1p5", "zhida-thinking-1p5", "zhida-agent"] = "zhida-fast-1p5"
    term: Optional[str] = Field(default=None, max_length=80)
    sourceText: Optional[str] = Field(default=None, max_length=500)


class KnowledgeSearchRequest(Model):
    query: str = Field(min_length=1, max_length=200)
    knowledgeBaseIds: list[str] = Field(default_factory=list, max_length=10)
    recallScopes: list[Literal["personal", "subscription", "public"]] = Field(default_factory=list)
    limit: int = Field(default=5, ge=1, le=10)


class TestRequest(Model):
    revision: int
    level: Level
    keyPointIds: list[str] = Field(min_length=1)


class Health(Model):
    ok: bool
    zhihuBudgetLeft: dict[str, int]
    llmBudgetLeft: Optional[int]
    replayAvailable: bool
    replayCount: int
    generationMode: Mode
    llmProvider: str
    zhihuLive: bool
    zhihuSecretConfigured: bool
    llmKeyConfigured: bool


class SseEvent(Model):
    runId: str
    seq: int
    type: Literal["started", "terms", "evidence", "ready", "error"]
    payload: dict


SCHEMA_MODELS = {
    "run_snapshot": RunSnapshot,
    "test_result": TestResult,
    "question_draft": QuestionDraft,
    "question_draft_request": QuestionDraftRequest,
    "run_request": RunRequest,
    "test_request": TestRequest,
    "health": Health,
    "sse_event": SseEvent,
    "evidence": Evidence,
}
