"use client";

import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  ExternalLink,
  LoaderCircle,
  Radio,
  RefreshCw,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { type ReactNode, useState } from "react";

type TrackerView = "summary" | "transfers";
type TransferChain = "all" | "evm" | "solana";
type CounterpartyRole =
  | "trade"
  | "funding"
  | "exchange"
  | "bridge"
  | "known"
  | "unknown";

type TelegramSummaryResponse = {
  jobId: string;
  status: "pending" | "processing" | "completed" | "failed";
  command: string;
  responses: {
    chatId: string;
    title: string;
    text: string;
    receivedAt: string;
  }[];
  requestedAt: string;
  completedAt: string | null;
  error: string | null;
};

type TrackerEvent = {
  id: string;
  transferKind: "wallet" | "bridge";
  serviceName: string | null;
  direction: "in" | "out" | "unknown";
  network: string;
  destinationNetwork: string | null;
  walletAddress: string;
  counterpartyAddress: string | null;
  counterpartyPersonName: string | null;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  amount: string;
  receivedAmount: string | null;
  usdValue: string | null;
  receivedUsdValue: string | null;
  txHash: string;
  destinationTxHash: string | null;
  occurredAt: string;
  sourceChatTitle: string | null;
  matchedPersonName: string | null;
  matchedWalletLabel: string | null;
  counterpartyWalletLabel: string | null;
  counterpartyRole: CounterpartyRole;
  counterpartyRoleLabel: string;
  counterpartyLatestTradeAt: string | null;
  nextHopAddress: string | null;
  nextHopNetwork: string | null;
  nextHopPersonName: string | null;
  nextHopWalletLabel: string | null;
  nextHopRole: CounterpartyRole | null;
  analysisEvidence: {
    label: string;
    network: string;
    txHash: string;
  }[];
  analysisNote: string;
};

type TrackerSource = {
  id: string;
  name: string;
  connectionStatus:
    | "not_configured"
    | "disconnected"
    | "connected"
    | "error";
  lastMessageAt: string | null;
};

type TrackerPayload = {
  events: TrackerEvent[];
  sources: TrackerSource[];
  counts: {
    recent: number;
    transfers: number;
    incoming: number;
    outgoing: number;
    known: number;
    unmatched: number;
    bridges: number;
    walletTransfers: number;
  };
  connectionStatus: "not_configured" | "disconnected" | "connected";
};

const emptyPayload: TrackerPayload = {
  events: [],
  sources: [],
  counts: {
    recent: 0,
    transfers: 0,
    incoming: 0,
    outgoing: 0,
    known: 0,
    unmatched: 0,
    bridges: 0,
    walletTransfers: 0,
  },
  connectionStatus: "not_configured",
};

function shortAddress(value: string | null) {
  if (!value) return "Karşı taraf bulunamadı";
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatTime(value: string | null) {
  if (!value) return "Henüz mesaj yok";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  }).format(date);
}

