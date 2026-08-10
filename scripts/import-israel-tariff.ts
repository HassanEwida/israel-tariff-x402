import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TariffEntry, TariffMetadata } from "../src/types.js";

export const DATASET_NAME = "customsbook";
export const DATASET_TITLE = "ספר סיווג טובין ביבוא" as const;
export const DATASET_URL = "https://data.gov.il/he/datasets/taxes-authority/customsbook";
export const DATASET_TERMS_URL = "https://data.gov.il/he/terms-of-use";
export const DATASTORE_URL = "https://data.gov.il/api/3/action/datastore_search";
export const PACKAGE_SEARCH_URL = "https://data.gov.il/api/3/action/package_search";
export const HEBREW_RESOURCE_ID = "5536eaa1-2e51-406b-aff6-b9ca02801b7c";
export const ENGLISH_RESOURCE_ID = "c96d99fe-fd3a-4e86-a767-4119dd8b723e";

const PAGE_SIZE = 1_000;
const ORDINARY_CODE_PATTERN = /^([0-9]{10})(?:\/[0-9])?$/;
const ROMAN_SECTION_PATTERN = /^[IVXLCDM]+$/;
const REQUIRED_SOURCE_FIELDS = [
  "_id",
  "CustomsItemFullClassification",
  "HierarchicLocation",
  "GoodsDescription",
  "CustomsTariff",
  "PurchaseTaxTariff",
  "MeasurementUnitDescription",
  "CustomsItemEndDate",
  "CustomsTariffEndDate",
  "PurchaseTaxTariffEndDate",
  "CustomsItemCategoryID",
] as const;

export type SourceRecord = Record<string, unknown> & {
  _id?: unknown;
  CustomsItemFullClassification?: unknown;
  HierarchicLocation?: unknown;
  GoodsDescription?: unknown;
  CustomsTariff?: unknown;
  PurchaseTaxTariff?: unknown;
  MeasurementUnitDescription?: unknown;
  CustomsItemEndDate?: unknown;
  CustomsTariffEndDate?: unknown;
  PurchaseTaxTariffEndDate?: unknown;
  CustomsItemCategoryID?: unknown;
};

type DatasetResource = {
  id: string;
  last_modified: string;
};

export type ImportSummary = {
  hebrew_rows: number;
  english_rows: number;
  included: number;
  excluded_special: number;
  excluded_section: number;
  excluded_hierarchy: number;
  excluded_malformed: number;
  missing_english_description: number;
  duplicates: number;
};

export type NormalizeResult = {
  entries: TariffEntry[];
  summary: ImportSummary;
};

type FetchLike = typeof fetch;

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalDate(value: unknown, field: string, officialCode: string): string | undefined {
  const date = optionalString(value);
  if (!date) return undefined;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) {
    throw new Error(`Invalid ${field} for ${officialCode}: ${date}`);
  }
  return date;
}

function categoryId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function extractPublicCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ORDINARY_CODE_PATTERN.exec(value.trim());
  return match?.[1] ?? null;
}

function isLeafRecord(record: SourceRecord): boolean {
  const hierarchy = optionalString(record.HierarchicLocation);
  return hierarchy?.endsWith("פיצול") ?? false;
}

function buildEnglishDescriptionMap(records: SourceRecord[]): Map<string, string> {
  const descriptions = new Map<string, string>();

  for (const record of records) {
    const rawCode = optionalString(record.CustomsItemFullClassification);
    if (!rawCode || rawCode.startsWith("-")) continue;
    const code = extractPublicCode(rawCode);
    const description = optionalString(record.GoodsDescription);
    if (!code || !description) continue;

    if (descriptions.has(code)) {
      throw new Error(`Duplicate English public lookup key: ${code}`);
    }
    descriptions.set(code, description);
  }

  return descriptions;
}

