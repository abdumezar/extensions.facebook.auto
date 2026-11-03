import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocIdRow, GovernorSnapshot } from "@nashir/shared";
import { call } from "../lib/rpc.js";
import { loadDocIds } from "../lib/data.js";
import { DocIdStatusCard } from "../components/DocIdStatusCard.js";
import { GovernorCard } from "../components/GovernorCard.js";
import { Button, Card } from "../ui/index.js";

interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
}

const LEVEL_TONE: Record<LogEntry["level"], string> = {
  error: "text-error",
  warn: "text-warning",
  info: "text-on-surface",
};

export function LogsPage() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [governor, setGovernor] = useState<GovernorSnapshot | null>(null);
  const [docIds, setDocIds] = useState<DocIdRow[]>([]);
  const [now, setNow] = useState(() => Date.now());

  async function load() {
    const out = await chrome.storage.local.get("nashir:logs");
    setLogs(((out["nashir:logs"] as LogEntry[]) ?? []).slice().reverse());
  }

  useEffect(() => {
    void load();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes["nashir:logs"]) void load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // Learned ids land in storage when a Facebook tab is harvested, which can happen while
  // this page is open — so follow the key instead of reading once.
  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    const refresh = () => {
      const mine = ++latest;
      void loadDocIds().then((rows) => {
        // A failed read keeps what is already shown; a reply that was overtaken by a
        // newer read, or that arrives after unmount, is dropped.
        if (cancelled || mine !== latest || rows === null) return;
        setDocIds(rows);
      });
    };
    refresh();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes["nashir:docIds"]) refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  // The budget is only interesting while it is moving, so this ticks rather than
  // rendering once — but slowly: it is a diagnostic, not a live meter.
  useEffect(() => {
    const poll = async () => {
      setGovernor(await call<GovernorSnapshot>({ type: "GET_GOVERNOR_SNAPSHOT" }).catch(() => null));
      setNow(Date.now());
    };
    void poll();
    const id = setInterval(() => void poll(), 5000);
    return () => clearInterval(id);
  }, []);

  async function clear() {
    await chrome.storage.local.set({ "nashir:logs": [] });
    setLogs([]);
  }

  return (
    <div className="space-y-4">
      {governor && <GovernorCard snap={governor} now={now} />}
      {docIds.length > 0 && <DocIdStatusCard rows={docIds} />}

      <div className="flex items-center justify-end">
        <Button variant="text" icon="delete" onClick={() => void clear()}>
          {t("common.clear")}
        </Button>
      </div>

      {logs.length === 0 ? (
        <Card variant="filled">
          <p className="text-body-medium text-on-surface-variant">{t("logs.empty")}</p>
        </Card>
      ) : (
        <Card variant="filled" className="max-h-[70vh] overflow-y-auto font-mono" dir="ltr">
          <div className="space-y-1">
            {logs.map((l, i) => (
              <div key={i} className="flex gap-2 text-body-small">
                <span className="shrink-0 text-on-surface-variant">
                  {new Date(l.ts).toLocaleTimeString()}
                </span>
                <bdi className={LEVEL_TONE[l.level]}>{l.msg}</bdi>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
