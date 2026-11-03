import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_CAMPAIGN_MEDIA, type CampaignMedia } from "@nashir/shared";
import { useStore } from "../store.js";
import { MediaStore } from "../../engine/MediaStore.js";
import { Button, Icon, IconButton, StatusChip, cn } from "../ui/index.js";

// Shares the "nashir-media" IndexedDB with the service worker, so a blob stashed by the
// dashboard picker is readable by the engine during a run.
const media = new MediaStore();

export function MediaPicker() {
  const { t } = useTranslation();
  const items = useStore((s) => s.draft.media);
  const update = useStore((s) => s.updateDraft);
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previews = usePreviews(items);

  const full = items.length >= MAX_CAMPAIGN_MEDIA;

  async function accept(files: FileList | File[]): Promise<void> {
    const incoming = [...files];
    if (incoming.length === 0) return;

    const room = MAX_CAMPAIGN_MEDIA - items.length;
    if (room <= 0) {
      setError(t("content.mediaFull", { max: MAX_CAMPAIGN_MEDIA }));
      return;
    }
    setError(incoming.length > room ? t("content.mediaFull", { max: MAX_CAMPAIGN_MEDIA }) : null);

    const added: CampaignMedia[] = [];
    for (const file of incoming.slice(0, room)) {
      const kind: "image" | "video" = file.type.startsWith("video") ? "video" : "image";
      const blobId = await media.put({
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        blob: file,
        kind,
      });
      added.push({ blobId, name: file.name, mimeType: file.type, sizeBytes: file.size, kind });
    }
    update({ media: [...items, ...added] });
    if (inputRef.current) inputRef.current.value = "";
  }

  async function remove(blobId: string): Promise<void> {
    update({ media: items.filter((m) => m.blobId !== blobId) });
    setError(null);
    await media.remove(blobId).catch(() => {});
  }

  /** Order is the order Facebook renders the attachments in, so it is worth controlling. */
  function move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    update({ media: next });
  }

  const totalBytes = items.reduce((sum, m) => sum + m.sizeBytes, 0);
  const hasVideo = items.some((m) => m.kind === "video");

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-title-small text-on-surface">{t("content.media")}</span>
        {items.length > 0 && (
          <span className="flex items-center gap-2">
            <StatusChip tone="primary">
              {items.length}/{MAX_CAMPAIGN_MEDIA}
            </StatusChip>
            <span className="text-body-small text-on-surface-variant" dir="ltr">
              {formatBytes(totalBytes)}
            </span>
          </span>
        )}
      </div>

      {items.length > 0 && (
        <ul className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {items.map((m, i) => (
            <li
              key={m.blobId}
              className="group relative overflow-hidden rounded-sm border border-outline-variant"
            >
              <div className="aspect-square w-full bg-surface-container-highest">
                {previews[m.blobId] ? (
                  <img src={previews[m.blobId]} alt={m.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-on-surface-variant">
                    <Icon name={m.kind === "video" ? "movie" : "image"} size={28} />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-1 bg-surface-container px-1 py-0.5">
                <bdi className="min-w-0 flex-1 truncate text-body-small text-on-surface-variant">
                  {m.name}
                </bdi>
                <IconButton
                  icon="delete"
                  label={`${t("content.mediaRemove")} — ${m.name}`}
                  className="h-8 w-8 shrink-0 text-error"
                  onClick={() => void remove(m.blobId)}
                />
              </div>

              {items.length > 1 && (
                <div className="absolute top-1 flex gap-0.5 ltr:left-1 rtl:right-1">
                  <ReorderButton
                    label={t("content.mediaMoveEarlier", { name: m.name })}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ‹
                  </ReorderButton>
                  <ReorderButton
                    label={t("content.mediaMoveLater", { name: m.name })}
                    disabled={i === items.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ›
                  </ReorderButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files?.length) void accept(e.dataTransfer.files);
        }}
        className={cn(
          "grid place-items-center gap-2 rounded-md border-2 border-dashed text-center",
          "transition-colors duration-short2 ease-standard",
          items.length > 0 ? "p-3" : "p-6",
          drag ? "border-primary bg-primary-container" : "border-outline",
          full && "opacity-60",
        )}
      >
        {items.length === 0 && (
          <>
            <Icon name="add_photo_alternate" size={32} className="text-on-surface-variant" />
            <div className="text-body-medium text-on-surface-variant">{t("content.mediaDrop")}</div>
            <div className="text-body-small text-on-surface-variant">{t("content.mediaHint")}</div>
          </>
        )}
        {/* An explicit control, so the drop zone is reachable without a pointer. */}
        <Button
          variant="tonal"
          icon="add_photo_alternate"
          disabled={full}
          className={items.length === 0 ? "mt-1" : undefined}
          onClick={() => inputRef.current?.click()}
        >
          {items.length === 0 ? t("common.add") : t("content.mediaAddMore")}
        </Button>
      </div>

      {error && (
        <p role="status" className="mt-2 text-body-small text-error">
          {error}
        </p>
      )}
      {hasVideo && <p className="mt-2 text-body-small text-warning">{t("content.videoSoon")}</p>}

      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) void accept(e.target.files);
        }}
      />
    </div>
  );
}

function ReorderButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "state-layer grid h-6 w-6 place-items-center rounded-full bg-surface/80 text-label-large",
        disabled ? "text-on-surface/[0.38]" : "text-on-surface",
      )}
    >
      <span aria-hidden>{children}</span>
    </button>
  );
}

/**
 * Object URLs for the image attachments, rebuilt from IndexedDB rather than kept from
 * the original File — the Content page unmounts whenever the user visits another view,
 * and a preview that vanishes on the way back reads as data loss.
 */
function usePreviews(items: CampaignMedia[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = items.map((m) => m.blobId).join(",");

  useEffect(() => {
    let alive = true;
    const created: string[] = [];

    void (async () => {
      const next: Record<string, string> = {};
      for (const item of items) {
        if (item.kind !== "image") continue;
        const rec = await media.get(item.blobId).catch(() => null);
        if (!rec) continue;
        const url = URL.createObjectURL(rec.blob);
        created.push(url);
        next[item.blobId] = url;
      }
      if (alive) setUrls(next);
      else created.forEach((u) => URL.revokeObjectURL(u));
    })();

    return () => {
      alive = false;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
    // Identity of `items` changes on every draft edit; the blob ids are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return urls;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