export function normalizeSourceRecords(
  hebrewRecords: SourceRecord[],
  englishRecords: SourceRecord[],
): NormalizeResult {
  const englishDescriptions = buildEnglishDescriptionMap(englishRecords);
  const entries: TariffEntry[] = [];
  const seenCodes = new Set<string>();
  const summary: ImportSummary = {
    hebrew_rows: hebrewRecords.length,
    english_rows: englishRecords.length,
    included: 0,
    excluded_special: 0,
    excluded_section: 0,
    excluded_hierarchy: 0,
    excluded_malformed: 0,
    missing_english_description: 0,
    duplicates: 0,
  };

  for (const record of hebrewRecords) {
    const officialCode = optionalString(record.CustomsItemFullClassification);

    if (!officialCode) {
      summary.excluded_malformed++;
      continue;
    }
    if (officialCode.startsWith("-")) {
      summary.excluded_special++;
      continue;
    }
    if (ROMAN_SECTION_PATTERN.test(officialCode)) {
      summary.excluded_section++;
      continue;
    }

    const code = extractPublicCode(officialCode);
    if (!code) {
      summary.excluded_malformed++;
      continue;
    }
    if (!isLeafRecord(record)) {
      summary.excluded_hierarchy++;
      continue;
    }

    const customsItemCategoryId = categoryId(record.CustomsItemCategoryID);
    if (customsItemCategoryId === undefined) {
      summary.excluded_malformed++;
      continue;
    }
    if (seenCodes.has(code)) {
      summary.duplicates++;
      throw new Error(`Duplicate public lookup key after normalization: ${code}`);
    }
    seenCodes.add(code);

    const descriptionEn = englishDescriptions.get(code);
    if (!descriptionEn) summary.missing_english_description++;

    const entry: TariffEntry = {
      code,
      official_code: officialCode,
      customs_item_category_id: customsItemCategoryId,
    };

    const descriptionHe = optionalString(record.GoodsDescription);
    const customsRate = optionalString(record.CustomsTariff);
    const purchaseTax = optionalString(record.PurchaseTaxTariff);
    const measurementUnit = optionalString(record.MeasurementUnitDescription);
    const itemValidUntil = optionalDate(record.CustomsItemEndDate, "CustomsItemEndDate", officialCode);
    const customsRateValidUntil = optionalDate(
      record.CustomsTariffEndDate,
      "CustomsTariffEndDate",
      officialCode,
    );
    const purchaseTaxValidUntil = optionalDate(
      record.PurchaseTaxTariffEndDate,
      "PurchaseTaxTariffEndDate",
      officialCode,
    );

    if (descriptionHe) entry.description_he = descriptionHe;
    if (descriptionEn) entry.description_en = descriptionEn;
    if (customsRate) entry.customs_rate = customsRate;
    if (purchaseTax) entry.purchase_tax = purchaseTax;
    if (measurementUnit) entry.measurement_unit = measurementUnit;
    if (itemValidUntil) entry.item_valid_until = itemValidUntil;
    if (customsRateValidUntil) entry.customs_rate_valid_until = customsRateValidUntil;
    if (purchaseTaxValidUntil) entry.purchase_tax_valid_until = purchaseTaxValidUntil;

    entries.push(entry);
  }

  entries.sort((left, right) => left.code.localeCompare(right.code));
  summary.included = entries.length;
  return { entries, summary };
}

async function fetchJson(url: URL, fetchImpl: FetchLike): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Unable to fetch ${url.toString()}: ${message}`);
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Malformed ${context}: expected an object`);
  }
  return value as Record<string, unknown>;
}

export async function fetchAllResourceRows(
  resourceId: string,
  fetchImpl: FetchLike = fetch,
  pageSize = PAGE_SIZE,
): Promise<SourceRecord[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000) {
    throw new Error(`Invalid DataStore page size: ${pageSize}`);
  }

  const rows: SourceRecord[] = [];
  const sourceIds = new Set<string>();
  let offset = 0;
  let expectedTotal: number | undefined;

  while (expectedTotal === undefined || offset < expectedTotal) {
    const url = new URL(DATASTORE_URL);
    url.searchParams.set("resource_id", resourceId);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));

    const payload = objectValue(await fetchJson(url, fetchImpl), "DataStore response");
    if (payload.success !== true) {
      throw new Error(`DataStore reported failure for resource ${resourceId}`);
    }
    const result = objectValue(payload.result, "DataStore result");
    if (result.resource_id !== resourceId) {
      throw new Error(`Unexpected resource ID in DataStore response: ${String(result.resource_id)}`);
    }
    if (!Number.isInteger(result.total) || (result.total as number) < 0) {
      throw new Error(`Invalid DataStore total for resource ${resourceId}`);
    }
    if (!Array.isArray(result.records)) {
      throw new Error(`Missing DataStore records for resource ${resourceId}`);
    }
    if (!Array.isArray(result.fields)) {
      throw new Error(`Missing DataStore field metadata for resource ${resourceId}`);
    }
    const fieldIds = new Set(
      result.fields.map((field) => String(objectValue(field, "DataStore field").id ?? "")),
    );
    const missingFields = REQUIRED_SOURCE_FIELDS.filter((field) => !fieldIds.has(field));
    if (missingFields.length > 0) {
      throw new Error(
        `Resource ${resourceId} is missing required fields: ${missingFields.join(", ")}`,
      );
    }

    const total = result.total as number;
    if (expectedTotal === undefined) expectedTotal = total;
    if (total !== expectedTotal) {
      throw new Error(`DataStore total changed during pagination for resource ${resourceId}`);
    }
    if (result.records.length === 0 && offset < total) {
      throw new Error(`DataStore pagination ended early for resource ${resourceId} at offset ${offset}`);
    }
    if (result.records.length > pageSize) {
      throw new Error(`DataStore returned more than the requested page size for resource ${resourceId}`);
    }

    for (const value of result.records) {
      const record = objectValue(value, "DataStore record") as SourceRecord;
      const sourceId = String(record._id ?? "");
      if (!sourceId) throw new Error(`DataStore record is missing _id in resource ${resourceId}`);
      if (sourceIds.has(sourceId)) {
        throw new Error(`Duplicate DataStore _id ${sourceId} in resource ${resourceId}`);
      }
      sourceIds.add(sourceId);
      rows.push(record);
    }

    offset += result.records.length;
  }

  if (rows.length !== expectedTotal) {
    throw new Error(`Fetched ${rows.length} of ${expectedTotal} rows for resource ${resourceId}`);
  }
  return rows;
}

