export type TrackerEventIdentity = {
  network: string;
  txHash: string;
  walletAddress: string;
};

function normalized(value: string) {
  return value.trim().toLocaleLowerCase("en-US");
}

export function buildTrackerEventDedupeKey(input: TrackerEventIdentity) {
  return [
    normalized(input.network),
    normalized(input.txHash),
    normalized(input.walletAddress),
  ].join("|");
}
