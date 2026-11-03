import { useId, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useStore, resolveGroupIds } from "../store.js";
import { MediaPicker } from "../components/MediaPicker.js";
import { LinkPicker } from "../components/LinkPicker.js";
import { Avatar } from "../components/Avatar.js";
import { recommendDelay } from "../../engine/SafetyPolicy.js";
import { formatDuration } from "../lib/format.js";
import {
  Button,
  Card,
  FilterChip,
  Icon,
  IconButton,
  NumberField,
  SegmentedButton,
  StatusChip,
  Switch,
  TextArea,
  cn,
} from "../ui/index.js";

/** Spacing presets, from the same tiers SafetyPolicy recommends. */
const DELAY_PRESETS = [
  { id: "fast", minSeconds: 60, maxSeconds: 180 },
  { id: "balanced", minSeconds: 180, maxSeconds: 1200 },
  { id: "slow", minSeconds: 1200, maxSeconds: 1800 },
] as const;

/**
 * Content — where a campaign is actually written.
 *
 * Reorganised around the three decisions it contains, each its own titled section:
 * what to say (captions + attachments), who to say it to (accounts + groups), and how
 * fast (spacing + safety). The old "how many posts" dropdown is gone: variations are
 * added and removed one at a time, so the control matches the mental model instead of
 * silently truncating text when the number goes down.
 */
