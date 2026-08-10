# israel-tariff-x402

A deliberately small experiment: expose normalized official Israeli tariff data through
one x402-paid API endpoint and observe whether independent agents discover and pay for it.

`GET /il/tariff/:code` is protected with x402 v2. `GET /health` remains free. The
server charges `$0.0025` per successful request. `X402_ENVIRONMENT=development`
selects Base Sepolia (`eip155:84532`); `X402_ENVIRONMENT=production` selects Base
mainnet (`eip155:8453`). The variable is mandatory, and `NODE_ENV` never selects a
financial network.

The runtime is intentionally simple: Express loads a generated local JSON snapshot into
an in-memory `Map`. There is no database, frontend, account system, or background worker.

## Requirements

- Node.js 22+
- A CDP API key and wallet secret for a development receiver wallet

Copy `.env.example` to `.env` and set:

```text
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=
CDP_WALLET_SECRET=
X402_ENVIRONMENT=development
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

The normalized records are loaded from `src/data/tariff.json` into an in-memory `Map`
at startup. Snapshot provenance and retrieval timestamps are stored separately in
`src/data/tariff.meta.json`.

The successful response includes:

```json
{
  "code": "8517130000",
  "official_code": "8517130000/8",
  "description_he": "טלפונים חכמים (SMARTPHONES )",
  "description_en": "-- Smartphones",
  "customs_rate": "פטור",
  "purchase_tax": "פטור",
  "measurement_unit": "כל אחד",
  "customs_rate_valid_until": "2028-05-31",
  "customs_item_category_id": 1,
  "dataset_updated_at": "...",
  "retrieved_at": "...",
  "source": "Israel Tax Authority",
  "source_type": "official_open_data",
  "source_dataset": "ספר סיווג טובין ביבוא",
  "source_url": "https://data.gov.il/he/datasets/taxes-authority/customsbook",
  "disclaimer": "..."
}
```

Optional fields are omitted when the official source does not publish a value. The API
does not invent an effective date or interpret a missing rate as zero or exempt.

Successful settlements emit one safe JSON console event containing the timestamp,
tariff code, public payer address when returned by the facilitator, process-local
new/repeat status, network, atomic amount, and public transaction hash. The application
never logs payment authorization headers or credentials. New/repeat tracking resets
when the process restarts; no database or external analytics service is used.

Successful blockchain settlement is intentionally not mocked in Vitest. To test a
real development payment, use an x402 v2 buyer funded with Base Sepolia test USDC
and request the same local tariff URL.

## Official tariff-data refresh

The source is the Israel Tax Authority dataset
[ספר סיווג טובין ביבוא](https://data.gov.il/he/datasets/taxes-authority/customsbook):

- Hebrew canonical resource: `5536eaa1-2e51-406b-aff6-b9ca02801b7c`
- English-description resource: `c96d99fe-fd3a-4e86-a767-4119dd8b723e`
- License: `אחר (פתוח)` under the
  [data.gov.il terms](https://data.gov.il/he/terms-of-use)

Refresh the snapshot manually:

```bash
npm run update:tariff
npm run build
npm test
git diff --stat
```

The importer paginates both official DataStore resources, uses Hebrew tax fields as
canonical, merges only the English description, excludes leading-dash special items and
non-leaf hierarchy records, rejects malformed codes and collisions, sorts by the public
ten-digit code, and writes only after the full import validates. Normal tests use local
fixtures and never contact `data.gov.il`.

Review the generated diff before committing. The source currently reports manual,
irregular updates, so no scheduled automation is included.

## Scope and limitations

`customs_rate` and `purchase_tax` preserve the summarized text fields published in the
official open dataset. They are not a complete legally applicable calculation. The API
does not classify products, calculate treaty/agreement rates, or account for quotas,
levies, licensing, or approval requirements. Official legislation and Customs
determinations prevail. Publication by the Israel Tax Authority does not imply its
endorsement of this API.

## Bazaar discovery metadata

The paid route declares explicit x402 Bazaar metadata describing its tariff-lookup
purpose, required `code` path parameter, successful JSON response, and limitations.
Agents can identify it for Israeli import research, tariff verification, procurement,
and trade-compliance workflows when they already know the tariff code.

The current public deployment is:

```text
https://israel-tariff-x402.onrender.com
```

Validate the concrete public resource URL with:

```bash
curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
  -H "Content-Type: application/json" \
  -d '{
    "resource": "https://israel-tariff-x402.onrender.com/il/tariff/8517130000",
    "method": "GET"
  }'
```

The repository contains an explicitly guarded buyer test from the completed testnet-flow
verification. Do not run it during ordinary data refreshes; it can perform a payment.
