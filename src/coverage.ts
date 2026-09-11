/**
 * What a manifest covers — said on every verdict.
 *
 * A verdict that passes says the declared contracts hold. It says nothing
 * about the contracts nobody declared, and a short manifest reads exactly like
 * a thorough one. Naming the probe types a manifest uses, and the ones it does
 * not, costs no inference and makes a two-probe manifest visible as one.
 */
import { PROBE_FIELDS, type Manifest } from "./manifest.js";

export interface TypeCoverage {
  /** Probe types this build knows that the manifest declares. */
  declared: string[];
  /** Probe types this build knows that the manifest does not declare. */
  undeclared: string[];
  /** Types the manifest names that this build does not know. */
  unknown: string[];
}

/** `version` stamps the verdict rather than checking a dependency, so it is
 * neither coverage nor a gap. */
const NOT_A_CONTRACT = new Set(["version"]);

export function typeCoverage(manifest: Manifest): TypeCoverage {
  const known = Object.keys(PROBE_FIELDS).filter((t) => !NOT_A_CONTRACT.has(t));
  const used = new Set<string>(manifest.probes.map((p) => p.type));
  return {
    declared: known.filter((t) => used.has(t)),
    undeclared: known.filter((t) => !used.has(t)),
    unknown: [...used].filter((t) => !(t in PROBE_FIELDS)).sort(),
  };
}

/** One line for the verdict. */
export function describeTypeCoverage(c: TypeCoverage): string {
  const parts = [
    `declares ${c.declared.length > 0 ? c.declared.join(", ") : "no contract probes"}`,
    c.undeclared.length > 0 ? `not declared: ${c.undeclared.join(", ")}` : "",
    c.unknown.length > 0
      ? `unknown to this build: ${c.unknown.join(", ")}`
      : "",
  ].filter(Boolean);
  return parts.join(" · ");
}
