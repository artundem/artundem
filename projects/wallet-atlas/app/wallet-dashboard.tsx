"use client";

import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDollarSign,
  Coins,
  Copy,
  ExternalLink,
  Hexagon,
  Info,
  LoaderCircle,
  NotebookPen,
  Pencil,
  Plus,
  Search,
  Trash2,
  WalletCards,
  X,
  Zap,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  inferWalletCategory,
  nextCanonicalWalletLabel,
  type WalletCategory,
} from "@/lib/wallet-naming";

type Status =
  | "active_trade"
  | "active_nontrade"
  | "inactive"
  | "out_of_scope";

type WalletRole = "trade" | "funding" | "bridge" | "cex" | "linked";
type SideWallet = {
  destination: string;
  sol: number;
  signature: string;
  timestamp: number | null;
  explorerUrl?: string;
  classification?: {
    type: string;
    label: string;
    verified: boolean;
    terminal: boolean;
    note: string;
  };
  candidate?: {
    address: string;
    label: string | null;
    solBalance: number;
    latestTradeAt: number | null;
    recentTradeCount: number;
    status: Status;
    inOriginalList: boolean;
  };
};

type Wallet = {
  address: string;
  label: string;
  group: string;
  chain: "solana" | "evm";
  category?: WalletCategory;
  status: Status;
  role?: WalletRole;
  solBalance?: number;
  nativeBalance?: number;
  nativeSymbol?: "SOL" | "ETH";
  lastActivityAt?: number | null;
  latestTradeAt?: number | null;
  recentTradeCount?: number;
  analysisNote?: string;
  explorerUrl?: string;
  sideWallets?: SideWallet[];
};

type EvmNetwork = {
  id: string;
  name: string;
  nativeSymbol: string;
  nativeBalance: number;
  usdValue: number;
  lastActivityAt: number | null;
  explorerUrl: string;
  status: "available" | "partial" | "unavailable";
  tokens: {
    symbol: string;
    name: string;
    balance: number;
    usdValue: number | null;
  }[];
};

type EvmPortfolio = {
  networks: EvmNetwork[];
  otherNetworks: EvmNetwork[];
  updatedAt: string;
};

type SolanaPortfolio = {
  solBalance: number;
  usdValue: number;
  lastActivityAt: number | null;
  updatedAt: string;
  tokens: {
    mint: string;
    balance: number;
    usdValue: number | null;
  }[];
};

type Group = {
  group: string;
  wallets: Wallet[];
  personalNote?: string;
  summary: {
    total: number;
    activeTrade: number;
    activeNontrade: number;
    sideLinks: number;
    sol: number;
  };
};

type ChainStep = {
  address: string;
  label: string;
};

export type WalletData = {
  generatedAt: string;
  counts: {
    total: number;
    solana: number;
    evm: number;
    groups: number;
    activeTrade: number;
    activeNontrade: number;
    nearTermInactive: number;
    totalSol: number;
  };
  methodology: {
    recentTransactionsInspectedPerWallet: number;
    directSolTransferMinimum: number;
    scopeNote: string;
  };
  groups: Group[];
  insights: {
    sideWalletChains: {
      sourceLabel: string;
      sourceAddress: string;
      confidence: "strong_heuristic" | "direct_verified";
      terminal: boolean;
      path: ChainStep[];
      alternatePath?: ChainStep[];
    }[];
    robinhoodArchive: {
      label: string;
      source: string;
      linked: string[];
      note: string;
    }[];
  };
};

type DirectoryOverlay = {
  people: {
    id: string;
    name: string;
    note: string;
    createdAt: string;
    nativeBalance?: number;
    nativeSymbol?: "SOL" | "ETH";
  }[];
  wallets: {
    id: string;
    personName: string;
    chain: "solana" | "evm";
    category: WalletCategory;
    label: string;
    address: string;
    note: string;
    createdAt: string;
  }[];
  deletions: {
    id: string;
    entityType: "person" | "wallet";
    entityKey: string;
    createdAt: string;
  }[];
};

type ConfirmTarget =
  | { kind: "person"; personName: string }
  | {
      kind: "wallet";
      personName: string;
      walletAddress: string;
      walletLabel: string;
    };

const emptyOverlay: DirectoryOverlay = {
  people: [],
  wallets: [],
  deletions: [],
};

const statusMeta: Record<
  Status,
  { label: string; className: string; icon: typeof Activity }
> = {
  active_trade: {
    label: "Trade aktif",
    className: "status-active",
    icon: Zap,
  },
  active_nontrade: {
    label: "Hareket var · trade yok",
    className: "status-observe",
    icon: Activity,
  },
  inactive: {
    label: "Yakın dönem sessiz",
    className: "status-muted",
    icon: CircleDollarSign,
  },
  out_of_scope: {
    label: "ETH / EVM",
    className: "status-muted",
    icon: Hexagon,
  },
};

const roleMeta: Record<WalletRole, { label: string; className: string }> = {
  trade: { label: "Trade cüzdanı", className: "role-trade" },
  funding: { label: "Funding", className: "role-funding" },
  bridge: { label: "Bridge ara cüzdanı", className: "role-bridge" },
  cex: { label: "Borsa terminali", className: "role-cex" },
  linked: { label: "Bağlı / pasif", className: "role-linked" },
};

function formatSol(value = 0) {
  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatDate(timestamp?: number | null) {
  if (!timestamp) return "Yakın dönem kaydı yok";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  }).format(new Date(timestamp * 1000));
}

