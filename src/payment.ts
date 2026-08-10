import { createX402Server, type CdpX402ServerConfig } from "@coinbase/cdp-sdk/x402";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { RequestHandler } from "express";

export const X402_ENVIRONMENT = "development" as const;
export const PAYMENT_NETWORK = "eip155:84532" as const;
export const TARIFF_PRICE = "$0.0025" as const;
export const TARIFF_DESCRIPTION =
  "Israeli Customs Tariff Lookup. Look up structured Israeli customs tariff information for a known Israeli customs tariff code using normalized data sourced from the Israel Tax Authority. Use for Israel import research, customs duty or import tax verification, procurement/import workflows, and trade compliance research. The caller must already know the code. This endpoint does not classify products or provide legal or customs advice. Official legislation and Customs determinations prevail.";

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
        description:
          "Israeli customs tariff code. Exactly 10 digits after removing spaces, dots, or hyphens.",
        pattern: "^(?=(?:[^0-9]*[0-9]){10}[^0-9]*$)[0-9 .-]+$",
        examples: ["8517130000"],
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
  output: {
    example: {
      code: "8517130000",
      description_he: "טלפונים חכמים",
      description_en: "Smartphones",
      customs_rate: "Exempt",
      purchase_tax: "Exempt",
      effective_date: "2024-01-01",
      source: "Israel Tax Authority",
      source_type: "official",
      disclaimer:
        "Informational lookup only. Official Israeli legislation and Customs determinations prevail.",
    },
    schema: {
      properties: {
        code: {
          type: "string",
          description: "Normalized 10-digit Israeli customs tariff code.",
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
          description: "Customs-rate metadata when present in the normalized source data.",
        },
        purchase_tax: {
          type: "string",
          description: "Purchase-tax metadata when present in the normalized source data.",
        },
        effective_date: {
          type: "string",
          description: "Effective-date metadata when present in the normalized source data.",
        },
        source: {
          type: "string",
          const: "Israel Tax Authority",
        },
        source_type: {
          type: "string",
          const: "official",
        },
        disclaimer: {
          type: "string",
          description:
            "Informational-use limitation; official Israeli legislation and Customs determinations prevail.",
        },
      },
      required: ["code", "source", "source_type", "disclaimer"],
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
