import express, { type RequestHandler } from "express";
import { findTariff, normalizeTariffCode } from "./tariff.js";

const TARIFF_ROUTE = "/il/tariff/:code";

const validateTariffRequest: RequestHandler = (request, response, next) => {
  const rawCode = request.params.code;
  const code = typeof rawCode === "string" ? normalizeTariffCode(rawCode) : null;

  if (code === null) {
    response.status(400).json({
      error: "invalid_tariff_code",
      code: rawCode,
    });
    return;
  }

  const tariff = findTariff(code);
  if (!tariff) {
    response.status(404).json({ error: "tariff_code_not_found", code });
    return;
  }

  response.locals.tariffCode = code;
  next();
};

const tariffHandler: RequestHandler = (_request, response) => {
  const tariff = findTariff(response.locals.tariffCode as string);

  // The preflight middleware guarantees this entry exists before payment.
  if (!tariff) {
    response.status(500).json({ error: "tariff_lookup_failed" });
    return;
  }

  response.json(tariff);
};

export function createApp(paymentMiddleware?: RequestHandler) {
  const app = express();

  app.disable("x-powered-by");

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  if (paymentMiddleware) {
    app.get(TARIFF_ROUTE, validateTariffRequest, paymentMiddleware, tariffHandler);
  } else {
    app.get(TARIFF_ROUTE, validateTariffRequest, tariffHandler);
  }

  return app;
}

// Unpaid app instance for business-logic tests. The production entry point
// creates a payment-enabled instance after x402 initialization succeeds.
export const app = createApp();