function formatTradeDate(wallet: Wallet) {
  if (wallet.latestTradeAt) return formatDate(wallet.latestTradeAt);
  if (wallet.role === "cex") return "Borsa terminali · trade takip edilmedi";
  if (wallet.role === "bridge") return "Bridge cüzdanı · DEX trade değil";
  return "Trade tarihi bulunamadı";
}

function walletCategory(wallet: Wallet): WalletCategory {
  return inferWalletCategory(wallet);
}

function summarize(wallets: Wallet[]): Group["summary"] {
  return {
    total: wallets.length,
    activeTrade: wallets.filter((wallet) => wallet.status === "active_trade")
      .length,
    activeNontrade: wallets.filter(
      (wallet) => wallet.status === "active_nontrade",
    ).length,
    sideLinks: wallets.reduce(
      (sum, wallet) => sum + (wallet.sideWallets?.length ?? 0),
      0,
    ),
    sol: wallets.reduce((sum, wallet) => sum + (wallet.solBalance ?? 0), 0),
  };
}

function mergeDirectory(
  baselineGroups: Group[],
  overlay: DirectoryOverlay,
): Group[] {
  const deletedPeople = new Set(
    overlay.deletions
      .filter((item) => item.entityType === "person")
      .map((item) => item.entityKey),
  );
  const deletedWallets = new Set(
    overlay.deletions
      .filter((item) => item.entityType === "wallet")
      .map((item) => item.entityKey.toLocaleLowerCase("tr")),
  );
  const groups = new Map<string, Wallet[]>();
  const personNotes = new Map(
    overlay.people.map((person) => [person.name, person.note]),
  );

  baselineGroups.forEach((group) => {
    if (deletedPeople.has(group.group)) return;
    groups.set(
      group.group,
      group.wallets.filter(
        (wallet) =>
          !deletedWallets.has(wallet.address.toLocaleLowerCase("tr")),
      ),
    );
  });

  overlay.people.forEach((person) => {
    if (!deletedPeople.has(person.name) && !groups.has(person.name)) {
      groups.set(person.name, []);
    }
  });

  overlay.wallets.forEach((wallet) => {
    if (
      deletedPeople.has(wallet.personName) ||
      deletedWallets.has(wallet.address.toLocaleLowerCase("tr"))
    ) {
      return;
    }
    const groupWallets = groups.get(wallet.personName) ?? [];
    const addressExists = groupWallets.some(
      (item) =>
        item.address.toLocaleLowerCase("tr") ===
        wallet.address.toLocaleLowerCase("tr"),
    );
    if (!addressExists) {
      groupWallets.push({
        address: wallet.address,
        label: wallet.label,
        group: wallet.personName,
        chain: wallet.chain,
        category: wallet.category,
        status: wallet.chain === "solana" ? "inactive" : "out_of_scope",
        solBalance:
          wallet.chain === "solana" ? wallet.nativeBalance : undefined,
        nativeBalance: wallet.nativeBalance,
        nativeSymbol: wallet.nativeSymbol,
        recentTradeCount: 0,
        analysisNote:
          wallet.note || "Manuel eklendi; zincir taraması henüz yapılmadı.",
        explorerUrl:
          wallet.chain === "solana"
            ? `https://solscan.io/account/${wallet.address}`
            : `https://etherscan.io/address/${wallet.address}`,
      });
    }
    groups.set(wallet.personName, groupWallets);
  });

  return [...groups.entries()]
    .map(([group, wallets]) => ({
      group,
      wallets,
      personalNote: personNotes.get(group) ?? "",
      summary: summarize(wallets),
    }))
    .sort(
      (a, b) =>
        b.wallets.length - a.wallets.length ||
        a.group.localeCompare(b.group, "tr"),
    );
}

function CopyAddress({
  address,
  className = "",
}: {
  address: string;
  className?: string;
}) {
  const [copyState, setCopyState] = useState<
    "idle" | "copied" | "error"
  >("idle");

  async function copy() {
    let succeeded = false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address);
        succeeded = true;
      }
    } catch {
      succeeded = false;
    }

    if (!succeeded) {
      const textarea = document.createElement("textarea");
      textarea.value = address;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      succeeded = document.execCommand("copy");
      textarea.remove();
    }

    setCopyState(succeeded ? "copied" : "error");
    window.setTimeout(() => setCopyState("idle"), 1600);
  }

  const copyLabel =
    copyState === "copied"
      ? "Kopyalandı"
      : copyState === "error"
        ? "Kopyalanamadı"
        : "Adresi kopyala";

  return (
    <button
      className={`icon-button ${className}`.trim()}
      type="button"
      onClick={copy}
      title={copyLabel}
      aria-label={copyLabel}
    >
      {copyState === "copied" ? (
        <Check size={15} />
      ) : copyState === "error" ? (
        <X size={15} />
      ) : (
        <Copy size={15} />
      )}
    </button>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <span className={`status-badge ${meta.className}`}>
      <Icon size={13} />
      {meta.label}
    </span>
  );
}

