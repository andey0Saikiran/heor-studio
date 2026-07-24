/**
 * MarketScan® native schema map — written in HEOR Studio's own words from
 * long-public sources (peer-reviewed methods papers, OHDSI/Janssen open ETL
 * documentation, university methods pages). No vendor documentation text is
 * reproduced. MarketScan is a registered trademark of Merative US L.P.;
 * HEOR Studio is independent and unaffiliated. Using generated code requires
 * your own valid MarketScan license.
 *
 * Table letter conventions (CCAE = Commercial, MDCR = Medicare Supplemental,
 * MDCD = Medicaid). Physical table names vary by delivery
 * (e.g. yearly SAS files ccaes181, warehouse tables CCAE_S_2018_R1912);
 * emitters take a naming pattern so generated code matches the user's site.
 */

export interface TableColumn {
  name: string;
  role:
    | "person_id" | "date" | "date_end" | "diagnosis" | "diagnosis_principal"
    | "procedure" | "procedure_principal" | "ndc" | "days_supply" | "quantity"
    | "enroll_start" | "enroll_end" | "rx_coverage" | "demographic" | "payment"
    | "utilization" | "other";
  note: string;
}

export interface MsTable {
  letter: string;           // the family letter used in file naming
  key: string;              // stable key used by emitters
  label: string;
  grain: string;
  columns: TableColumn[];
}

export const MARKETSCAN_TABLES: MsTable[] = [
  {
    letter: "T",
    key: "enrollment_detail",
    label: "Enrollment detail",
    grain: "one row per member per contiguous coverage segment",
    columns: [
      { name: "ENROLID", role: "person_id", note: "unique member identifier; joins across all tables" },
      { name: "DTSTART", role: "enroll_start", note: "coverage segment start date" },
      { name: "DTEND", role: "enroll_end", note: "coverage segment end date" },
      { name: "MEMDAYS", role: "utilization", note: "member-days in segment" },
      { name: "RX", role: "rx_coverage", note: "'1' when segment includes drug coverage (CCAE/MDCR)" },
      { name: "PLANTYP", role: "demographic", note: "plan type code" },
      { name: "SEX", role: "demographic", note: "member sex" },
      { name: "DOBYR", role: "demographic", note: "year of birth" },
      { name: "REGION", role: "demographic", note: "census region code" },
    ],
  },
  {
    letter: "D",
    key: "drug_claims",
    label: "Outpatient pharmacy claims",
    grain: "one row per dispensed prescription claim",
    columns: [
      { name: "ENROLID", role: "person_id", note: "member identifier" },
      { name: "NDCNUM", role: "ndc", note: "11-digit NDC of dispensed product" },
      { name: "SVCDATE", role: "date", note: "fill/service date" },
      { name: "DAYSUPP", role: "days_supply", note: "days supplied" },
      { name: "QTY", role: "quantity", note: "quantity dispensed" },
      { name: "THERCLS", role: "other", note: "therapeutic class code" },
      { name: "PAY", role: "payment", note: "gross payment on claim" },
      { name: "NETPAY", role: "payment", note: "net payment on claim" },
      { name: "AGE", role: "demographic", note: "member age at service" },
      { name: "SEX", role: "demographic", note: "member sex" },
    ],
  },
  {
    letter: "O",
    key: "outpatient_services",
    label: "Outpatient services",
    grain: "one row per outpatient service line",
    columns: [
      { name: "ENROLID", role: "person_id", note: "member identifier" },
      { name: "SVCDATE", role: "date", note: "service date" },
      { name: "TSVCDAT", role: "date_end", note: "service end date" },
      { name: "DX1", role: "diagnosis", note: "diagnosis 1" },
      { name: "DX2", role: "diagnosis", note: "diagnosis 2" },
      { name: "DX3", role: "diagnosis", note: "diagnosis 3" },
      { name: "DX4", role: "diagnosis", note: "diagnosis 4" },
      { name: "DXVER", role: "other", note: "'9' = ICD-9-CM era, '0' = ICD-10-CM era" },
      { name: "PROC1", role: "procedure", note: "procedure code on line" },
      { name: "PROCTYP", role: "other", note: "procedure code type (CPT/HCPCS/ICD)" },
      { name: "REVCODE", role: "other", note: "revenue code" },
      { name: "STDPLAC", role: "other", note: "standardized place of service" },
      { name: "PAY", role: "payment", note: "gross payment on line" },
      { name: "NETPAY", role: "payment", note: "net payment on line" },
      { name: "AGE", role: "demographic", note: "member age at service" },
      { name: "SEX", role: "demographic", note: "member sex" },
    ],
  },
  {
    letter: "S",
    key: "inpatient_services",
    label: "Inpatient services",
    grain: "one row per service line within an admission",
    columns: [
      { name: "ENROLID", role: "person_id", note: "member identifier" },
      { name: "CASEID", role: "other", note: "links service lines to the admission record" },
      { name: "ADMDATE", role: "date", note: "admission date" },
      { name: "DISDATE", role: "date_end", note: "discharge date" },
      { name: "SVCDATE", role: "date", note: "service line date" },
      { name: "PDX", role: "diagnosis_principal", note: "principal diagnosis" },
      { name: "DX1", role: "diagnosis", note: "diagnosis 1" },
      { name: "DX2", role: "diagnosis", note: "diagnosis 2" },
      { name: "DX3", role: "diagnosis", note: "diagnosis 3" },
      { name: "DX4", role: "diagnosis", note: "diagnosis 4" },
      { name: "DXVER", role: "other", note: "ICD version indicator" },
      { name: "PPROC", role: "procedure_principal", note: "principal procedure" },
      { name: "PROC1", role: "procedure", note: "procedure on line" },
      { name: "PROCTYP", role: "other", note: "procedure code type" },
      { name: "DRG", role: "other", note: "diagnosis-related group" },
      { name: "PAY", role: "payment", note: "gross payment on line" },
      { name: "AGE", role: "demographic", note: "member age" },
      { name: "SEX", role: "demographic", note: "member sex" },
    ],
  },
  {
    letter: "I",
    key: "inpatient_admissions",
    label: "Inpatient admissions",
    grain: "one row per hospital admission (case level)",
    columns: [
      { name: "ENROLID", role: "person_id", note: "member identifier" },
      { name: "CASEID", role: "other", note: "admission identifier" },
      { name: "ADMDATE", role: "date", note: "admission date" },
      { name: "DISDATE", role: "date_end", note: "discharge date" },
      { name: "DAYS", role: "utilization", note: "length of stay" },
      { name: "PDX", role: "diagnosis_principal", note: "principal diagnosis" },
      ...Array.from({ length: 15 }, (_, i) => ({
        name: `DX${i + 1}`,
        role: "diagnosis" as const,
        note: `diagnosis ${i + 1}`,
      })),
      { name: "DXVER", role: "other", note: "ICD version indicator" },
      { name: "PPROC", role: "procedure_principal", note: "principal procedure" },
      ...Array.from({ length: 15 }, (_, i) => ({
        name: `PROC${i + 1}`,
        role: "procedure" as const,
        note: `procedure ${i + 1}`,
      })),
      { name: "DRG", role: "other", note: "diagnosis-related group" },
      { name: "TOTPAY", role: "payment", note: "total case payment" },
      { name: "TOTNET", role: "payment", note: "total net case payment" },
      { name: "AGE", role: "demographic", note: "member age at admission" },
      { name: "SEX", role: "demographic", note: "member sex" },
    ],
  },
  {
    letter: "F",
    key: "facility_header",
    label: "Facility header",
    grain: "one row per facility claim header",
    columns: [
      { name: "ENROLID", role: "person_id", note: "member identifier" },
      { name: "SVCDATE", role: "date", note: "service date" },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `DX${i + 1}`,
        role: "diagnosis" as const,
        note: `diagnosis ${i + 1}`,
      })),
      { name: "DXVER", role: "other", note: "ICD version indicator" },
      ...Array.from({ length: 6 }, (_, i) => ({
        name: `PROC${i + 1}`,
        role: "procedure" as const,
        note: `procedure ${i + 1}`,
      })),
      { name: "CASEID", role: "other", note: "admission link when inpatient" },
    ],
  },
  {
    letter: "A",
    key: "annual_enrollment",
    label: "Annual enrollment summary",
    grain: "one row per member per year (month-level indicator columns)",
    columns: [
      { name: "ENROLID", role: "person_id", note: "member identifier" },
      { name: "YEAR", role: "other", note: "calendar year" },
      { name: "MEMDAYS", role: "utilization", note: "covered days in year" },
      { name: "SEX", role: "demographic", note: "member sex" },
      { name: "DOBYR", role: "demographic", note: "year of birth" },
      { name: "REGION", role: "demographic", note: "census region" },
      { name: "PLNTYP1", role: "demographic", note: "plan type by month (…PLNTYP12)" },
      { name: "ENRIND1", role: "other", note: "enrollment indicator by month (…ENRIND12)" },
    ],
  },
];

