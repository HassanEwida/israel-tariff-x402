import { createX402Server, type CdpX402ServerConfig } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { RequestHandler } from "express";

export const X402_ENVIRONMENT = "development" as const;
export const PAYMENT_NETWORK = "eip155:84532" as const;
export const TARIFF_PRICE = "$0.0025" as const;
export const TARIFF_DESCRIPTION =
  "Israeli Customs Tariff Lookup. Retrieve fields published in the official Israel Tax Authority open dataset for a known ten-digit Israeli customs tariff code. Use for Israel import research, tariff metadata verification, procurement/import workflows, and trade-compliance research. The caller must already know the code. This endpoint does not classify products, provide legal or customs advice, calculate treaty/agreement rates, or account for quotas, levies, or licensing and approval requirements. Official legislation and Customs determinations prevail.";

export const TARIFF_DISCOVERY = declareDiscoveryExtension({
  input: {},
  inputSchema: {
    properties: {},
    additionalProperties: false,
  },
  pathParams: {
    code: "8517130000",
  },
  pathParamsSchema: {
    properties: {
      code: {
        type: "string",
        description: "Israeli customs tariff code, exactly 10 digits.",
        pattern: "^[0-9]{10}$",
        examples: ["8517130000"],
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
  output: {
    example: {
      code: "8517130000",
      official_code: "8517130000/8",
      description_he: "טלפונים חכמים (SMARTPHONES )",
      description_en: "-- Smartphones",
      customs_rate: "פטור",
      purchase_tax: "פטור",
      measurement_unit: "כל אחד",
      customs_rate_valid_until: "2028-05-31",
      customs_item_category_id: 1,
      dataset_updated_at: "2026-08-10T08:58:44.723712",
      retrieved_at: "2026-08-10T11:00:00.000Z",
      source: "Israel Tax Authority",
      source_type: "official_open_data",
      source_dataset: "ספר סיווג טובין ביבוא",
      source_url: "https://data.gov.il/he/datasets/taxes-authority/customsbook",
      disclaimer:
        "Official open-dataset fields only. Not tariff-classification advice; does not calculate treaty/agreement rates or account for quotas, levies, or licensing/approval requirements. Official legislation and Customs determinations prevail.",
    },
    schema: {
      properties: {
        code: {
          type: "string",
          description: "Normalized 10-digit Israeli customs tariff code.",
        },
        official_code: {
          type: "string",
          description: "Official source classification, preserving an optional slash/check digit.",
        },
        description_he: {
          type: "string",
          description: "Hebrew tariff description when present in the normalized source data.",
        },
        description_en: {
          type: "string",
          description: "English tariff description when present in the normalized source data.",
        },
        customs_rate: {
          type: "string",
          description:
            "Summarized CustomsTariff text published in the official open dataset, when present.",
        },
        purchase_tax: {
          type: "string",
          description:
            "Summarized PurchaseTaxTariff text published in the official open dataset, when present.",
        },
        measurement_unit: {
          type: "string",
          description: "Measurement-unit description published in the Hebrew source, when present.",
        },
        item_valid_until: {
          type: "string",
          description: "Item validity end date in YYYY-MM-DD form, when published.",
        },
        customs_rate_valid_until: {
          type: "string",
          description: "Customs-rate validity end date in YYYY-MM-DD form, when published.",
        },
        purchase_tax_valid_until: {
          type: "string",
          description: "Purchase-tax validity end date in YYYY-MM-DD form, when published.",
        },
        customs_item_category_id: {
          type: "number",
          description: "Category identifier published in the canonical Hebrew resource.",
        },
        dataset_updated_at: {
          type: "string",
          description: "Most recent source-resource update timestamp at import time.",
        },
        retrieved_at: {
          type: "string",
          description: "Timestamp when the local official-data snapshot was retrieved.",
        },
        source: {
          type: "string",
          const: "Israel Tax Authority",
        },
        source_type: {
          type: "string",
          const: "official_open_data",
        },
        source_dataset: {
          type: "string",
          const: "ספר סיווג טובין ביבוא",
        },
        source_url: {
          type: "string",
          const: "https://data.gov.il/he/datasets/taxes-authority/customsbook",
        },
        disclaimer: {
          type: "string",
          description:
            "Informational-use limitation; official Israeli legislation and Customs determinations prevail.",
        },
      },
      required: [
        "code",
        "official_code",
        "dataset_updated_at",
        "retrieved_at",
        "source",
        "source_type",
        "source_dataset",
        "source_url",
        "disclaimer",
      ],
      additionalProperties: false,
    },
  },
});

export const X402_ROUTES = {
  "GET /il/tariff/:code": {
    price: TARIFF_PRICE,
    description: TARIFF_DESCRIPTION,
    networks: [PAYMENT_NETWORK],
    extensions: {
      ...TARIFF_DISCOVERY,
    },
  },
} satisfies NonNullable<CdpX402ServerConfig["routes"]>;

const REQUIRED_CDP_ENVIRONMENT_VARIABLES = [
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
] as const;

export type PaymentSetup = {
  middleware: RequestHandler;
  payToAddress: string;
};

export async function createPaymentSetup(): Promise<PaymentSetup> {
  const missingVariables = REQUIRED_CDP_ENVIRONMENT_VARIABLES.filter(
    (name) => !process.env[name],
  );

  if (missingVariables.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVariables.join(", ")}`);
  }

  const x402Server = await createX402Server({
    environment: X402_ENVIRONMENT,
    routes: X402_ROUTES,
  });

  if (!x402Server.payToEvmAddress) {
    throw new Error("CDP did not return an EVM payment destination");
  }

  return {
    middleware: paymentMiddlewareFromHTTPServer(x402Server),
    payToAddress: x402Server.payToEvmAddress,
  };
}
