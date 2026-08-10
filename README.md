# israel-tariff-x402

A deliberately small experiment: expose normalized Israeli tariff data through one
x402-paid API endpoint and observe whether independent agents discover and pay for it.

Step 2 protects `GET /il/tariff/:code` with x402 v2. `GET /health` remains free.
The server is development-only and accepts test USDC on Base Sepolia
(`eip155:84532`). No Base mainnet or real-payment configuration is included.

## Requirements

- Node.js 22+
- A CDP API key and wallet secret for a development receiver wallet

Copy `.env.example` to `.env` and set:

```text
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=
CDP_WALLET_SECRET=
PORT=8402
NODE_ENV=development
```

Secrets are read from the environment or local `.env` file and must never be
committed. The `.env` file is ignored by Git.

## Run and verify

```bash
npm install
npm run build
npm test
npm start
```

In another terminal, verify the free health endpoint:

```bash
curl -i http://localhost:8402/health
```

It returns HTTP 200. An unpaid request to an existing tariff code:

```bash
curl -i http://localhost:8402/il/tariff/8517130000
```

returns HTTP 402 with the x402 v2 `PAYMENT-REQUIRED` header. A paid client sends
its authorization in the v2 `PAYMENT-SIGNATURE` header; successful settlement is
reported in `PAYMENT-RESPONSE`.

Malformed codes return HTTP 400 and valid but unknown codes return HTTP 404 before
the payment middleware, so those requests are not charged.

The normalized fixture records are loaded from `src/data/tariff.json` into an
in-memory `Map` at startup. They are sample data for development, not yet a complete
or independently verified government tariff extract.

Successful blockchain settlement is intentionally not mocked in Vitest. To test a
real development payment, use an x402 v2 buyer funded with Base Sepolia test USDC
and request the same local tariff URL.

## Bazaar discovery metadata

The paid route declares explicit x402 Bazaar metadata describing its tariff-lookup
purpose, required `code` path parameter, successful JSON response, and limitations.
Agents can identify it for Israeli import research, tariff verification, procurement,
and trade-compliance workflows when they already know the tariff code. It does not
classify products or provide legal or customs advice.

The API is still localhost-only, so Coinbase cannot externally probe, validate, or
index it yet. After deployment to a public HTTPS host, validate the concrete fixture
URL with:

```bash
curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
  -H "Content-Type: application/json" \
  -d '{
    "resource": "https://YOUR_PUBLIC_HOST/il/tariff/8517130000",
    "method": "GET"
  }'
```

External validation and the first paid call are intentionally deferred until after
public deployment.
