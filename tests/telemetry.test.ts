import type { RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFailedAuthenticationLimiter, createTelemetry } from "../src/telemetry.js";

function unpaid402(): RequestHandler {
  return (_request, response) => {
    response.status(402).set("PAYMENT-REQUIRED", "safe-fixture").json({});
  };
}

function telemetryApp(options: { eventLimit?: number; hashSecret?: string } = {}) {
  const lines: string[] = [];
  const telemetry = createTelemetry({ ...options, log: (line) => lines.push(line) });
  const app = createApp(unpaid402(), telemetry, { username: "monitor", password: "correct" });
  return { app, telemetry, lines };
}

describe("private production telemetry", () => {
  it("keeps health public and outside telemetry demand counters", async () => {
    const { app, telemetry } = telemetryApp();
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(telemetry.snapshot().counters).toMatchObject({
      total_tariff_requests: 0,
      status_402: 0,
    });
    expect(telemetry.snapshot().recent_events.map((event) => event.event)).toEqual([
      "SERVICE_STARTED",
    ]);
  });

  it("keeps telemetry authentication isolated from the public health route", async () => {
    const { app } = telemetryApp();

    expect((await request(app).get("/internal/telemetry")).status).toBe(401);
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("preserves unpaid tariff behavior alongside the public health route", async () => {
    const { app, telemetry } = telemetryApp();

    const tariff = await request(app).get("/il/tariff/8517130000");
    expect(tariff.status).toBe(402);
    expect(tariff.headers["payment-required"]).toBe("safe-fixture");
    expect(telemetry.snapshot().counters).toMatchObject({
      total_tariff_requests: 1,
      status_402: 1,
    });
    expect((await request(app).get("/health")).status).toBe(200);
    expect(telemetry.snapshot().counters).toMatchObject({
      total_tariff_requests: 1,
      status_402: 1,
    });
  });

  it("classifies 400, 404, and unpaid 402 responses", async () => {
    const { app, telemetry } = telemetryApp();
    await request(app).get("/il/tariff/nope");
    await request(app).get("/il/tariff/9999999999");
    await request(app).get("/il/tariff/8517130000");
    expect(telemetry.snapshot().counters).toMatchObject({
      total_tariff_requests: 3,
      status_400: 1,
      status_404: 1,
      status_402: 1,
    });
  });

  it("detects payment presence without retaining its value and classifies failure", async () => {
    const { app, telemetry, lines } = telemetryApp();
    await request(app)
      .get("/il/tariff/8517130000")
      .set("PAYMENT-SIGNATURE", "super-secret-payment-payload");
    const snapshot = telemetry.snapshot();
    expect(snapshot.counters.payment_present).toBe(1);
    expect(snapshot.counters.payment_failed).toBe(1);
    expect(snapshot.recent_events.map((event) => event.event)).toContain("PAYMENT_PRESENT");
    expect(JSON.stringify(snapshot)).not.toContain("super-secret-payment-payload");
    expect(lines.join("\n")).not.toContain("super-secret-payment-payload");
  });

  it("does not treat payment headers rejected by preflight validation as attempts", async () => {
    const { app, telemetry } = telemetryApp();
    await request(app).get("/il/tariff/nope").set("PAYMENT-SIGNATURE", "ignored-invalid-code");
    await request(app).get("/il/tariff/9999999999").set("PAYMENT-SIGNATURE", "ignored-unknown-code");
    expect(telemetry.snapshot().counters).toMatchObject({ payment_present: 0, payment_failed: 0 });
  });

  it("records settlement truth, repeat payer, and revenue through the settlement API", () => {
    const { telemetry } = telemetryApp();
    telemetry.recordSettlement({
      request_id: "request-1",
      tariff_code: "8517130000",
      network: "eip155:8453",
      amount_atomic: "2500",
      payer: "0xAbC",
      transaction: "0xtx1",
    });
    telemetry.recordSettlement({
      request_id: "request-2",
      tariff_code: "8517130000",
      network: "eip155:8453",
      amount_atomic: "2500",
      payer: "0xabc",
      transaction: "0xtx2",
    });
    expect(telemetry.snapshot().counters).toMatchObject({
      settlements: 2,
      unique_payer_wallets_current_boot: 1,
      repeat_payer_count_current_boot: 1,
      revenue_usdc_current_boot: "0.005",
    });
  });

  it("keeps a bounded event ring buffer", async () => {
    const { app, telemetry } = telemetryApp({ eventLimit: 5 });
    await request(app).get("/il/tariff/nope");
    await request(app).get("/il/tariff/nope");
    await request(app).get("/il/tariff/nope");
    expect(telemetry.snapshot().recent_events).toHaveLength(5);
  });

  it("fails closed without credentials and rejects bad Basic auth", async () => {
    const telemetry = createTelemetry({ log: () => undefined });
    const missing = createApp(undefined, telemetry);
    expect((await request(missing).get("/internal/telemetry")).status).toBe(503);
    const configured = createApp(undefined, telemetry, { username: "monitor", password: "correct" });
    expect((await request(configured).get("/internal/telemetry")).status).toBe(401);
    expect((await request(configured).get("/internal/telemetry").auth("monitor", "wrong")).status).toBe(401);
  });

  it("rate-limits only after ten failed authentication attempts per source", async () => {
    const { app } = telemetryApp();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await request(app).get("/internal/telemetry").auth("monitor", "wrong")).status).toBe(401);
    }
    const limited = await request(app).get("/internal/telemetry").auth("monitor", "wrong");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("does not rate-limit a successful collector request after failures", async () => {
    const { app } = telemetryApp();
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await request(app).get("/internal/telemetry").auth("monitor", "wrong");
    }
    expect((await request(app).get("/internal/telemetry").auth("monitor", "correct")).status).toBe(200);
  });

  it("isolates failed-authentication limits by trusted request source", async () => {
    const { app } = telemetryApp();
    for (let attempt = 0; attempt < 11; attempt += 1) {
      await request(app)
        .get("/internal/telemetry")
        .set("X-Forwarded-For", "198.51.100.10")
        .auth("monitor", "wrong");
    }
    const differentSource = await request(app)
      .get("/internal/telemetry")
      .set("X-Forwarded-For", "198.51.100.11")
      .auth("monitor", "wrong");
    expect(differentSource.status).toBe(401);
  });

  it("keeps failed-authentication source state bounded and expires windows", () => {
    let now = 1_000;
    const limiter = createFailedAuthenticationLimiter({
      failureLimit: 1,
      windowMs: 1_000,
      maxSources: 2,
      now: () => now,
    });
    expect(limiter.recordFailure("source-one").limited).toBe(false);
    expect(limiter.recordFailure("source-one").limited).toBe(true);
    limiter.recordFailure("source-two");
    limiter.recordFailure("source-three");
    expect(limiter.storedSources()).toBe(2);
    now += 1_001;
    expect(limiter.recordFailure("source-one").limited).toBe(false);
  });

  it("returns safe JSON with auth and privacy headers", async () => {
    const { app } = telemetryApp({ hashSecret: "hash-secret" });
    await request(app)
      .get("/il/tariff/8517130000")
      .set("X-Forwarded-For", "203.0.113.9")
      .set("Cookie", "private-cookie=value")
      .set("Authorization", "Bearer private-auth");
    const response = await request(app).get("/internal/telemetry").auth("monitor", "correct");
    const serialized = JSON.stringify(response.body);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain("private-cookie");
    expect(serialized).not.toContain("private-auth");
    expect(response.body.recent_events.some((event: { source_id?: string }) => event.source_id)).toBe(true);
  });
});
