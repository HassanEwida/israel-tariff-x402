import { describe, expect, it } from "vitest";
import englishFixture from "./fixtures/import-en.json" with { type: "json" };
import hebrewFixture from "./fixtures/import-he.json" with { type: "json" };
import duplicateHebrewFixture from "./fixtures/import-duplicate-he.json" with { type: "json" };
import {
  DATASTORE_URL,
  extractPublicCode,
  fetchAllResourceRows,
  normalizeSourceRecords,
  type SourceRecord,
} from "../scripts/import-israel-tariff.js";

describe("official tariff source normalization", () => {
  it("extracts exactly ten digits before an optional check digit", () => {
    expect(extractPublicCode("8517130000/8")).toBe("8517130000");
    expect(extractPublicCode("0901210000")).toBe("0901210000");
    expect(extractPublicCode("85171300008")).toBeNull();
    expect(extractPublicCode("-8517130000/8")).toBeNull();
  });

  it("excludes special, section, and hierarchy records", () => {
    const result = normalizeSourceRecords(
      hebrewFixture as SourceRecord[],
      englishFixture as SourceRecord[],
    );

    expect(result.entries).toHaveLength(3);
    expect(result.summary).toMatchObject({
      included: 3,
      excluded_special: 1,
      excluded_section: 1,
      excluded_hierarchy: 1,
      excluded_malformed: 1,
      duplicates: 0,
    });
  });

  it("preserves the official code and produces deterministic code ordering", () => {
    const { entries } = normalizeSourceRecords(
      hebrewFixture as SourceRecord[],
      englishFixture as SourceRecord[],
    );

    expect(entries.map((entry) => entry.code)).toEqual([
      "0901210000",
      "1234567890",
      "8517130000",
    ]);
    expect(entries.at(-1)).toMatchObject({
      code: "8517130000",
      official_code: "8517130000/8",
    });
  });

  it("merges only the English description and keeps Hebrew tax fields canonical", () => {
    const { entries } = normalizeSourceRecords(
      hebrewFixture as SourceRecord[],
      englishFixture as SourceRecord[],
    );
    const smartphone = entries.find((entry) => entry.code === "8517130000");
    const coffee = entries.find((entry) => entry.code === "0901210000");

    expect(smartphone).toMatchObject({
      description_he: "טלפונים חכמים",
      description_en: "Smartphones",
      customs_rate: "פטור",
      purchase_tax: "פטור",
      customs_rate_valid_until: "2028-05-31",
    });
    expect(coffee).toMatchObject({
      description_en: "Roasted coffee",
      customs_rate: "12%",
    });
    expect(coffee?.purchase_tax).toBeUndefined();
  });

  it("does not invent English descriptions or null validity dates", () => {
    const result = normalizeSourceRecords(
      hebrewFixture as SourceRecord[],
      englishFixture as SourceRecord[],
    );
    const missingEnglish = result.entries.find((entry) => entry.code === "1234567890");

    expect(result.summary.missing_english_description).toBe(1);
    expect(missingEnglish?.description_en).toBeUndefined();
    expect(missingEnglish?.item_valid_until).toBeUndefined();
    expect(missingEnglish?.customs_rate_valid_until).toBeUndefined();
    expect(missingEnglish?.purchase_tax_valid_until).toBeUndefined();
  });

  it("fails loudly when two source records collide on one public key", () => {
    expect(() =>
      normalizeSourceRecords(
        duplicateHebrewFixture as SourceRecord[],
        englishFixture as SourceRecord[],
      ),
    ).toThrow("Duplicate public lookup key after normalization: 8517130000");
  });
});

describe("official DataStore pagination", () => {
  const fields = [
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
  ].map((id) => ({ id }));

  it("retrieves all rows using the actual page lengths", async () => {
    const rows = [
      { _id: 1, CustomsItemFullClassification: "0000000001/0" },
      { _id: 2, CustomsItemFullClassification: "0000000002/0" },
      { _id: 3, CustomsItemFullClassification: "0000000003/0" },
    ];
    const requestedOffsets: number[] = [];
    const fetchStub = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(DATASTORE_URL);
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      requestedOffsets.push(offset);
      return Response.json({
        success: true,
        result: {
          resource_id: "fixture-resource",
          total: rows.length,
          records: rows.slice(offset, offset + limit),
          fields,
        },
      });
    }) as typeof fetch;

    const result = await fetchAllResourceRows("fixture-resource", fetchStub, 2);
    expect(result).toEqual(rows);
    expect(requestedOffsets).toEqual([0, 2]);
  });

  it("rejects an early empty page instead of producing partial data", async () => {
    const fetchStub = (async () =>
      Response.json({
        success: true,
        result: { resource_id: "fixture-resource", total: 3, records: [], fields },
      })) as typeof fetch;

    await expect(fetchAllResourceRows("fixture-resource", fetchStub, 2)).rejects.toThrow(
      "pagination ended early",
    );
  });

  it("rejects a source whose required schema changed", async () => {
    const fetchStub = (async () =>
      Response.json({
        success: true,
        result: {
          resource_id: "fixture-resource",
          total: 0,
          records: [],
          fields: [{ id: "_id" }],
        },
      })) as typeof fetch;

    await expect(fetchAllResourceRows("fixture-resource", fetchStub, 2)).rejects.toThrow(
      "missing required fields",
    );
  });
});
