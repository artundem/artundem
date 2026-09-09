"use client";

import { Database, Radio } from "lucide-react";
import { useState } from "react";
import { TelegramTracker } from "./telegram-tracker";
import { WalletDashboard, type WalletData } from "./wallet-dashboard";

type Workspace = "wallet-database" | "telegram-tracker";

function WorkspaceNav({
  active,
  onChange,
}: {
  active: Workspace;
  onChange: (workspace: Workspace) => void;
}) {
  return (
    <nav className="workspace-nav" aria-label="Ana bölümler">
      <button
        className={active === "wallet-database" ? "workspace-nav-active" : ""}
        type="button"
        onClick={() => onChange("wallet-database")}
      >
        <Database size={15} />
        Wallet Database
      </button>
      <button
        className={active === "telegram-tracker" ? "workspace-nav-active" : ""}
        type="button"
        onClick={() => onChange("telegram-tracker")}
      >
        <Radio size={15} />
        Telegram Tracker
      </button>
    </nav>
  );
}

export function AtlasApp({ initialData }: { initialData: WalletData }) {
  const [activeWorkspace, setActiveWorkspace] =
    useState<Workspace>("telegram-tracker");
  const workspaceNav = (
    <WorkspaceNav active={activeWorkspace} onChange={setActiveWorkspace} />
  );

  return activeWorkspace === "wallet-database" ? (
    <WalletDashboard initialData={initialData} workspaceNav={workspaceNav} />
  ) : (
    <TelegramTracker workspaceNav={workspaceNav} />
  );
}
