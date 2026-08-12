import { createHmac, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

export const TELEMETRY_EVENT_LIMIT = 200;
const USER_AGENT_LIMIT = 160;

export type TelemetryEventName =
  | "SERVICE_STARTED"
  | "TARIFF_REQUEST"
  | "TARIFF_400"
  | "TARIFF_404"
  | "TARIFF_402"
  | "PAYMENT_PRESENT"
  | "PAYMENT_FAILED"
  | "X402_SETTLEMENT"
  | "TARIFF_200";

export type SafeTelemetryEvent = {
  timestamp: string;
  event: TelemetryEventName;
  boot_id: string;
  request_id?: string;
  tariff_code?: string;
  status?: number;
  payment_present?: boolean;
  user_agent?: string;
  source_id?: string;
  network?: string;
  amount_atomic?: string;
  amount_usdc?: string;
  payer?: string;
  payer_history?: "new" | "repeat" | "unavailable";
  transaction?: string;
};

export type TelemetryCounters = {
  total_tariff_requests: number;
  status_400: number;
  status_404: number;
  status_402: number;
  payment_present: number;
  payment_failed: number;
  settlements: number;
  paid_200: number;
  unique_source_ids_current_boot: number;
  unique_payer_wallets_current_boot: number;
  repeat_payer_count_current_boot: number;
  revenue_usdc_current_boot: string;
};

export type TelemetrySnapshot = {
  service: {
    service_started_at: string;
    boot_id: string;
    network?: string;
  };
  counters: TelemetryCounters;
  recent_events: SafeTelemetryEvent[];
};

export type TariffRequestContext = {
  request_id: string;
  tariff_code?: string;
  payment_present: boolean;
  user_agent?: string;
  source_id?: string;
  reached_payment_stage?: boolean;
};

export type SettlementRecord = {
  request_id?: string;
  tariff_code?: string;
  network?: string;
  amount_atomic?: string;
  payer?: string;
  transaction?: string;
};

export type Telemetry = ReturnType<typeof createTelemetry>;

function atomicUsdcToDecimal(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function safeUserAgent(request: Request): string | undefined {
  const value = request.get("user-agent")?.trim();
  return value ? value.slice(0, USER_AGENT_LIMIT) : undefined;
}

function paymentPresent(request: Request): boolean {
  return Boolean(request.get("payment-signature") || request.get("x-payment"));
}

function safeSourceId(request: Request, secret: string | undefined): string | undefined {
  if (!secret || !request.ip) return undefined;
  return createHmac("sha256", secret).update(request.ip).digest("hex").slice(0, 20);
}

function fixedDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(fixedDigest(actual), fixedDigest(expected));
}

function parseBasicAuthorization(value: string | undefined): { username: string; password: string } | null {
  if (!value?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

export function createTelemetry(options: {
  hashSecret?: string;
  network?: string;
  eventLimit?: number;
  now?: () => Date;
  log?: (line: string) => void;
} = {}) {
  const bootId = randomUUID();
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const eventLimit = Math.max(1, options.eventLimit ?? TELEMETRY_EVENT_LIMIT);
  const recentEvents: SafeTelemetryEvent[] = [];
  const sourceIds = new Set<string>();
  const payerWallets = new Set<string>();
  let revenueAtomic = 0n;
  const counters = {
    total_tariff_requests: 0,
    status_400: 0,
    status_404: 0,
    status_402: 0,
    payment_present: 0,
    payment_failed: 0,
    settlements: 0,
    paid_200: 0,
    repeat_payer_count_current_boot: 0,
  };

  const emit = (event: Omit<SafeTelemetryEvent, "timestamp" | "boot_id">) => {
    const safeEvent: SafeTelemetryEvent = {
      timestamp: (options.now ?? (() => new Date()))().toISOString(),
      boot_id: bootId,
      ...event,
    };
    recentEvents.push(safeEvent);
    if (recentEvents.length > eventLimit) recentEvents.splice(0, recentEvents.length - eventLimit);
    (options.log ?? console.log)(JSON.stringify(safeEvent));
  };

  emit({ event: "SERVICE_STARTED", ...(options.network ? { network: options.network } : {}) });

  const requestMiddleware: RequestHandler = (request, response, next) => {
    const rawCode = request.params.code;
    const code = typeof rawCode === "string" && /^\d{10}$/.test(rawCode) ? rawCode : undefined;
    const context: TariffRequestContext = {
      request_id: randomUUID(),
      ...(code ? { tariff_code: code } : {}),
      payment_present: paymentPresent(request),
      ...(safeUserAgent(request) ? { user_agent: safeUserAgent(request) } : {}),
      ...(safeSourceId(request, options.hashSecret)
        ? { source_id: safeSourceId(request, options.hashSecret) }
        : {}),
    };
    response.locals.telemetry = context;
    counters.total_tariff_requests += 1;
    if (context.source_id) sourceIds.add(context.source_id);
    emit({
      event: "TARIFF_REQUEST",
      request_id: context.request_id,
      ...(context.tariff_code ? { tariff_code: context.tariff_code } : {}),
      payment_present: context.payment_present,
      ...(context.user_agent ? { user_agent: context.user_agent } : {}),
      ...(context.source_id ? { source_id: context.source_id } : {}),
    });
    response.once("finish", () => {
      const common = {
        request_id: context.request_id,
        ...(context.tariff_code ? { tariff_code: context.tariff_code } : {}),
        status: response.statusCode,
        payment_present: context.payment_present,
      };
      if (response.statusCode === 400) {
        counters.status_400 += 1;
        emit({ event: "TARIFF_400", ...common });
      } else if (response.statusCode === 404) {
        counters.status_404 += 1;
        emit({ event: "TARIFF_404", ...common });
      } else if (response.statusCode === 402) {
        counters.status_402 += 1;
        emit({ event: "TARIFF_402", ...common });
      } else if (response.statusCode === 200) {
        counters.paid_200 += 1;
        emit({ event: "TARIFF_200", ...common });
      }
      if (context.payment_present && context.reached_payment_stage && response.statusCode !== 200) {
        counters.payment_failed += 1;
        emit({ event: "PAYMENT_FAILED", ...common });
      }
    });
    next();
  };

  const paymentStageMiddleware: RequestHandler = (_request, response, next) => {
    const context = response.locals.telemetry as TariffRequestContext | undefined;
    if (context) {
      context.reached_payment_stage = true;
      if (context.payment_present) {
        counters.payment_present += 1;
        emit({
          event: "PAYMENT_PRESENT",
          request_id: context.request_id,
          ...(context.tariff_code ? { tariff_code: context.tariff_code } : {}),
          payment_present: true,
        });
      }
    }
    next();
  };

  const recordSettlement = (record: SettlementRecord) => {
    const payer = record.payer?.toLowerCase();
    const repeat = payer ? payerWallets.has(payer) : false;
    if (payer) payerWallets.add(payer);
    if (repeat) counters.repeat_payer_count_current_boot += 1;
    counters.settlements += 1;
    if (record.amount_atomic && /^\d+$/.test(record.amount_atomic)) {
      revenueAtomic += BigInt(record.amount_atomic);
    }
    emit({
      event: "X402_SETTLEMENT",
      ...(record.request_id ? { request_id: record.request_id } : {}),
      ...(record.tariff_code ? { tariff_code: record.tariff_code } : {}),
      ...(record.network ? { network: record.network } : {}),
      ...(record.amount_atomic ? { amount_atomic: record.amount_atomic } : {}),
      ...(record.amount_atomic && /^\d+$/.test(record.amount_atomic)
        ? { amount_usdc: atomicUsdcToDecimal(BigInt(record.amount_atomic)) }
        : {}),
      ...(record.payer ? { payer: record.payer } : {}),
      payer_history: payer ? (repeat ? "repeat" : "new") : "unavailable",
      ...(record.transaction ? { transaction: record.transaction } : {}),
    });
  };

  const snapshot = (): TelemetrySnapshot => ({
    service: {
      service_started_at: startedAt,
      boot_id: bootId,
      ...(options.network ? { network: options.network } : {}),
    },
    counters: {
      ...counters,
      unique_source_ids_current_boot: sourceIds.size,
      unique_payer_wallets_current_boot: payerWallets.size,
      revenue_usdc_current_boot: atomicUsdcToDecimal(revenueAtomic),
    },
    recent_events: structuredClone(recentEvents),
  });

  return { bootId, requestMiddleware, paymentStageMiddleware, recordSettlement, snapshot };
}

export function createTelemetryEndpoint(
  telemetry: Telemetry,
  credentials: { username?: string; password?: string },
): RequestHandler {
  return (request: Request, response: Response) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Robots-Tag", "noindex, nofollow");
    response.type("application/json");
    if (!credentials.username || !credentials.password) {
      response.status(503).json({ error: "telemetry_monitor_not_configured" });
      return;
    }
    const supplied = parseBasicAuthorization(request.get("authorization"));
    if (
      !supplied ||
      !safeEqual(supplied.username, credentials.username) ||
      !safeEqual(supplied.password, credentials.password)
    ) {
      response.set("WWW-Authenticate", 'Basic realm="x402-monitor", charset="UTF-8"');
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    response.json(telemetry.snapshot());
  };
}

export function telemetryContextFromResponseLocals(responseLocals: unknown): TariffRequestContext | undefined {
  if (typeof responseLocals !== "object" || responseLocals === null) return undefined;
  const value = (responseLocals as { telemetry?: unknown }).telemetry;
  if (typeof value !== "object" || value === null) return undefined;
  const requestId = (value as { request_id?: unknown }).request_id;
  return typeof requestId === "string" ? (value as TariffRequestContext) : undefined;
}
