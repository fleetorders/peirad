/**
 * The settings STACK, not one settings file.
 *
 * A harness reads several settings files and merges them in its own order —
 * user, project, a local override, a managed policy file. A probe that reads
 * one of them answers a question nobody asked: a hook moved from project scope
 * to user scope reads as drift though nothing broke, and a value overridden by
 * a higher layer reads as present though the harness never sees it.
 *
 * The precedence lives in the harness profile as DATA (`settingsLayers`,
 * lowest precedence first), so teaching peirad another harness's stack is a
 * profile edit, not an engine change. Nothing here branches on a version.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArrayMerge, SettingsLayer } from "./harness-profiles.js";

export type { ArrayMerge };

/** One layer after an attempt to read it. A layer that is not there is not an
 * error — most stacks are mostly empty — but it is reported, so "nowhere" and
 * "we never looked" stay distinguishable. */
export interface LoadedLayer {
  name: string;
  path: string;
  state: "read" | "absent" | "unreadable";
  /** Parsed contents; `undefined` unless state is "read". */
  data?: unknown;
  /** Why it could not be read, when state is "unreadable". */
  reason?: string;
}

export interface LayerVars {
  /** The user's home directory. */
  home: string;
  /** The base directory a manifest's relative paths resolve against. */
  configDir: string;
  /** The harness's own configuration directory, as the harness resolves it —
   * the variable that relocates it honoured, not just the default beneath the
   * home directory. Absent when the profile declares no such directory, and a
   * layer that needs it then reads as absent rather than as an unexpanded
   * path. */
  userConfigDir?: string;
}

/** Expand `{home}` / `{configDir}` / `{userConfigDir}` in a layer path, and
 * pick the platform-specific spelling where the layer declares one. */
export function layerPath(
  layer: SettingsLayer,
  vars: LayerVars,
): string | null {
  const template = layer.platformPaths?.[process.platform] ?? layer.path;
  if (
    template.includes("{userConfigDir}") &&
    vars.userConfigDir === undefined
  ) {
    return null;
  }
  const expanded = template
    .replace(/\{userConfigDir\}/g, vars.userConfigDir ?? "")
    .replace(/\{home\}/g, vars.home)
    .replace(/\{configDir\}/g, vars.configDir);
  return path.resolve(expanded);
}

/** Read every declared layer, lowest precedence first. */
export function loadLayers(
  layers: readonly SettingsLayer[],
  vars: LayerVars,
): LoadedLayer[] {
  return layers.map((layer) => {
    const file = layerPath(layer, vars);
    if (file === null) {
      return {
        name: layer.name,
        path: layer.platformPaths?.[process.platform] ?? layer.path,
        state: "absent" as const,
      };
    }
    if (!fs.existsSync(file)) {
      return { name: layer.name, path: file, state: "absent" as const };
    }
    try {
      return {
        name: layer.name,
        path: file,
        state: "read" as const,
        data: JSON.parse(fs.readFileSync(file, "utf8")),
      };
    } catch (e) {
      return {
        name: layer.name,
        path: file,
        state: "unreadable" as const,
        reason: String(e),
      };
    }
  });
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Merge two layers' values, `higher` winning. Objects merge key by key;
 * lists either join (a harness that runs every registered hook) or replace
 * (one where the nearest scope wins outright), as the profile declares. */
export function mergeValues(
  lower: unknown,
  higher: unknown,
  arrays: ArrayMerge,
): unknown {
  if (higher === undefined) return lower;
  if (lower === undefined) return higher;
  if (Array.isArray(lower) && Array.isArray(higher)) {
    return arrays === "concat" ? [...lower, ...higher] : higher;
  }
  if (isPlainObject(lower) && isPlainObject(higher)) {
    const out: Record<string, unknown> = { ...lower };
    for (const [k, v] of Object.entries(higher)) {
      out[k] = mergeValues(out[k], v, arrays);
    }
    return out;
  }
  return higher;
}

/** The settings the harness actually acts on: every readable layer folded in
 * precedence order. */
export function effectiveSettings(
  layers: readonly LoadedLayer[],
  arrays: ArrayMerge,
): unknown {
  let merged: unknown = undefined;
  for (const layer of layers) {
    if (layer.state !== "read") continue;
    merged = mergeValues(merged, layer.data, arrays);
  }
  return merged ?? {};
}

/** Which layers a key's value came from — the point of merging at all. A
 * scalar is attributed to the layer that won, with the layers it overrode
 * named as shadowed; a joined list is attributed to every layer that
 * contributed. */
export interface Provenance {
  /** Layers whose value survives into the effective settings. */
  from: string[];
  /** Layers that set the key and lost to a higher one. */
  shadowed: string[];
}

export function provenance(
  layers: readonly LoadedLayer[],
  key: string,
  arrays: ArrayMerge,
  getValue: (data: unknown, key: string) => unknown,
): Provenance {
  const setting = layers.filter(
    (l) => l.state === "read" && getValue(l.data, key) !== undefined,
  );
  if (setting.length === 0) return { from: [], shadowed: [] };
  const joined =
    arrays === "concat" &&
    setting.every((l) => Array.isArray(getValue(l.data, key)));
  if (joined) return { from: setting.map((l) => l.name), shadowed: [] };
  const winner = setting[setting.length - 1]!;
  return {
    from: [winner.name],
    shadowed: setting.slice(0, -1).map((l) => l.name),
  };
}

/** One line naming where the probe looked: which layers were read, which were
 * not there, which could not be parsed. A stack that is mostly empty is the
 * normal case and says so plainly. */
export function describeLayers(layers: readonly LoadedLayer[]): string {
  const read = layers.filter((l) => l.state === "read").map((l) => l.name);
  const bad = layers.filter((l) => l.state === "unreadable").map((l) => l.name);
  const absent = layers.filter((l) => l.state === "absent").length;
  const parts = [
    read.length > 0 ? `read ${read.join(", ")}` : "no layer present",
    absent > 0 ? `${absent} absent` : "",
    bad.length > 0 ? `unreadable: ${bad.join(", ")}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}

/** The variables a layer path expands against. */
export function layerVars(configDir: string): LayerVars {
  return { home: os.homedir(), configDir: path.resolve(configDir) };
}