export function ContentPage() {
  const { t } = useTranslation();
  const draft = useStore((s) => s.draft);
  const update = useStore((s) => s.updateDraft);
  const groups = useStore((s) => s.groups);
  const selectedGroupIds = useStore((s) => s.selectedGroupIds);
  const toggleGroup = useStore((s) => s.toggleGroup);
  const clearSelection = useStore((s) => s.clearSelection);
  const setView = useStore((s) => s.setView);
  const accounts = useStore((s) => s.accounts);
  const session = useStore((s) => s.session);
  const selectedAccountIds = useStore((s) => s.selectedAccountIds);
  const toggleAccount = useStore((s) => s.toggleAccount);
  const clearAccountSelection = useStore((s) => s.clearAccountSelection);

  const targetIds = useMemo(
    () => resolveGroupIds(selectedGroupIds, draft.manualGroupIds),
    [selectedGroupIds, draft.manualGroupIds],
  );
  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const accountCount = selectedAccountIds.size || 1;
  const totalPosts = targetIds.length * accountCount;

  const setVariation = (i: number, val: string) => {
    const next = [...draft.variations];
    next[i] = val;
    update({ variations: next });
  };
  const addVariation = () => update({ variations: [...draft.variations, ""] });
  const removeVariation = (i: number) =>
    update({ variations: draft.variations.filter((_, idx) => idx !== i) });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* ---- What to say ---- */}
      <div className="space-y-6">
        <Section
          title={t("content.title")}
          subtitle={t("content.variationsHint")}
          trailing={<StatusChip tone="neutral">{t("content.variationCount", { n: draft.variations.length })}</StatusChip>}
        >
          <div className="space-y-3">
            {draft.variations.map((v, i) => (
              <Variation
                key={i}
                index={i}
                total={draft.variations.length}
                value={v}
                onChange={(val) => setVariation(i, val)}
                onRemove={() => removeVariation(i)}
              />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outlined" icon="add" onClick={addVariation}>
              {t("content.addVariation")}
            </Button>
          </div>

          <div className="mt-4 border-t border-outline-variant pt-4">
            <MediaPicker />
          </div>

          {/* Only renders once a caption actually contains a link. */}
          <div className="mt-4 empty:mt-0">
            <LinkPicker />
          </div>

          {/*
            The first comment is where a link belongs: Facebook demotes a post that
            carries an outbound link, and the comment thread is where people reply.
          */}
          <div className="mt-4 border-t border-outline-variant pt-4">
            <TextArea
              label={t("content.firstComment")}
              value={draft.firstComment}
              onChange={(e) => update({ firstComment: e.target.value })}
              rows={2}
              dir="auto"
            />
            <p className="mt-1 text-body-small text-on-surface-variant">
              {t("content.firstCommentHint")}
            </p>
          </div>
        </Section>
      </div>

      {/* ---- Who to say it to, and how fast ---- */}
      <div className="space-y-6">
        <Section title={t("content.targets")}>
          {/* Post from */}
          <div className="space-y-2">
            <h3 className="text-title-small text-on-surface">{t("content.postFrom")}</h3>
            <div className="flex flex-wrap gap-2">
              {/* Deselecting every managed account IS choosing the live session, so the
                  session chip is the one that clears the selection. */}
              <FilterChip selected={selectedAccountIds.size === 0} onSelectedChange={clearAccountSelection}>
                <bdi>{session?.profile?.name ?? t("content.currentSession")}</bdi>
              </FilterChip>
              {accounts.map((a) => (
                <FilterChip
                  key={a.id}
                  selected={selectedAccountIds.has(a.id)}
                  onSelectedChange={() => toggleAccount(a.id)}
                >
                  <span className="flex items-center gap-1.5">
                    <Avatar src={a.avatarUrl} name={a.label} size={20} />
                    <bdi>{a.label}</bdi>
                  </span>
                </FilterChip>
              ))}
            </div>
            <p className="text-body-small text-on-surface-variant">{t("content.postFromHint")}</p>
          </div>

          {/* Target groups */}
          <div className="mt-5 space-y-2 border-t border-outline-variant pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-title-small text-on-surface">{t("content.targetGroups")}</h3>
              <div className="flex items-center gap-1">
                {selectedGroupIds.size > 0 && (
                  <Button variant="text" onClick={clearSelection}>
                    {t("common.clear")}
                  </Button>
                )}
                <Button variant="tonal" icon="groups" onClick={() => setView("groups")}>
                  {t("content.chooseGroups")}
                </Button>
              </div>
            </div>

            {targetIds.length === 0 ? (
              <p className="text-body-medium text-on-surface-variant">{t("content.noGroups")}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {[...selectedGroupIds].slice(0, 30).map((id) => (
                  <li key={id}>
                    <span className="inline-flex h-8 items-center gap-1 rounded-sm bg-secondary-container ps-3 pe-1 text-label-large text-on-secondary-container">
                      <bdi className="max-w-[180px] truncate">{groupsById.get(id)?.name ?? id}</bdi>
                      <IconButton
                        icon="close"
                        size={16}
                        label={`${t("common.remove")} — ${groupsById.get(id)?.name ?? id}`}
                        className="h-6 w-6 text-on-secondary-container"
                        onClick={() => toggleGroup(id)}
                      />
                    </span>
                  </li>
                ))}
                {selectedGroupIds.size > 30 && (
                  <li className="self-center text-body-small text-on-surface-variant">
                    {t("content.andMore", { n: selectedGroupIds.size - 30 })}
                  </li>
                )}
              </ul>
            )}

            <Disclosure summary={t("content.manualIds")}>
              <TextArea
                label={t("content.groupIds")}
                className="font-mono"
                dir="ltr"
                rows={3}
                value={draft.manualGroupIds}
                onChange={(e) => update({ manualGroupIds: e.target.value })}
              />
              <p className="mt-1 text-body-small text-on-surface-variant">{t("content.manualHint")}</p>
            </Disclosure>

            <p className="text-body-small text-on-surface-variant">
              {t("content.totalPosts", { n: totalPosts })}
            </p>
          </div>
        </Section>

        {/* ---- Timing ---- */}
        <Section title={t("content.delay")}>
          <DelayControls totalGroups={targetIds.length} />
        </Section>

        {/* ---- Safety ---- */}
        <Section title={t("content.safetyTitle")}>
          <ToggleRow
            title={t("content.safety")}
            checked={draft.safetyBreak.enabled}
            onCheckedChange={(enabled) => update({ safetyBreak: { ...draft.safetyBreak, enabled } })}
          />
          <p className="text-body-small text-on-surface-variant">{t("content.safetyDesc")}</p>

          {draft.safetyBreak.enabled && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <NumberField
                label={t("content.every")}
                value={draft.safetyBreak.everyNPosts}
                onValueChange={(n) =>
                  update({ safetyBreak: { ...draft.safetyBreak, everyNPosts: Math.max(1, Math.round(n)) } })
                }
              />
              <NumberField
                label={t("content.duration")}
                value={draft.safetyBreak.durationSeconds / 60}
                onValueChange={(m) =>
                  update({ safetyBreak: { ...draft.safetyBreak, durationSeconds: Math.round(m * 60) } })
                }
              />
            </div>
          )}

          <Disclosure summary={t("anti.title")} className="mt-4">
            <div className="space-y-3">
              <ToggleRow
                title={t("anti.jitter")}
                subdued
                checked={draft.antiDetection.jitter}
                onCheckedChange={(jitter) => update({ antiDetection: { ...draft.antiDetection, jitter } })}
              />
              <ToggleRow
                title={t("anti.warmup")}
                subdued
                checked={draft.antiDetection.warmup}
                onCheckedChange={(warmup) => update({ antiDetection: { ...draft.antiDetection, warmup } })}
              />
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  label={t("anti.dailyBudget")}
                  value={draft.antiDetection.dailyBudgetPerAccount}
                  onValueChange={(n) =>
                    update({
                      antiDetection: {
                        ...draft.antiDetection,
                        dailyBudgetPerAccount: Math.max(0, Math.round(n)),
                      },
                    })
                  }
                />
                <NumberField
                  label={t("anti.autoPause")}
                  value={draft.antiDetection.autoPauseAfterConsecutiveFailures}
                  onValueChange={(n) =>
                    update({
                      antiDetection: {
                        ...draft.antiDetection,
                        autoPauseAfterConsecutiveFailures: Math.max(0, Math.round(n)),
                      },
                    })
                  }
                />
              </div>
            </div>
          </Disclosure>
        </Section>
      </div>
    </div>
  );
}

