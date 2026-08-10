import request from "supertest";
import { describe, expect, it } from "vitest";
import type { RequestHandler } from "express";
import {
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
  type DiscoveryExtension,
} from "@x402/extensions/bazaar";
import { app, createApp } from "../src/app.js";
import {
  PAYMENT_NETWORK,
  TARIFF_DESCRIPTION,
  TARIFF_DISCOVERY,
  TARIFF_PRICE,
  X402_ROUTES,
} from "../src/payment.js";
import { createTariffLookup, normalizeTariffCode } from "../src/tariff.js";

describe("tariff code normalization", () => {
  it("normalizes common separators to digits", () => {
    expect(normalizeTariffCode(" 8517.13-0000 ")).toBe("8517130000");
  });

  it("rejects letters and incorrect lengths", () => {
    expect(normalizeTariffCode("8517abc0000")).toBeNull();
    expect(normalizeTariffCode("1234")).toBeNull();
  });

  it("normalizes codes while constructing the in-memory lookup", () => {
    const lookup = createTariffLookup([{ code: "8517.13.0000" }]);
    expect(lookup.has("8517130000")).toBe(true);
  });
});

describe("API", () => {
  it("keeps health free and reports ok", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("trusts the hosting proxy for externally advertised HTTPS URLs", () => {
    expect(app.get("trust proxy")).toBe(1);
  });

  it("returns a normalized official-source tariff response", async () => {
    const response = await request(app).get("/il/tariff/8517130000");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      code: "8517130000",
      description_en: "Smartphones",
      source: "Israel Tax Authority",
      source_type: "official",
    });
    expect(response.body.disclaimer).toContain("Informational lookup only");
  });

  it("normalizes a formatted route code", async () => {
    const response = await request(app).get("/il/tariff/8517.13-0000");
    expect(response.status).toBe(200);
    expect(response.body.code).toBe("8517130000");
  });

  it("returns 404 for a valid but missing code", async () => {
    const response = await request(app).get("/il/tariff/9999999999");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: "tariff_code_not_found",
      code: "9999999999",
    });
  });

  it("returns 400 for a malformed code", async () => {
    const response = await request(app).get("/il/tariff/not-a-code");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "invalid_tariff_code",
      code: "not-a-code",
    });
  });
});

describe("payment routing", () => {
  function paymentRequiredMiddleware(onCall?: () => void): RequestHandler {
    return (_request, response) => {
      onCall?.();
      response.status(402).set("PAYMENT-REQUIRED", "test-payment-requirements").json({});
    };
  }

  it("configures the paid route for Base Sepolia at the requested price", () => {
    expect(X402_ROUTES["GET /il/tariff/:code"]).toMatchObject({
      price: TARIFF_PRICE,
      networks: [PAYMENT_NETWORK],
    });
    expect(TARIFF_PRICE).toBe("$0.0025");
    expect(PAYMENT_NETWORK).toBe("eip155:84532");
  });

  it("attaches a valid explicit Bazaar declaration", () => {
    const bazaar = TARIFF_DISCOVERY.bazaar;
    expect(bazaar).toBeDefined();
    expect(validateDiscoveryExtensionSpec(bazaar as unknown as Record<string, unknown>)).toEqual({
      valid: true,
    });

    // createX402Server enriches the declaration with the route's HTTP method.
    const enriched = structuredClone(bazaar) as DiscoveryExtension;
    enriched.info.input.method = "GET";
    expect(validateDiscoveryExtension(enriched)).toEqual({ valid: true });

    expect(X402_ROUTES["GET /il/tariff/:code"].extensions.bazaar).toBe(bazaar);
  });

  it("describes path input, actual output fields, and service limitations", () => {
    const bazaar = TARIFF_DISCOVERY.bazaar as NonNullable<typeof TARIFF_DISCOVERY.bazaar>;
    const pathParams = bazaar.schema.properties.input.properties.pathParams;
    const output = bazaar.schema.properties.output;

    expect(bazaar.info.input.pathParams).toEqual({ code: "8517130000" });
    expect(pathParams?.required).toContain("code");
    expect(pathParams?.additionalProperties).toBe(false);
    expect(pathParams?.properties?.code?.pattern).toBe("^[0-9]{10}$");
    expect(output?.required).toEqual(["type"]);
    expect(output?.properties?.example).toMatchObject({
      required: ["code", "source", "source_type", "disclaimer"],
      additionalProperties: false,
    });
    expect(TARIFF_DESCRIPTION).toContain("Israel import research");
    expect(TARIFF_DESCRIPTION).toContain("does not classify products");
    expect(TARIFF_DESCRIPTION).toContain("does not classify products or provide legal");
  });

  it("returns 402 for an unpaid existing tariff in payment mode", async () => {
    const paidApp = createApp(paymentRequiredMiddleware());
    const response = await request(paidApp).get("/il/tariff/8517130000");

    expect(response.status).toBe(402);
    expect(response.headers["payment-required"]).toBe("test-payment-requirements");
  });

  it("keeps health and unrelated routes outside payment middleware", async () => {
    let paymentCalls = 0;
    const paidApp = createApp(paymentRequiredMiddleware(() => paymentCalls++));

    expect((await request(paidApp).get("/health")).status).toBe(200);
    expect((await request(paidApp).get("/unrelated")).status).toBe(404);
    expect(paymentCalls).toBe(0);
  });

  it("rejects malformed and missing codes before payment middleware", async () => {
    let paymentCalls = 0;
    const paidApp = createApp(paymentRequiredMiddleware(() => paymentCalls++));

    expect((await request(paidApp).get("/il/tariff/not-a-code")).status).toBe(400);
    expect((await request(paidApp).get("/il/tariff/9999999999")).status).toBe(404);
    expect(paymentCalls).toBe(0);
  });
});