export async function fetchDatasetResources(fetchImpl: FetchLike = fetch): Promise<{
  he: DatasetResource;
  en: DatasetResource;
}> {
  const url = new URL(PACKAGE_SEARCH_URL);
  url.searchParams.set("q", DATASET_NAME);
  url.searchParams.set("rows", "10");

  const payload = objectValue(await fetchJson(url, fetchImpl), "package response");
  if (payload.success !== true) throw new Error("Package search reported failure");
  const result = objectValue(payload.result, "package result");
  if (!Array.isArray(result.results)) throw new Error("Package search is missing results");

  const dataset = result.results
    .map((value) => objectValue(value, "package dataset"))
    .find((value) => value.name === DATASET_NAME);
  if (!dataset || !Array.isArray(dataset.resources)) {
    throw new Error(`Official dataset ${DATASET_NAME} was not found`);
  }
  if (dataset.license_id !== "other-open") {
    throw new Error(`Unexpected dataset license: ${String(dataset.license_id)}`);
  }

  const resources = dataset.resources.map((value) => objectValue(value, "package resource"));
  const findResource = (id: string): DatasetResource => {
    const resource = resources.find((value) => value.id === id);
    if (!resource || typeof resource.last_modified !== "string") {
      throw new Error(`Official resource ${id} was not found or has no update timestamp`);
    }
    return { id, last_modified: resource.last_modified };
  };

  return {
    he: findResource(HEBREW_RESOURCE_ID),
    en: findResource(ENGLISH_RESOURCE_ID),
  };
}

async function main(): Promise<void> {
  const resources = await fetchDatasetResources();
  const [hebrewRecords, englishRecords] = await Promise.all([
    fetchAllResourceRows(HEBREW_RESOURCE_ID),
    fetchAllResourceRows(ENGLISH_RESOURCE_ID),
  ]);
  const { entries, summary } = normalizeSourceRecords(hebrewRecords, englishRecords);
  if (entries.length < 1_000) {
    throw new Error(
      `Only ${entries.length} public tariff records survived normalization; refusing a partial snapshot`,
    );
  }
  const retrievedAt = new Date().toISOString();
  const datasetUpdatedAt = [resources.he.last_modified, resources.en.last_modified].sort().at(-1);
  if (!datasetUpdatedAt) throw new Error("Unable to determine dataset update timestamp");

  const metadata: TariffMetadata = {
    retrieved_at: retrievedAt,
    dataset_updated_at: datasetUpdatedAt,
    source: "Israel Tax Authority",
    source_type: "official_open_data",
    source_dataset: DATASET_TITLE,
    source_url: DATASET_URL,
    license: {
      id: "other-open",
      title: "אחר (פתוח)",
      terms_url: DATASET_TERMS_URL,
    },
    resource_ids: {
      he: HEBREW_RESOURCE_ID,
      en: ENGLISH_RESOURCE_ID,
    },
    resource_updated_at: {
      he: resources.he.last_modified,
      en: resources.en.last_modified,
    },
  };

  const dataPath = fileURLToPath(new URL("../src/data/tariff.json", import.meta.url));
  const metadataPath = fileURLToPath(new URL("../src/data/tariff.meta.json", import.meta.url));
  const dataJson = `${JSON.stringify(entries, null, 2)}\n`;
  const metadataJson = `${JSON.stringify(metadata, null, 2)}\n`;

  await mkdir(fileURLToPath(new URL("../src/data/", import.meta.url)), { recursive: true });
  await writeFile(dataPath, dataJson, "utf8");
  await writeFile(metadataPath, metadataJson, "utf8");

  console.log(`Hebrew rows fetched: ${summary.hebrew_rows}`);
  console.log(`English rows fetched: ${summary.english_rows}`);
  console.log(`Included normalized records: ${summary.included}`);
  console.log(`Excluded leading-dash special records: ${summary.excluded_special}`);
  console.log(`Excluded Roman-numeral sections: ${summary.excluded_section}`);
  console.log(`Excluded hierarchy records: ${summary.excluded_hierarchy}`);
  console.log(`Excluded malformed records: ${summary.excluded_malformed}`);
  console.log(`Missing English descriptions: ${summary.missing_english_description}`);
  console.log(`Duplicate public lookup keys: ${summary.duplicates}`);
  console.log(`Generated tariff.json bytes: ${Buffer.byteLength(dataJson)}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Tariff import failed: ${message}`);
    process.exitCode = 1;
  });
}