/** One caption, with its own character count and a remove control when there is more than one. */
function Variation({
  index,
  total,
  value,
  onChange,
  onRemove,
}: {
  index: number;
  total: number;
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="flex items-start gap-2">
        <TextArea
          label={total > 1 ? `${t("content.postPlaceholder")} ${index + 1}` : t("content.postPlaceholder")}
          className="flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
        {total > 1 && (
          <IconButton
            icon="delete"
            label={t("content.removeVariation", { n: index + 1 })}
            className="mt-2 text-error"
            onClick={onRemove}
          />
        )}
      </div>
      <div className="px-4 text-end text-body-small text-on-surface-variant" dir="ltr">
        {value.length}
      </div>
    </div>
  );
}

/**
 * Spacing between posts. Presets first, because "how many seconds" is not how anyone
 * thinks about this — and a one-click "recommended for this many groups" reuses the
 * same tiers the pre-run risk warning would otherwise scold you with.
 */
function DelayControls({ totalGroups }: { totalGroups: number }) {
  const { t } = useTranslation();
  const draft = useStore((s) => s.draft);
  const update = useStore((s) => s.updateDraft);
  const delay = draft.delay;

  const modes = [
    { value: "range", label: t("content.range") },
    { value: "fixed", label: t("content.fixed") },
  ] as const;

  const recommended = recommendDelay(Math.max(1, totalGroups));
  const matchesRecommended =
    delay.minSeconds === recommended.minSeconds && delay.maxSeconds === recommended.maxSeconds;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {DELAY_PRESETS.map((p) => (
          <FilterChip
            key={p.id}
            icon="speed"
            selected={
              delay.mode === "range" &&
              delay.minSeconds === p.minSeconds &&
              delay.maxSeconds === p.maxSeconds
            }
            onSelectedChange={() =>
              update({ delay: { mode: "range", minSeconds: p.minSeconds, maxSeconds: p.maxSeconds } })
            }
          >
            {t(`content.preset_${p.id}`)}
          </FilterChip>
        ))}
        <Button
          variant="text"
          icon="shield"
          disabled={matchesRecommended}
          onClick={() =>
            update({
              delay: {
                mode: "range",
                minSeconds: recommended.minSeconds,
                maxSeconds: recommended.maxSeconds,
              },
            })
          }
        >
          {t("content.useRecommended")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-body-small text-on-surface-variant">
          {t("content.spacingSummary", {
            range:
              delay.mode === "fixed"
                ? formatDuration(delay.minSeconds * 1000)
                : `${formatDuration(delay.minSeconds * 1000)} – ${formatDuration(delay.maxSeconds * 1000)}`,
          })}
        </span>
        <SegmentedButton
          options={modes}
          value={delay.mode}
          onValueChange={(mode) => update({ delay: { ...delay, mode } })}
          label={t("content.delay")}
        />
      </div>

      {delay.mode === "range" ? (
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label={t("content.minMinutes")}
            value={delay.minSeconds / 60}
            onValueChange={(min) => update({ delay: { ...delay, minSeconds: Math.round(min * 60) } })}
          />
          <NumberField
            label={t("content.maxMinutes")}
            value={delay.maxSeconds / 60}
            onValueChange={(max) => update({ delay: { ...delay, maxSeconds: Math.round(max * 60) } })}
          />
        </div>
      ) : (
        <NumberField
          label={t("content.fixedSeconds")}
          value={delay.minSeconds}
          onValueChange={(s) => update({ delay: { ...delay, minSeconds: s, maxSeconds: s } })}
        />
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  trailing,
  children,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <Card aria-labelledby={id} className="space-y-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={id} className="text-title-medium text-on-surface">
          {title}
        </h2>
        {trailing}
      </div>
      {subtitle && <p className="pb-2 text-body-small text-on-surface-variant">{subtitle}</p>}
      <div className="pt-2">{children}</div>
    </Card>
  );
}

/** Native disclosure — secondary controls stay reachable without occupying the page. */
function Disclosure({
  summary,
  className,
  children,
}: {
  summary: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={cn("group", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1 py-2 text-label-large text-primary">
        <Icon
          name="expand_more"
          size={18}
          className="transition-transform duration-short2 group-open:rotate-180"
        />
        {summary}
      </summary>
      <div className="pb-1">{children}</div>
    </details>
  );
}

/**
 * A titled row with a trailing M3 switch. The title is wired to the switch through
 * aria-labelledby rather than a wrapping <label>, because a label wrapping a
 * role="switch" button is not an association assistive tech honours.
 */
function ToggleRow({
  title,
  checked,
  onCheckedChange,
  subdued,
}: {
  title: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  subdued?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <span
        id={id}
        className={
          subdued ? "text-body-large text-on-surface-variant" : "text-title-medium text-on-surface"
        }
      >
        {title}
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} labelledBy={id} />
    </div>
  );
}
