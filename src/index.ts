export {
  loadManifest,
  unknownProbeFields,
  unknownManifestFields,
  PROBE_FIELDS,
  MANIFEST_FIELDS,
} from "./manifest.js";
export type { Manifest, ProbeSpec, SettingsScope } from "./manifest.js";
export {
  resolveProfile,
  profileNames,
  expandArgs,
} from "./harness-profiles.js";
export type {
  ArrayMerge,
  HarnessProfile,
  HarnessUsage,
  SettingsLayer,
} from "./harness-profiles.js";
export {
  describeLayers,
  effectiveSettings,
  layerPath,
  layerVars,
  loadLayers,
  mergeValues,
  provenance,
} from "./settings.js";
export type { LayerVars, LoadedLayer, Provenance } from "./settings.js";
export {
  describeEntry,
  describeMiss,
  evaluateFind,
  parseReport,
  readReport,
} from "./reports.js";
export type {
  FindResult,
  HarnessReport,
  ReportParse,
  ReportRead,
  ReportRecord,
} from "./reports.js";
export { deepEqual, fold, getDotted, show } from "./values.js";
export { checkPath, envNames, evaluateEnv, safeToShow } from "./environment.js";
export type {
  EnvAssertions,
  EnvEvaluation,
  EnvSource,
  PathKind,
} from "./environment.js";
export {
  validateManifestFile,
  validateManifestText,
  parseLocated,
  PROBE_SCHEMA,
} from "./validate.js";
export type { Finding, ValidatedProbe, ValidationReport } from "./validate.js";
export { typeCoverage, describeTypeCoverage } from "./coverage.js";
export type { TypeCoverage } from "./coverage.js";
export {
  runLive,
  sessionIdFrom,
  harnessConfigDir,
  findSessionTranscript,
} from "./live.js";
export type { LiveOptions, LiveOutcome, LiveProfile } from "./live.js";
export {
  scanProject,
  draftManifest,
  compareWithScan,
  likelyHarness,
} from "./derive.js";
export type {
  Scan,
  ScanCoverage,
  ScanReport,
  CoverageItem,
  Location,
} from "./derive.js";
export {
  runManifest,
  observeManifest,
  runLedger,
  runScanCoverage,
} from "./doctor.js";
export type { Verdict, RunOptions, LedgerOptions } from "./doctor.js";
export {
  BASELINE_FILE,
  compareSurface,
  formatBaseline,
  keyPaths,
  makeBaseline,
  observeSurface,
  readBaseline,
} from "./baseline.js";
export type {
  Baseline,
  BaselineRead,
  BaselineReport,
  Moved,
  Surface,
} from "./baseline.js";
export {
  runProbe,
  harnessVersion,
  helpTokens,
  newestMatch,
  readSettings,
  checkTranscriptFile,
} from "./probes.js";
export type { ProbeResult, ProbeStatus, ProbeContext } from "./probes.js";
export { assessAlarm, buildChangelogRubric } from "./triage.js";
export type {
  TriageVerdict,
  TriageConfidence,
  ReasoningPoint,
  TriageResult,
  TriageOutcome,
} from "./triage.js";
export {
  parseEntry,
  normalizeKeyPart,
  classKey,
  parseLedger,
  detectRail,
  findPrecedent,
  precedentCommand,
} from "./precedent.js";
export type {
  ParsedEntry,
  ClassKey,
  LedgerEntry,
  SiblingInput,
  PrecedentResult,
  PrecedentCliOptions,
} from "./precedent.js";
