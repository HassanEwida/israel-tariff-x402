import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { CdpClient } from "@coinbase/cdp-sdk";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";

const RESOURCE_URL =
  "https://israel-tariff-x402.onrender.com/il/tariff/8517130000";
const BUYER_ACCOUNT_NAME = "israel-tariff-x402-step5-buyer";
const NETWORK = "eip155:84532";
const CDP_NETWORK = "base-sepolia";
const EXPECTED_AMOUNT = 2_500n;
const MAX_AMOUNT = 10_000n;
const USDC_ADDRESS = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SELLER_ADDRESS = "0x78571a85f3b6020bdec09f810bfd6f1a61f92afc";

type PaymentRequirement = {
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
};

type PaymentRequired = {
  x402Version?: number;
  resource?: { url?: string };
  accepts?: PaymentRequirement[];
};

if (existsSync(".env")) {
  loadEnvFile(".env");
}

function requireCredentials() {
  for (const name of ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
    if (!process.env[name]) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
  }
}

function normalizeAddress(value: string | undefined) {
  return value?.toLowerCase();
}

function safeJson(value: unknown) {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

function decodePaymentRequired(header: string): PaymentRequired {
  return JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as PaymentRequired;
}

function validatePaymentRequired(paymentRequired: PaymentRequired) {
  if (paymentRequired.x402Version !== 2) {
    throw new Error(`Refusing x402 version ${String(paymentRequired.x402Version)}`);
  }
  if (paymentRequired.resource?.url !== RESOURCE_URL) {
    throw new Error("Refusing an unexpected resource URL");
  }
  if (paymentRequired.accepts?.length !== 1) {
    throw new Error("Expected exactly one payment requirement");
  }

  const requirement = paymentRequired.accepts[0];
  if (!requirement || requirement.scheme !== "exact") {
    throw new Error("Refusing a non-exact payment scheme");
  }
  if (requirement.network !== NETWORK) {
    throw new Error(`Refusing payment network ${String(requirement.network)}`);
  }
  if (normalizeAddress(requirement.asset) !== USDC_ADDRESS) {
    throw new Error("Refusing an unexpected payment asset");
  }
  if (normalizeAddress(requirement.payTo) !== SELLER_ADDRESS) {
    throw new Error("Refusing an unexpected payment receiver");
  }

  const amount = BigInt(requirement.amount ?? "-1");
  if (amount !== EXPECTED_AMOUNT || amount > MAX_AMOUNT) {
    throw new Error(`Refusing payment amount ${amount.toString()}`);
  }

  return {
    network: requirement.network,
    amount: amount.toString(),
    asset: requirement.asset,
    seller: requirement.payTo,
  };
}

async function getBalances(cdp: CdpClient, address: `0x${string}`) {
  const result = await cdp.evm.listTokenBalances({
    address,
    network: CDP_NETWORK,
    pageSize: 100,
  });
  const byAddress = new Map(
    result.balances.map(balance => [
      balance.token.contractAddress.toLowerCase(),
      balance.amount.amount,
    ]),
  );
  return {
    usdc: byAddress.get(USDC_ADDRESS) ?? 0n,
    eth: byAddress.get(ETH_ADDRESS) ?? 0n,
  };
}

async function waitForFunds(cdp: CdpClient, address: `0x${string}`) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const balances = await getBalances(cdp, address);
    if (balances.usdc >= EXPECTED_AMOUNT && balances.eth > 0n) {
      return balances;
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  throw new Error("Timed out waiting for Base Sepolia faucet funds");
}

async function waitForSellerPayment(cdp: CdpClient, balanceBefore: bigint) {
  let latest = balanceBefore;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    latest = (await getBalances(cdp, SELLER_ADDRESS as `0x${string}`)).usdc;
    if (latest - balanceBefore >= EXPECTED_AMOUNT) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  return latest;
}

async function fundBuyer(cdp: CdpClient, address: `0x${string}`) {
  const before = await getBalances(cdp, address);
  const transactions: Record<string, string> = {};

  if (before.usdc < EXPECTED_AMOUNT) {
    const result = await cdp.evm.requestFaucet({
      address,
      network: CDP_NETWORK,
      token: "usdc",
    });
    transactions.usdc = result.transactionHash;
  }
  if (before.eth === 0n) {
    const result = await cdp.evm.requestFaucet({
      address,
      network: CDP_NETWORK,
      token: "eth",
    });
    transactions.eth = result.transactionHash;
  }

  const after = await waitForFunds(cdp, address);
  console.log(
    safeJson({
      mode: "fund-only",
      buyerAddress: address,
      network: NETWORK,
      fundingMethod: "Coinbase CDP Base Sepolia faucet",
      faucetTransactions: transactions,
      balances: {
        usdcAtomic: after.usdc.toString(),
        ethAtomic: after.eth.toString(),
      },
    }),
  );
}

async function main() {
  requireCredentials();

  const paymentClient = new CdpX402Client({
    environment: "development",
    walletConfig: { type: "eoa", accountName: BUYER_ACCOUNT_NAME },
    spendControls: {
      maxAmountPerPayment: { atomic: MAX_AMOUNT, asset: USDC_ADDRESS },
      maxCumulativeSpend: { atomic: MAX_AMOUNT, asset: USDC_ADDRESS },
      maxCumulativeSpendWindow: "24h",
      allowedNetworks: [NETWORK],
      allowedAssets: [USDC_ADDRESS],
      allowedPayees: [SELLER_ADDRESS],
    },
  });
  const { evmAddress } = await paymentClient.getAddresses();
  if (normalizeAddress(evmAddress) === SELLER_ADDRESS) {
    throw new Error("Buyer and seller addresses must be different");
  }

  const cdp = new CdpClient();
  if (process.argv.includes("--fund-only")) {
    await fundBuyer(cdp, evmAddress);
    return;
  }

  const buyerBefore = await getBalances(cdp, evmAddress);
  if (buyerBefore.usdc < EXPECTED_AMOUNT || buyerBefore.eth === 0n) {
    throw new Error("Buyer lacks confirmed Base Sepolia faucet funds; run npm run buyer:fund");
  }
  const sellerBefore = await getBalances(cdp, SELLER_ADDRESS as `0x${string}`);

  let initialStatus: number | undefined;
  let signedRequestCount = 0;
  let challengeSummary: ReturnType<typeof validatePaymentRequired> | undefined;

  const guardedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.has("PAYMENT-SIGNATURE")) {
      signedRequestCount += 1;
      if (signedRequestCount > 1) {
        throw new Error("Refusing to send more than one signed payment request");
      }
    }

    const response = await fetch(request);
    if (initialStatus === undefined) {
      initialStatus = response.status;
      if (response.status !== 402) {
        throw new Error(`Expected initial HTTP 402, received ${response.status}`);
      }
      const header = response.headers.get("PAYMENT-REQUIRED");
      if (!header) {
        throw new Error("Initial HTTP 402 omitted PAYMENT-REQUIRED");
      }
      challengeSummary = validatePaymentRequired(decodePaymentRequired(header));
    }
    return response;
  };

  const fetchWithPayment = wrapFetchWithPayment(guardedFetch, paymentClient);
  const finalResponse = await fetchWithPayment(RESOURCE_URL, { method: "GET" });
  const tariff = (await finalResponse.json()) as Record<string, unknown>;
  if (finalResponse.status !== 200 || tariff.code !== "8517130000") {
    throw new Error(`Paid resource was not unlocked; final status ${finalResponse.status}`);
  }
  if (signedRequestCount !== 1) {
    throw new Error(`Expected one signed request, observed ${signedRequestCount}`);
  }

  const paymentResponseHeader = finalResponse.headers.get("PAYMENT-RESPONSE");
  if (!paymentResponseHeader) {
    throw new Error("Successful response omitted PAYMENT-RESPONSE");
  }
  const httpClient = new x402HTTPClient(paymentClient);
  const settlement = httpClient.getPaymentSettleResponse(name => finalResponse.headers.get(name));
  if (!settlement.success || settlement.network !== NETWORK) {
    throw new Error("Facilitator did not report a successful Base Sepolia settlement");
  }

  const sellerAfterUsdc = await waitForSellerPayment(cdp, sellerBefore.usdc);
  console.log(
    safeJson({
      buyerAddress: evmAddress,
      sellerAddress: challengeSummary?.seller,
      network: challengeSummary?.network,
      requestedAmountAtomic: challengeSummary?.amount,
      requestedAmountUsdc: "0.0025",
      initialStatus,
      signedRequestCount,
      finalStatus: finalResponse.status,
      tariff,
      paymentResponsePresent: true,
      settlement,
      sellerBalance: {
        beforeAtomic: sellerBefore.usdc.toString(),
        afterAtomic: sellerAfterUsdc.toString(),
        observedDeltaAtomic: (sellerAfterUsdc - sellerBefore.usdc).toString(),
        expectedDeltaObserved: sellerAfterUsdc - sellerBefore.usdc >= EXPECTED_AMOUNT,
      },
    }),
  );
}

main().catch(error => {
  const message = error instanceof Error ? error.message : "Unknown buyer test error";
  console.error(`Buyer test failed: ${message}`);
  process.exitCode = 1;
});
