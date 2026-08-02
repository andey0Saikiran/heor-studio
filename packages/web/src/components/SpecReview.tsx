import { useId, useState, type ComponentProps } from "react";
import type {
  AdherenceAnalysis,
  Analysis,
  AnalysisCommon,
  AnalysisKind,
  CalendarTrendAnalysis,
  CareSetting,
  CompetingEvent,
  CompetingRisksAnalysis,
  ComorbidityIndexAnalysis,
  CoxAnalysis,
  Criterion,
  CriterionKind,
  CumulativeIncidenceAnalysis,
  DatabaseId,
  DaysSupplyCleaning,
  DenominatorRule,
  FineGrayAnalysis,
  GFormulaAnalysis,
  GroupVariable,
  IncidenceRateAnalysis,
  IptwOutcomeAnalysis,
  LedgerSetting,
  OutcomeDefinition,
  PeriodPrevalenceAnalysis,
  PersonTimeRule,
  PointPrevalenceAnalysis,
  PropensityScoreAnalysis,
  ProportionCiMethod,
  RateCiMethod,
  Recurrence,
  RegressionAnalysis,
  RegressionFamily,
  RelativeWindow,
  ResourceUseAnalysis,
  StandardizationAnalysis,
  StatisticalEngineAnalysis,
  Stratifier,
  StudySpec,
  SurvivalAnalysis,
  SurvivalEndpoint,
  TreatmentSwitchingAnalysis,
} from "@heor-studio/core";
import {
  DEFAULT_DAYS_SUPPLY_CLEANING,
  daysSupplyCleaningFor,
  findCodeList,
  specReadiness,
  EMITTABLE_ANALYSIS_KINDS,
} from "@heor-studio/core";
import { FlagButton } from "./CorrectionModal";
import SpecChat from "./SpecChat";
import type { AppSettings } from "./SettingsModal";
import type { FlagRequest } from "../lib/corrections";

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
  /** Keep the decimal part. Thresholds, trims and weights are fractions; day
   *  counts and horizons are whole numbers and stay truncated. */
  fraction?: boolean;
  step?: number;
}

