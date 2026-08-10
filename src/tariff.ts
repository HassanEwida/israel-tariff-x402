import tariffData from "./data/tariff.json" with { type: "json" };
import type { TariffEntry, TariffResponse } from "./types.js";

const DISCLAIMER =
  "Informational lookup only. Official Israeli legislation and Customs determinations prevail.";

export function normalizeTariffCode(value: string): string | null {
  const trimmed = value.trim();

  // Accept digits and common visual separators, but never silently accept letters.
  if (!trimmed || !/^[\d\s.-]+$/.test(trimmed)) {
    return null;
  }

  const normalized = trimmed.replace(/\D/g, "");
  return normalized.length === 10 ? normalized : null;
}

export function createTariffLookup(entries: TariffEntry[]): Map<string, TariffEntry> {
  const lookup = new Map<string, TariffEntry>();

  for (const entry of entries) {
    const code = normalizeTariffCode(entry.code);
    if (!code) {
      throw new Error(`Invalid tariff code in data file: ${entry.code}`);
    }
    lookup.set(code, { ...entry, code });
  }

  return lookup;
}

const tariffLookup = createTariffLookup(tariffData as TariffEntry[]);

export function findTariff(code: string): TariffResponse | undefined {
  const entry = tariffLookup.get(code);
  if (!entry) return undefined;

  return {
    ...entry,
    source: "Israel Tax Authority",
    source_type: "official",
    disclaimer: DISCLAIMER,
  };
}
