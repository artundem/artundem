import walletData from "../data/wallet-data.json";
import { AtlasApp } from "./atlas-app";
import type { WalletData } from "./wallet-dashboard";

export default function Home() {
  return <AtlasApp initialData={walletData as unknown as WalletData} />;
}
