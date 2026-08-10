import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createApp } from "./app.js";
import {
  createPaymentSetup,
  resolveX402Configuration,
} from "./payment.js";

if (existsSync(".env")) {
  loadEnvFile(".env");
}

const PORT = Number(process.env.PORT ?? 8402);

try {
  const x402Configuration = resolveX402Configuration(process.env.X402_ENVIRONMENT);
  const payment = await createPaymentSetup(x402Configuration);
  const app = createApp(payment.middleware);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on 0.0.0.0:${PORT}`);
    console.log(`x402 environment: ${x402Configuration.environment}`);
    console.log(`payment network: ${x402Configuration.network}`);
    console.log(`payment destination: ${payment.payToAddress}`);
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown initialization error";
  console.error(`Unable to start x402 server: ${message}`);
  process.exitCode = 1;
}