function formatUsd(value: string | null) {
  if (!value) return "USD bilinmiyor";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

function transferChain(event: TrackerEvent): Exclude<TransferChain, "all"> {
  return event.walletAddress.startsWith("0x") ? "evm" : "solana";
}

function explorerAddressUrl(network: string, address: string) {
  if (!address) return null;
  if (!address.startsWith("0x")) {
    return `https://solscan.io/account/${encodeURIComponent(address)}`;
  }

  const normalizedNetwork = network.toLowerCase();
  const explorer = normalizedNetwork.includes("robinhood")
    ? "https://robinhoodchain.blockscout.com/address/"
    : normalizedNetwork.includes("base")
      ? "https://basescan.org/address/"
      : normalizedNetwork.includes("bnb") ||
          normalizedNetwork.includes("bsc")
        ? "https://bscscan.com/address/"
        : "https://etherscan.io/address/";
  return `${explorer}${encodeURIComponent(address)}`;
}

function explorerTransactionUrl(network: string, txHash: string) {
  if (!txHash || txHash.startsWith("telegram:")) return null;
  if (!txHash.startsWith("0x")) {
    return `https://solscan.io/tx/${encodeURIComponent(txHash)}`;
  }

  const normalizedNetwork = network.toLowerCase();
  const explorer = normalizedNetwork.includes("robinhood")
    ? "https://robinhoodchain.blockscout.com/tx/"
    : normalizedNetwork.includes("base")
      ? "https://basescan.org/tx/"
      : normalizedNetwork.includes("bnb") ||
          normalizedNetwork.includes("bsc")
        ? "https://bscscan.com/tx/"
        : "https://etherscan.io/tx/";
  return `${explorer}${encodeURIComponent(txHash)}`;
}

function gmgnAddressUrl(network: string, address: string) {
  const normalizedNetwork = network.toLowerCase();
  const chain = !address.startsWith("0x")
    ? "sol"
    : normalizedNetwork.includes("robinhood")
      ? "robinhood"
      : normalizedNetwork.includes("base")
        ? "base"
        : normalizedNetwork.includes("bnb") ||
            normalizedNetwork.includes("bsc")
          ? "bsc"
          : normalizedNetwork.includes("arbitrum") ||
              normalizedNetwork.includes("arb")
            ? "arb"
            : "eth";
  return `https://gmgn.ai/${chain}/address/${encodeURIComponent(address)}`;
}

function AddressActions({
  address,
  network,
  fallback,
}: {
  address: string | null;
  network: string;
  fallback: string;
}) {
  if (!address) return <code>{fallback}</code>;
  const scanHref = explorerAddressUrl(network, address);
  const gmgnHref = gmgnAddressUrl(network, address);
  return (
    <div className="transfer-address-block">
      <code title={address}>{shortAddress(address)}</code>
      <span className="transfer-address-actions">
        <a
          href={scanHref ?? undefined}
          target="_blank"
          rel="noreferrer"
          title={`${address} adresini explorer'da aç`}
        >
          Scan
          <ExternalLink size={9} aria-hidden="true" />
        </a>
        <a
          href={gmgnHref}
          target="_blank"
          rel="noreferrer"
          title={`${address} adresini GMGN'de aç`}
        >
          GMGN
          <ExternalLink size={9} aria-hidden="true" />
        </a>
      </span>
    </div>
  );
}

function TransferRow({ event }: { event: TrackerEvent }) {
  const outgoing = event.direction === "out";
  const incoming = event.direction === "in";
  const bridge = event.transferKind === "bridge";
  const DirectionIcon = bridge ? ArrowRightLeft : ArrowRight;
  const trackedName =
    event.matchedWalletLabel ??
    event.matchedPersonName ??
    shortAddress(event.walletAddress);
  const counterpartyName =
    event.counterpartyWalletLabel ??
    event.counterpartyPersonName ??
    (bridge && event.serviceName
      ? event.serviceName
      : shortAddress(event.counterpartyAddress));
  const transactionUrl = explorerTransactionUrl(
    event.network,
    event.txHash,
  );
  const destinationTransactionUrl =
    event.destinationNetwork && event.destinationTxHash
      ? explorerTransactionUrl(
          event.destinationNetwork,
          event.destinationTxHash,
        )
      : null;

  return (
    <article
      className={`transfer-record ${
        bridge ? "transfer-record-bridge" : ""
      }`}
    >
      <span
        className={`transfer-direction ${
          bridge
            ? "transfer-direction-bridge"
            : outgoing
              ? "transfer-direction-out"
              : incoming
                ? "transfer-direction-in"
                : ""
        }`}
      >
        <DirectionIcon size={17} />
      </span>
      <div className="transfer-route">
        <div>
          <strong>{trackedName}</strong>
          <AddressActions
            address={event.walletAddress}
            network={event.network}
            fallback="Adres bulunamadı"
          />
        </div>
        <span>
          {bridge && event.destinationNetwork
            ? `${event.network} → ${event.destinationNetwork}`
            : bridge
              ? incoming
                ? `${event.network} ağına bridge`
                : `${event.network} ağından bridge`
              : outgoing
                ? "gönderdi"
                : incoming
                  ? "aldı"
                  : "transfer"}
          {bridge ? <ArrowRightLeft size={13} /> : <ArrowRight size={13} />}
        </span>
        <div>
          <strong>{counterpartyName}</strong>
          <small
            className={`counterparty-role counterparty-role-${event.counterpartyRole}`}
          >
            {bridge ? "Bridge servisi" : event.counterpartyRoleLabel}
          </small>
          <AddressActions
            address={event.counterpartyAddress}
            network={event.network}
            fallback={bridge ? "Bridge servisi" : "Mesajda adres yok"}
          />
        </div>
      </div>
      <div className="transfer-amount">
        <strong>
          {bridge && event.receivedAmount
            ? `${event.amount} → ${event.receivedAmount}`
            : event.amount}{" "}
          {event.tokenSymbol ?? ""}
        </strong>
        <span>
          {bridge && event.receivedUsdValue
            ? `${formatUsd(event.usdValue)} → ${formatUsd(
                event.receivedUsdValue,
              )}`
            : formatUsd(event.usdValue)}
        </span>
      </div>
      <div className="transfer-meta">
        <strong>
          {bridge
            ? `BRIDGE · ${event.serviceName ?? "SERVİS"}`
            : event.network}
        </strong>
        <span>{event.sourceChatTitle ?? "Telegram"}</span>
        <small>{formatTime(event.occurredAt)}</small>
      </div>
      <div className="transfer-analysis-note">
        <Sparkles size={15} aria-hidden="true" />
        <div>
          <div className="transfer-analysis-heading">
            <strong>Otomatik analiz</strong>
            <span
              className={`counterparty-role counterparty-role-${event.counterpartyRole}`}
            >
              {event.counterpartyRoleLabel}
            </span>
          </div>
          <p>{event.analysisNote}</p>
          {event.nextHopAddress && (
            <div className="transfer-next-hop">
              <span>Sonraki çıkış</span>
              <strong>
                {event.nextHopWalletLabel ??
                  event.nextHopPersonName ??
                  shortAddress(event.nextHopAddress)}
              </strong>
              <AddressActions
                address={event.nextHopAddress}
                network={event.nextHopNetwork ?? event.network}
                fallback="Adres bulunamadı"
              />
            </div>
          )}
          {event.analysisEvidence.length > 0 && (
            <div className="transfer-evidence-links">
              {event.analysisEvidence.map((evidence) => {
                const href = explorerTransactionUrl(
                  evidence.network,
                  evidence.txHash,
                );
                return href ? (
                  <a
                    key={`${evidence.label}:${evidence.txHash}`}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {evidence.label}
                    <ExternalLink size={10} aria-hidden="true" />
                  </a>
                ) : null;
              })}
            </div>
          )}
        </div>
        <span className="transfer-transaction-links">
          {transactionUrl && (
            <a href={transactionUrl} target="_blank" rel="noreferrer">
              {bridge ? "Çıkış işlemi" : "İşlemi aç"}
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
          {destinationTransactionUrl && (
            <a
              href={destinationTransactionUrl}
              target="_blank"
              rel="noreferrer"
            >
              Giriş işlemi
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </span>
      </div>
    </article>
  );
}

export function TelegramTracker({
  workspaceNav,
}: {
  workspaceNav: ReactNode;
}) {
  const [payload, setPayload] = useState<TrackerPayload>(emptyPayload);
  const [activeView, setActiveView] = useState<TrackerView>("summary");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<TelegramSummaryResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState("");
  const [transferChainFilter, setTransferChainFilter] =
    useState<TransferChain>("all");

  async function loadTransfers() {
    setActiveView("transfers");
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/tracker", { cache: "no-store" });
      const data = (await response.json()) as TrackerPayload & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error || "Transfer kayıtları alınamadı.");
      }
      setPayload(data);
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Transfer kayıtları alınamadı.",
      );
    } finally {
      setLoading(false);
    }
  }

  const connectionLabel =
    payload.connectionStatus === "connected"
      ? "Telegram bağlı"
      : payload.connectionStatus === "disconnected"
        ? "Bağlantı kesik"
        : "İlk mesaj bekleniyor";
  const filteredEvents = payload.events.filter(
    (event) =>
      transferChainFilter === "all" ||
      transferChain(event) === transferChainFilter,
  );
  const evmTransferCount = payload.events.filter(
    (event) => transferChain(event) === "evm",
  ).length;
  const solanaTransferCount = payload.events.length - evmTransferCount;

  async function refreshSummary() {
    setActiveView("summary");
    setSummaryLoading(true);
    setSummaryError("");
    try {
      const response = await fetch("/api/telegram/summary", {
        method: "POST",
      });
      let result = (await response.json()) as TelegramSummaryResponse & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error || "Telegram özeti alınamadı.");
      }
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResponse = await fetch(
          `/api/telegram/summary?id=${encodeURIComponent(result.jobId)}`,
          { cache: "no-store" },
        );
        result = (await statusResponse.json()) as TelegramSummaryResponse & {
          error?: string;
        };
        if (!statusResponse.ok) {
          throw new Error(result.error || "Özet durumu alınamadı.");
        }
        if (result.status === "completed") {
          setSummary(result);
          return;
        }
        if (result.status === "failed") {
          throw new Error(result.error || "Telegram özeti alınamadı.");
        }
      }
      throw new Error(
        "Telegram yardımcısı zamanında yanıt vermedi. Mac’in açık olduğundan emin ol.",
      );
    } catch (summaryLoadError: unknown) {
      setSummaryError(
        summaryLoadError instanceof Error
          ? summaryLoadError.message
          : "Telegram özeti alınamadı.",
      );
    } finally {
      setSummaryLoading(false);
    }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#tracker" aria-label="Telegram Tracker'a git">
          <span className="brand-mark">
            <WalletCards size={19} />
          </span>
          <span>
            <strong>Wallet Atlas</strong>
            <small>Transfer Intelligence</small>
          </span>
        </a>
        {workspaceNav}
        <span
          className={`tracker-connection-pill ${
            payload.connectionStatus === "connected"
              ? "tracker-connection-live"
              : ""
          }`}
        >
          <Radio size={14} />
          {connectionLabel}
        </span>
      </header>

      <section className="tracker-section" id="tracker">
        <nav className="tracker-primary-tabs" aria-label="Transfer görünümleri">
          <button
            className={activeView === "summary" ? "tracker-view-active" : ""}
            type="button"
            onClick={refreshSummary}
          >
            /summary
            <span>Gruplara /summary@ray_blue_bot gönder</span>
          </button>
          <button
            className={activeView === "transfers" ? "tracker-view-active" : ""}
            type="button"
            onClick={loadTransfers}
          >
            /transfers
            <span>Transfer akışı</span>
          </button>
        </nav>

        {error && (
          <div className="system-message system-message-error">
            <AlertTriangle size={15} />
            <span>{error}</span>
          </div>
        )}

        {activeView === "summary" ? (
          <section className="tracker-feed telegram-summary-panel">
            <header className="tracker-panel-heading">
              <div>
                <strong>Canlı Telegram özeti</strong>
                <span>
                  Her yenilemede gruplara /summary@ray_blue_bot gönderilir
                </span>
              </div>
              <button
                type="button"
                disabled={summaryLoading}
                onClick={refreshSummary}
              >
                <RefreshCw
                  className={summaryLoading ? "spin" : ""}
                  size={14}
                />
                {summaryLoading ? "Gruplar kontrol ediliyor…" : "Özeti yenile"}
              </button>
            </header>
            <div className="tracker-feed-panel">
              {summaryError ? (
                <div className="system-message system-message-error">
                  <AlertTriangle size={15} />
                  <span>{summaryError}</span>
                </div>
              ) : summaryLoading ? (
                <div className="tracker-empty">
                  <LoaderCircle className="spin" size={22} />
                  <strong>İki gruba komut gönderildi</strong>
                  <p>Tracker yanıtları bekleniyor…</p>
                </div>
              ) : summary?.responses.length ? (
                <div className="telegram-summary-responses">
                  {summary.responses.map((response, index) => (
                    <article key={`${response.chatId}-${index}`}>
                      <header>
                        <strong>{response.title}</strong>
                        <span>{formatTime(response.receivedAt)}</span>
                      </header>
                      <pre>{response.text}</pre>
                    </article>
                  ))}
                </div>
              ) : summary ? (
                <div className="tracker-empty">
                  <Radio size={24} />
                  <strong>Komut tamamlandı, yanıt bulunamadı</strong>
                  <p>BNB CÜZDAN ve Robinhood kontrol edildi.</p>
                </div>
              ) : (
                <div className="tracker-empty">
                  <RefreshCw size={24} />
                  <strong>Güncel özeti almak için /summary’ye tıkla</strong>
                  <p>
                    Sistem gruplara /summary@ray_blue_bot gönderip gelen cevabı
                    burada gösterecek.
                  </p>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className="tracker-feed">
            <div
              className="transfer-network-filters"
              aria-label="Ağ filtresi"
            >
              {(
                [
                  ["all", "Tüm ağlar", payload.events.length],
                  ["evm", "EVM", evmTransferCount],
                  ["solana", "Solana", solanaTransferCount],
                ] as [TransferChain, string, number][]
              ).map(([value, label, count]) => (
                <button
                  className={
                    transferChainFilter === value
                      ? "transfer-network-filter-active"
                      : ""
                  }
                  key={value}
                  type="button"
                  onClick={() => setTransferChainFilter(value)}
                >
                  {label}
                  <span>{count}</span>
                </button>
              ))}
            </div>
            <div className="tracker-feed-panel">
              {loading ? (
                <div className="tracker-empty">
                  <LoaderCircle className="spin" size={22} />
                  <strong>Kayıtlar yükleniyor…</strong>
                </div>
              ) : filteredEvents.length > 0 ? (
                <div className="tracker-event-list">
                  {filteredEvents.map((event) => (
                    <TransferRow event={event} key={event.id} />
                  ))}
                </div>
              ) : (
                <div className="tracker-empty">
                  <ArrowRight size={24} />
                  <strong>
                    {payload.events.length > 0
                      ? "Bu ağda transfer bulunamadı"
                      : "İlk transfer bekleniyor"}
                  </strong>
                  <p>
                    BUY ve SELL mesajları atlanacak; yalnızca TRANSFER mesajları
                    burada görünecek.
                  </p>
                </div>
              )}
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