/** Diagnosis columns to scan per table, in claim-position order. */
export const DX_COLUMNS: Record<string, string[]> = {
  inpatient_admissions: ["PDX", ...Array.from({ length: 15 }, (_, i) => `DX${i + 1}`)],
  inpatient_services: ["PDX", "DX1", "DX2", "DX3", "DX4"],
  outpatient_services: ["DX1", "DX2", "DX3", "DX4"],
  facility_header: Array.from({ length: 9 }, (_, i) => `DX${i + 1}`),
};

export const PROC_COLUMNS: Record<string, string[]> = {
  inpatient_admissions: ["PPROC", ...Array.from({ length: 15 }, (_, i) => `PROC${i + 1}`)],
  inpatient_services: ["PPROC", "PROC1"],
  outpatient_services: ["PROC1"],
  facility_header: Array.from({ length: 6 }, (_, i) => `PROC${i + 1}`),
};

/**
 * Physical-name pattern. Users differ: yearly SAS files ("ccaes181"),
 * warehouse schemas ("MS_Commercial.CCAE_S_2018_R1912"), or a single
 * consolidated table. The emitters accept one of these strategies.
 */
export type TableNamingStrategy =
  | { kind: "yearly_sas"; prefix: string }             // e.g. ccaes181 = prefix ccae + letter s + yy1
  | { kind: "warehouse_yearly"; schema: string; pattern: string } // pattern with {LETTER} {YEAR} {RELEASE}
  | { kind: "single_table"; schema: string; pattern: string };    // one table per family: {LETTER}

export const DB_PREFIX: Record<string, string> = {
  marketscan_ccae: "ccae",
  marketscan_mdcr: "mdcr",
  marketscan_medicaid: "mdcd",
};
