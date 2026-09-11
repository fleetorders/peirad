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
export { runManifest } from "./doctor.js";
export type { Verdict, RunOptions } from "./doctor.js";
export { runProbe, harnessVersion } from "./probes.js";
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
