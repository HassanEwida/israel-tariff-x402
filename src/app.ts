import express, { type RequestHandler } from "express";
import { findTariff, normalizeTariffCode } from "./tariff.js";
import { createTelemetryEndpoint, type Telemetry } from "./telemetry.js";

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
  const telemetryContext = response.locals.telemetry as { tariff_code?: string } | undefined;
  if (telemetryContext) telemetryContext.tariff_code = code;
  next();
};

const tariffHandler: RequestHandler = (_request, response) => {
  const tariff = findTariff(response.locals.tariffCode as string);
  if (!tariff) {
    response.status(500).json({ error: "tariff_lookup_failed" });
    return;
  }
  response.json(tariff);
};

export function createApp(
  paymentMiddleware?: RequestHandler,
  telemetry?: Telemetry,
  monitorCredentials: { username?: string; password?: string } = {},
) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  if (telemetry) {
    app.get("/internal/telemetry", createTelemetryEndpoint(telemetry, monitorCredentials));
  }

  const routeHandlers: RequestHandler[] = [
    ...(telemetry ? [telemetry.requestMiddleware] : []),
    validateTariffRequest,
    ...(telemetry ? [telemetry.paymentStageMiddleware] : []),
    ...(paymentMiddleware ? [paymentMiddleware] : []),
    tariffHandler,
  ];
  app.get(TARIFF_ROUTE, ...routeHandlers);
  return app;
}

export const app = createApp();