function LabeledNumber({
  label,
  value,
  onCommit,
  allowEmpty,
  min,
  max,
  disabled,
  hint,
  fraction,
  step,
}: LabeledNumberProps) {
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
        inputMode={fraction ? "decimal" : "numeric"}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={value === undefined ? "" : String(value)}
        onCommit={(s) => {
          if (s.trim() === "") {
            if (allowEmpty) onCommit(undefined);
            return;
          }
          const n = Number(s);
          if (!Number.isFinite(n)) return;
          let v = fraction ? n : Math.trunc(n);
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
  bounded,
}: {
  value: RelativeWindow;
  onChange: (w: RelativeWindow) => void;
  /** The measure divides by the length of this window, so "any time" has no
   *  meaning for it and the two open-ended options are not offered. */
  bounded?: boolean;
}) {
  const startAnytime = value.start === "anytime_before";
  const endAnytime = value.end === "anytime_after";
  return (
    <>
      <div className="field">
        <LabeledNumber
          label="Window start (day)"
          disabled={startAnytime && !bounded}
          value={typeof value.start === "number" ? value.start : undefined}
          onCommit={(n) => {
            if (n !== undefined) onChange({ ...value, start: n });
          }}
          hint="Days from index; negative = before"
        />
        {!bounded && (
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
        )}
      </div>
      <div className="field">
        <LabeledNumber
          label="Window end (day)"
          disabled={endAnytime && !bounded}
          value={typeof value.end === "number" ? value.end : undefined}
          onCommit={(n) => {
            if (n !== undefined) onChange({ ...value, end: n });
          }}
          hint="Days from index; 0 = index date"
        />
        {!bounded && (
          <label className="check">
            <input
              type="checkbox"
              checked={endAnytime}
              onChange={(e) => onChange({ ...value, end: e.target.checked ? "anytime_after" : 0 })}
            />
            Any time after
          </label>
        )}
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
  label = "Code list",
}: {
  spec: StudySpec;
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  const id = useId();
  const missing = value !== "" && !findCodeList(spec, value);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
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

/* ---------- shared analysis-parameter controls ----------
 *
 * Nineteen analysis kinds are built from a handful of repeated field shapes: an
 * outcome definition, a code-list reference, a relative window, a follow-up
 * clock, a number, an enum, a checkbox and a list of ids. These are those
 * shapes, written once, so a new kind is composed rather than hand-drawn. Every
 * one of them uses CommitInput for text and numbers, so autosave and the spec
 * version bump fire on blur instead of on every keystroke.
 */

interface Choice<T extends string> {
  value: T;
  label: string;
}

/** Select over a fixed enum.
 *
 *  A value the spec already holds that is NOT offered here (a refused or
 *  unbuilt option that arrived through the spec chat or the MCP server) is
 *  shown as a marked extra option rather than silently overwritten, so the
 *  analyst can see what the study says and choose their way out of it. */
function LabeledSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<Choice<T>>;
  onChange: (v: T) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const offered = options.some((o) => o.value === value);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="control"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {!offered && <option value={value}>{value} (not generated)</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

function CheckField({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <label className="check">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** Comma-separated whole numbers, sorted and de-duplicated on commit.
 *  Horizons and score bands are only legal in strictly increasing order, so
 *  sorting here removes a readiness problem no analyst ever means to create. */
function NumberListField({
  label,
  value,
  onCommit,
  hint,
  min = 1,
}: {
  label: string;
  value: number[];
  onCommit: (v: number[]) => void;
  hint?: string;
  min?: number;
}) {
  const id = useId();
  return (
    <div className="field" style={{ flex: "1 1 14rem" }}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <CommitInput
        id={id}
        className="control control-wide"
        value={value.join(", ")}
        onCommit={(s) => {
          const nums = s
            .split(",")
            .map((p) => Number(p.trim()))
            .filter((n) => Number.isFinite(n))
            .map((n) => Math.trunc(n))
            .filter((n) => n >= min);
          onCommit([...new Set(nums)].sort((a, b) => a - b));
        }}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** Comma-separated free text, trimmed, blanks dropped. */
function TextListField({
  label,
  value,
  onCommit,
  hint,
  placeholder,
}: {
  label: string;
  value: string[];
  onCommit: (v: string[]) => void;
  hint?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field" style={{ flex: "1 1 14rem" }}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <CommitInput
        id={id}
        className="control control-wide"
        placeholder={placeholder}
        value={value.join(", ")}
        onCommit={(s) =>
          onCommit(
            s
              .split(",")
              .map((p) => p.trim())
              .filter((p) => p !== ""),
          )
        }
      />
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

interface ChecklistItem {
  id: string;
  label: string;
  /** Why this one cannot be picked, shown beside its label. */
  note?: string;
  disabled?: boolean;
}

/** Multi-select over ids, as checkboxes, in the order the items are given so
 *  the stored list is stable across edits. `minSelected` holds a structurally
 *  required list above empty. */
function IdChecklist({
  label,
  items,
  selected,
  onChange,
  hint,
  emptyNote,
  minSelected = 0,
}: {
  label: string;
  items: ChecklistItem[];
  selected: string[];
  onChange: (ids: string[]) => void;
  hint?: string;
  emptyNote?: string;
  minSelected?: number;
}) {
  const labelId = useId();
  const chosen = new Set(selected);
  const order = items.map((i) => i.id);
  return (
    <div className="field">
      <span className="field-label" id={labelId}>
        {label}
      </span>
      {items.length === 0 ? (
        <span className="field-hint">{emptyNote ?? "Nothing to choose from yet."}</span>
      ) : (
        <div className="field-row" role="group" aria-labelledby={labelId}>
          {items.map((it) => {
            const on = chosen.has(it.id);
            const held = on && chosen.size <= minSelected;
            return (
              <label className="check" key={it.id}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={held || (it.disabled === true && !on)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(it.id);
                    else next.delete(it.id);
                    onChange(order.filter((id) => next.has(id)));
                  }}
                />
                {it.label}
                {it.note ? ` (${it.note})` : ""}
              </label>
            );
          })}
        </div>
      )}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** A relative window with its own caption. */
function WindowField({
  label,
  value,
  onChange,
  bounded,
  hint,
}: {
  label: string;
  value: RelativeWindow;
  onChange: (w: RelativeWindow) => void;
  bounded?: boolean;
  hint?: string;
}) {
  return (
    <fieldset className="analysis-fieldset">
      <legend>{label}</legend>
      <div className="field-row">
        <WindowEditor value={value} onChange={onChange} bounded={bounded} />
      </div>
      {hint && <span className="field-hint">{hint}</span>}
    </fieldset>
  );
}

/* ---------- outcome, clock, endpoint ---------- */

const DX_POSITION_OPTIONS: Choice<OutcomeDefinition["diagnosisPosition"]>[] = [
  { value: "any", label: "Any position" },
  { value: "primary", label: "Primary / principal only" },
];

function OutcomeFieldset({
  spec,
  legend,
  value,
  onChange,
  codeListLabel,
}: {
  spec: StudySpec;
  legend: string;
  value: OutcomeDefinition;
  onChange: (o: OutcomeDefinition) => void;
  codeListLabel?: string;
}) {
  return (
    <fieldset className="analysis-outcome">
      <legend>{legend}</legend>
      <CodeListSelect
        spec={spec}
        label={codeListLabel}
        value={value.codeListId}
        onChange={(v) => onChange({ ...value, codeListId: v })}
      />
      <div className="field-row">
        <LabeledNumber
          label="Min. claims"
          min={1}
          value={value.minClaims}
          onCommit={(v) => onChange({ ...value, minClaims: v ?? 1 })}
        />
        {value.minClaims >= 2 && (
          <LabeledNumber
            label="Days between claims"
            min={0}
            allowEmpty
            value={value.claimSeparationDays}
            onCommit={(v) => onChange({ ...value, claimSeparationDays: v })}
          />
        )}
      </div>
      <div className="field-row">
        <SettingSelect value={value.setting} onChange={(s) => onChange({ ...value, setting: s })} />
        <LabeledSelect
          label="Diagnosis position"
          value={value.diagnosisPosition}
          options={DX_POSITION_OPTIONS}
          onChange={(v) => onChange({ ...value, diagnosisPosition: v })}
        />
      </div>
    </fieldset>
  );
}

type CensorReason = PersonTimeRule["censorAt"][number];

const CENSOR_ORDER: CensorReason[] = [
  "outcome",
  "disenrollment",
  "death",
  "study_end",
  "max_followup",
];

const CENSOR_LABELS: Record<CensorReason, string> = {
  outcome: "The outcome",
  disenrollment: "Disenrollment",
  death: "Death (in-hospital only, masked from 2016)",
  study_end: "End of the study period",
  max_followup: "A maximum follow-up cap",
};

const PT_START_OPTIONS: Choice<PersonTimeRule["start"]>[] = [
  { value: "index", label: "Index date" },
  { value: "enrollment_start", label: "Start of enrollment" },
  { value: "washout_end", label: "End of washout" },
];

/** The at-risk clock.
 *
 *  `required` reasons are checked and locked: a time-to-event model whose clock
 *  does not stop at the event is measuring time to administrative censoring,
 *  which readiness refuses. `forbidden` reasons are the mirror case, a
 *  recurrent-event model that would stop at the first event and then count
 *  events it could never observe. */
function PersonTimeFieldset({
  value,
  onChange,
  legend = "Follow-up clock",
  required = [],
  forbidden = [],
  hint,
}: {
  value: PersonTimeRule;
  onChange: (p: PersonTimeRule) => void;
  legend?: string;
  required?: CensorReason[];
  forbidden?: CensorReason[];
  hint?: string;
}) {
  const labelId = useId();
  const on = new Set(value.censorAt);
  for (const r of required) on.add(r);
  for (const f of forbidden) on.delete(f);
  const capped = on.has("max_followup");
  return (
    <fieldset className="analysis-fieldset">
      <legend>{legend}</legend>
      <div className="field-row">
        <LabeledSelect
          label="Clock starts at"
          value={value.start}
          options={PT_START_OPTIONS}
          onChange={(v) => onChange({ ...value, start: v })}
        />
      </div>
      <div className="field">
        <span className="field-label" id={labelId}>
          Censor follow-up at
        </span>
        <div className="field-row" role="group" aria-labelledby={labelId}>
          {CENSOR_ORDER.map((c) => (
            <label className="check" key={c}>
              <input
                type="checkbox"
                checked={on.has(c)}
                disabled={required.includes(c) || forbidden.includes(c)}
                onChange={(e) => {
                  const next = new Set(on);
                  if (e.target.checked) next.add(c);
                  else next.delete(c);
                  onChange({ ...value, censorAt: CENSOR_ORDER.filter((x) => next.has(x)) });
                }}
              />
              {CENSOR_LABELS[c]}
            </label>
          ))}
        </div>
        {required.length > 0 && (
          <span className="field-hint">
            Censoring at the outcome is fixed for this analysis. Without it every follow-up time
            becomes the administrative one and the result describes enrollment.
          </span>
        )}
        {forbidden.length > 0 && (
          <span className="field-hint">
            This model counts every event, so the clock cannot stop at the first one.
          </span>
        )}
      </div>
      {capped && (
        <div className="field-row">
          <LabeledNumber
            label="Maximum follow-up (days)"
            min={1}
            allowEmpty
            value={value.maxFollowupDays}
            onCommit={(v) => onChange({ ...value, maxFollowupDays: v })}
            hint="Blank = no cap applied"
          />
        </div>
      )}
      {hint && <span className="field-hint">{hint}</span>}
    </fieldset>
  );
}

/** What the time-to-event endpoint IS.
 *
 *  Only the claims-based arm is offered. A death endpoint is well formed and
 *  unbuildable on MarketScan, so readiness refuses it with the reason; this
 *  shows that state and offers the way out instead of pretending it cannot
 *  happen, because a spec built elsewhere can arrive holding one. */
function EndpointFieldset({
  spec,
  value,
  onChange,
  legend = "Endpoint",
}: {
  spec: StudySpec;
  value: SurvivalEndpoint;
  onChange: (e: SurvivalEndpoint) => void;
  legend?: string;
}) {
  if (value.kind === "death") {
    return (
      <fieldset className="analysis-fieldset">
        <legend>{legend}</legend>
        <p className="field-hint">
          This analysis declares a death endpoint, read from {value.source}. Readiness refuses it:
          MarketScan carries in-hospital death only, and that signal is masked from data year 2016,
          so the curve would silently become time to in-hospital death with every other death
          treated as censoring.
        </p>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            onChange({ kind: "claims_event", outcomeDefinition: { ...BLANK_OUTCOME } })
          }
        >
          Use a claims-based endpoint instead
        </button>
      </fieldset>
    );
  }
  return (
    <OutcomeFieldset
      spec={spec}
      legend={legend}
      codeListLabel="Endpoint code list"
      value={value.outcomeDefinition}
      onChange={(o) => onChange({ kind: "claims_event", outcomeDefinition: o })}
    />
  );
}

/** Competing causes, each with its own ascertainment.
 *
 *  "Died of something else" and "had the outcome" are read from different code
 *  lists, so each cause carries a full outcome definition rather than a list id. */
function CompetingEventsFieldset({
  spec,
  value,
  onChange,
}: {
  spec: StudySpec;
  value: CompetingEvent[];
  onChange: (e: CompetingEvent[]) => void;
}) {
  const patch = (i: number, next: CompetingEvent) =>
    onChange(value.map((e, j) => (j === i ? next : e)));
  return (
    <fieldset className="analysis-fieldset">
      <legend>Competing events</legend>
      {value.length === 0 && (
        <p className="field-hint">
          None declared. With none, this estimator is the same as the simpler one it is meant to
          improve on, and readiness says so.
        </p>
      )}
      {value.map((ce, i) => (
        <div className="field" key={ce.id}>
          <div className="field-row">
            <LabeledText
              label="Cause"
              value={ce.label}
              onCommit={(v) => patch(i, { ...ce, label: v || ce.id })}
            />
            <button
              type="button"
              className="btn btn-sm btn-danger-quiet"
              aria-label={`Remove competing event ${ce.label}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
          <OutcomeFieldset
            spec={spec}
            legend={`Ascertainment of ${ce.label}`}
            codeListLabel="Cause code list"
            value={ce.outcomeDefinition}
            onChange={(o) => patch(i, { ...ce, outcomeDefinition: o })}
          />
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          const n = value.length + 1;
          onChange([
            ...value,
            {
              id: `competing_${n}`,
              label: `Competing cause ${n}`,
              outcomeDefinition: { ...BLANK_OUTCOME },
            },
          ]);
        }}
      >
        Add a competing cause
      </button>
    </fieldset>
  );
}

/* ---------- exposure groups ---------- */

function groupVarsOf(spec: StudySpec): GroupVariable[] {
  return spec.groupVars ?? [];
}

/** Baseline kinds a saturated cell model can use. The causal family is closed
 *  form ONLY over categorical cells, so this set is what those pickers offer. */
const CATEGORICAL_BASELINE_KINDS: ReadonlySet<string> = new Set([
  "sex",
  "region",
  "plan_type",
  "year",
]);

function GroupVarSelect({
  spec,
  value,
  onChange,
  label = "Exposure variable",
  allowNone,
  hint,
}: {
  spec: StudySpec;
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  label?: string;
  allowNone?: boolean;
  hint?: string;
}) {
  const id = useId();
  const groups = groupVarsOf(spec);
  const current = value ?? "";
  const missing = current !== "" && !groups.some((g) => g.id === current);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="control"
        value={current}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      >
        {allowNone && <option value="">No exposure: one curve</option>}
        {!allowNone && current === "" && <option value="">Not chosen yet</option>}
        {missing && <option value={current}>{current} (missing)</option>}
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.label}
          </option>
        ))}
      </select>
      <span className="field-hint">
        {groups.length === 0
          ? "No exposure groups defined yet. Add one in the Exposure groups section above."
          : (hint ?? "Two levels, with a reference level, are required.")}
      </span>
    </div>
  );
}

function BaselineChecklist({
  spec,
  label,
  selected,
  onChange,
  categoricalOnly,
  hint,
}: {
  spec: StudySpec;
  label: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  categoricalOnly?: boolean;
  hint?: string;
}) {
  const items: ChecklistItem[] = (spec.baseline ?? []).map((b) => {
    const blocked = categoricalOnly === true && !CATEGORICAL_BASELINE_KINDS.has(b.kind);
    return {
      id: b.id,
      label: b.label,
      note: blocked ? "not categorical" : undefined,
      disabled: blocked,
    };
  });
  return (
    <IdChecklist
      label={label}
      items={items}
      selected={selected}
      onChange={onChange}
      emptyNote="No baseline characteristics in this study yet."
      hint={hint}
    />
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
  onFlag,
}: {
  spec: StudySpec;
  criterion: Criterion;
  index: number;
  count: number;
  onPatch: (patch: Partial<Criterion>) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
  onFlag: (r: FlagRequest) => void;
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
          <FlagButton
            what={`criterion ${c.id}`}
            onClick={() =>
              onFlag({
                label: `${c.kind === "inclusion" ? "Inclusion" : "Exclusion"} criterion, applied at position ${index + 1} of ${count}`,
                context: [
                  `Protocol text: ${c.sourceText}`,
                  `Mapped as: ${describeTest(spec, t)}`,
                ],
                target: { kind: "spec_field", ref: c.id, specVersion: spec.meta.version },
                reasonHint:
                  "Which part of the rule is off (the code list, the window, the claim count, the setting), and what does the protocol say?",
              })
            }
          />
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
        {describeTest(spec, t)}{" "}
        <FlagButton
          what={`this plain-English reading of criterion ${c.id}`}
          className="btn btn-quiet btn-sm"
          onClick={() =>
            onFlag({
              label: `Plain-English reading of criterion ${c.id}`,
              context: [`Reads as: ${describeTest(spec, t)}`],
              target: {
                kind: "terminology",
                ref: `${c.id}:maps_to`,
                specVersion: spec.meta.version,
              },
              classification: "terminology",
              reasonHint:
                "How would you say it instead, and where does this wording mislead a reader of your protocol?",
            })
          }
        >
          Flag this reading
        </FlagButton>
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
              sourceText: sourceText.trim() || "Added manually in HEOR Studio (no protocol quote).",
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

/* ---------- analysis-layer editor ---------- */

const ANALYSIS_KIND_LABELS: Record<AnalysisKind, string> = {
  attrition: "Attrition (CONSORT)",
  table1: "Baseline Table 1",
  incidence_rate: "Incidence rate",
  point_prevalence: "Point prevalence",
  period_prevalence: "Period prevalence",
  cumulative_incidence: "Cumulative incidence (risk)",
  standardization: "Age/sex standardization",
  calendar_trend: "Calendar trend",
  resource_use: "Resource use and cost",
  comorbidity_index: "Comorbidity index",
  regression: "Regression model",
  survival: "Survival (Kaplan-Meier / log-rank)",
  cox: "Cox proportional hazards",
  competing_risks: "Cumulative incidence with competing risks",
  fine_gray: "Fine-Gray subdistribution hazard model",
  propensity_score: "Propensity-score adjustment (IPTW)",
  iptw_outcome: "IPTW outcome model (weighted effect estimate)",
  g_formula: "Standardization / g-formula (doubly robust)",
  negative_control: "Negative control outcomes (residual confounding)",
  adherence: "Adherence and persistence (PDC / MPR)",
  treatment_switching: "Treatment switching and line of therapy",
  statistical_engine: "Statistical comparison",
  future_stub: "Planned (not generated yet)",
};

const BLANK_OUTCOME: OutcomeDefinition = {
  codeListId: "",
  minClaims: 1,
  setting: "any",
  diagnosisPosition: "any",
};

const WASHOUT_ALL_BEFORE: RelativeWindow = { start: "anytime_before", end: 0, includesIndex: true };

/** A follow-up year, inclusive of both endpoints, the way the shipped adherence
 *  and resource-use analyses express it. */
const FOLLOWUP_YEAR: RelativeWindow = { start: 0, end: 364, includesIndex: true };

/** The time-to-event clock: stops at the event, at disenrollment, or at the end
 *  of the study period. */
const CLOCK_TO_OUTCOME: PersonTimeRule = {
  start: "index",
  censorAt: ["outcome", "disenrollment", "study_end"],
};

const ALL_LEDGER_SETTINGS: LedgerSetting[] = ["inpatient", "ed", "outpatient", "pharmacy"];

/** Age bands whose every boundary is also a boundary of all three bundled
 *  reference populations. Direct standardization is only defined when the study
 *  bands are unions of whole reference bands, and the default reporting bands
 *  (a boundary at 18) are not, so a rate standardized on them is refused at
 *  generation time. These are the aligned starting point. */
const ALIGNED_STANDARDIZATION_BANDS = [0, 25, 45, 65];

function firstGroupVarId(spec: StudySpec): string {
  return groupVarsOf(spec)[0]?.id ?? "";
}

function firstEnabledIndexAnalysisId(spec: StudySpec): string {
  return spec.analyses.find((x) => x.kind === "comorbidity_index" && x.enabled)?.id ?? "";
}

/** The drug list an index-drug analysis measures. The index event's own list is
 *  the study's declared index drug, which is what adherence and switching are
 *  measured against, so it is the default rather than a guess at one. */
function indexDrugListId(spec: StudySpec): string {
  return spec.indexEvent.codeListId || (spec.codeLists[0]?.id ?? "");
}

type AnalysisBuilder = (spec: StudySpec, common: AnalysisCommon) => Analysis;

/**
 * A valid, minimally-parameterized analysis for every kind this screen can
 * create, keyed by kind.
 *
 * THIS MAP IS THE ONE LIST. The add menu, the "is this card editable" test and
 * the gap notice in the Analyses section are all derived from it and from
 * core's EMITTABLE_ANALYSIS_KINDS, because the hand-written add list it
 * replaces went stale twice: fifteen more emitters landed and the menu still
 * offered four, so the whole survival and causal half of the product was
 * unreachable from the browser. Derivation means a kind that becomes emittable
 * in core is either offered here or named in a visible note, never silently
 * dropped.
 *
 * Defaults follow the extractor normalizer where it has an opinion, and leave
 * outcome code lists EMPTY so readiness tells the analyst what to supply. The
 * three code-list fields that structural validation requires to be non-empty
 * (adherence and switching) take the study's own index drug list instead: an
 * empty one there is rejected by checkSpecShape, which the MCP server and the
 * spec chat both run, so it would break the whole spec rather than flag a gap.
 */
const ANALYSIS_BUILDERS: Partial<Record<AnalysisKind, AnalysisBuilder>> = {
  incidence_rate: (_spec, common) => ({
    ...common,
    kind: "incidence_rate",
    outcomeDefinition: { ...BLANK_OUTCOME },
    caseStatus: "incident",
    washout: { ...WASHOUT_ALL_BEFORE },
    denominatorRule: "person_time",
    personTimeRule: { ...CLOCK_TO_OUTCOME },
    recurrence: "first_only",
    rateMultiplier: 1000,
    ciMethod: "poisson_byar",
    stratifyBy: [],
  }),

  point_prevalence: (_spec, common) => ({
    ...common,
    kind: "point_prevalence",
    outcomeDefinition: { ...BLANK_OUTCOME },
    caseStatus: "prevalent",
    anchorDate: { kind: "index" },
    denominatorRule: "enrolled_midperiod",
    ciMethod: "wilson",
    stratifyBy: [],
  }),

  period_prevalence: (spec, common) => ({
    ...common,
    kind: "period_prevalence",
    outcomeDefinition: { ...BLANK_OUTCOME },
    caseStatus: "prevalent",
    /* The study period, not two blank strings: a blank date is not an ISO date,
     * so a spec carrying one fails structural validation. */
    prevalencePeriod: { ...spec.meta.studyPeriod },
    denominatorRule: "enrolled_anytime",
    ciMethod: "wilson",
    stratifyBy: [],
  }),

  cumulative_incidence: (_spec, common) => ({
    ...common,
    kind: "cumulative_incidence",
    outcomeDefinition: { ...BLANK_OUTCOME },
    caseStatus: "incident",
    washout: { ...WASHOUT_ALL_BEFORE },
    incidentWithRespectTo: "cohort_entry",
    denominatorRule: "at_risk_start",
    horizonDays: 365,
    personTimeRule: {
      start: "index",
      censorAt: ["outcome", "disenrollment", "study_end", "max_followup"],
      maxFollowupDays: 365,
    },
    competingRiskDeath: "ignore",
    recurrence: "first_only",
    ciMethod: "wilson",
    stratifyBy: [],
  }),

  standardization: (_spec, common) => ({
    ...common,
    kind: "standardization",
    base: "incidence_rate",
    outcomeDefinition: { ...BLANK_OUTCOME },
    personTimeRule: { ...CLOCK_TO_OUTCOME },
    rateMultiplier: 1000,
    standardization: {
      method: "direct",
      strataIds: ["age_band"],
      referencePopulation: { kind: "named", name: "us_2000" },
      ciMethod: "fay_feuer",
      standardizationBands: [...ALIGNED_STANDARDIZATION_BANDS],
    },
  }),

  calendar_trend: (_spec, common) => ({
    ...common,
    kind: "calendar_trend",
    base: "period_prevalence",
    outcomeDefinition: { ...BLANK_OUTCOME },
    denominatorRule: "enrolled_anytime",
    trend: { bucket: "calendar_year", method: "cochran_armitage", reportPerBucket: true },
    ciMethod: "wilson",
    stratifyBy: [],
  }),

  resource_use: (_spec, common) => ({
    ...common,
    kind: "resource_use",
    ascertainmentWindow: { ...FOLLOWUP_YEAR },
    settings: [...ALL_LEDGER_SETTINGS],
    costField: "paytot",
    includeCombined: true,
  }),

  comorbidity_index: (spec, common) => ({
    ...common,
    kind: "comorbidity_index",
    indexName: "Comorbidity index",
    lookback: { start: -spec.enrollment.baselineDays, end: 0, includesIndex: true },
    conditions: [],
    scoreBands: [0, 1, 3],
  }),

  regression: (spec, common) => ({
    ...common,
    kind: "regression",
    family: "logistic",
    outcomeDefinition: { ...BLANK_OUTCOME },
    washout: { ...WASHOUT_ALL_BEFORE },
    horizonDays: 365,
    groupVarId: firstGroupVarId(spec),
    recurrence: "first_only",
    covariateIds: [],
  }),

  survival: (_spec, common) => ({
    ...common,
    kind: "survival",
    endpoint: { kind: "claims_event", outcomeDefinition: { ...BLANK_OUTCOME } },
    washout: { ...WASHOUT_ALL_BEFORE },
    personTimeRule: { ...CLOCK_TO_OUTCOME },
    horizonDays: [90, 180, 365],
    ciMethod: "log_log",
    emitLifeTable: false,
  }),

  cox: (spec, common) => ({
    ...common,
    kind: "cox",
    endpoint: { kind: "claims_event", outcomeDefinition: { ...BLANK_OUTCOME } },
    washout: { ...WASHOUT_ALL_BEFORE },
    personTimeRule: { ...CLOCK_TO_OUTCOME },
    groupVarId: firstGroupVarId(spec),
    covariateIds: [],
    ties: "breslow",
  }),

  competing_risks: (_spec, common) => ({
    ...common,
    kind: "competing_risks",
    endpoint: { kind: "claims_event", outcomeDefinition: { ...BLANK_OUTCOME } },
    competingEvents: [],
    washout: { ...WASHOUT_ALL_BEFORE },
    personTimeRule: { ...CLOCK_TO_OUTCOME },
    horizonDays: [90, 180, 365],
    emitNaiveComparison: true,
    emitLifeTable: false,
  }),

  fine_gray: (spec, common) => ({
    ...common,
    kind: "fine_gray",
    endpoint: { kind: "claims_event", outcomeDefinition: { ...BLANK_OUTCOME } },
    competingEvents: [],
    washout: { ...WASHOUT_ALL_BEFORE },
    personTimeRule: { ...CLOCK_TO_OUTCOME },
    groupVarId: firstGroupVarId(spec),
    covariateIds: [],
  }),

  propensity_score: (spec, common) => ({
    ...common,
    kind: "propensity_score",
    groupVarId: firstGroupVarId(spec),
    psCovariateIds: [],
    balanceCovariateIds: [],
    method: "iptw",
    estimand: "ate",
    stabilized: true,
    trim: 0,
  }),

  iptw_outcome: (spec, common) => ({
    ...common,
    kind: "iptw_outcome",
    groupVarId: firstGroupVarId(spec),
    psCovariateIds: [],
    estimand: "ate",
    stabilized: true,
    trim: 0,
    outcomeDefinition: { ...BLANK_OUTCOME },
    washout: { ...WASHOUT_ALL_BEFORE },
    horizonDays: 365,
    doublyRobust: false,
  }),

  g_formula: (spec, common) => ({
    ...common,
    kind: "g_formula",
    groupVarId: firstGroupVarId(spec),
    covariateIds: [],
    outcomeDefinition: { ...BLANK_OUTCOME },
    washout: { ...WASHOUT_ALL_BEFORE },
    horizonDays: 365,
  }),

  adherence: (spec, common) => ({
    ...common,
    kind: "adherence",
    drugCodeListId: indexDrugListId(spec),
    window: { ...FOLLOWUP_YEAR },
    permissibleGapDays: 60,
    adherenceThreshold: 0.8,
  }),

  treatment_switching: (spec, common) => {
    const from = indexDrugListId(spec);
    const to = spec.codeLists.find((c) => c.id !== from)?.id ?? from;
    return {
      ...common,
      kind: "treatment_switching",
      fromCodeListId: from,
      toCodeListIds: to === "" ? [] : [to],
      window: { ...FOLLOWUP_YEAR },
      permissibleOverlapDays: 30,
      lineRule: "new_line_on_switch",
    };
  },

  statistical_engine: (_spec, common) => ({
    ...common,
    kind: "statistical_engine",
    comparisonIds: [],
    multiplicity: { method: "none", alpha: 0.05, appliesToRoles: ["primary"] },
  }),
};

/** Cohort-spine kinds: always present, produced by the spine, never added. */
const SPINE_ANALYSIS_KINDS: ReadonlySet<AnalysisKind> = new Set<AnalysisKind>([
  "attrition",
  "table1",
]);

const KIND_HAS_EDITOR = (k: AnalysisKind): boolean => ANALYSIS_BUILDERS[k] !== undefined;

/** What an analyst can add here: everything the emitters generate, less the
 *  spine pair, less anything this screen has no editor for. */
const ADDABLE_ANALYSIS_KINDS: AnalysisKind[] = [...EMITTABLE_ANALYSIS_KINDS].filter(
  (k) => !SPINE_ANALYSIS_KINDS.has(k) && KIND_HAS_EDITOR(k),
);

/** Emittable in core, but with no editor on this screen. Empty today. It is
 *  computed rather than assumed so that the next module to land in core is
 *  named on screen instead of quietly missing from the menu. */
const EMITTABLE_WITHOUT_EDITOR: AnalysisKind[] = [...EMITTABLE_ANALYSIS_KINDS].filter(
  (k) => !SPINE_ANALYSIS_KINDS.has(k) && !KIND_HAS_EDITOR(k),
);

/** Structural validation rejects an empty drug list on these, so the study
 *  needs at least one code list before either can be added. */
const KINDS_NEEDING_CODE_LIST: ReadonlySet<AnalysisKind> = new Set<AnalysisKind>([
  "adherence",
  "treatment_switching",
]);

/** Same, for the exposure these models are about. */
const KINDS_NEEDING_GROUP_VAR: ReadonlySet<AnalysisKind> = new Set<AnalysisKind>([
  "regression",
  "cox",
  "fine_gray",
  "propensity_score",
  "iptw_outcome",
  "g_formula",
]);

/** Grouping for the add menu. Any addable kind missing from here still appears,
 *  under "Other", so the menu cannot go stale even if this list does. */
const ADD_MENU_GROUPS: { label: string; kinds: AnalysisKind[] }[] = [
  {
    label: "Descriptive epidemiology",
    kinds: [
      "incidence_rate",
      "point_prevalence",
      "period_prevalence",
      "cumulative_incidence",
      "standardization",
      "calendar_trend",
    ],
  },
  { label: "Time to event", kinds: ["survival", "competing_risks", "cox", "fine_gray"] },
  {
    label: "Causal and adjusted",
    kinds: ["propensity_score", "iptw_outcome", "g_formula", "regression", "statistical_engine"],
  },
  {
    label: "Treatment and utilization",
    kinds: ["adherence", "treatment_switching", "resource_use", "comorbidity_index"],
  },
];

const ADD_MENU: { label: string; kinds: AnalysisKind[] }[] = (() => {
  const addable = new Set(ADDABLE_ANALYSIS_KINDS);
  const placed = new Set(ADD_MENU_GROUPS.flatMap((g) => g.kinds));
  const groups = ADD_MENU_GROUPS.map((g) => ({
    label: g.label,
    kinds: g.kinds.filter((k) => addable.has(k)),
  })).filter((g) => g.kinds.length > 0);
  const rest = ADDABLE_ANALYSIS_KINDS.filter((k) => !placed.has(k));
  if (rest.length > 0) groups.push({ label: "Other", kinds: rest });
  return groups;
})();

/** Build a valid, minimally-parameterized analysis of the given kind. */
function newAnalysis(spec: StudySpec, kind: AnalysisKind, id: string): Analysis {
  const common: AnalysisCommon = { id, label: ANALYSIS_KIND_LABELS[kind], enabled: true };
  const build = ANALYSIS_BUILDERS[kind];
  // Spine and planned kinds are not offered in the add menu; a bare header is
  // all they carry anyway.
  return build ? build(spec, common) : ({ ...common, kind } as Analysis);
}

/* ---------- per-kind parameter editors ----------
 *
 * One component per analysis kind, each composed from the shared controls
 * above. The kind's own switch arm in AnalysisFields is the only place that
 * knows which fields it has, so adding a kind is: a builder in
 * ANALYSIS_BUILDERS, a label, and one of these.
 */

interface KindProps<T extends Analysis> {
  spec: StudySpec;
  a: T;
  onPatch: (patch: Partial<T>) => void;
}

const PROPORTION_CI_OPTIONS: Choice<ProportionCiMethod>[] = [
  { value: "wilson", label: "Wilson score" },
  { value: "clopper_pearson", label: "Clopper-Pearson exact (SAS)" },
  { value: "wald", label: "Wald" },
];

const RATE_CI_OPTIONS: Choice<RateCiMethod>[] = [
  { value: "poisson_byar", label: "Byar Poisson" },
  { value: "poisson_exact", label: "Poisson exact (SAS)" },
  { value: "wald_log", label: "Wald on the log scale" },
];

const RECURRENCE_OPTIONS: Choice<Recurrence>[] = [
  { value: "first_only", label: "First event only" },
  { value: "all_events", label: "Every event (recurrent)" },
];

const DENOMINATOR_OPTIONS: Choice<DenominatorRule>[] = [
  { value: "enrolled_midperiod", label: "Enrolled on the anchor date" },
  { value: "enrolled_anytime", label: "Enrolled at any point in the window" },
  { value: "at_risk_start", label: "Event free and at risk at the start" },
  { value: "person_time", label: "Person-time at risk" },
];

const ESTIMAND_OPTIONS: Choice<"ate" | "att">[] = [
  { value: "ate", label: "ATE: the effect in everyone" },
  { value: "att", label: "ATT: the effect in the treated" },
];

const COST_FIELD_OPTIONS: Choice<"paytot" | "netpay">[] = [
  { value: "paytot", label: "PAYTOT (total payment)" },
  { value: "netpay", label: "NETPAY (net payment)" },
];

const LEDGER_SETTING_ITEMS: ChecklistItem[] = [
  { id: "inpatient", label: "Inpatient" },
  { id: "ed", label: "Emergency department" },
  { id: "outpatient", label: "Outpatient" },
  { id: "pharmacy", label: "Pharmacy" },
];

/** Stratifiers are shown, not edited: the emitters build demographic axes only,
 *  and the axis list is set through the spec chat or the MCP server. */
function StratifierSummary({ strata }: { strata: Stratifier[] }) {
  return (
    <p className="field-hint">
      {strata.length > 0
        ? `Stratified by ${strata.map((s) => s.label).join(", ")}. `
        : "No stratifiers. "}
      Stratifiers are read here but set through the spec chat or the MCP server.
    </p>
  );
}

function IncidenceRateFields({ spec, a, onPatch }: KindProps<IncidenceRateAnalysis>) {
  const recurrent = a.recurrence === "all_events";
  return (
    <>
      <OutcomeFieldset
        spec={spec}
        legend="Outcome definition"
        value={a.outcomeDefinition}
        onChange={(o) => onPatch({ outcomeDefinition: o })}
      />
      <WindowField
        label="Prevalent-case washout (before index)"
        value={a.washout}
        onChange={(w) => onPatch({ washout: w })}
      />
      <PersonTimeFieldset
        value={a.personTimeRule}
        onChange={(p) => onPatch({ personTimeRule: p })}
        forbidden={recurrent ? ["outcome"] : []}
      />
      <div className="field-row">
        <LabeledNumber
          label="Rate multiplier (per N person-years)"
          min={1}
          hint="1000 = per 1,000 PY"
          value={a.rateMultiplier}
          onCommit={(v) => onPatch({ rateMultiplier: v ?? 1000 })}
        />
        <LabeledSelect
          label="Events counted"
          value={a.recurrence}
          options={RECURRENCE_OPTIONS}
          onChange={(v) =>
            onPatch({
              recurrence: v,
              /* Counting every event while the clock stops at the first one
               * would count events that could never be observed. */
              personTimeRule:
                v === "all_events"
                  ? {
                      ...a.personTimeRule,
                      censorAt: a.personTimeRule.censorAt.filter((c) => c !== "outcome"),
                    }
                  : a.personTimeRule,
            })
          }
        />
        <LabeledSelect
          label="Confidence interval"
          value={a.ciMethod}
          options={RATE_CI_OPTIONS}
          onChange={(v) => onPatch({ ciMethod: v })}
        />
      </div>
      <StratifierSummary strata={a.stratifyBy} />
    </>
  );
}

function PointPrevalenceFields({ spec, a, onPatch }: KindProps<PointPrevalenceAnalysis>) {
  return (
    <>
      <OutcomeFieldset
        spec={spec}
        legend="Outcome definition"
        value={a.outcomeDefinition}
        onChange={(o) => onPatch({ outcomeDefinition: o })}
      />
      <div className="field">
        <span className="field-label">Anchor date</span>
        {a.anchorDate.kind === "fixed" ? (
          <div className="field-row">
            <CommitInput
              className="control"
              type="date"
              aria-label="Anchor date"
              value={a.anchorDate.date}
              onCommit={(v) => onPatch({ anchorDate: { kind: "fixed", date: v } })}
            />
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => onPatch({ anchorDate: { kind: "index" } })}
            >
              Use each subject&rsquo;s index date
            </button>
          </div>
        ) : (
          <div className="field-row">
            <span className="field-hint">Each subject&rsquo;s own index date.</span>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() =>
                onPatch({ anchorDate: { kind: "fixed", date: spec.indexEvent.indexPeriod.end } })
              }
            >
              Use a fixed calendar date
            </button>
          </div>
        )}
      </div>
      <div className="field-row">
        <LabeledSelect
          label="Confidence interval"
          value={a.ciMethod}
          options={PROPORTION_CI_OPTIONS}
          onChange={(v) => onPatch({ ciMethod: v })}
        />
      </div>
      <StratifierSummary strata={a.stratifyBy} />
    </>
  );
}

function PeriodPrevalenceFields({ spec, a, onPatch }: KindProps<PeriodPrevalenceAnalysis>) {
  return (
    <>
      <OutcomeFieldset
        spec={spec}
        legend="Outcome definition"
        value={a.outcomeDefinition}
        onChange={(o) => onPatch({ outcomeDefinition: o })}
      />
      <div className="field-row">
        <LabeledText
          label="Period start"
          type="date"
          value={a.prevalencePeriod.start}
          onCommit={(v) => onPatch({ prevalencePeriod: { ...a.prevalencePeriod, start: v } })}
        />
        <LabeledText
          label="Period end"
          type="date"
          value={a.prevalencePeriod.end}
          onCommit={(v) => onPatch({ prevalencePeriod: { ...a.prevalencePeriod, end: v } })}
        />
        <LabeledSelect
          label="Confidence interval"
          value={a.ciMethod}
          options={PROPORTION_CI_OPTIONS}
          onChange={(v) => onPatch({ ciMethod: v })}
        />
      </div>
      <StratifierSummary strata={a.stratifyBy} />
    </>
  );
}

function CumulativeIncidenceFields({ spec, a, onPatch }: KindProps<CumulativeIncidenceAnalysis>) {
  return (
    <>
      <OutcomeFieldset
        spec={spec}
        legend="Outcome definition"
        value={a.outcomeDefinition}
        onChange={(o) => onPatch({ outcomeDefinition: o })}
      />
      <WindowField
        label="Prevalent-case washout (before index)"
        value={a.washout}
        onChange={(w) => onPatch({ washout: w })}
      />
      <PersonTimeFieldset
        value={a.personTimeRule}
        onChange={(p) => onPatch({ personTimeRule: p })}
      />
      <div className="field-row">
        <LabeledNumber
          label="Risk horizon (days after index)"
          min={1}
          hint="365 = 1-year risk"
          value={a.horizonDays}
          onCommit={(v) => onPatch({ horizonDays: v ?? 365 })}
        />
        <LabeledSelect
          label="Incident with respect to"
          value={a.incidentWithRespectTo}
          options={[
            { value: "cohort_entry", label: "Cohort entry" },
            { value: "first_ever", label: "First ever recorded" },
          ]}
          onChange={(v) => onPatch({ incidentWithRespectTo: v })}
        />
        <LabeledSelect
          label="Competing death"
          value={a.competingRiskDeath}
          options={[
            { value: "ignore", label: "Ignore" },
            { value: "censor", label: "Censor (1 minus KM)" },
            { value: "aalen_johansen", label: "Aalen-Johansen CIF (SAS only)" },
          ]}
          hint="Ignoring or censoring death overstates risk when death is common."
          onChange={(v) => onPatch({ competingRiskDeath: v })}
        />
        <LabeledSelect
          label="Confidence interval"
          value={a.ciMethod}
          options={PROPORTION_CI_OPTIONS}
          onChange={(v) => onPatch({ ciMethod: v })}
        />
      </div>
      <StratifierSummary strata={a.stratifyBy} />
    </>
  );
}

function StandardizationFields({ spec, a, onPatch }: KindProps<StandardizationAnalysis>) {
  const std = a.standardization;
  const custom = std.referencePopulation.kind === "custom";
  const patchStd = (p: Partial<StandardizationAnalysis["standardization"]>) =>
    onPatch({ standardization: { ...std, ...p } });
  return (
    <>
      <div className="field-row">
        <LabeledSelect
          label="Measure being standardized"
          value={a.base}
          options={[
            { value: "incidence_rate", label: "Incidence rate" },
            { value: "point_prevalence", label: "Point prevalence" },
            { value: "period_prevalence", label: "Period prevalence" },
          ]}
          onChange={(v) =>
            onPatch({
              base: v,
              // A rate needs the same clock the incidence table used, or the
              // standardized rate re-weights a different measure.
              personTimeRule:
                v === "incidence_rate"
                  ? (a.personTimeRule ?? { ...CLOCK_TO_OUTCOME })
                  : undefined,
            })
          }
        />
        {a.base === "incidence_rate" && (
          <LabeledNumber
            label="Rate multiplier (per N person-years)"
            min={1}
            value={a.rateMultiplier ?? 1000}
            onCommit={(v) => onPatch({ rateMultiplier: v ?? 1000 })}
          />
        )}
      </div>
      <OutcomeFieldset
        spec={spec}
        legend="Outcome definition"
        value={a.outcomeDefinition}
        onChange={(o) => onPatch({ outcomeDefinition: o })}
      />
      {a.base === "incidence_rate" && a.personTimeRule && (
        <PersonTimeFieldset
          value={a.personTimeRule}
          onChange={(p) => onPatch({ personTimeRule: p })}
          hint="Match the incidence analysis this standardizes, maximum follow-up included."
        />
      )}
      <fieldset className="analysis-fieldset">
        <legend>Direct standardization</legend>
        {custom && (
          <p className="field-hint">
            This analysis names custom reference weights. They are not generated yet, so no
            standardized rate is emitted. Pick a bundled population below to replace them.
          </p>
        )}
        <div className="field-row">
          <LabeledSelect
            label="Reference population"
            value={
              std.referencePopulation.kind === "named" ? std.referencePopulation.name : "us_2000"
            }
            options={[
              { value: "us_2000", label: "US 2000 standard million" },
              { value: "who_world", label: "WHO World standard" },
              { value: "esp_2013", label: "European standard 2013" },
            ]}
            onChange={(v) => patchStd({ referencePopulation: { kind: "named", name: v } })}
          />
          <LabeledSelect
            label="Interval"
            value={std.ciMethod}
            options={[
              { value: "fay_feuer", label: "Fay-Feuer gamma (SAS)" },
              { value: "dobson", label: "Dobson (SAS)" },
              { value: "normal_approx", label: "Normal approximation" },
            ]}
            onChange={(v) => patchStd({ ciMethod: v })}
          />
        </div>
        <div className="field-row">
          <NumberListField
            label="Age bands (inclusive lower bounds)"
            min={0}
            value={std.standardizationBands ?? [...ALIGNED_STANDARDIZATION_BANDS]}
            onCommit={(v) => patchStd({ standardizationBands: v })}
            hint="Every boundary must also be a boundary of the reference population, or no standardized rate is emitted. 0, 25, 45, 65 line up with all three."
          />
          <TextListField
            label="Strata reported"
            value={std.strataIds}
            onCommit={(v) => patchStd({ strataIds: v })}
            hint="At least one. The rate itself is standardized over the age bands above."
          />
        </div>
      </fieldset>
    </>
  );
}

function CalendarTrendFields({ spec, a, onPatch }: KindProps<CalendarTrendAnalysis>) {
  const rateBase = a.base === "incidence_rate";
  const armitage = a.trend.method === "cochran_armitage";
  return (
    <>
      <div className="field-row">
        <LabeledSelect
          label="Measure being trended"
          value={a.base}
          options={[{ value: "period_prevalence", label: "Period prevalence" }]}
          hint="Only the proportion trend is generated. A rate trend needs person-time split across buckets; a point-prevalence trend needs a per-bucket anchor."
          onChange={(v) => onPatch({ base: v })}
        />
        <LabeledSelect
          label="Denominator"
          value={a.denominatorRule}
          options={DENOMINATOR_OPTIONS}
          onChange={(v) => onPatch({ denominatorRule: v })}
        />
      </div>
      <OutcomeFieldset
        spec={spec}
        legend="Outcome definition"
        value={a.outcomeDefinition}
        onChange={(o) => onPatch({ outcomeDefinition: o })}
      />
      <fieldset className="analysis-fieldset">
        <legend>Trend test</legend>
        <div className="field-row">
          <LabeledSelect
            label="Bucket"
            value={a.trend.bucket}
            options={[
              { value: "calendar_year", label: "Calendar year" },
              { value: "calendar_quarter", label: "Calendar quarter" },
              /* Monthly buckets under a Cochran-Armitage test score the buckets
               * 0,1,2,... and assume equal spacing, so dozens of sparse cells
               * leave it almost no power. Readiness blocks the pair. */
              ...(armitage ? [] : [{ value: "calendar_month" as const, label: "Calendar month" }]),
            ]}
            hint={armitage ? "Monthly buckets are not offered with a Cochran-Armitage test." : undefined}
            onChange={(v) => onPatch({ trend: { ...a.trend, bucket: v } })}
          />
          <LabeledSelect
            label="Method"
            value={a.trend.method}
            options={[
              { value: "cochran_armitage", label: "Cochran-Armitage" },
              { value: "poisson_rate_trend", label: "Poisson rate trend" },
              { value: "linear_slope", label: "Linear slope" },
            ]}
            onChange={(v) =>
              onPatch({
                trend: {
                  ...a.trend,
                  method: v,
                  bucket:
                    v === "cochran_armitage" && a.trend.bucket === "calendar_month"
                      ? "calendar_quarter"
                      : a.trend.bucket,
                },
              })
            }
          />
          <CheckField
            label="Report each bucket"
            checked={a.trend.reportPerBucket}
            onChange={(v) => onPatch({ trend: { ...a.trend, reportPerBucket: v } })}
          />
        </div>
        <div className="field-row">
          <LabeledSelect<ProportionCiMethod | RateCiMethod>
            label="Confidence interval"
            value={a.ciMethod}
            options={rateBase ? RATE_CI_OPTIONS : PROPORTION_CI_OPTIONS}
            onChange={(v) => onPatch({ ciMethod: v })}
          />
        </div>
      </fieldset>
      <StratifierSummary strata={a.stratifyBy} />
    </>
  );
}

function ResourceUseFields({ a, onPatch }: KindProps<ResourceUseAnalysis>) {
  return (
    <>
      <WindowField
        label="Ascertainment window"
        bounded
        value={a.ascertainmentWindow}
        onChange={(w) => onPatch({ ascertainmentWindow: w })}
        hint="Both endpoints are counted, so a 365-day follow-up is day 0 through day 364. Cost is divided by the observed days inside the window, so it needs day bounds."
      />
      <IdChecklist
        label="Encounter settings"
        items={LEDGER_SETTING_ITEMS}
        selected={a.settings}
        minSelected={1}
        onChange={(ids) => onPatch({ settings: ids as LedgerSetting[] })}
        hint="The emergency department is carved out of outpatient by place of service."
      />
      <div className="field-row">
        <LabeledSelect
          label="Payment column"
          value={a.costField}
          options={COST_FIELD_OPTIONS}
          onChange={(v) => onPatch({ costField: v })}
        />
        <CheckField
          label="Also report a combined row"
          checked={a.includeCombined}
          onChange={(v) => onPatch({ includeCombined: v })}
        />
      </div>
      <div className="field-row">
        <TextListField
          label="Emergency department place-of-service codes"
          value={a.edPlaceOfService ?? []}
          placeholder="23"
          onCommit={(v) =>
            onPatch({
              edPlaceOfService:
                v.length === 0 ? undefined : v.filter((c) => /^[\x20-\x7E]+$/.test(c)),
            })
          }
          hint="Blank uses 23, the standard ED place of service."
        />
      </div>
    </>
  );
}

function ComorbidityIndexFields({ spec, a, onPatch }: KindProps<ComorbidityIndexAnalysis>) {
  const noLists = spec.codeLists.length === 0;
  const patchCondition = (i: number, next: ComorbidityIndexAnalysis["conditions"][number]) =>
    onPatch({ conditions: a.conditions.map((c, j) => (j === i ? next : c)) });
  return (
    <>
      <div className="field-row">
        <LabeledText
          label="Index name"
          wide
          value={a.indexName}
          onCommit={(v) => onPatch({ indexName: v || "Comorbidity index" })}
          hint="A label carried into the output. The conditions below are the definition."
        />
      </div>
      <WindowField
        label="Lookback (before index)"
        value={a.lookback}
        onChange={(w) => onPatch({ lookback: w })}
      />
      <fieldset className="analysis-fieldset">
        <legend>Conditions</legend>
        {a.conditions.length === 0 && (
          <p className="field-hint">
            None yet. With no conditions the score is zero for everyone, and readiness says so.
            Weights come from the published algorithm you are implementing, never from this tool.
          </p>
        )}
        {a.conditions.map((c, i) => (
          <div className="field" key={c.id}>
            <div className="field-row">
              <LabeledText
                label="Condition"
                value={c.label}
                onCommit={(v) => patchCondition(i, { ...c, label: v || c.id })}
              />
              <CodeListSelect
                spec={spec}
                value={c.codeListId}
                onChange={(v) => patchCondition(i, { ...c, codeListId: v })}
              />
              <LabeledNumber
                label="Weight"
                min={0}
                fraction
                step={0.5}
                value={c.weight}
                onCommit={(v) => patchCondition(i, { ...c, weight: v ?? 1 })}
              />
              <button
                type="button"
                className="btn btn-sm btn-danger-quiet"
                aria-label={`Remove condition ${c.label}`}
                onClick={() => onPatch({ conditions: a.conditions.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
            <IdChecklist
              label="Withholds the weight of"
              items={a.conditions
                .filter((o) => o.id !== c.id)
                .map((o) => ({ id: o.id, label: o.label }))}
              selected={c.supersedes ?? []}
              onChange={(ids) =>
                patchCondition(i, { ...c, supersedes: ids.length === 0 ? undefined : ids })
              }
              emptyNote="Add a second condition to declare a hierarchy."
            />
          </div>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          disabled={noLists}
          onClick={() => {
            const n = a.conditions.length + 1;
            onPatch({
              conditions: [
                ...a.conditions,
                {
                  id: `condition_${n}`,
                  label: `Condition ${n}`,
                  codeListId: spec.codeLists[0]?.id ?? "",
                  weight: 1,
                },
              ],
            });
          }}
        >
          Add a condition
        </button>
        {noLists && (
          <span className="field-hint">
            A condition needs a code list. Create one in the Codelists step first.
          </span>
        )}
      </fieldset>
      <div className="field-row">
        <NumberListField
          label="Score bands (inclusive lower bounds)"
          min={0}
          value={a.scoreBands}
          onCommit={(v) => onPatch({ scoreBands: v })}
          hint="e.g. 0, 1, 3"
        />
      </div>
    </>
  );
}

const REGRESSION_FAMILY_OPTIONS: Choice<RegressionFamily>[] = [
  { value: "logistic", label: "Logistic (binary outcome, odds ratio)" },
  { value: "poisson", label: "Poisson (count, rate ratio)" },
  { value: "negative_binomial", label: "Negative binomial (overdispersed count)" },
  { value: "gamma_log", label: "Gamma log-link (cost)" },
  { value: "ols", label: "OLS (continuous)" },
];

/** Rebuild the family-dependent fields when the family changes.
 *
 *  Each family needs a different response and a different offset, and carrying
 *  the previous family's over is how a cost model ends up with a person-time
 *  offset or a count model with none. Both are refused by readiness, and both
 *  are avoidable here. */
function regressionForFamily(
  a: RegressionAnalysis,
  family: RegressionFamily,
  spec: StudySpec,
): Partial<RegressionAnalysis> {
  const base: Partial<RegressionAnalysis> = {
    family,
    personTimeRule: undefined,
    continuousResponse: undefined,
    costResponse: undefined,
    recurrence: "first_only",
  };
  switch (family) {
    case "logistic":
      return base;
    case "poisson":
      return { ...base, personTimeRule: a.personTimeRule ?? { ...CLOCK_TO_OUTCOME } };
    case "negative_binomial":
      /* A negative binomial fitted to a 0/1 response is degenerate, so it takes
       * every event, and a clock that stopped at the first one would contradict
       * that. */
      return {
        ...base,
        recurrence: "all_events",
        personTimeRule: { start: "index", censorAt: ["disenrollment", "study_end"] },
      };
    case "gamma_log":
      return {
        ...base,
        costResponse: {
          window: { ...FOLLOWUP_YEAR },
          settings: [...ALL_LEDGER_SETTINGS],
          costField: "paytot",
        },
      };
    case "ols": {
      const idx = firstEnabledIndexAnalysisId(spec);
      return {
        ...base,
        continuousResponse: idx
          ? { source: "comorbidity_index", comorbidityIndexAnalysisId: idx }
          : undefined,
      };
    }
  }
}

function RegressionFields({ spec, a, onPatch }: KindProps<RegressionAnalysis>) {
  const counts = a.family === "poisson" || a.family === "negative_binomial";
  const indexAnalyses = spec.analyses.filter((x) => x.kind === "comorbidity_index" && x.enabled);
  const recurrent = (a.recurrence ?? "first_only") === "all_events";
  const cost = a.costResponse;
  return (
    <>
      <div className="field-row">
        <LabeledSelect
          label="Family"
          value={a.family}
          options={REGRESSION_FAMILY_OPTIONS}
          onChange={(v) => onPatch(regressionForFamily(a, v, spec))}
        />
        <GroupVarSelect
          spec={spec}
          value={a.groupVarId}
          onChange={(v) => onPatch({ groupVarId: v ?? "" })}
          hint="Two levels with a reference level: the closed-form check this model is measured against is a 2x2."
        />
        <LabeledNumber
          label="Outcome horizon (days after index)"
          min={1}
          value={a.horizonDays}
          onCommit={(v) => onPatch({ horizonDays: v ?? 365 })}
        />
      </div>
      <OutcomeFieldset
        spec={spec}
        legend="Outcome definition"
        value={a.outcomeDefinition}
        onChange={(o) => onPatch({ outcomeDefinition: o })}
      />
      <WindowField
        label="Prevalent-case washout (before index)"
        value={a.washout}
        onChange={(w) => onPatch({ washout: w })}
      />

      {counts && (
        <>
          <div className="field-row">
            <LabeledSelect
              label="Events counted"
              value={a.recurrence ?? "first_only"}
              options={RECURRENCE_OPTIONS}
              disabled={a.family === "negative_binomial"}
              hint={
                a.family === "negative_binomial"
                  ? "A negative binomial needs every event: on a 0/1 response its dispersion parameter is not identified."
                  : undefined
              }
              onChange={(v) =>
                onPatch({
                  recurrence: v,
                  personTimeRule:
                    v === "all_events" && a.personTimeRule
                      ? {
                          ...a.personTimeRule,
                          censorAt: a.personTimeRule.censorAt.filter((c) => c !== "outcome"),
                        }
                      : a.personTimeRule,
                })
              }
            />
          </div>
          {a.personTimeRule && (
            <PersonTimeFieldset
              legend="Person-time offset"
              value={a.personTimeRule}
              onChange={(p) => onPatch({ personTimeRule: p })}
              forbidden={recurrent ? ["outcome"] : []}
              hint="Without an offset the model fits counts rather than rates."
            />
          )}
        </>
      )}

      {a.family === "ols" && (
        <fieldset className="analysis-fieldset">
          <legend>Continuous response</legend>
          <LabeledSelect
            label="Response comes from"
            value={a.continuousResponse?.comorbidityIndexAnalysisId ?? ""}
            options={[
              { value: "", label: "Not chosen yet" },
              ...indexAnalyses.map((x) => ({ value: x.id, label: x.label })),
            ]}
            hint="A comorbidity index score is the only continuous response derivable today."
            onChange={(v) =>
              onPatch({
                continuousResponse:
                  v === ""
                    ? undefined
                    : { source: "comorbidity_index", comorbidityIndexAnalysisId: v },
              })
            }
          />
          {indexAnalyses.length === 0 && (
            <span className="field-hint">
              This study has no enabled comorbidity index analysis. Add one, or choose another
              family.
            </span>
          )}
        </fieldset>
      )}

      {a.family === "gamma_log" && cost && (
        <fieldset className="analysis-fieldset">
          <legend>Cost response</legend>
          <WindowField
            label="Cost window"
            bounded
            value={cost.window}
            onChange={(w) => onPatch({ costResponse: { ...cost, window: w } })}
            hint="Cost is a total over the window, not a rate, so this model takes no person-time offset."
          />
          <IdChecklist
            label="Encounter settings"
            items={LEDGER_SETTING_ITEMS}
            selected={cost.settings}
            minSelected={1}
            onChange={(ids) =>
              onPatch({ costResponse: { ...cost, settings: ids as LedgerSetting[] } })
            }
          />
          <LabeledSelect
            label="Payment column"
            value={cost.costField}
            options={COST_FIELD_OPTIONS}
            onChange={(v) => onPatch({ costResponse: { ...cost, costField: v } })}
          />
        </fieldset>
      )}

      <BaselineChecklist
        spec={spec}
        label="Adjusted for"
        selected={a.covariateIds}
        onChange={(ids) => onPatch({ covariateIds: ids })}
      />
    </>
  );
}

function SurvivalFields({ spec, a, onPatch }: KindProps<SurvivalAnalysis>) {
  return (
    <>
      <EndpointFieldset
        spec={spec}
        value={a.endpoint}
        onChange={(e) => onPatch({ endpoint: e })}
      />
      <WindowField
        label="Prevalent-case washout (before index)"
        value={a.washout}
        onChange={(w) => onPatch({ washout: w })}
      />
      <PersonTimeFieldset
        value={a.personTimeRule}
        onChange={(p) => onPatch({ personTimeRule: p })}
        required={["outcome"]}
      />
      <div className="field-row">
        <NumberListField
          label="Report survival at (days)"
          value={a.horizonDays}
          onCommit={(v) => onPatch({ horizonDays: v })}
          hint="Comma separated, e.g. 90, 180, 365"
        />
        <LabeledSelect
          label="Interval"
          value={a.ciMethod}
          options={[
            { value: "log_log", label: "Log-log (limits stay inside 0 to 1)" },
            { value: "linear", label: "Greenwood, linear scale" },
          ]}
          onChange={(v) => onPatch({ ciMethod: v })}
        />
        <GroupVarSelect
          spec={spec}
          label="Compared groups"
          allowNone
          value={a.groupVarId}
          onChange={(v) => onPatch({ groupVarId: v })}
          hint="Two levels, compared with the log-rank test."
        />
      </div>
      <CheckField
        label="Emit the per-event-time life table"
        checked={a.emitLifeTable}
        onChange={(v) => onPatch({ emitLifeTable: v })}
        hint="The most disclosive table this project produces: most rows carry a single patient's event date."
      />
    </>
  );
}

function CoxFields({ spec, a, onPatch }: KindProps<CoxAnalysis>) {
  return (
    <>
      <EndpointFieldset spec={spec} value={a.endpoint} onChange={(e) => onPatch({ endpoint: e })} />
      <WindowField
        label="Prevalent-case washout (before index)"
        value={a.washout}
        onChange={(w) => onPatch({ washout: w })}
      />
      <PersonTimeFieldset
        value={a.personTimeRule}
        onChange={(p) => onPatch({ personTimeRule: p })}
        required={["outcome"]}
      />
      <div className="field-row">
        <GroupVarSelect
          spec={spec}
          value={a.groupVarId}
          onChange={(v) => onPatch({ groupVarId: v ?? "" })}
        />
        <LabeledSelect
          label="Tied event times"
          value={a.ties}
          options={[{ value: "breslow", label: "Breslow" }]}
          hint="Both twins compute Breslow's closed forms, so a SAS fit maximizing Efron's likelihood would fail this program's own self-check even when it is right."
          onChange={(v) => onPatch({ ties: v })}
        />
      </div>
      <BaselineChecklist
        spec={spec}
        label="Adjusted for"
        selected={a.covariateIds}
        onChange={(ids) => onPatch({ covariateIds: ids })}
      />
    </>
  );
}

function CompetingRisksFields({ spec, a, onPatch }: KindProps<CompetingRisksAnalysis>) {
  return (
    <>
      <EndpointFieldset
        spec={spec}
        legend="Event of interest"
        value={a.endpoint}
        onChange={(e) => onPatch({ endpoint: e })}
      />
      <CompetingEventsFieldset
        spec={spec}
        value={a.competingEvents}
        onChange={(e) => onPatch({ competingEvents: e })}
      />
      <WindowField
        label="Prevalent-case washout (before index)"
        value={a.washout}
        onChange={(w) => onPatch({ washout: w })}
      />
      <PersonTimeFieldset
        value={a.personTimeRule}
        onChange={(p) => onPatch({ personTimeRule: p })}
        required={["outcome"]}
      />
      <div className="field-row">
        <NumberListField
          label="Report the CIF at (days)"
          value={a.horizonDays}
          onCommit={(v) => onPatch({ horizonDays: v })}
          hint="Comma separated, e.g. 90, 180, 365"
        />
      </div>
      <div className="field-row">
        <CheckField
          label="Show the naive 1 minus KM beside it"
          checked={a.emitNaiveComparison}
          onChange={(v) => onPatch({ emitNaiveComparison: v })}
          hint="The gap between the two is the bias this analysis exists to measure."
        />
        <CheckField
          label="Emit the per-event-time life table"
          checked={a.emitLifeTable}
          onChange={(v) => onPatch({ emitLifeTable: v })}
        />
      </div>
    </>
  );
}

function FineGrayFields({ spec, a, onPatch }: KindProps<FineGrayAnalysis>) {
  return (
    <>
      <EndpointFieldset
        spec={spec}
        legend="Event of interest"
        value={a.endpoint}
        onChange={(e) => onPatch({ endpoint: e })}
      />
      <CompetingEventsFieldset
        spec={spec}
        value={a.competingEvents}
        onChange={(e) => onPatch({ competingEvents: e })}
      />
      <WindowField
        label="Prevalent-case washout (before index)"
        value={a.washout}
        onChange={(w) => onPatch({ washout: w })}
      />
      <PersonTimeFieldset
        value={a.personTimeRule}
        onChange={(p) => onPatch({ personTimeRule: p })}
        required={["outcome"]}
      />
      <div className="field-row">
        <GroupVarSelect
          spec={spec}
          value={a.groupVarId}
          onChange={(v) => onPatch({ groupVarId: v ?? "" })}
        />
      </div>
      <BaselineChecklist
        spec={spec}
        label="Adjusted for"
        selected={a.covariateIds}
        onChange={(ids) => onPatch({ covariateIds: ids })}
      />
    </>
  );
}

const PS_COVARIATE_HINT =
  "Categorical only. The score is closed form because a logistic model over categorical cells is saturated: its fitted probability in each cell is the observed treated fraction. Band a continuous variable, or fit the score in SAS and bring it in.";

function PropensityScoreFields({ spec, a, onPatch }: KindProps<PropensityScoreAnalysis>) {
  return (
    <>
      <div className="field-row">
        <GroupVarSelect
          spec={spec}
          label="Treatment"
          value={a.groupVarId}
          onChange={(v) => onPatch({ groupVarId: v ?? "" })}
          hint="A propensity score is the probability of one treatment, so exactly two levels."
        />
        <LabeledSelect
          label="Method"
          value={a.method}
          options={[{ value: "iptw", label: "Inverse-probability weighting (IPTW)" }]}
          hint="Greedy and optimal matching are not generated: greedy is order dependent, and optimal needs an assignment algorithm warehouse SQL cannot express."
          onChange={(v) => onPatch({ method: v })}
        />
        <LabeledSelect
          label="Estimand"
          value={a.estimand}
          options={ESTIMAND_OPTIONS}
          onChange={(v) => onPatch({ estimand: v })}
        />
      </div>
      <div className="field-row">
        <CheckField
          label="Stabilized weights"
          checked={a.stabilized}
          onChange={(v) => onPatch({ stabilized: v })}
        />
        <LabeledNumber
          label="Symmetric trim"
          min={0}
          max={0.49}
          fraction
          step={0.01}
          value={a.trim}
          onCommit={(v) => onPatch({ trim: v ?? 0 })}
          hint="0.05 keeps scores in 0.05 to 0.95. 0 = no trim."
        />
      </div>
      <BaselineChecklist
        spec={spec}
        label="Propensity model covariates"
        categoricalOnly
        selected={a.psCovariateIds}
        onChange={(ids) => onPatch({ psCovariateIds: ids })}
        hint={PS_COVARIATE_HINT}
      />
      <BaselineChecklist
        spec={spec}
        label="Balance reported on"
        selected={a.balanceCovariateIds}
        onChange={(ids) => onPatch({ balanceCovariateIds: ids })}
        hint="Balance may be reported on continuous variables even though the score cannot use them."
      />
    </>
  );
}

function IptwOutcomeFields({ spec, a, onPatch }: KindProps<IptwOutcomeAnalysis>) {
  return (
    <>
      <div className="field-row">
        <GroupVarSelect
          spec={spec}
          label="Treatment"
          value={a.groupVarId}
          onChange={(v) => onPatch({ groupVarId: v ?? "" })}
        />
        <LabeledSelect
          label="Estimand"
          value={a.estimand}
          options={ESTIMAND_OPTIONS}
          onChange={(v) => onPatch({ estimand: v })}
        />
        <LabeledNumber
          label="Outcome horizon (days after index)"
          min={1}
          value={a.horizonDays}
          onCommit={(v) => onPatch({ horizonDays: v ?? 365 })}
        />
      </div>
      <OutcomeFieldset
        spec={spec}
        legend="Outcome definition"
        value={a.outcomeDefinition}
        onChange={(o) => onPatch({ outcomeDefinition: o })}
      />
      <WindowField
        label="Prevalent-case washout (before index)"
        value={a.washout}
        onChange={(w) => onPatch({ washout: w })}
      />
      <BaselineChecklist
        spec={spec}
        label="Propensity model covariates"
        categoricalOnly
        selected={a.psCovariateIds}
        onChange={(ids) => onPatch({ psCovariateIds: ids })}
        hint={PS_COVARIATE_HINT}
      />
      <div className="field-row">
        <CheckField
          label="Stabilized weights"
          checked={a.stabilized}
          onChange={(v) => onPatch({ stabilized: v })}
        />
        <LabeledNumber
          label="Symmetric trim"
          min={0}
          max={0.49}
          fraction
          step={0.01}
          value={a.trim}
          onCommit={(v) => onPatch({ trim: v ?? 0 })}
        />
        <CheckField
          label="Doubly robust (augmented IPTW)"
          checked={a.doublyRobust}
          disabled={!a.doublyRobust}
          onChange={(v) => onPatch({ doublyRobust: v })}
          hint="Not built yet. It needs the augmentation term's own influence function, since the AIPW variance is not the Hajek sandwich."
        />
      </div>
    </>
  );
}

function GFormulaFields({ spec, a, onPatch }: KindProps<GFormulaAnalysis>) {
  return (
    <>
      <div className="field-row">
        <GroupVarSelect
          spec={spec}
          label="Treatment"
          value={a.groupVarId}
          onChange={(v) => onPatch({ groupVarId: v ?? "" })}
        />
        <LabeledNumber
          label="Outcome horizon (days after index)"
          min={1}
          value={a.horizonDays}
          onCommit={(v) => onPatch({ horizonDays: v ?? 365 })}
        />
      </div>
      <OutcomeFieldset
        spec={spec}
        legend="Outcome definition"
        value={a.outcomeDefinition}
        onChange={(o) => onPatch({ outcomeDefinition: o })}
      />
      <WindowField
        label="Prevalent-case washout (before index)"
        value={a.washout}
        onChange={(w) => onPatch({ washout: w })}
      />
      <BaselineChecklist
        spec={spec}
        label="Standardized over"
        categoricalOnly
        selected={a.covariateIds}
        onChange={(ids) => onPatch({ covariateIds: ids })}
        hint="The g-formula standardizes over cells, and a continuous covariate has no cells. At least one is required."
      />
    </>
  );
}

/** Shared by every analysis that reads the per-fill feeder, so the two cannot
 *  drift into cleaning DAYSUPP differently. */
function DaysSupplyFieldset({
  value,
  onChange,
}: {
  value: { daysSupplyCleaning?: DaysSupplyCleaning };
  onChange: (c: DaysSupplyCleaning) => void;
}) {
  const clean = daysSupplyCleaningFor(value);
  const patch = (p: Partial<DaysSupplyCleaning>) => onChange({ ...clean, ...p });
  return (
    <fieldset className="analysis-fieldset">
      <legend>Days-supply cleaning</legend>
      <p className="field-hint">
        DAYSUPP is a billing field, not an observation. Every drop is counted in a fill-attrition
        table beside the results.
      </p>
      <div className="field-row">
        <CheckField
          label="Drop fills with no days supply"
          checked={clean.dropMissing}
          onChange={(v) => patch({ dropMissing: v })}
        />
        <CheckField
          label="Drop zero and negative days supply"
          checked={clean.dropZeroNegative}
          onChange={(v) => patch({ dropZeroNegative: v })}
        />
        <LabeledNumber
          label="Maximum days supply"
          min={1}
          value={clean.maxDaysSupplyCap}
          onCommit={(v) =>
            patch({ maxDaysSupplyCap: v ?? DEFAULT_DAYS_SUPPLY_CLEANING.maxDaysSupplyCap })
          }
          hint="A year on one dispensing is usually a keying error."
        />
      </div>
    </fieldset>
  );
}

function AdherenceFields({ spec, a, onPatch }: KindProps<AdherenceAnalysis>) {
  return (
    <>
      <CodeListSelect
        spec={spec}
        label="Drug code list"
        value={a.drugCodeListId}
        onChange={(v) => onPatch({ drugCodeListId: v })}
      />
      <WindowField
        label="Measurement window"
        bounded
        value={a.window}
        onChange={(w) => onPatch({ window: w })}
        hint="Both endpoints are counted, so a 365-day follow-up is day 0 through day 364."
      />
      <div className="field-row">
        <LabeledNumber
          label="Permissible gap (days)"
          min={1}
          value={a.permissibleGapDays}
          onCommit={(v) => onPatch({ permissibleGapDays: v ?? 60 })}
          hint="An uncovered stretch this long counts as discontinuation."
        />
        <LabeledNumber
          label="Adherence threshold (PDC)"
          min={0.01}
          max={1}
          fraction
          step={0.05}
          value={a.adherenceThreshold}
          onCommit={(v) => onPatch({ adherenceThreshold: v ?? 0.8 })}
          hint="0.8 is conventional, not a fact."
        />
      </div>
      <DaysSupplyFieldset value={a} onChange={(c) => onPatch({ daysSupplyCleaning: c })} />
    </>
  );
}

function TreatmentSwitchingFields({ spec, a, onPatch }: KindProps<TreatmentSwitchingAnalysis>) {
  const sameList = a.toCodeListIds.includes(a.fromCodeListId);
  return (
    <>
      <CodeListSelect
        spec={spec}
        label="Index drug list (switching from)"
        value={a.fromCodeListId}
        onChange={(v) => onPatch({ fromCodeListId: v })}
      />
      <IdChecklist
        label="Switch destinations"
        items={spec.codeLists.map((c) => ({ id: c.id, label: c.label }))}
        selected={a.toCodeListIds}
        minSelected={1}
        onChange={(ids) => onPatch({ toCodeListIds: ids })}
        emptyNote="No code lists in this study yet."
        hint={
          sameList
            ? "One destination is the index drug list itself. Set a real switch target before generating."
            : "Each destination is followed separately."
        }
      />
      <WindowField
        label="Observation window"
        bounded
        value={a.window}
        onChange={(w) => onPatch({ window: w })}
      />
      <div className="field-row">
        <LabeledNumber
          label="Permissible overlap (days)"
          min={0}
          value={a.permissibleOverlapDays}
          onCommit={(v) => onPatch({ permissibleOverlapDays: v ?? 30 })}
          hint="Remaining index-drug supply at the moment the new drug starts that still counts as a switch, rather than as combination therapy. The program reports how many patients this choice moves."
        />
        <LabeledSelect
          label="Line of therapy rule"
          value={a.lineRule}
          options={[{ value: "new_line_on_switch", label: "A new line begins at each switch" }]}
          hint="The only rule generated. It is a definition, not a finding, and the emitted code says so beside the number."
          onChange={(v) => onPatch({ lineRule: v })}
        />
      </div>
      <DaysSupplyFieldset value={a} onChange={(c) => onPatch({ daysSupplyCleaning: c })} />
    </>
  );
}

function StatisticalEngineFields({ spec, a, onPatch }: KindProps<StatisticalEngineAnalysis>) {
  const comparisons = spec.comparisons ?? [];
  const groups = groupVarsOf(spec);
  const smd = a.smdBalance;
  return (
    <>
      <IdChecklist
        label="Comparisons governed"
        items={comparisons.map((c) => ({ id: c.id, label: c.id }))}
        selected={a.comparisonIds}
        onChange={(ids) => onPatch({ comparisonIds: ids })}
        emptyNote="This study defines no comparisons. Comparisons, outcome variables and their distribution policies are set through the spec chat or the MCP server, not on this screen."
        hint="Hypothesis tests themselves need SAS procedures; this program emits the balance diagnostic."
      />
      <fieldset className="analysis-fieldset">
        <legend>Multiplicity</legend>
        <div className="field-row">
          <LabeledSelect
            label="Adjustment"
            value={a.multiplicity.method}
            options={[
              { value: "none", label: "None" },
              { value: "bonferroni", label: "Bonferroni" },
              { value: "holm", label: "Holm" },
              { value: "benjamini_hochberg", label: "Benjamini-Hochberg" },
            ]}
            onChange={(v) => onPatch({ multiplicity: { ...a.multiplicity, method: v } })}
          />
          <LabeledNumber
            label="Alpha (two sided)"
            min={0.001}
            max={0.999}
            fraction
            step={0.01}
            value={a.multiplicity.alpha}
            onCommit={(v) => onPatch({ multiplicity: { ...a.multiplicity, alpha: v ?? 0.05 } })}
          />
        </div>
        <IdChecklist
          label="Applies to"
          items={[
            { id: "primary", label: "Primary" },
            { id: "secondary", label: "Secondary" },
            { id: "exploratory", label: "Exploratory" },
          ]}
          selected={a.multiplicity.appliesToRoles}
          onChange={(ids) =>
            onPatch({
              multiplicity: {
                ...a.multiplicity,
                appliesToRoles: ids as StatisticalEngineAnalysis["multiplicity"]["appliesToRoles"],
              },
            })
          }
        />
      </fieldset>
      <CheckField
        label="Report covariate balance (SMD)"
        checked={smd !== undefined}
        disabled={smd === undefined && groups.length === 0}
        onChange={(v) =>
          onPatch({
            smdBalance: v
              ? {
                  groupVarId: firstGroupVarId(spec),
                  covariateIds: [],
                  imbalanceThreshold: 0.1,
                  reportWeighted: false,
                }
              : undefined,
          })
        }
        hint={
          groups.length === 0
            ? "The balance table compares two exposure arms, so it needs an exposure group."
            : undefined
        }
      />
      {smd && (
        <fieldset className="analysis-fieldset">
          <legend>Covariate balance</legend>
          <div className="field-row">
            <GroupVarSelect
              spec={spec}
              value={smd.groupVarId}
              onChange={(v) => onPatch({ smdBalance: { ...smd, groupVarId: v ?? "" } })}
              hint="The balance table reads the arm from the index code each subject matched."
            />
            <LabeledNumber
              label="Imbalance threshold"
              min={0.01}
              max={1}
              fraction
              step={0.05}
              value={smd.imbalanceThreshold}
              onCommit={(v) => onPatch({ smdBalance: { ...smd, imbalanceThreshold: v ?? 0.1 } })}
              hint="0.1 by convention."
            />
            <CheckField
              label="Weighted balance"
              checked={smd.reportWeighted}
              disabled={!smd.reportWeighted}
              onChange={(v) => onPatch({ smdBalance: { ...smd, reportWeighted: v } })}
              hint="Not built yet: crude balance is what the program produces."
            />
          </div>
          <BaselineChecklist
            spec={spec}
            label="Balance reported on"
            selected={smd.covariateIds}
            onChange={(ids) => onPatch({ smdBalance: { ...smd, covariateIds: ids } })}
          />
        </fieldset>
      )}
    </>
  );
}

/** The per-kind switch. Kinds with no arm here have no builder either, so they
 *  are never offered in the add menu and are named in the Analyses section
 *  instead of appearing as an empty card. */
function AnalysisFields({
  spec,
  a,
  onPatch,
}: {
  spec: StudySpec;
  a: Analysis;
  onPatch: (patch: Partial<Analysis>) => void;
}) {
  switch (a.kind) {
    case "incidence_rate":
      return <IncidenceRateFields spec={spec} a={a} onPatch={onPatch} />;
    case "point_prevalence":
      return <PointPrevalenceFields spec={spec} a={a} onPatch={onPatch} />;
    case "period_prevalence":
      return <PeriodPrevalenceFields spec={spec} a={a} onPatch={onPatch} />;
    case "cumulative_incidence":
      return <CumulativeIncidenceFields spec={spec} a={a} onPatch={onPatch} />;
    case "standardization":
      return <StandardizationFields spec={spec} a={a} onPatch={onPatch} />;
    case "calendar_trend":
      return <CalendarTrendFields spec={spec} a={a} onPatch={onPatch} />;
    case "resource_use":
      return <ResourceUseFields spec={spec} a={a} onPatch={onPatch} />;
    case "comorbidity_index":
      return <ComorbidityIndexFields spec={spec} a={a} onPatch={onPatch} />;
    case "regression":
      return <RegressionFields spec={spec} a={a} onPatch={onPatch} />;
    case "survival":
      return <SurvivalFields spec={spec} a={a} onPatch={onPatch} />;
    case "cox":
      return <CoxFields spec={spec} a={a} onPatch={onPatch} />;
    case "competing_risks":
      return <CompetingRisksFields spec={spec} a={a} onPatch={onPatch} />;
    case "fine_gray":
      return <FineGrayFields spec={spec} a={a} onPatch={onPatch} />;
    case "propensity_score":
      return <PropensityScoreFields spec={spec} a={a} onPatch={onPatch} />;
    case "iptw_outcome":
      return <IptwOutcomeFields spec={spec} a={a} onPatch={onPatch} />;
    case "g_formula":
      return <GFormulaFields spec={spec} a={a} onPatch={onPatch} />;
    case "adherence":
      return <AdherenceFields spec={spec} a={a} onPatch={onPatch} />;
    case "treatment_switching":
      return <TreatmentSwitchingFields spec={spec} a={a} onPatch={onPatch} />;
    case "statistical_engine":
      return <StatisticalEngineFields spec={spec} a={a} onPatch={onPatch} />;
    default:
      return null;
  }
}

/** One analysis card: the header every kind shares, then that kind's fields. */
function AnalysisEditor({
  spec,
  analysis,
  onPatch,
  onDelete,
  onFlag,
}: {
  spec: StudySpec;
  analysis: Analysis;
  onPatch: (patch: Partial<Analysis>) => void;
  onDelete: () => void;
  onFlag: (r: FlagRequest) => void;
}) {
  const a = analysis;
  const labelId = useId();
  const emittable = EMITTABLE_ANALYSIS_KINDS.has(a.kind);
  const editable = KIND_HAS_EDITOR(a.kind);

  return (
    <div className={`analysis-card${a.enabled ? "" : " analysis-card-off"}`}>
      <div className="analysis-head">
        <label className="analysis-toggle">
          <input
            type="checkbox"
            checked={a.enabled}
            onChange={(e) => onPatch({ enabled: e.target.checked })}
          />
          <span className="analysis-kind">{ANALYSIS_KIND_LABELS[a.kind]}</span>
        </label>
        <div className="analysis-head-actions">
          <FlagButton
            what={`the ${a.label} analysis`}
            onClick={() =>
              onFlag({
                label: `${ANALYSIS_KIND_LABELS[a.kind]} analysis, labelled "${a.label}"`,
                context: [
                  `Kind: ${a.kind}`,
                  a.enabled ? "Enabled, so it generates code." : "Disabled, so it generates no code.",
                ],
                target: { kind: "spec_field", ref: a.id, specVersion: spec.meta.version },
                classification: "methodological_choice",
                reasonHint:
                  "Which methodological choice do you disagree with (denominator, washout, censoring, CI method), and what would you use?",
              })
            }
          />
          <button type="button" className="btn-danger-quiet btn-sm" onClick={onDelete} aria-label={`Remove ${a.label}`}>
            Remove
          </button>
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={labelId}>
          Label
        </label>
        <CommitInput
          id={labelId}
          className="control"
          value={a.label}
          onCommit={(v) => onPatch({ label: v })}
        />
      </div>

      {a.notes && <p className="field-hint">{a.notes}</p>}

      {a.kind === "future_stub" && (
        <p className="field-hint">
          Planned “{a.plannedKind}”. No code is generated for this yet — it stays here so the request is visible.
        </p>
      )}

      {!emittable && a.kind !== "future_stub" && (
        <p className="field-hint">No code generator is registered for this analysis kind yet.</p>
      )}

      {emittable && !editable && !SPINE_ANALYSIS_KINDS.has(a.kind) && (
        <p className="field-hint">
          This kind generates code, but its parameters have no editor on this screen yet. Set them
          through the spec chat or the MCP server.
        </p>
      )}

      {editable && <AnalysisFields spec={spec} a={a} onPatch={onPatch} />}
    </div>
  );
}

function AddAnalysisForm({
  spec,
  onAdd,
}: {
  spec: StudySpec;
  onAdd: (kind: AnalysisKind) => void;
}) {
  const [kind, setKind] = useState<AnalysisKind>("incidence_rate");
  const selectId = useId();
  const needsList = KINDS_NEEDING_CODE_LIST.has(kind) && spec.codeLists.length === 0;
  const needsGroup = KINDS_NEEDING_GROUP_VAR.has(kind) && groupVarsOf(spec).length === 0;
  const blocked = needsList || needsGroup;
  return (
    <div className="add-form">
      <div className="add-analysis">
        <div className="field">
          <label className="field-label" htmlFor={selectId}>
            Add an analysis
          </label>
          <select
            id={selectId}
            className="control"
            value={kind}
            onChange={(e) => setKind(e.target.value as AnalysisKind)}
          >
            {ADD_MENU.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.kinds.map((k) => (
                  <option key={k} value={k}>
                    {ANALYSIS_KIND_LABELS[k]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <button type="button" className="btn" disabled={blocked} onClick={() => onAdd(kind)}>
          Add analysis
        </button>
      </div>
      {needsList && (
        <p className="field-hint">
          This analysis measures a named drug, and the code list it points at cannot be left blank.
          Create one in the Codelists step first.
        </p>
      )}
      {needsGroup && (
        <p className="field-hint">
          This model is about the difference between two exposure arms, and the exposure it points
          at cannot be left blank. Add an exposure group above first.
        </p>
      )}
      {EMITTABLE_WITHOUT_EDITOR.length > 0 && (
        <p className="field-hint">
          Generated by the emitters but not editable here yet:{" "}
          {EMITTABLE_WITHOUT_EDITOR.map((k) => ANALYSIS_KIND_LABELS[k]).join(", ")}. Add these
          through the spec chat or the MCP server.
        </p>
      )}
    </div>
  );
}

/* ---------- exposure groups (referenced by the models above) ---------- */

function GroupVarEditor({
  spec,
  groupVar: g,
  onPatch,
  onDelete,
}: {
  spec: StudySpec;
  groupVar: GroupVariable;
  onPatch: (patch: Partial<GroupVariable>) => void;
  onDelete: () => void;
}) {
  const src = g.source;
  return (
    <div className="analysis-card">
      <div className="analysis-head">
        <span className="analysis-kind">{g.label}</span>
        <div className="analysis-head-actions">
          <button
            type="button"
            className="btn-danger-quiet btn-sm"
            aria-label={`Remove exposure group ${g.label}`}
            onClick={onDelete}
          >
            Remove
          </button>
        </div>
      </div>
      <div className="field-row">
        <LabeledText label="Label" value={g.label} onCommit={(v) => onPatch({ label: v || g.id })} />
        <LabeledSelect
          label="Arms come from"
          value={src.kind}
          options={[
            { value: "exposure_cohort", label: "The index code each subject matched" },
            { value: "baseline", label: "A baseline characteristic" },
            { value: "codelist", label: "A code list in a window" },
          ]}
          hint={
            src.kind === "exposure_cohort"
              ? "The cohort spine already records the index code, so this is the arm definition the emitters build."
              : "Only arms taken from the index code are generated today; the others are reported as a limitation."
          }
          onChange={(v) =>
            onPatch({
              source:
                v === "exposure_cohort"
                  ? { kind: "exposure_cohort" }
                  : v === "baseline"
                    ? { kind: "baseline", baselineId: spec.baseline[0]?.id ?? "" }
                    : {
                        kind: "codelist",
                        codeListId: spec.codeLists[0]?.id ?? "",
                        window: { ...WASHOUT_ALL_BEFORE },
                      },
            })
          }
        />
        {src.kind === "baseline" && (
          <LabeledSelect
            label="Baseline characteristic"
            value={src.baselineId}
            options={(spec.baseline ?? []).map((b) => ({ value: b.id, label: b.label }))}
            onChange={(v) => onPatch({ source: { kind: "baseline", baselineId: v } })}
          />
        )}
        {src.kind === "codelist" && (
          <CodeListSelect
            spec={spec}
            value={src.codeListId}
            onChange={(v) => onPatch({ source: { ...src, codeListId: v } })}
          />
        )}
      </div>
      {src.kind === "codelist" && (
        <WindowField
          label="Looked for in"
          value={src.window}
          onChange={(w) => onPatch({ source: { ...src, window: w } })}
        />
      )}
      <div className="field-row">
        <TextListField
          label="Levels"
          value={g.levels}
          onCommit={(v) =>
            onPatch({
              levels: v,
              referenceLevel: v.includes(g.referenceLevel ?? "") ? g.referenceLevel : v[0],
            })
          }
          hint="Comma separated. Exactly two, and they must match the values the data carries."
        />
        <LabeledSelect
          label="Reference level"
          value={g.referenceLevel ?? ""}
          options={[
            { value: "", label: "Not chosen yet" },
            ...g.levels.map((l) => ({ value: l, label: l })),
          ]}
          hint="The arm the effect is measured against. Without one the direction of every estimate is arbitrary."
          onChange={(v) => onPatch({ referenceLevel: v === "" ? undefined : v })}
        />
      </div>
    </div>
  );
}

export default function SpecReview({
  spec,
  settings,
  onChange,
  onFlag,
  onOpenSettings,
}: {
  spec: StudySpec;
  settings: AppSettings;
  onChange: (s: StudySpec) => void;
  onFlag: (r: FlagRequest) => void;
  onOpenSettings: () => void;
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

  const patchAnalysis = (id: string, patch: Partial<Analysis>) =>
    onChange({
      ...spec,
      analyses: spec.analyses.map((a) => (a.id === id ? ({ ...a, ...patch } as Analysis) : a)),
    });
  const deleteAnalysis = (id: string) =>
    onChange({ ...spec, analyses: spec.analyses.filter((a) => a.id !== id) });
  const addAnalysis = (kind: AnalysisKind) => {
    const used = new Set(spec.analyses.map((a) => a.id));
    let id: string = kind;
    let n = 2;
    while (used.has(id)) id = `${kind}_${n++}`;
    onChange({ ...spec, analyses: [...spec.analyses, newAnalysis(spec, kind, id)] });
  };

  const groupVars = groupVarsOf(spec);
  const patchGroupVar = (id: string, patch: Partial<GroupVariable>) =>
    onChange({
      ...spec,
      groupVars: groupVars.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    });
  const deleteGroupVar = (id: string) =>
    onChange({ ...spec, groupVars: groupVars.filter((g) => g.id !== id) });
  const addGroupVar = () => {
    const used = new Set(groupVars.map((g) => g.id));
    let id = "exposure";
    let n = 2;
    while (used.has(id)) id = `exposure_${n++}`;
    onChange({
      ...spec,
      groupVars: [
        ...groupVars,
        { id, label: "Exposure", source: { kind: "exposure_cohort" }, levels: [] },
      ],
    });
  };

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

      <SpecChat
        spec={spec}
        settings={settings}
        onChange={onChange}
        onOpenSettings={onOpenSettings}
      />

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
                onFlag={onFlag}
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

      <section className="card" aria-labelledby="grp-title">
        <h2 className="card-title" id="grp-title">
          Exposure groups
        </h2>
        <p className="card-sub">
          Two-level exposures the models compare. Cox, Fine-Gray, propensity score, IPTW, the
          g-formula and regression each need one, and so does the balance table.
        </p>
        {groupVars.length === 0 ? (
          <p className="field-hint">
            None yet. Add one before adding a model that compares two arms.
          </p>
        ) : (
          <div className="analysis-list">
            {groupVars.map((g) => (
              <GroupVarEditor
                key={g.id}
                spec={spec}
                groupVar={g}
                onPatch={(patch) => patchGroupVar(g.id, patch)}
                onDelete={() => deleteGroupVar(g.id)}
              />
            ))}
          </div>
        )}
        <div className="add-form">
          <button type="button" className="btn" onClick={addGroupVar}>
            Add an exposure group
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="plan-title">
        <h2 className="card-title" id="plan-title">
          Analyses
        </h2>
        <p className="card-sub">
          Each enabled analysis generates SAS + SQL. Verify the outcome code list and every
          parameter before generating: the readiness panel at the top lists what is still missing,
          and what this tool refuses to build.
        </p>
        {spec.baseline.length > 0 && (
          <dl className="spec-dl">
            <dt>Baseline characteristics (Table 1)</dt>
            <dd>{spec.baseline.map((b) => b.label).join(", ")}</dd>
          </dl>
        )}
        <div className="analysis-list">
          {spec.analyses.map((a) => (
            <AnalysisEditor
              key={a.id}
              spec={spec}
              analysis={a}
              onPatch={(patch) => patchAnalysis(a.id, patch)}
              onDelete={() => deleteAnalysis(a.id)}
              onFlag={onFlag}
            />
          ))}
        </div>
        <AddAnalysisForm spec={spec} onAdd={addAnalysis} />
      </section>
    </div>
  );
}
