import tariffData from "./data/tariff.json" with { type: "json" };
import tariffMetadata from "./data/tariff.meta.json" with { type: "json" };
import type { TariffEntry, TariffMetadata, TariffResponse } from "./types.js";

const DISCLAIMER =
  "Official open-dataset fields only. Not tariff-classification advice; does not calculate treaty/agreement rates or account for quotas, levies, or licensing/approval requirements. Official legislation and Customs determinations prevail.";

export function normalizeTariffCode(value: string): string | null {
  const trimmed = value.trim();
  return /^[0-9]{10}$/.test(trimmed) ? trimmed : null;
}

export function createTariffLookup(entries: TariffEntry[]): Map<string, TariffEntry> {
  const lookup = new Map<string, TariffEntry>();

  for (const entry of entries) {
    const code = normalizeTariffCode(entry.code);
    if (!code) {
      throw new Error(`Invalid tariff code in data file: ${entry.code}`);
    }
    if (lookup.has(code)) {
      throw new Error(`Duplicate tariff code in data file: ${code}`);
    }
    lookup.set(code, { ...entry, code });
  }

  return lookup;
}

const tariffLookup = createTariffLookup(tariffData as TariffEntry[]);
const metadata = tariffMetadata as TariffMetadata;

export function findTariff(code: string): TariffResponse | undefined {
  const entry = tariffLookup.get(code);
  if (!entry) return undefined;

  return {
    ...entry,
    dataset_updated_at: metadata.dataset_updated_at,
    retrieved_at: metadata.retrieved_at,
    source: metadata.source,
    source_type: metadata.source_type,
    source_dataset: metadata.source_dataset,
    source_url: metadata.source_url,
    disclaimer: DISCLAIMER,
  };
}
