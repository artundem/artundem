import {
  isAmbiguousTelegramTransfer,
  parseTelegramTransfer,
  type TransferKind,
} from "./telegram-transfer.ts";
import {
  isVisibleTelegramTransferValue,
  shouldStoreTelegramMessage,
} from "./telegram-sources.ts";

export type CounterpartyRole =
  | "trade"
  | "funding"
  | "exchange"
  | "bridge"
  | "known"
  | "unknown";

export type WalletDirectoryProfile = {
  personName: string;
  label?: string | null;
  note?: string | null;
  status?: string | null;
  latestTradeAt?: number | string | null;
};

type WalletDirectoryValue = string | WalletDirectoryProfile;

export type StoredTrackerEvent = {
  id: string;
  eventType?: "buy" | "sell" | "transfer";
  transferKind: TransferKind;
  serviceName: string | null;
  direction: "in" | "out" | "unknown";
  network: string;
  walletAddress: string;
  counterpartyAddress: string | null;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  amount: string;
  usdValue: string | null;
  txHash: string;
  occurredAt: string;
  sourceChatTitle: string | null;
  rawText: string | null;
  linkedUrlsJson: string;
  matchedPersonName: string | null;
};

export type PresentedTrackerEvent = {
  id: string;
  transferKind: TransferKind;
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

type NormalizedEvent = Omit<
  PresentedTrackerEvent,
  | "destinationNetwork"
  | "receivedAmount"
  | "receivedUsdValue"
  | "destinationTxHash"
  | "nextHopAddress"
  | "nextHopNetwork"
  | "nextHopPersonName"
  | "nextHopWalletLabel"
  | "nextHopRole"
  | "analysisEvidence"
  | "analysisNote"
>;

const UNKNOWN_USD_NATIVE_MINIMUMS = new Map([
  ["SOL", 0.15],
  ["ETH", 0.01],
  ["WETH", 0.01],
  ["BNB", 0.035],
  ["WBNB", 0.035],
]);
const STABLECOINS = new Set([
  "USDC",
  "USDT",
  "DAI",
  "USDE",
  "FDUSD",
  "USDS",
]);

function sameAddress(first: string | null, second: string | null) {
  if (!first || !second) return false;
  return first.toLocaleLowerCase("en-US") === second.toLocaleLowerCase("en-US");
}

function sameLabel(first: string | null, second: string | null) {
  if (!first || !second) return false;
  return (
    first.trim().toLocaleLowerCase("tr-TR") ===
    second.trim().toLocaleLowerCase("tr-TR")
  );
}

function cleanTelegramLabel(value: string | null) {
  if (!value) return null;
  const cleaned = value
    .replace(/\b0x[a-fA-F0-9]{40}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function walletProfile(
  address: string | null,
  directory: ReadonlyMap<string, WalletDirectoryValue>,
): WalletDirectoryProfile | null {
  if (!address) return null;
  const value = directory.get(address.toLocaleLowerCase("en-US"));
  if (!value) return null;
  if (typeof value === "string") {
    return { personName: value, label: value };
  }
  return value;
}

function profileRole(profile: WalletDirectoryProfile | null) {
  if (!profile) return "unknown" satisfies CounterpartyRole;
  const corpus = `${profile.label ?? ""} ${profile.note ?? ""}`
    .toLocaleLowerCase("tr-TR")
    .replace(/[ıİ]/g, "i");
  if (
    /\b(?:binance|bitmex|bybit|coinbase|okx|kraken|kucoin|mexc|gate|borsa|cex|exchange|hot wallet|deposit)\b/.test(
      corpus,
    )
  ) {
    return "exchange" satisfies CounterpartyRole;
  }
  if (/\b(?:relay|bridge|across|stargate|orbiter|debridge|bungee)\b/.test(corpus)) {
    return "bridge" satisfies CounterpartyRole;
  }
  if (
    profile.status === "active_trade" ||
    profile.latestTradeAt ||
    /(?:^|[_\s-])t\d*(?:$|[_\s-])/.test(corpus)
  ) {
    return "trade" satisfies CounterpartyRole;
  }
  if (
    /(?:^|[_\s-])f\d*(?:$|[_\s-])/.test(corpus) ||
    /\b(?:funding|fund|gecis|geçis|geçiş|toplama)\b/.test(corpus)
  ) {
    return "funding" satisfies CounterpartyRole;
  }
  return "known" satisfies CounterpartyRole;
}

function roleLabel(role: CounterpartyRole) {
  return {
    trade: "Trade cüzdanı",
    funding: "Funding / ara cüzdan",
    exchange: "Borsa / terminal",
    bridge: "Bridge servisi",
    known: "Kayıtlı cüzdan",
    unknown: "İncelenecek adres",
  }[role];
}

function latestTradeIso(profile: WalletDirectoryProfile | null) {
  if (!profile?.latestTradeAt) return null;
  if (typeof profile.latestTradeAt === "number") {
    return new Date(profile.latestTradeAt * 1000).toISOString();
  }
  const date = new Date(profile.latestTradeAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function invertDirection(direction: NormalizedEvent["direction"]) {
  if (direction === "in") return "out";
  if (direction === "out") return "in";
  return direction;
}

function parseLinkedUrls(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function linkedAccountAddresses(linkedUrls: string[]) {
  const addresses: string[] = [];
  for (const linkedUrl of linkedUrls) {
    try {
      const url = new URL(linkedUrl);
      const segments = url.pathname.split("/").filter(Boolean);
      const segmentIndex = segments.findIndex((segment) =>
        /^(?:address|account)$/i.test(segment),
      );
      const address = segmentIndex >= 0 ? segments[segmentIndex + 1] : null;
      if (
        address &&
        !addresses.some((item) => sameAddress(item, address))
      ) {
        addresses.push(address);
      }
    } catch {
      // Telegram may contain non-URL values.
    }
  }
  return addresses;
}

function singleTelegramLabel(rawText: string | null) {
  if (!rawText) return null;
  const header = rawText.split(/\n\s*\n/)[0] ?? "";
  const labels = header
    .split("\n")
    .map((line) => line.replace(/^[^\p{L}\p{N}]+/u, "").trim())
    .filter(
      (line) =>
        line &&
        !/^TRANSFER\b/i.test(line) &&
        !/^0x[a-fA-F0-9]{40}$/.test(line),
    );
  return labels.length === 1 ? labels[0] : null;
}

function telegramAddressLabels(
  rawText: string | null,
  linkedUrls: string[],
) {
  const labels = new Map<string, string>();
  if (!rawText) return labels;
  const headerLabels = (rawText.split(/\n\s*\n/)[0] ?? "")
    .split("\n")
    .map((line) => line.replace(/^[^\p{L}\p{N}]+/u, "").trim())
    .filter(
      (line) =>
        line &&
        !/^TRANSFER\b/i.test(line) &&
        !/^0x[a-fA-F0-9]{40}$/.test(line),
    );
  const headerAddresses = linkedUrls
    .map((linkedUrl) => {
      try {
        const url = new URL(linkedUrl);
        const segments = url.pathname.split("/").filter(Boolean);
        const segmentIndex = segments.findIndex((segment) =>
          /^(?:address|account)$/i.test(segment),
        );
        return segmentIndex >= 0 ? segments[segmentIndex + 1] ?? null : null;
      } catch {
        return null;
      }
    })
    .filter((address): address is string => Boolean(address))
    .slice(0, headerLabels.length);

  headerLabels.forEach((label, index) => {
    const address = headerAddresses[index];
    if (address) {
      labels.set(address.toLocaleLowerCase("en-US"), label);
    }
  });
  return labels;
}

function telegramSentenceLabels(rawText: string | null) {
  if (!rawText) return { sender: null, recipient: null };
  const sender =
    rawText.match(
      /(?:^|\n)\s*🔹\s*([^\n]+?)\s+(?:transferred|sent)\b/i,
    )?.[1]?.trim() ?? null;
  const recipient =
    rawText.match(/\bto\s+🔹\s*([^\n└]+)/i)?.[1]?.trim() ?? null;
  return { sender, recipient };
}

function shortAddress(value: string | null) {
  if (!value) return "bilinmeyen adres";
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatAmount(value: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value.toLocaleLowerCase("tr-TR");
  return new Intl.NumberFormat("tr-TR", {
    maximumFractionDigits: 8,
  }).format(amount);
}

function numeric(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameToken(first: NormalizedEvent, second: NormalizedEvent) {
  if (!first.tokenSymbol || !second.tokenSymbol) return true;
  return (
    first.tokenSymbol.toLocaleUpperCase("en-US") ===
    second.tokenSymbol.toLocaleUpperCase("en-US")
  );
}

function normalizeStoredEvent(
  event: StoredTrackerEvent,
  directory: ReadonlyMap<string, WalletDirectoryValue>,
): NormalizedEvent | null {
  if (event.eventType && event.eventType !== "transfer") return null;
  const linkedUrls = parseLinkedUrls(event.linkedUrlsJson);
  if (event.rawText && isAmbiguousTelegramTransfer(event.rawText)) {
    return null;
  }
  const telegramLabels = telegramAddressLabels(event.rawText, linkedUrls);
  const sentenceLabels = telegramSentenceLabels(event.rawText);
  const parsed = event.rawText
    ? parseTelegramTransfer(event.rawText, linkedUrls)
    : null;
  if (
    !shouldStoreTelegramMessage(event.sourceChatTitle ?? "", event.rawText)
  ) {
    return null;
  }
  if (
    !isVisibleTelegramTransferValue(
      event.sourceChatTitle,
      parsed?.usdValue ?? event.usdValue,
    )
  ) {
    return null;
  }

  if (
    !parsed &&
    event.walletAddress.toLocaleLowerCase("en-US").endsWith("pump")
  ) {
    return null;
  }

  let walletAddress = parsed?.walletAddress ?? event.walletAddress;
  let counterpartyAddress =
    parsed?.counterpartyAddress ?? event.counterpartyAddress;
  let direction = parsed?.direction ?? event.direction;
  let trackedProfile = walletProfile(walletAddress, directory);
  let counterpartyProfile = walletProfile(counterpartyAddress, directory);

  if (!trackedProfile && counterpartyProfile && counterpartyAddress) {
    [walletAddress, counterpartyAddress] = [
      counterpartyAddress,
      walletAddress,
    ];
    direction = invertDirection(direction);
    [trackedProfile, counterpartyProfile] = [
      counterpartyProfile,
      trackedProfile,
    ];
  } else if (!trackedProfile) {
    const knownAccount = linkedAccountAddresses(linkedUrls).find((address) =>
      walletProfile(address, directory),
    );
    if (knownAccount) {
      const previousWallet = walletAddress;
      if (sameAddress(knownAccount, counterpartyAddress)) {
        counterpartyAddress = previousWallet;
        direction = invertDirection(direction);
      } else if (!sameAddress(knownAccount, previousWallet)) {
        counterpartyAddress = previousWallet;
      }
      walletAddress = knownAccount;
      trackedProfile = walletProfile(walletAddress, directory);
      counterpartyProfile = walletProfile(counterpartyAddress, directory);
    }
  }

  const matchedPersonName =
    trackedProfile?.personName ??
    event.matchedPersonName ??
    telegramLabels.get(walletAddress.toLocaleLowerCase("en-US")) ??
    (direction === "out"
      ? sentenceLabels.sender
      : direction === "in"
        ? sentenceLabels.recipient
        : null) ??
    singleTelegramLabel(event.rawText);
  const sentenceCounterparty =
    direction === "out"
      ? sentenceLabels.recipient
      : direction === "in"
        ? sentenceLabels.sender
        : null;
  const inferredCounterpartyName = counterpartyAddress
    ? counterpartyProfile?.personName ??
      cleanTelegramLabel(
        telegramLabels.get(
          counterpartyAddress.toLocaleLowerCase("en-US"),
        ) ?? null,
      ) ??
      cleanTelegramLabel(sentenceCounterparty)
    : null;
  const counterpartyPersonName =
    inferredCounterpartyName &&
    (!sameLabel(inferredCounterpartyName, matchedPersonName) ||
      Boolean(counterpartyProfile))
      ? inferredCounterpartyName
      : null;
  const counterpartyRole = profileRole(counterpartyProfile);

  return {
    id: event.id,
    transferKind: parsed?.transferKind ?? event.transferKind,
    serviceName: parsed?.serviceName ?? event.serviceName,
    direction,
    network:
      parsed?.network && parsed.network !== "UNKNOWN"
        ? parsed.network
        : event.network,
    walletAddress,
    counterpartyAddress,
    counterpartyPersonName,
    tokenSymbol: parsed?.tokenSymbol ?? event.tokenSymbol,
    tokenAddress: parsed?.tokenAddress ?? event.tokenAddress,
    amount:
      parsed?.amount && parsed.amount !== "Bilinmiyor"
        ? parsed.amount
        : event.amount,
    usdValue: parsed?.usdValue ?? event.usdValue,
    txHash: parsed?.txHash ?? event.txHash,
    occurredAt: event.occurredAt,
    sourceChatTitle: event.sourceChatTitle,
    matchedPersonName,
    matchedWalletLabel:
      trackedProfile?.label ??
      telegramLabels.get(walletAddress.toLocaleLowerCase("en-US")) ??
      matchedPersonName,
    counterpartyWalletLabel:
      counterpartyProfile?.label ?? counterpartyPersonName,
    counterpartyRole,
    counterpartyRoleLabel: roleLabel(counterpartyRole),
    counterpartyLatestTradeAt: latestTradeIso(counterpartyProfile),
  };
}

type NextHop = {
  address: string;
  network: string;
  personName: string | null;
  walletLabel: string | null;
  role: CounterpartyRole;
};

function visibleUsdValue(event: NormalizedEvent) {
  const explicit = numeric(event.usdValue);
  if (explicit !== null) return explicit;
  const amount = numeric(event.amount);
  const token = event.tokenSymbol?.toLocaleUpperCase("en-US");
  if (amount !== null && token && STABLECOINS.has(token)) return amount;
  return null;
}

function isActionableTransfer(event: NormalizedEvent) {
  if (
    event.amount === "Bilinmiyor" ||
    !event.tokenSymbol ||
    event.direction === "unknown" ||
    (!event.counterpartyAddress && event.transferKind !== "bridge")
  ) {
    return false;
  }
  const amount = numeric(event.amount);
  if (amount === null || amount <= 0) return false;

  const usdValue = visibleUsdValue(event);
  if (usdValue !== null) {
    return isVisibleTelegramTransferValue(
      event.sourceChatTitle,
      String(usdValue),
    );
  }

  const token = event.tokenSymbol.toLocaleUpperCase("en-US");
  const nativeMinimum = UNKNOWN_USD_NATIVE_MINIMUMS.get(token);
  if (nativeMinimum !== undefined) {
    return amount >= nativeMinimum;
  }

  return event.counterpartyRole !== "unknown";
}

function formatTradeDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Europe/Berlin",
  }).format(date);
}

function counterpartyAssessment(
  event: NormalizedEvent,
  nextHop: NextHop | null,
) {
  const subject = event.direction === "in" ? "Kaynak" : "Hedef";
  const samePerson =
    event.matchedPersonName &&
    event.counterpartyPersonName &&
    sameLabel(event.matchedPersonName, event.counterpartyPersonName);
  let assessment = "";

  if (samePerson) {
    assessment =
      "İki adres aynı kişi altında kayıtlı; bu bir cüzdanlar arası iç transfer.";
  } else if (event.counterpartyRole === "trade") {
    const tradeDate = formatTradeDate(event.counterpartyLatestTradeAt);
    assessment = `${subject} Wallet Database’de trade cüzdanı olarak kayıtlı.${
      tradeDate ? ` Son trade: ${tradeDate}.` : ""
    }`;
  } else if (event.counterpartyRole === "exchange") {
    assessment = `${subject} borsa/servis terminali olarak kayıtlı; takip bu noktada bırakılır.`;
  } else if (event.counterpartyRole === "bridge") {
    assessment = `${subject} bridge servisi olarak kayıtlı; kullanıcı side wallet’ı sayılmaz.`;
  } else if (event.counterpartyRole === "funding") {
    assessment = `${subject} funding/ara cüzdan olarak kayıtlı; sonraki çıkışı takip etmek gerekir.`;
  } else if (event.counterpartyRole === "known") {
    assessment = `${subject} Wallet Database’de kayıtlı; trade veya funding rolü henüz kesin değil.`;
  } else {
    assessment = `${subject} takipte kayıtlı değil; side wallet veya borsa olduğu henüz doğrulanmadı.`;
  }

  if (!nextHop) return assessment;
  const nextHopName =
    nextHop.walletLabel ?? nextHop.personName ?? shortAddress(nextHop.address);
  if (nextHop.role === "trade") {
    return `${assessment} Bu adresten daha sonra ${nextHopName} trade cüzdanına para çıkışı görüldü.`;
  }
  if (nextHop.role === "exchange") {
    return `${assessment} Bu adresten daha sonra ${nextHopName} borsa/terminal adresine para gitti; takip burada bırakılır.`;
  }
  return `${assessment} Bu adresten daha sonra ${nextHopName} adresine başka bir çıkış görüldü.`;
}

function regularTransferNote(
  event: NormalizedEvent,
  nextHop: NextHop | null,
  fundedByTradeWallet: boolean,
) {
  const tracked =
    event.matchedWalletLabel ??
    event.matchedPersonName ??
    shortAddress(event.walletAddress);
  const counterparty =
    event.counterpartyWalletLabel ??
    event.counterpartyPersonName ??
    shortAddress(event.counterpartyAddress);
  const value =
    event.amount === "Bilinmiyor"
      ? "miktarı çözülemeyen varlık"
      : `${formatAmount(event.amount)} ${event.tokenSymbol ?? "varlık"}`;
  const route =
    event.direction === "in"
      ? `${counterparty} adresinden ${tracked} cüzdanına ${value} geldi.`
      : event.direction === "out"
        ? `${tracked}, ${counterparty} adresine ${value} gönderdi.`
        : `${tracked} için ${value} transferi görüldü; yön kesinleştirilemedi.`;
  const mintNote = event.tokenAddress
    ?.toLocaleLowerCase("en-US")
    .endsWith("pump")
    ? ` ${shortAddress(event.tokenAddress)} taşınan coinin mint adresidir; cüzdan değildir.`
    : "";
  const fundingNote = fundedByTradeWallet
    ? " Bu adrese, Telegram kayıtlarında trade yaptığı görülen başka bir cüzdandan da para geldi."
    : "";
  return `${route}${mintNote} ${counterpartyAssessment(event, nextHop)}${fundingNote}`;
}

function unpairedBridgeNote(event: NormalizedEvent) {
  const service = event.serviceName ?? "Bridge servisi";
  const value =
    event.amount === "Bilinmiyor"
      ? "miktarı çözülemeyen varlık"
      : `${formatAmount(event.amount)} ${event.tokenSymbol ?? "varlık"}`;
  if (event.direction === "in") {
    return `${service} üzerinden ${event.network} ağına ${value} bridge girişi görüldü. Kaynak ağ çıkışı henüz eşleşmedi.`;
  }
  if (event.direction === "out") {
    return `${service} ile ${event.network} ağından ${value} bridge çıkışı görüldü. Hedef ağ girişi henüz eşleşmedi.`;
  }
  return `${service} bağlantılı bir bridge hareketi görüldü; yön henüz kesinleştirilemedi.`;
}

function pairedBridgeNote(
  outgoing: NormalizedEvent,
  incoming: NormalizedEvent,
) {
  const service = outgoing.serviceName ?? incoming.serviceName ?? "Bridge";
  const token = outgoing.tokenSymbol ?? incoming.tokenSymbol ?? "varlık";
  const sent = numeric(outgoing.amount);
  const received = numeric(incoming.amount);
  const sentLabel =
    sent === null ? outgoing.amount : formatAmount(outgoing.amount);
  const receivedLabel =
    received === null ? incoming.amount : formatAmount(incoming.amount);
  let difference = "";
  if (sent !== null && received !== null && sent > 0 && sent >= received) {
    const absolute = sent - received;
    const percentage = (absolute / sent) * 100;
    difference = ` Fark ${formatAmount(String(absolute))} ${token} (%${new Intl.NumberFormat(
      "tr-TR",
      { maximumFractionDigits: 2 },
    ).format(percentage)}); köprü ücreti veya fiyat farkı olabilir.`;
  }
  return `${service} ile ${outgoing.network} → ${incoming.network} bridge. ${sentLabel} ${token} çıktı, ${receivedLabel} ${token} aynı cüzdana ulaştı.${difference}`;
}

function canPair(first: NormalizedEvent, second: NormalizedEvent) {
  if (
    (first.transferKind !== "bridge" &&
      second.transferKind !== "bridge") ||
    first.direction === second.direction ||
    first.direction === "unknown" ||
    second.direction === "unknown" ||
    !sameAddress(first.walletAddress, second.walletAddress) ||
    first.network === second.network ||
    !sameToken(first, second)
  ) {
    return false;
  }
  const firstService = first.serviceName?.toLocaleLowerCase("en-US") ?? "";
  const secondService = second.serviceName?.toLocaleLowerCase("en-US") ?? "";
  if (firstService && secondService && firstService !== secondService) {
    return false;
  }
  const timeDifference = Math.abs(
    new Date(first.occurredAt).getTime() -
      new Date(second.occurredAt).getTime(),
  );
  return Number.isFinite(timeDifference) && timeDifference <= 5 * 60 * 1000;
}

function findNextHop(
  event: NormalizedEvent,
  events: NormalizedEvent[],
): NextHop | null {
  if (
    event.direction !== "out" ||
    !event.counterpartyAddress ||
    event.counterpartyRole === "exchange" ||
    event.counterpartyRole === "bridge"
  ) {
    return null;
  }
  const occurredAt = new Date(event.occurredAt).getTime();
  const latestAllowed = occurredAt + 30 * 24 * 60 * 60 * 1000;
  const candidate = events
    .filter((item) => {
      const candidateTime = new Date(item.occurredAt).getTime();
      return (
        item.id !== event.id &&
        item.direction === "out" &&
        Boolean(item.counterpartyAddress) &&
        sameAddress(item.walletAddress, event.counterpartyAddress) &&
        Number.isFinite(candidateTime) &&
        candidateTime >= occurredAt &&
        candidateTime <= latestAllowed &&
        isActionableTransfer(item)
      );
    })
    .sort(
      (first, second) =>
        new Date(first.occurredAt).getTime() -
        new Date(second.occurredAt).getTime(),
    )[0];
  if (!candidate?.counterpartyAddress) return null;
  return {
    address: candidate.counterpartyAddress,
    network: candidate.network,
    personName: candidate.counterpartyPersonName,
    walletLabel: candidate.counterpartyWalletLabel,
    role: candidate.counterpartyRole,
  };
}

function singlePresentedEvent(
  event: NormalizedEvent,
  nextHop: NextHop | null,
  analysisEvidence: PresentedTrackerEvent["analysisEvidence"],
  fundedByTradeWallet: boolean,
): PresentedTrackerEvent {
  return {
    ...event,
    destinationNetwork: null,
    receivedAmount: null,
    receivedUsdValue: null,
    destinationTxHash: null,
    nextHopAddress: nextHop?.address ?? null,
    nextHopNetwork: nextHop?.network ?? null,
    nextHopPersonName: nextHop?.personName ?? null,
    nextHopWalletLabel: nextHop?.walletLabel ?? null,
    nextHopRole: nextHop?.role ?? null,
    analysisEvidence,
    analysisNote:
      event.transferKind === "bridge"
        ? unpairedBridgeNote(event)
        : regularTransferNote(event, nextHop, fundedByTradeWallet),
  };
}

export function presentTrackerEvents(
  storedEvents: StoredTrackerEvent[],
  directory: ReadonlyMap<string, WalletDirectoryValue>,
) {
  const observedTrades = new Map<string, string>();
  for (const event of storedEvents) {
    if (event.eventType !== "buy" && event.eventType !== "sell") continue;
    const key = event.walletAddress.toLocaleLowerCase("en-US");
    const previous = observedTrades.get(key);
    if (!previous || new Date(event.occurredAt) > new Date(previous)) {
      observedTrades.set(key, event.occurredAt);
    }
  }
  const normalized = storedEvents
    .map((event) => normalizeStoredEvent(event, directory))
    .filter((event): event is NormalizedEvent => Boolean(event));
  for (const event of normalized) {
    const counterpartyKey =
      event.counterpartyAddress?.toLocaleLowerCase("en-US") ?? "";
    const observedTradeAt = observedTrades.get(counterpartyKey);
    if (
      observedTradeAt &&
      (event.counterpartyRole === "unknown" ||
        event.counterpartyRole === "known")
    ) {
      event.counterpartyRole = "trade";
      event.counterpartyRoleLabel = roleLabel("trade");
      event.counterpartyLatestTradeAt = observedTradeAt;
    }
  }
  const used = new Set<string>();
  const presented: PresentedTrackerEvent[] = [];

  for (const event of normalized) {
    if (used.has(event.id)) continue;
    const pair = normalized.find(
      (candidate) =>
        !used.has(candidate.id) &&
        candidate.id !== event.id &&
        canPair(event, candidate),
    );
    if (!pair) {
      const candidateKey =
        event.counterpartyAddress?.toLocaleLowerCase("en-US") ?? "";
      const tradeEvent = storedEvents
        .filter(
          (item) =>
            (item.eventType === "buy" || item.eventType === "sell") &&
            item.walletAddress.toLocaleLowerCase("en-US") === candidateKey,
        )
        .sort(
          (first, second) =>
            new Date(second.occurredAt).getTime() -
            new Date(first.occurredAt).getTime(),
        )[0];
      const fundingEvent = normalized.find(
        (item) =>
          item.id !== event.id &&
          item.direction === "out" &&
          item.counterpartyAddress?.toLocaleLowerCase("en-US") ===
            candidateKey &&
          observedTrades.has(
            item.walletAddress.toLocaleLowerCase("en-US"),
          ),
      );
      const analysisEvidence = [
        ...(tradeEvent
          ? [
              {
                label: `${tradeEvent.eventType === "buy" ? "BUY" : "SELL"} kanıtı`,
                network: tradeEvent.network,
                txHash: tradeEvent.txHash,
              },
            ]
          : []),
        ...(fundingEvent
          ? [
              {
                label: "Trade cüzdanından gelen fon",
                network: fundingEvent.network,
                txHash: fundingEvent.txHash,
              },
            ]
          : []),
      ];
      used.add(event.id);
      presented.push(
        singlePresentedEvent(
          event,
          findNextHop(event, normalized),
          analysisEvidence,
          Boolean(fundingEvent),
        ),
      );
      continue;
    }

    const outgoing = event.direction === "out" ? event : pair;
    const incoming = event.direction === "in" ? event : pair;
    used.add(outgoing.id);
    used.add(incoming.id);
    presented.push({
      ...outgoing,
      id: `${outgoing.id}:${incoming.id}`,
      transferKind: "bridge",
      serviceName:
        outgoing.serviceName ?? incoming.serviceName ?? "Bridge",
      destinationNetwork: incoming.network,
      receivedAmount: incoming.amount,
      receivedUsdValue: incoming.usdValue,
      destinationTxHash: incoming.txHash,
      counterpartyPersonName: null,
      counterpartyWalletLabel:
        outgoing.serviceName ?? incoming.serviceName ?? "Bridge",
      counterpartyRole: "bridge",
      counterpartyRoleLabel: roleLabel("bridge"),
      counterpartyLatestTradeAt: null,
      nextHopAddress: null,
      nextHopNetwork: null,
      nextHopPersonName: null,
      nextHopWalletLabel: null,
      nextHopRole: null,
      analysisEvidence: [],
      occurredAt:
        new Date(outgoing.occurredAt) <= new Date(incoming.occurredAt)
          ? outgoing.occurredAt
          : incoming.occurredAt,
      analysisNote: pairedBridgeNote(outgoing, incoming),
    });
  }

  return presented
    .filter((event) => {
      if (event.transferKind === "bridge") {
        const usd = numeric(event.usdValue);
        const amount = numeric(event.amount);
        return (
          amount !== null &&
          amount > 0 &&
          (usd === null ||
            isVisibleTelegramTransferValue(event.sourceChatTitle, String(usd)))
        );
      }
      return isActionableTransfer(event);
    })
    .sort(
      (first, second) =>
        new Date(second.occurredAt).getTime() -
        new Date(first.occurredAt).getTime(),
    );
}
