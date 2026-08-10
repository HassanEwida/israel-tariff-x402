import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createApp } from "./app.js";
import {
  createPaymentSetup,
  PAYMENT_NETWORK,
  X402_ENVIRONMENT,
} from "./payment.js";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const PORT = Number(process.env.PORT ?? 8402);

try {
  const payment = await createPaymentSetup();
  const app = createApp(payment.middleware);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on 0.0.0.0:${PORT}`);
    console.log(`x402 environment: ${X402_ENVIRONMENT}`);
    console.log(`payment network: ${PAYMENT_NETWORK}`);
    console.log(`payment destination: ${payment.payToAddress}`);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown initialization error";
  console.error(`Unable to start x402 server: ${message}`);
  process.exitCode = 1;
}