function RoleBadge({ role }: { role?: WalletRole }) {
  if (!role) return null;
  const meta = roleMeta[role];
  return (
    <span className={`role-badge ${meta.className}`}>{meta.label}</span>
  );
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function EvmPortfolioPanel({ address }: { address: string }) {
  const [portfolio, setPortfolio] = useState<EvmPortfolio | null>(null);
  const [portfolioError, setPortfolioError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/evm-portfolio?address=${encodeURIComponent(address)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Portföy alınamadı.");
        return payload as EvmPortfolio;
      })
      .then((payload) => {
        if (!cancelled) setPortfolio(payload);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPortfolioError(
            error instanceof Error ? error.message : "Portföy alınamadı.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (portfolioError) {
    return <p className="evm-portfolio-state">{portfolioError}</p>;
  }
  if (!portfolio) {
    return <p className="evm-portfolio-state">Ağ bakiyeleri yükleniyor…</p>;
  }

  const renderNetwork = (network: EvmNetwork, highlighted = false) => (
    <article
      className={`evm-network-card ${highlighted ? "evm-network-extra" : ""} ${
        network.status === "unavailable" ? "evm-network-unavailable" : ""
      }`}
      key={network.id}
    >
      <div className="evm-network-head">
        <div>
          <strong>{network.name}</strong>
          {network.status === "partial" && <small>Temel bakiye gösteriliyor</small>}
          {network.status === "unavailable" && (
            <small>Bağlantı geçici olarak kullanılamıyor</small>
          )}
        </div>
        <div>
          <strong>
            {network.status === "unavailable"
              ? "—"
              : formatUsd(network.usdValue)}
          </strong>
          <small>
            {network.status === "unavailable"
              ? "Bakiye alınamadı"
              : `${formatSol(network.nativeBalance)} ${network.nativeSymbol}`}
          </small>
        </div>
      </div>
      {network.status !== "unavailable" && (
        <p className="evm-last-activity">
          Son aktivite: {formatDate(network.lastActivityAt)}
        </p>
      )}
      {network.tokens.length > 0 && (
        <div className="evm-token-list">
          {network.tokens.map((token) => (
            <div key={`${network.id}-${token.symbol}-${token.name}`}>
              <span>{token.symbol}</span>
              <span>{formatSol(token.balance)}</span>
              <strong>
                {token.usdValue === null ? "Fiyat yok" : formatUsd(token.usdValue)}
              </strong>
            </div>
          ))}
        </div>
      )}
      <a href={network.explorerUrl} target="_blank" rel="noreferrer">
        Explorer’da aç <ExternalLink size={12} />
      </a>
    </article>
  );

  return (
    <section className="evm-portfolio">
      <div className="evm-portfolio-title">
        <div>
          <span>EVM ağ bakiyeleri</span>
          <strong>7 ağın tamamı</strong>
        </div>
        <small>Tıklayınca güncellendi</small>
      </div>
      <div className="evm-network-grid">
        {portfolio.networks.map((network) => renderNetwork(network))}
      </div>
      <div className="evm-extra-networks">
        <p className="section-kicker">Arbitrum · Optimism · Polygon</p>
        <div className="evm-network-grid">
          {portfolio.otherNetworks.map((network) => renderNetwork(network))}
        </div>
      </div>
    </section>
  );
}

function SolanaPortfolioPanel({ address }: { address: string }) {
  const [portfolio, setPortfolio] = useState<SolanaPortfolio | null>(null);
  const [portfolioError, setPortfolioError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/solana-portfolio?address=${encodeURIComponent(address)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Portföy alınamadı.");
        return payload as SolanaPortfolio;
      })
      .then((payload) => {
        if (!cancelled) setPortfolio(payload);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPortfolioError(
            error instanceof Error ? error.message : "Portföy alınamadı.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (portfolioError) {
    return <p className="evm-portfolio-state">{portfolioError}</p>;
  }
  if (!portfolio) {
    return <p className="evm-portfolio-state">Canlı bakiye yükleniyor…</p>;
  }

  return (
    <section className="evm-portfolio solana-live-portfolio">
      <div className="evm-portfolio-title">
        <div>
          <span>Canlı Solana portföyü</span>
          <strong>{formatSol(portfolio.solBalance)} SOL</strong>
        </div>
        <div className="solana-live-total">
          <strong>{formatUsd(portfolio.usdValue)}</strong>
          <small>Tıklayınca güncellendi</small>
        </div>
      </div>
      <p className="evm-last-activity">
        Son aktivite: {formatDate(portfolio.lastActivityAt)}
      </p>
      {portfolio.tokens.length > 0 && (
        <div className="evm-token-list">
          {portfolio.tokens.map((token) => (
            <div key={token.mint}>
              <span title={token.mint}>
                {token.mint.slice(0, 4)}…{token.mint.slice(-4)}
              </span>
              <span>{formatSol(token.balance)}</span>
              <strong>{formatUsd(token.usdValue ?? 0)}</strong>
            </div>
          ))}
        </div>
      )}
      <a
        className="solana-live-link"
        href={`https://solscan.io/account/${address}`}
        target="_blank"
        rel="noreferrer"
      >
        Solscan’da aç <ExternalLink size={12} />
      </a>
    </section>
  );
}

function WalletRow({
  wallet,
  onDelete,
}: {
  wallet: Wallet;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(Boolean(wallet.sideWallets?.length));
  const sideWallets = wallet.sideWallets ?? [];

  return (
    <article className={`wallet-row ${open ? "wallet-row-open" : ""}`}>
      <div className="wallet-row-head">
        <button
          className="wallet-main"
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="wallet-identity">
            <span className="wallet-label-line">
              <span className="wallet-label">{wallet.label}</span>
              <RoleBadge role={wallet.role} />
            </span>
            <span className="wallet-address">{wallet.address}</span>
          </span>
          <span className="wallet-balance">
            <strong>
              {open
                ? "Canlı detaylar açık"
                : wallet.chain === "solana"
                  ? "Bakiyeyi göster"
                  : "4 ağı göster"}
            </strong>
            <small>
              {wallet.chain === "evm"
                ? "ETH · Robinhood · BNB · Base"
                : "Yalnızca tıklayınca sorgulanır"}
            </small>
          </span>
          <StatusBadge status={wallet.status} />
          <ChevronDown className="row-chevron" size={18} />
        </button>
        <CopyAddress
          address={wallet.address}
          className="wallet-inline-copy"
        />
        <button
          className="delete-button wallet-delete"
          type="button"
          onClick={onDelete}
          title="Cüzdanı sil"
          aria-label={`${wallet.label} cüzdanını sil`}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {open && (
        <div className="wallet-detail">
          {wallet.chain === "solana" && (
            <SolanaPortfolioPanel address={wallet.address} />
          )}
          {wallet.chain === "evm" && (
            <EvmPortfolioPanel address={wallet.address} />
          )}
          <div
            className={`trade-date-highlight ${
              wallet.latestTradeAt ? "has-trade" : "no-trade"
            }`}
          >
            <span>En son trade tarihi</span>
            <strong>{formatTradeDate(wallet)}</strong>
            {wallet.latestTradeAt && <small>Berlin saati (UTC+2)</small>}
          </div>

          <div className="note-block">
            <Info size={17} />
            <p>
              {wallet.analysisNote ??
                "Bu cüzdan için henüz araştırma notu eklenmedi."}
            </p>
          </div>

          <div className="detail-grid">
            <div>
              <span>Son aktivite</span>
              <strong>{formatDate(wallet.lastActivityAt)}</strong>
            </div>
            <div>
              <span>Cüzdan tipi</span>
              <strong>
                {wallet.role
                  ? roleMeta[wallet.role].label
                  : statusMeta[wallet.status].label}
              </strong>
            </div>
            <div>
              <span>Yakın trade sinyali</span>
              <strong>{wallet.recentTradeCount ?? 0}</strong>
            </div>
          </div>

          <div className="address-actions">
            <code>{wallet.address}</code>
            <CopyAddress address={wallet.address} />
            {wallet.explorerUrl && (
              <a
                className="icon-button"
                href={wallet.explorerUrl}
                target="_blank"
                rel="noreferrer"
                title="Explorer'da aç"
                aria-label="Explorer'da aç"
              >
                <ExternalLink size={15} />
              </a>
            )}
          </div>

          {sideWallets.length > 0 && (
            <div className="side-list">
              <p className="section-kicker">Doğrudan para çıkışları</p>
              {sideWallets.map((link) => (
                <div className="side-link" key={link.signature}>
                  <div>
                    <strong>
                      {link.candidate?.label ??
                        link.classification?.label ??
                        link.destination}
                    </strong>
                    <code>{link.destination}</code>
                    <small>
                      {formatSol(link.sol)} SOL · {formatDate(link.timestamp)}
                    </small>
                    {link.classification && <p>{link.classification.note}</p>}
                  </div>
                  <span
                    className={`link-verdict ${
                      link.classification?.terminal ? "terminal" : "candidate"
                    }`}
                  >
                    {link.classification?.terminal ? "Terminal" : "EOA adayı"}
                  </span>
                  {link.explorerUrl && (
                    <a
                      className="icon-button"
                      href={link.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="İşlemi aç"
                      aria-label="İşlemi aç"
                    >
                      <ExternalLink size={15} />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Dialog({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <header className="dialog-head">
          <div>
            <h2 id="dialog-title">{title}</h2>
            <p>{description}</p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Pencereyi kapat"
          >
            <X size={17} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function WalletDashboard({
  initialData,
  workspaceNav,
}: {
  initialData: WalletData;
  workspaceNav?: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  const [activeCategoryByGroup, setActiveCategoryByGroup] = useState<
    Record<string, WalletCategory>
  >({});
  const [activeNetworkByCategory, setActiveNetworkByCategory] = useState<
    Record<string, Wallet["chain"]>
  >({});
  const [overlay, setOverlay] = useState<DirectoryOverlay>(emptyOverlay);
  const [loadingOverlay, setLoadingOverlay] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [personDialogOpen, setPersonDialogOpen] = useState(false);
  const [personName, setPersonName] = useState("");
  const [renameDialogPerson, setRenameDialogPerson] = useState<string | null>(
    null,
  );
  const [renamedPersonName, setRenamedPersonName] = useState("");
  const [walletDialogPerson, setWalletDialogPerson] = useState<string | null>(
    null,
  );
  const [walletChain, setWalletChain] = useState<Wallet["chain"]>("solana");
  const [walletCategoryInput, setWalletCategoryInput] =
    useState<WalletCategory>("funding");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletLabelInput, setWalletLabelInput] = useState("");
  const [walletNote, setWalletNote] = useState("");
  const [personNoteDrafts, setPersonNoteDrafts] = useState<
    Record<string, string>
  >({});
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);

  const refreshDirectory = useCallback(async () => {
    try {
      const response = await fetch("/api/directory", { cache: "no-store" });
      const payload = (await response.json()) as DirectoryOverlay & {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Dizin yüklenemedi.");
      setOverlay(payload);
      setError("");
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Dizin değişiklikleri yüklenemedi.",
      );
    } finally {
      setLoadingOverlay(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/directory", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as DirectoryOverlay & {
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error || "Dizin yüklenemedi.");
        }
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setOverlay(payload);
        setError("");
      })
      .catch((refreshError: unknown) => {
        if (cancelled) return;
        setError(
          refreshError instanceof Error
            ? refreshError.message
            : "Dizin değişiklikleri yüklenemedi.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingOverlay(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const allGroups = useMemo(
    () => mergeDirectory(initialData.groups, overlay),
    [initialData.groups, overlay],
  );

  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("tr");
    return allGroups
      .map((group) => {
        const groupMatches =
          !normalized ||
          group.group.toLocaleLowerCase("tr").includes(normalized);
        const wallets = group.wallets.filter((wallet) => {
          return (
            groupMatches ||
            wallet.label.toLocaleLowerCase("tr").includes(normalized) ||
            wallet.address.toLocaleLowerCase("tr").includes(normalized)
          );
        });

        return { ...group, wallets, summary: summarize(wallets) };
      })
      .filter((group) => {
        if (group.wallets.length > 0) return true;
        const groupMatches =
          !normalized ||
          group.group.toLocaleLowerCase("tr").includes(normalized);
        return groupMatches;
      });
  }, [allGroups, query]);

  const visibleWalletCount = groups.reduce(
    (sum, group) => sum + group.wallets.length,
    0,
  );

  function toggleGroup(groupName: string) {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  }

  async function mutate(
    payload: Record<string, unknown>,
    successMessage: string,
  ) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "İşlem tamamlanamadı.");
      await refreshDirectory();
      setNotice(successMessage);
      window.setTimeout(() => setNotice(""), 2600);
      return true;
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "İşlem tamamlanamadı.",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function addPerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = personName.trim();
    if (!name) {
      setError("Önce bir isim yaz.");
      return;
    }
    const completed = await mutate(
      { action: "add_person", personName: name },
      `${name} dizine eklendi.`,
    );
    if (completed) {
      setPersonName("");
      setPersonDialogOpen(false);
      setOpenGroups((current) => new Set(current).add(name));
    }
  }

  function openWalletDialog(groupName: string) {
    setWalletDialogPerson(groupName);
    setWalletChain("solana");
    setWalletCategoryInput("funding");
    setWalletAddress("");
    const currentGroup = allGroups.find((group) => group.group === groupName);
    setWalletLabelInput(
      nextCanonicalWalletLabel(
        groupName,
        "solana",
        "funding",
        currentGroup?.wallets.map((wallet) => wallet.label) ?? [],
      ),
    );
    setWalletNote("");
    setError("");
  }

  async function addWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!walletDialogPerson) return;
    const address = walletAddress.trim();
    if (!address) {
      setError("Tam cüzdan adresi gerekli.");
      return;
    }
    const alreadyExists = allGroups.some((group) =>
      group.wallets.some(
        (wallet) =>
          wallet.address.toLocaleLowerCase("tr") ===
          address.toLocaleLowerCase("tr"),
      ),
    );
    if (alreadyExists) {
      setError("Bu cüzdan adresi dizinde zaten bulunuyor.");
      return;
    }
    const label = walletLabelInput.trim();
    if (!label) {
      setError("Cüzdan için bir isim yaz.");
      return;
    }

    const completed = await mutate(
      {
        action: "add_wallet",
        personName: walletDialogPerson,
        chain: walletChain,
        category: walletCategoryInput,
        label,
        address,
        note: walletNote.trim(),
      },
      `${label} cüzdanı eklendi.`,
    );
    if (completed) {
      setActiveCategoryByGroup((current) => ({
        ...current,
        [walletDialogPerson]: walletCategoryInput,
      }));
      setActiveNetworkByCategory((current) => ({
        ...current,
        [`${walletDialogPerson}:${walletCategoryInput}`]: walletChain,
      }));
      setWalletDialogPerson(null);
    }
  }

  function openRenameDialog(groupName: string) {
    setRenameDialogPerson(groupName);
    setRenamedPersonName(groupName);
    setError("");
  }

  async function renamePerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameDialogPerson) return;
    const nextName = renamedPersonName.trim();
    if (!nextName) {
      setError("Yeni ismi yaz.");
      return;
    }
    if (
      nextName !== renameDialogPerson &&
      allGroups.some((group) => group.group === nextName)
    ) {
      setError("Bu isim dizinde zaten bulunuyor.");
      return;
    }
    const group = allGroups.find(
      (item) => item.group === renameDialogPerson,
    );
    const completed = await mutate(
      {
        action: "rename_person",
        oldPersonName: renameDialogPerson,
        personName: nextName,
        note: group?.personalNote ?? "",
        wallets:
          group?.wallets.map((wallet) => ({
            chain: wallet.chain,
            category: walletCategory(wallet),
            label: wallet.label,
            address: wallet.address,
            note: wallet.analysisNote ?? "",
          })) ?? [],
      },
      `${renameDialogPerson} adı ${nextName} olarak değiştirildi.`,
    );
    if (completed) {
      setOpenGroups((current) => {
        const next = new Set(current);
        next.delete(renameDialogPerson);
        next.add(nextName);
        return next;
      });
      setRenameDialogPerson(null);
    }
  }

  async function deleteConfirmed() {
    if (!confirmTarget) return;
    if (confirmTarget.kind === "person") {
      const completed = await mutate(
        {
          action: "delete_person",
          personName: confirmTarget.personName,
        },
        `${confirmTarget.personName} dizinden silindi.`,
      );
      if (completed) {
        setOpenGroups((current) => {
          const next = new Set(current);
          next.delete(confirmTarget.personName);
          return next;
        });
        setConfirmTarget(null);
      }
      return;
    }

    const completed = await mutate(
      {
        action: "delete_wallet",
        address: confirmTarget.walletAddress,
      },
      `${confirmTarget.walletLabel} cüzdanı silindi.`,
    );
    if (completed) setConfirmTarget(null);
  }

  async function savePersonNote(groupName: string, currentNote: string) {
    await mutate(
      {
        action: "save_person_note",
        personName: groupName,
        note: currentNote,
      },
      `${groupName} notu kaydedildi.`,
    );
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#directory" aria-label="Cüzdan dizinine git">
          <span className="brand-mark">
            <WalletCards size={19} />
          </span>
          <span>
            <strong>Wallet Atlas</strong>
            <small>Cüzdan dizini</small>
          </span>
        </a>
        {workspaceNav}
        <div className="topbar-actions">
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              setError("");
              setPersonDialogOpen(true);
            }}
          >
            <Plus size={17} />
            Kişi ekle
          </button>
        </div>
      </header>

      <section className="directory-section" id="directory">
        <div className="directory-title">
          <div>
            <span className="section-kicker">Cüzdan dizini</span>
            <h1>İsimler ve bağlı cüzdanlar</h1>
          </div>
          <p>
            {visibleWalletCount} cüzdan · {groups.length} isim gösteriliyor
          </p>
        </div>

        <div className="control-panel">
          <label className="search-box">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="İsim veya tam adres ara"
              aria-label="İsim veya adres ara"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Aramayı temizle"
              >
                <X size={17} />
              </button>
            )}
          </label>

        </div>

        {(loadingOverlay || notice || error) && (
          <div
            className={`system-message ${error ? "system-message-error" : ""}`}
          >
            {loadingOverlay && <LoaderCircle className="spin" size={15} />}
            {!loadingOverlay && error && <AlertTriangle size={15} />}
            {!loadingOverlay && !error && <Check size={15} />}
            <span>
              {loadingOverlay
                ? "Dizin değişiklikleri yükleniyor…"
                : error || notice}
            </span>
          </div>
        )}

        {groups.length > 0 ? (
          <div className="group-grid">
            {groups.map((group) => {
              const isOpen = openGroups.has(group.group);
              const tradeWallets = group.wallets.filter(
                (wallet) => walletCategory(wallet) === "trade",
              );
              const fundingWallets = group.wallets.filter(
                (wallet) => walletCategory(wallet) === "funding",
              );
              const activeCategory =
                activeCategoryByGroup[group.group] ??
                (tradeWallets.length > 0 ? "trade" : "funding");
              const categoryWallets =
                activeCategory === "trade" ? tradeWallets : fundingWallets;
              const solWallets = categoryWallets.filter(
                (wallet) => wallet.chain === "solana",
              );
              const evmWallets = categoryWallets.filter(
                (wallet) => wallet.chain === "evm",
              );
              const networkStateKey = `${group.group}:${activeCategory}`;
              const activeNetwork =
                activeNetworkByCategory[networkStateKey] ??
                (solWallets.length > 0 ? "solana" : "evm");
              const activeWallets =
                activeNetwork === "solana" ? solWallets : evmWallets;

              return (
                <section
                  className={`group-card ${isOpen ? "group-card-open" : ""}`}
                  key={group.group}
                >
                  <div className="group-header">
                    <button
                      className="group-toggle"
                      type="button"
                      onClick={() => toggleGroup(group.group)}
                      aria-expanded={isOpen}
                    >
                      <span className="group-title">
                        <span className="group-name">{group.group}</span>
                        <span>{group.wallets.length} cüzdan</span>
                      </span>
                      <span className="group-stats">
                        {group.summary.activeTrade > 0 && (
                          <span>
                            <Zap size={13} />
                            {group.summary.activeTrade} aktif
                          </span>
                        )}
                        <span>Pasif · tıklayınca sorgula</span>
                        <ChevronDown className="group-chevron" size={18} />
                      </span>
                    </button>
                    <button
                      className="icon-button group-edit"
                      type="button"
                      onClick={() => openRenameDialog(group.group)}
                      title="İsmi değiştir"
                      aria-label={`${group.group} ismini değiştir`}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="delete-button group-delete"
                      type="button"
                      onClick={() =>
                        setConfirmTarget({
                          kind: "person",
                          personName: group.group,
                        })
                      }
                      title="Kişiyi sil"
                      aria-label={`${group.group} kişisini sil`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>

                  {isOpen && (
                    <div className="group-workspace">
                      <header className="group-workspace-head">
                        <div>
                          <span>İsim dosyası</span>
                          <h2>{group.group}</h2>
                          <p>
                            Önce cüzdan türünü, ardından SOL veya EVM ağını seç.
                            Bakiye, not ve işlem bilgileri korunur.
                          </p>
                        </div>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => openWalletDialog(group.group)}
                        >
                          <Plus size={16} />
                          Cüzdan ekle
                        </button>
                      </header>

                      <div
                        className="chain-tabs"
                        role="tablist"
                        aria-label={`${group.group} cüzdan kategorisi`}
                      >
                        <button
                          className={
                            activeCategory === "trade"
                              ? "chain-tab-active"
                              : ""
                          }
                          type="button"
                          role="tab"
                          aria-selected={activeCategory === "trade"}
                          onClick={() =>
                            setActiveCategoryByGroup((current) => ({
                              ...current,
                              [group.group]: "trade",
                            }))
                          }
                        >
                          <span className="chain-tab-icon trade">
                            <Zap size={18} />
                          </span>
                          <span>
                            <strong>Trade cüzdanları</strong>
                            <small>{tradeWallets.length} cüzdan</small>
                          </span>
                        </button>
                        <button
                          className={
                            activeCategory === "funding"
                              ? "chain-tab-active"
                              : ""
                          }
                          type="button"
                          role="tab"
                          aria-selected={activeCategory === "funding"}
                          onClick={() =>
                            setActiveCategoryByGroup((current) => ({
                              ...current,
                              [group.group]: "funding",
                            }))
                          }
                        >
                          <span className="chain-tab-icon funding">
                            <CircleDollarSign size={18} />
                          </span>
                          <span>
                            <strong>Borsa / funding cüzdanları</strong>
                            <small>{fundingWallets.length} cüzdan</small>
                          </span>
                        </button>
                      </div>

                      <div
                        className="network-tabs"
                        role="tablist"
                        aria-label={`${group.group} ${
                          activeCategory === "trade"
                            ? "trade"
                            : "borsa funding"
                        } ağ seçimi`}
                      >
                        <button
                          className={
                            activeNetwork === "solana"
                              ? "network-tab-active"
                              : ""
                          }
                          type="button"
                          role="tab"
                          aria-selected={activeNetwork === "solana"}
                          onClick={() =>
                            setActiveNetworkByCategory((current) => ({
                              ...current,
                              [networkStateKey]: "solana",
                            }))
                          }
                        >
                          <Coins size={15} />
                          <span>SOL</span>
                          <small>{solWallets.length}</small>
                        </button>
                        <button
                          className={
                            activeNetwork === "evm"
                              ? "network-tab-active"
                              : ""
                          }
                          type="button"
                          role="tab"
                          aria-selected={activeNetwork === "evm"}
                          onClick={() =>
                            setActiveNetworkByCategory((current) => ({
                              ...current,
                              [networkStateKey]: "evm",
                            }))
                          }
                        >
                          <Hexagon size={15} />
                          <span>EVM</span>
                          <small>{evmWallets.length}</small>
                        </button>
                      </div>

                      <div className="chain-panel" role="tabpanel">
                        {activeWallets.length > 0 ? (
                          <div className="wallet-list">
                            {activeWallets.map((wallet) => (
                              <WalletRow
                                wallet={wallet}
                                key={wallet.address}
                                onDelete={() =>
                                  setConfirmTarget({
                                    kind: "wallet",
                                    personName: group.group,
                                    walletAddress: wallet.address,
                                    walletLabel: wallet.label,
                                  })
                                }
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="chain-empty">
                            {activeNetwork === "solana" ? (
                              <Coins size={22} />
                            ) : (
                              <Hexagon size={22} />
                            )}
                            <strong>
                              Bu isim altında{" "}
                              {activeCategory === "trade"
                                ? "trade"
                                : "borsa / funding"}{" "}
                              kategorisinde{" "}
                              {activeNetwork === "solana" ? "SOL" : "EVM"}{" "}
                              cüzdanı yok
                            </strong>
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => {
                                openWalletDialog(group.group);
                                setWalletChain(activeNetwork);
                              }}
                            >
                              <Plus size={14} />
                              Cüzdan ekle
                            </button>
                          </div>
                        )}
                      </div>

                      <section className="personal-notes">
                        <header>
                          <NotebookPen size={19} />
                          <span>
                            <strong>Kendi notum</strong>
                            <small>
                              Buraya yazdığın not kalıcı olarak kaydedilir
                            </small>
                          </span>
                        </header>
                        <textarea
                          value={
                            personNoteDrafts[group.group] ??
                            group.personalNote ??
                            ""
                          }
                          onChange={(event) =>
                            setPersonNoteDrafts((current) => ({
                              ...current,
                              [group.group]: event.target.value,
                            }))
                          }
                          placeholder={`${group.group} hakkında kendi notunu yaz…`}
                          maxLength={2000}
                          rows={5}
                          aria-label={`${group.group} için kendi notun`}
                        />
                        <footer>
                          <span>
                            {
                              (
                                personNoteDrafts[group.group] ??
                                group.personalNote ??
                                ""
                              ).length
                            }
                            /2000
                          </span>
                          <button
                            className="primary-button"
                            type="button"
                            disabled={saving}
                            onClick={() =>
                              void savePersonNote(
                                group.group,
                                personNoteDrafts[group.group] ??
                                  group.personalNote ??
                                  "",
                              )
                            }
                          >
                            {saving ? (
                              <LoaderCircle className="spin" size={16} />
                            ) : (
                              <Check size={16} />
                            )}
                            Notu kaydet
                          </button>
                        </footer>
                      </section>

                      <section className="group-notes">
                        <header>
                          <NotebookPen size={19} />
                          <span>
                            <strong>Araştırma notları</strong>
                            <small>{group.group} için araştırma notları</small>
                          </span>
                        </header>
                        {group.wallets.length > 0 ? (
                          <div className="group-note-list">
                            {group.wallets.map((wallet) => (
                              <article key={`${wallet.address}-note`}>
                                <div>
                                  <strong>{wallet.label}</strong>
                                  <StatusBadge status={wallet.status} />
                                </div>
                                <p>
                                  {wallet.analysisNote ??
                                    "Bu cüzdan için henüz araştırma notu eklenmedi."}
                                </p>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <p className="notes-empty">
                            Bu kişi için henüz cüzdan ve araştırma notu yok.
                          </p>
                        )}
                      </section>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <Search size={24} />
            <strong>Eşleşen kayıt bulunamadı</strong>
            <p>Aramayı veya filtreleri değiştir.</p>
          </div>
        )}
      </section>

      {personDialogOpen && (
        <Dialog
          title="Yeni kişi ekle"
          description="Kişi dizine eklenecek; cüzdanlarını daha sonra içine ekleyebilirsin."
          onClose={() => setPersonDialogOpen(false)}
        >
          <form className="dialog-form" onSubmit={addPerson}>
            <label>
              <span>İsim</span>
              <input
                autoFocus
                value={personName}
                onChange={(event) => setPersonName(event.target.value)}
                placeholder="Örn. Mavis"
                maxLength={80}
              />
            </label>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setPersonDialogOpen(false)}
              >
                Vazgeç
              </button>
              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                Kişiyi ekle
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {walletDialogPerson && (
        <Dialog
          title={`${walletDialogPerson} · cüzdan ekle`}
          description="Türü ve ağı seç; otomatik adı kullanabilir veya kendin değiştirebilirsin."
          onClose={() => setWalletDialogPerson(null)}
        >
          <form className="dialog-form" onSubmit={addWallet}>
            <fieldset className="network-choice">
              <legend>Ağ</legend>
              <button
                className={walletChain === "solana" ? "selected" : ""}
                type="button"
                onClick={() => setWalletChain("solana")}
              >
                <Coins size={17} />
                SOL
              </button>
              <button
                className={walletChain === "evm" ? "selected" : ""}
                type="button"
                onClick={() => setWalletChain("evm")}
              >
                <Hexagon size={17} />
                ETH / EVM
              </button>
            </fieldset>
            <fieldset className="network-choice">
              <legend>Cüzdan türü</legend>
              <button
                className={walletCategoryInput === "trade" ? "selected" : ""}
                type="button"
                onClick={() => setWalletCategoryInput("trade")}
              >
                <Zap size={17} />
                Trade
              </button>
              <button
                className={walletCategoryInput === "funding" ? "selected" : ""}
                type="button"
                onClick={() => setWalletCategoryInput("funding")}
              >
                <CircleDollarSign size={17} />
                Funding
              </button>
            </fieldset>
            <label>
              <span>Cüzdan adı</span>
              <input
                value={walletLabelInput}
                onChange={(event) => setWalletLabelInput(event.target.value)}
                placeholder="Cüzdana verilecek isim"
                maxLength={80}
              />
              <button
                className="text-button field-action"
                type="button"
                onClick={() =>
                  setWalletLabelInput(
                    nextCanonicalWalletLabel(
                      walletDialogPerson,
                      walletChain,
                      walletCategoryInput,
                      allGroups
                        .find((group) => group.group === walletDialogPerson)
                        ?.wallets.map((wallet) => wallet.label) ?? [],
                    ),
                  )
                }
              >
                Otomatik ad oluştur
              </button>
            </label>
            <label>
              <span>Tam cüzdan adresi</span>
              <input
                autoFocus
                value={walletAddress}
                onChange={(event) => setWalletAddress(event.target.value)}
                placeholder={
                  walletChain === "solana"
                    ? "Solana adresini yapıştır"
                    : "0x…"
                }
                maxLength={140}
              />
            </label>
            <label>
              <span>Not (isteğe bağlı)</span>
              <textarea
                value={walletNote}
                onChange={(event) => setWalletNote(event.target.value)}
                placeholder="Para nereden geldi, trade durumu, bağlantılar…"
                maxLength={1000}
                rows={4}
              />
            </label>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setWalletDialogPerson(null)}
              >
                Vazgeç
              </button>
              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                Cüzdanı ekle
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {renameDialogPerson && (
        <Dialog
          title={`${renameDialogPerson} · ismi değiştir`}
          description="Bu kişinin adı, altındaki bütün cüzdanlarla birlikte değiştirilecek."
          onClose={() => setRenameDialogPerson(null)}
        >
          <form className="dialog-form" onSubmit={renamePerson}>
            <label>
              <span>Yeni isim</span>
              <input
                autoFocus
                value={renamedPersonName}
                onChange={(event) => setRenamedPersonName(event.target.value)}
                placeholder="Yeni isim"
                maxLength={80}
              />
            </label>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setRenameDialogPerson(null)}
              >
                Vazgeç
              </button>
              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Pencil size={16} />
                )}
                İsmi değiştir
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {confirmTarget && (
        <Dialog
          title={
            confirmTarget.kind === "person"
              ? `${confirmTarget.personName} silinsin mi?`
              : `${confirmTarget.walletLabel} silinsin mi?`
          }
          description={
            confirmTarget.kind === "person"
              ? "Bu kişi ve altında görünen bütün cüzdanlar dizinden kaldırılacak."
              : `${confirmTarget.personName} altındaki bu cüzdan dizinden kaldırılacak.`
          }
          onClose={() => setConfirmTarget(null)}
        >
          <div className="confirm-panel">
            <AlertTriangle size={22} />
            <p>Bu işlemden sonra kayıt sitede görünmeyecek.</p>
          </div>
          <div className="dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setConfirmTarget(null)}
            >
              Vazgeç
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={() => void deleteConfirmed()}
              disabled={saving}
            >
              {saving ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Trash2 size={16} />
              )}
              Evet, sil
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
