import { useId, useState, type ComponentProps } from "react";
import type {
  CareSetting,
  Criterion,
  CriterionKind,
  DatabaseId,
  RelativeWindow,
  StudySpec,
} from "../spec/types";
import { findCodeList, specReadiness } from "../spec/types";

type Test = Criterion["test"];
type TestType = Test["type"];

export const DATABASE_OPTIONS: { id: DatabaseId; label: string }[] = [
  { id: "marketscan_ccae", label: "MarketScan Commercial (CCAE)" },
  { id: "marketscan_mdcr", label: "MarketScan Medicare Supplemental (MDCR)" },
  { id: "marketscan_medicaid", label: "MarketScan Medicaid (MDCD)" },
];

const INDEX_TYPE_LABELS: Record<StudySpec["indexEvent"]["type"], string> = {
  first_drug_claim: "First drug claim",
  first_diagnosis: "First diagnosis",
  first_procedure: "First procedure",
};

const TEST_TYPE_LABELS: Record<TestType, string> = {
  diagnosis: "Diagnosis claims",
  procedure: "Procedure claims",
  drug: "Drug claims",
  age_at_index: "Age at index",
  sex: "Sex",
  continuous_enrollment: "Continuous enrollment",
  unmapped: "Unmapped",
};

const SETTING_LABELS: Record<CareSetting, string> = {
  any: "Any setting",
  inpatient: "Inpatient only",
  outpatient: "Outpatient only",
  pharmacy: "Pharmacy",
};

/* ---------- plain-words description of a criterion test ---------- */

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function dayPhrase(n: number): string {
  if (n === 0) return "the index date";
  return n < 0 ? `${plural(-n, "day")} before index` : `${plural(n, "day")} after index`;
}

function windowPhrase(w: RelativeWindow): string {
  if (w.start === 0 && w.end === 0) {
    return w.includesIndex ? "on the index date" : "on the index date (index excluded — empty window)";
  }
  const start = w.start === "anytime_before" ? "any time before index" : dayPhrase(w.start);
  const end = w.end === "anytime_after" ? "any time after index" : dayPhrase(w.end);
  const incl = w.includesIndex ? "including" : "excluding";
  return `from ${start} through ${end}, ${incl} the index date`;
}

function settingPhrase(s: CareSetting): string {
  switch (s) {
    case "any":
      return "in any care setting";
    case "inpatient":
      return "in inpatient claims only";
    case "outpatient":
      return "in outpatient claims only";
    case "pharmacy":
      return "in pharmacy claims";
  }
}

export function describeTest(spec: StudySpec, test: Test): string {
  const listLabel = (id: string) =>
    findCodeList(spec, id)?.label ?? `missing code list "${id}"`;
  switch (test.type) {
    case "diagnosis": {
      const sep =
        test.claimSeparationDays !== undefined && test.claimSeparationDays > 0 && test.minClaims > 1
          ? `, at least ${plural(test.claimSeparationDays, "day")} apart`
          : "";
      return `At least ${plural(test.minClaims, "diagnosis claim")} of ${listLabel(
        test.codeListId,
      )}${sep}, ${settingPhrase(test.setting)}, ${windowPhrase(test.window)}.`;
    }
    case "procedure":
      return `At least ${plural(test.minClaims, "procedure claim")} of ${listLabel(
        test.codeListId,
      )}, ${settingPhrase(test.setting)}, ${windowPhrase(test.window)}.`;
    case "drug":
      return `At least ${plural(test.minClaims, "pharmacy claim")} for ${listLabel(
        test.codeListId,
      )}, ${windowPhrase(test.window)}.`;
    case "age_at_index":
      if (test.min !== undefined && test.max !== undefined)
        return `Age ${test.min} to ${test.max} on the index date.`;
      if (test.min !== undefined) return `Age ${test.min} or older on the index date.`;
      if (test.max !== undefined) return `Age ${test.max} or younger on the index date.`;
      return "Age at index — no bounds set yet.";
    case "sex":
      return `Sex recorded as ${test.value === "M" ? "male" : "female"}.`;
    case "continuous_enrollment":
      return (
        `Continuous enrollment for ${plural(test.baselineDays, "day")} of baseline ` +
        `(backward from and including the index date) and ${plural(
          test.followupDays,
          "day",
        )} of follow-up (after and excluding the index date)` +
        (test.requiresRxCoverage ? ", with drug (Rx) coverage" : "") +
        "."
      );
    case "unmapped":
      return "Not mapped to a testable rule yet — resolve before code can be generated.";
  }
}

