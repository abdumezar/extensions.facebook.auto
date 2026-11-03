import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LinkPreview } from "@nashir/shared";
import { useStore } from "../store.js";
import { rpc } from "../lib/rpc.js";
import { displayHost, extractLinks } from "../../engine/linkExtract.js";
import { Button, Card, Icon, StatusChip, cn } from "../ui/index.js";

/**
 * Which link, if any, gets the preview card.
 *
 * Facebook attaches at most one card per post, so a caption with three links is an
 * ambiguity the operator has to resolve — silently taking the first one is how a campaign
 * ends up advertising a footer link. The choice only appears when there is one to make.
 *
 * Media wins over a link in Facebook's composer, so when photos or videos are attached
 * this says so rather than letting the operator pick something that will be ignored.
 */
export function LinkPicker() {
  const { t } = useTranslation();
  const draft = useStore((s) => s.draft);
  const update = useStore((s) => s.updateDraft);

  const links = useMemo(() => extractLinks(draft.variations), [draft.variations]);
  const supersededByMedia = draft.media.length > 0;

  // A link the operator chose and then deleted from the caption must not stay attached.
  useEffect(() => {
    if (draft.linkUrl && !links.includes(draft.linkUrl)) update({ linkUrl: undefined });
  }, [links, draft.linkUrl, update]);

  if (links.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-title-small text-on-surface">{t("link.title")}</h3>
        {supersededByMedia && <StatusChip tone="neutral">{t("link.mediaWins")}</StatusChip>}
      </div>

      <p className="text-body-small text-on-surface-variant">
        {supersededByMedia ? t("link.mediaWinsHint") : t("link.hint")}
      </p>

      <div className={cn("space-y-2", supersededByMedia && "opacity-60")}>
        <LinkOption
          selected={!draft.linkUrl}
          label={t("link.none")}
          onSelect={() => update({ linkUrl: undefined })}
        />
        {links.map((url) => (
          <LinkOption
            key={url}
            url={url}
            selected={draft.linkUrl === url}
            label={displayHost(url)}
            onSelect={() => update({ linkUrl: url })}
          />
        ))}
      </div>
    </div>
  );
}

function LinkOption({
  url,
  label,
  selected,
  onSelect,
}: {
  url?: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
        selected ? "border-primary bg-primary-container/30" : "border-outline-variant",
      )}
    >
      <input
        type="radio"
        name="nashir-link"
        checked={selected}
        onChange={onSelect}
        className="mt-1 accent-[rgb(var(--md-sys-color-primary))]"
      />
      <div className="min-w-0 flex-1">
        <div className="text-body-medium text-on-surface">
          <bdi>{label}</bdi>
        </div>
        {url && (
          <div className="truncate text-body-small text-on-surface-variant" title={url}>
            <bdi>{url}</bdi>
          </div>
        )}
        {url && selected && <Preview url={url} />}
      </div>
    </label>
  );
}

/**
 * The card, once the operator has committed to a link. Fetched lazily and only for the
 * selected one — asking Facebook about every link someone happens to paste would be a
 * request per keystroke-pause, for links they may never use.
 */
function Preview({ url }: { url: string }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(refresh = false) {
    setBusy(true);
    const res = await rpc<LinkPreview>({ type: "GET_LINK_PREVIEW", url, refresh });
    if (res.ok && res.data) setPreview(res.data);
    setBusy(false);
  }

  useEffect(() => {
    setPreview(null);
    void load();
    // Re-fetch only when the URL itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  if (busy && !preview) {
    return <p className="mt-2 text-body-small text-on-surface-variant">{t("common.loading")}</p>;
  }
  if (!preview) return null;

  if (preview.status !== "ok") {
    return (
      <Card variant="filled" className="mt-2 flex items-start gap-2 py-2">
        <Icon name="info" size={16} className="mt-0.5 shrink-0 text-on-surface-variant" />
        <div>
          <p className="text-body-small text-on-surface">{t(`link.status_${preview.status}`)}</p>
          {/* The reassurance that matters: the post is unaffected either way. */}
          <p className="text-body-small text-on-surface-variant">{t("link.stillAttaches")}</p>
        </div>
      </Card>
    );
  }

  return (
    <Card variant="filled" className="mt-2 space-y-1 py-2">
      <div className="flex items-start gap-3">
        {preview.imageUrl && (
          <img
            src={preview.imageUrl}
            alt=""
            className="h-14 w-14 shrink-0 rounded object-cover"
            loading="lazy"
          />
        )}
        <div className="min-w-0 flex-1">
          {preview.title && (
            <div className="truncate text-body-medium text-on-surface">
              <bdi>{preview.title}</bdi>
            </div>
          )}
          {preview.description && (
            <p className="line-clamp-2 text-body-small text-on-surface-variant">
              <bdi>{preview.description}</bdi>
            </p>
          )}
        </div>
      </div>
      <Button variant="text" icon="refresh" disabled={busy} onClick={() => void load(true)}>
        {t("link.refresh")}
      </Button>
    </Card>
  );
}
