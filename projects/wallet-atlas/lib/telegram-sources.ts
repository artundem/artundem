const disabledTransferSources = new Set(["demo-muted"]);
const lowValueTransferSources = new Set(["demo chain feed", "demo-low-value"]);
const lowValueTransferUsdThreshold = 10;
const defaultVisibleTransferUsdThreshold = 20;

function normalizeSourceName(sourceName: string) {
  return sourceName.trim().toLocaleLowerCase("tr-TR");
}

function numericUsdValue(value: string | null | undefined) {
  if (!value) return null;
  const compact = value.replace(/\s/g, "");
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  const normalized =
    comma > dot
      ? compact.replace(/\./g, "").replace(",", ".")
      : compact.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function shouldIngestTelegramTransferSource(sourceName: string) {
  return !disabledTransferSources.has(normalizeSourceName(sourceName));
}

export function shouldStoreTelegramTransfer(
  sourceName: string,
  usdValue: string | null | undefined,
) {
  const normalizedSource = normalizeSourceName(sourceName);
  if (!lowValueTransferSources.has(normalizedSource)) return true;

  const value = numericUsdValue(usdValue);
  return value === null || value > lowValueTransferUsdThreshold;
}

export function shouldStoreTelegramMessage(
  sourceName: string,
  text: string | null | undefined,
) {
  const normalizedSource = normalizeSourceName(sourceName);
  if (!lowValueTransferSources.has(normalizedSource)) return true;
  return Boolean(text && /\b(?:BUY|SELL)\b/i.test(text));
}

export function isVisibleTelegramTransferValue(
  sourceName: string | null | undefined,
  usdValue: string | null | undefined,
) {
  const value = numericUsdValue(usdValue);
  if (value === null) return true;

  const normalizedSource = normalizeSourceName(sourceName ?? "");
  if (lowValueTransferSources.has(normalizedSource)) {
    return value > lowValueTransferUsdThreshold;
  }
  return value >= defaultVisibleTransferUsdThreshold;
}