/* ---------- commit-on-blur inputs (keeps version churn and autosave sane) ---------- */

type CommitInputProps = Omit<ComponentProps<"input">, "value" | "onChange"> & {
  value: string;
  onCommit: (v: string) => void;
};

function CommitInput({ value, onCommit, ...rest }: CommitInputProps) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  return (
    <input
      {...rest}
      value={editing ? draft : value}
      onFocus={(e) => {
        setDraft(value);
        setEditing(true);
        rest.onFocus?.(e);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        setEditing(false);
        if (draft !== value) onCommit(draft);
        rest.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        rest.onKeyDown?.(e);
      }}
    />
  );
}

interface LabeledNumberProps {
  label: string;
  value: number | undefined;
  onCommit: (v: number | undefined) => void;
  allowEmpty?: boolean;
  min?: number;
  max?: number;
  disabled?: boolean;
  hint?: string;
}

function LabeledNumber({ label, value, onCommit, allowEmpty, min, max, disabled, hint }: LabeledNumberProps) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <CommitInput
        id={id}
        className="control control-num"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        disabled={disabled}
        value={value === undefined ? "" : String(value)}
        onCommit={(s) => {
          if (s.trim() === "") {
            if (allowEmpty) onCommit(undefined);
            return;
          }
          const n = Number(s);
          if (!Number.isFinite(n)) return;
          let v = Math.trunc(n);
          if (min !== undefined && v < min) v = min;
          if (max !== undefined && v > max) v = max;
          onCommit(v);
        }}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function LabeledText({
  label,
  value,
  onCommit,
  type = "text",
  placeholder,
  wide,
  hint,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  type?: string;
  placeholder?: string;
  wide?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field" style={wide ? { flex: "1 1 16rem" } : undefined}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <CommitInput
        id={id}
        className={wide ? "control control-wide" : "control"}
        type={type}
        placeholder={placeholder}
        value={value}
        onCommit={onCommit}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/* ---------- window editor ---------- */

function WindowEditor({
  value,
  onChange,
}: {
  value: RelativeWindow;
  onChange: (w: RelativeWindow) => void;
}) {
  const startAnytime = value.start === "anytime_before";
  const endAnytime = value.end === "anytime_after";
  return (
    <>
      <div className="field">
        <LabeledNumber
          label="Window start (day)"
          disabled={startAnytime}
          value={typeof value.start === "number" ? value.start : undefined}
          onCommit={(n) => {
            if (n !== undefined) onChange({ ...value, start: n });
          }}
          hint="Days from index; negative = before"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={startAnytime}
            onChange={(e) =>
              onChange({ ...value, start: e.target.checked ? "anytime_before" : -365 })
            }
          />
          Any time before
        </label>
      </div>
      <div className="field">
        <LabeledNumber
          label="Window end (day)"
          disabled={endAnytime}
          value={typeof value.end === "number" ? value.end : undefined}
          onCommit={(n) => {
            if (n !== undefined) onChange({ ...value, end: n });
          }}
          hint="Days from index; 0 = index date"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={endAnytime}
            onChange={(e) => onChange({ ...value, end: e.target.checked ? "anytime_after" : 0 })}
          />
          Any time after
        </label>
      </div>
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={value.includesIndex}
            onChange={(e) => onChange({ ...value, includesIndex: e.target.checked })}
          />
          Includes index date
        </label>
      </div>
    </>
  );
}

/* ---------- code list + setting selects ---------- */

function CodeListSelect({
  spec,
  value,
  onChange,
}: {
  spec: StudySpec;
  value: string;
  onChange: (id: string) => void;
}) {
  const id = useId();
  const missing = value !== "" && !findCodeList(spec, value);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Code list
      </label>
      <select id={id} className="control" value={value} onChange={(e) => onChange(e.target.value)}>
        {value === "" && <option value="">— choose —</option>}
        {missing && <option value={value}>{value} (missing)</option>}
        {spec.codeLists.map((cl) => (
          <option key={cl.id} value={cl.id}>
            {cl.label}
          </option>
        ))}
      </select>
      {missing && <span className="field-hint">Referenced list does not exist yet.</span>}
    </div>
  );
}

function SettingSelect({
  value,
  onChange,
}: {
  value: CareSetting;
  onChange: (s: CareSetting) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Care setting
      </label>
      <select
        id={id}
        className="control"
        value={value}
        onChange={(e) => onChange(e.target.value as CareSetting)}
      >
        {(["any", "inpatient", "outpatient"] as CareSetting[]).map((s) => (
          <option key={s} value={s}>
            {SETTING_LABELS[s]}
          </option>
        ))}
        {value === "pharmacy" && <option value="pharmacy">{SETTING_LABELS.pharmacy}</option>}
      </select>
    </div>
  );
}

/* ---------- default tests for adding / mapping ---------- */

function buildDefaultTest(type: TestType, spec: StudySpec, codeListId: string): Test {
  const baselineWindow: RelativeWindow = {
    start: -spec.enrollment.baselineDays,
    end: 0,
    includesIndex: true,
  };
  switch (type) {
    case "diagnosis":
      return {
        type,
        codeListId,
        minClaims: 1,
        setting: "any",
        window: { start: "anytime_before", end: 0, includesIndex: true },
      };
    case "procedure":
      return { type, codeListId, minClaims: 1, setting: "any", window: baselineWindow };
    case "drug":
      return { type, codeListId, minClaims: 1, window: baselineWindow };
    case "age_at_index":
      return { type, min: 18 };
    case "sex":
      return { type, value: "F" };
    case "continuous_enrollment":
      return {
        type,
        baselineDays: spec.enrollment.baselineDays,
        followupDays: spec.enrollment.followupDays,
        requiresRxCoverage: spec.enrollment.requiresRxCoverage,
      };
    case "unmapped":
      return { type: "unmapped" };
  }
}

/* ---------- criterion row ---------- */

function CriterionRow({
  spec,
  criterion: c,
  index,
  count,
  onPatch,
  onMove,
  onDelete,
}: {
  spec: StudySpec;
  criterion: Criterion;
  index: number;
  count: number;
  onPatch: (patch: Partial<Criterion>) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const t = c.test;
  const setTest = (test: Test) => onPatch({ test });
  const unmapped = t.type === "unmapped";
  const reviewedId = useId();
  const mapId = useId();

  const confidenceBadge =
    c.confidence === "high" ? (
      <span className="badge badge-neutral">high confidence</span>
    ) : c.confidence === "medium" ? (
      <span className="badge badge-warn">medium confidence</span>
    ) : (
      <span className="badge badge-danger">low confidence</span>
    );

  return (
    <li className={unmapped ? "crit crit-unmapped" : "crit"}>
      <div className="crit-head">
        <span className={c.kind === "inclusion" ? "badge badge-inclusion" : "badge badge-exclusion"}>
          {c.kind}
        </span>
        {confidenceBadge}
        {unmapped && <span className="badge badge-danger">unmapped</span>}
        <span className="crit-id">{c.id}</span>
        <div className="crit-actions">
          <label className="check" htmlFor={reviewedId}>
            <input
              id={reviewedId}
              type="checkbox"
              checked={c.reviewed}
              disabled={unmapped}
              onChange={(e) => onPatch({ reviewed: e.target.checked })}
            />
            Reviewed
          </label>
          <button
            type="button"
            className="btn btn-sm"
            disabled={index === 0}
            aria-label={`Move criterion ${c.id} up`}
            onClick={() => onMove(-1)}
          >
            Up
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={index === count - 1}
            aria-label={`Move criterion ${c.id} down`}
            onClick={() => onMove(1)}
          >
            Down
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger-quiet"
            aria-label={`Delete criterion ${c.id}`}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>

      <blockquote className="crit-quote" cite="protocol">
        {c.sourceText}
      </blockquote>

      <p className="crit-summary">
        <span className="summary-label">Maps to</span>
        {describeTest(spec, t)}
      </p>

      {unmapped && (
        <div className="unmapped-callout">
          <strong>Needs mapping.</strong> The extractor could not translate this criterion into a
          testable rule. Choose what it should test; defaults can then be edited.
          <div className="field">
            <label className="field-label" htmlFor={mapId}>
              Map to
            </label>
            <select
              id={mapId}
              className="control"
              value=""
              onChange={(e) => {
                const v = e.target.value as TestType | "";
                if (v && v !== "unmapped")
                  setTest(buildDefaultTest(v, spec, spec.codeLists[0]?.id ?? ""));
              }}
            >
              <option value="">— choose a test type —</option>
              {(Object.keys(TEST_TYPE_LABELS) as TestType[])
                .filter((k) => k !== "unmapped")
                .map((k) => (
                  <option key={k} value={k}>
                    {TEST_TYPE_LABELS[k]}
                  </option>
                ))}
            </select>
          </div>
        </div>
      )}

      {t.type === "diagnosis" && (
        <div className="crit-editors">
          <CodeListSelect
            spec={spec}
            value={t.codeListId}
            onChange={(v) => setTest({ ...t, codeListId: v })}
          />
          <LabeledNumber
            label="Min claims"
            min={1}
            value={t.minClaims}
            onCommit={(n) => {
              if (n !== undefined) setTest({ ...t, minClaims: n });
            }}
          />
          <LabeledNumber
            label="Separation (days)"
            allowEmpty
            min={0}
            value={t.claimSeparationDays}
            onCommit={(n) => setTest({ ...t, claimSeparationDays: n })}
            hint="Blank = no separation rule"
          />
          <SettingSelect value={t.setting} onChange={(s) => setTest({ ...t, setting: s })} />
          <WindowEditor value={t.window} onChange={(w) => setTest({ ...t, window: w })} />
        </div>
      )}

      {t.type === "procedure" && (
        <div className="crit-editors">
          <CodeListSelect
            spec={spec}
            value={t.codeListId}
            onChange={(v) => setTest({ ...t, codeListId: v })}
          />
          <LabeledNumber
            label="Min claims"
            min={1}
            value={t.minClaims}
            onCommit={(n) => {
              if (n !== undefined) setTest({ ...t, minClaims: n });
            }}
          />
          <SettingSelect value={t.setting} onChange={(s) => setTest({ ...t, setting: s })} />
          <WindowEditor value={t.window} onChange={(w) => setTest({ ...t, window: w })} />
        </div>
      )}

      {t.type === "drug" && (
        <div className="crit-editors">
          <CodeListSelect
            spec={spec}
            value={t.codeListId}
            onChange={(v) => setTest({ ...t, codeListId: v })}
          />
          <LabeledNumber
            label="Min claims"
            min={1}
            value={t.minClaims}
            onCommit={(n) => {
              if (n !== undefined) setTest({ ...t, minClaims: n });
            }}
          />
          <WindowEditor value={t.window} onChange={(w) => setTest({ ...t, window: w })} />
        </div>
      )}

      {t.type === "age_at_index" && (
        <div className="crit-editors">
          <LabeledNumber
            label="Min age"
            allowEmpty
            min={0}
            value={t.min}
            onCommit={(n) => setTest({ ...t, min: n })}
            hint="Blank = no lower bound"
          />
          <LabeledNumber
            label="Max age"
            allowEmpty
            min={0}
            value={t.max}
            onCommit={(n) => setTest({ ...t, max: n })}
            hint="Blank = no upper bound"
          />
        </div>
      )}

      {t.type === "sex" && (
        <div className="crit-editors">
          <div className="field">
            <span className="field-label" id={`${c.id}-sex-label`}>
              Sex
            </span>
            <select
              className="control"
              aria-labelledby={`${c.id}-sex-label`}
              value={t.value}
              onChange={(e) => setTest({ ...t, value: e.target.value as "M" | "F" })}
            >
              <option value="F">Female</option>
              <option value="M">Male</option>
            </select>
          </div>
        </div>
      )}

      {t.type === "continuous_enrollment" && (
        <div className="crit-editors">
          <LabeledNumber
            label="Baseline days"
            min={0}
            value={t.baselineDays}
            onCommit={(n) => {
              if (n !== undefined) setTest({ ...t, baselineDays: n });
            }}
            hint="Includes index date"
          />
          <LabeledNumber
            label="Follow-up days"
            min={0}
            value={t.followupDays}
            onCommit={(n) => {
              if (n !== undefined) setTest({ ...t, followupDays: n });
            }}
            hint="Excludes index date"
          />
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={t.requiresRxCoverage}
                onChange={(e) => setTest({ ...t, requiresRxCoverage: e.target.checked })}
              />
              Requires drug (Rx) coverage
            </label>
          </div>
        </div>
      )}
    </li>
  );
}

/* ---------- add criterion ---------- */

let addSeq = 0;

function AddCriterionForm({
  spec,
  onAdd,
}: {
  spec: StudySpec;
  onAdd: (c: Criterion) => void;
}) {
  const [kind, setKind] = useState<CriterionKind>("inclusion");
  const [type, setType] = useState<TestType>("diagnosis");
  const [codeListId, setCodeListId] = useState<string>(spec.codeLists[0]?.id ?? "");
  const [sourceText, setSourceText] = useState("");
  const kindId = useId();
  const typeId = useId();

  const needsCodeList = type === "diagnosis" || type === "procedure" || type === "drug";
  const noLists = needsCodeList && spec.codeLists.length === 0;
  const chosenList = needsCodeList ? (codeListId || spec.codeLists[0]?.id || "") : "";

  return (
    <div className="add-form">
      <h3 className="field-label" style={{ marginBottom: "0.75rem" }}>
        Add a criterion
      </h3>
      <div className="field-row">
        <div className="field">
          <label className="field-label" htmlFor={kindId}>
            Kind
          </label>
          <select
            id={kindId}
            className="control"
            value={kind}
            onChange={(e) => setKind(e.target.value as CriterionKind)}
          >
            <option value="inclusion">Inclusion</option>
            <option value="exclusion">Exclusion</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={typeId}>
            Test type
          </label>
          <select
            id={typeId}
            className="control"
            value={type}
            onChange={(e) => setType(e.target.value as TestType)}
          >
            {(Object.keys(TEST_TYPE_LABELS) as TestType[]).map((k) => (
              <option key={k} value={k}>
                {TEST_TYPE_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        {needsCodeList && (
          <CodeListSelect spec={spec} value={chosenList} onChange={setCodeListId} />
        )}
        <div className="field" style={{ flex: "1 1 14rem" }}>
          <label className="field-label" htmlFor="add-crit-src">
            Protocol text (verbatim, optional)
          </label>
          <input
            id="add-crit-src"
            className="control control-wide"
            type="text"
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value)}
            placeholder="Quote the protocol wording if available"
          />
        </div>
        <button
          type="button"
          className="btn"
          disabled={noLists}
          onClick={() => {
            addSeq += 1;
            const id = `crit_${Date.now().toString(36)}_${addSeq}`;
            onAdd({
              id,
              kind,
              sourceText: sourceText.trim() || "Added manually in TimeZero (no protocol quote).",
              test: buildDefaultTest(type, spec, chosenList),
              confidence: "high",
              reviewed: false,
            });
            setSourceText("");
          }}
        >
          Add criterion
        </button>
      </div>
      {noLists && (
        <p className="field-hint">
          This test type needs a code list — create one in the Codelists step first.
        </p>
      )}
    </div>
  );
}

/* ---------- main component ---------- */

export default function SpecReview({
  spec,
  onChange,
}: {
  spec: StudySpec;
  onChange: (s: StudySpec) => void;
}) {
  const readiness = specReadiness(spec);
  const dbId = useId();
  const idxTypeId = useId();

  const patchMeta = (m: Partial<StudySpec["meta"]>) =>
    onChange({ ...spec, meta: { ...spec.meta, ...m } });
  const patchIndex = (m: Partial<StudySpec["indexEvent"]>) =>
    onChange({ ...spec, indexEvent: { ...spec.indexEvent, ...m } });
  const patchEnroll = (m: Partial<StudySpec["enrollment"]>) =>
    onChange({ ...spec, enrollment: { ...spec.enrollment, ...m } });
  const patchCriterion = (id: string, patch: Partial<Criterion>) =>
    onChange({
      ...spec,
      criteria: spec.criteria.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    });
  const moveCriterion = (id: string, dir: -1 | 1) => {
    const i = spec.criteria.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= spec.criteria.length) return;
    const next = spec.criteria.slice();
    const [item] = next.splice(i, 1);
    next.splice(j, 0, item);
    onChange({ ...spec, criteria: next });
  };
  const deleteCriterion = (id: string) =>
    onChange({ ...spec, criteria: spec.criteria.filter((c) => c.id !== id) });

  const prov = spec.meta.provenance;
  const indexList = findCodeList(spec, spec.indexEvent.codeListId);

  return (
    <div>
      {readiness.ready ? (
        <div className="banner banner-ok" role="status">
          <div className="banner-body">
            <p className="banner-title">Spec is ready for code generation.</p>
            <p>Every criterion is reviewed and mapped, and every code is verified.</p>
          </div>
        </div>
      ) : (
        <div className="banner banner-warn" role="status">
          <div className="banner-body">
            <p className="banner-title">Not ready yet — code generation stays locked until:</p>
            <ul>
              {readiness.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <section className="card" aria-labelledby="meta-title">
        <h2 className="card-title" id="meta-title">
          Study
        </h2>
        <p className="card-sub">
          Spec version {spec.meta.version} · produced by{" "}
          {prov.method === "llm_extraction"
            ? `LLM extraction (${prov.model ?? "model unknown"}${
                prov.sourceDocumentName ? `, from ${prov.sourceDocumentName}` : ""
              })`
            : "manual entry"}
          {prov.extractedAt ? ` on ${prov.extractedAt}` : ""}
        </p>
        <div className="field-row">
          <LabeledText
            label="Title"
            wide
            value={spec.meta.title}
            onCommit={(v) => patchMeta({ title: v })}
          />
          <div className="field">
            <label className="field-label" htmlFor={dbId}>
              Database
            </label>
            <select
              id={dbId}
              className="control"
              value={spec.meta.database}
              onChange={(e) => patchMeta({ database: e.target.value as DatabaseId })}
            >
              {DATABASE_OPTIONS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-row">
          <LabeledText
            label="Study period start"
            type="date"
            value={spec.meta.studyPeriod.start}
            onCommit={(v) => patchMeta({ studyPeriod: { ...spec.meta.studyPeriod, start: v } })}
          />
          <LabeledText
            label="Study period end"
            type="date"
            value={spec.meta.studyPeriod.end}
            onCommit={(v) => patchMeta({ studyPeriod: { ...spec.meta.studyPeriod, end: v } })}
          />
          <LabeledText
            label="Description"
            wide
            value={spec.meta.description ?? ""}
            onCommit={(v) => patchMeta({ description: v || undefined })}
          />
        </div>
      </section>

      <section className="card" aria-labelledby="idx-title">
        <h2 className="card-title" id="idx-title">
          Index event
        </h2>
        <p className="card-sub">
          Index date = {INDEX_TYPE_LABELS[spec.indexEvent.type].toLowerCase()} of{" "}
          {indexList?.label ?? `missing code list "${spec.indexEvent.codeListId}"`} between{" "}
          {spec.indexEvent.indexPeriod.start} and {spec.indexEvent.indexPeriod.end}.
        </p>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor={idxTypeId}>
              Event type
            </label>
            <select
              id={idxTypeId}
              className="control"
              value={spec.indexEvent.type}
              onChange={(e) =>
                patchIndex({ type: e.target.value as StudySpec["indexEvent"]["type"] })
              }
            >
              {(Object.keys(INDEX_TYPE_LABELS) as StudySpec["indexEvent"]["type"][]).map((k) => (
                <option key={k} value={k}>
                  {INDEX_TYPE_LABELS[k]}
                </option>
              ))}
            </select>
          </div>
          <CodeListSelect
            spec={spec}
            value={spec.indexEvent.codeListId}
            onChange={(v) => patchIndex({ codeListId: v })}
          />
          <LabeledText
            label="Index period start"
            type="date"
            value={spec.indexEvent.indexPeriod.start}
            onCommit={(v) =>
              patchIndex({ indexPeriod: { ...spec.indexEvent.indexPeriod, start: v } })
            }
          />
          <LabeledText
            label="Index period end"
            type="date"
            value={spec.indexEvent.indexPeriod.end}
            onCommit={(v) => patchIndex({ indexPeriod: { ...spec.indexEvent.indexPeriod, end: v } })}
          />
        </div>
        <div className="field-row">
          <LabeledText
            label="Definition note"
            wide
            value={spec.indexEvent.description ?? ""}
            onCommit={(v) => patchIndex({ description: v || undefined })}
          />
        </div>
      </section>

      <section className="card" aria-labelledby="enr-title">
        <h2 className="card-title" id="enr-title">
          Enrollment
        </h2>
        <p className="card-sub">
          Baseline includes the index date and runs backward; follow-up excludes the index date and
          runs forward.
        </p>
        <div className="field-row">
          <LabeledNumber
            label="Baseline days"
            min={0}
            value={spec.enrollment.baselineDays}
            onCommit={(n) => {
              if (n !== undefined) patchEnroll({ baselineDays: n });
            }}
          />
          <LabeledNumber
            label="Follow-up days"
            min={0}
            value={spec.enrollment.followupDays}
            onCommit={(n) => {
              if (n !== undefined) patchEnroll({ followupDays: n });
            }}
          />
          <LabeledNumber
            label="Gap allowance (days)"
            min={0}
            value={spec.enrollment.gapAllowanceDays}
            onCommit={(n) => {
              if (n !== undefined) patchEnroll({ gapAllowanceDays: n });
            }}
            hint="Enrollment segments this close are stitched"
          />
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={spec.enrollment.requiresRxCoverage}
                onChange={(e) => patchEnroll({ requiresRxCoverage: e.target.checked })}
              />
              Requires drug (Rx) coverage
            </label>
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="crit-title">
        <h2 className="card-title" id="crit-title">
          Cohort criteria
        </h2>
        <p className="card-sub">
          Applied in order — the attrition table follows this sequence. Check &ldquo;Reviewed&rdquo;
          only after confirming each mapped rule against the protocol wording.
        </p>
        {spec.criteria.length === 0 ? (
          <p className="field-hint">No criteria yet. Add the first one below.</p>
        ) : (
          <ol className="crit-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {spec.criteria.map((c, i) => (
              <CriterionRow
                key={c.id}
                spec={spec}
                criterion={c}
                index={i}
                count={spec.criteria.length}
                onPatch={(patch) => patchCriterion(c.id, patch)}
                onMove={(dir) => moveCriterion(c.id, dir)}
                onDelete={() => {
                  if (window.confirm(`Delete criterion "${c.id}"? This cannot be undone.`))
                    deleteCriterion(c.id);
                }}
              />
            ))}
          </ol>
        )}
        <AddCriterionForm
          spec={spec}
          onAdd={(c) => onChange({ ...spec, criteria: [...spec.criteria, c] })}
        />
      </section>

      {(spec.baseline.length > 0 || spec.analyses.length > 0) && (
        <section className="card" aria-labelledby="plan-title">
          <h2 className="card-title" id="plan-title">
            Planned outputs
          </h2>
          <dl className="spec-dl">
            {spec.baseline.length > 0 && (
              <>
                <dt>Baseline characteristics</dt>
                <dd>{spec.baseline.map((b) => b.label).join(", ")}</dd>
              </>
            )}
            {spec.analyses.length > 0 && (
              <>
                <dt>Analyses</dt>
                <dd>
                  {spec.analyses
                    .map((a) => `${a.type}${a.enabled ? "" : " (off)"}`)
                    .join(", ")}
                </dd>
              </>
            )}
          </dl>
        </section>
      )}
    </div>
  );
}
