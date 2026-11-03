import { useTranslation } from "react-i18next";
import { Icon } from "../ui/index.js";

/**
 * Shown while the joined-groups walk has not reached Facebook's last page.
 *
 * A large account is loaded in batches a couple of minutes apart, so for a while the
 * list is short by design. Saying so is the difference between "still loading" and a
 * user concluding that groups are missing.
 *
 * `automatic` is false for a managed account: its next batch needs a cookie swap, which
 * never happens in the background, so it continues only when the user asks.
 */
export function GroupsIncompleteNotice({ count, automatic }: { count: number; automatic: boolean }) {
  const { t } = useTranslation();
  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-md bg-secondary-container px-3 py-2 text-body-medium text-on-secondary-container"
    >
      <Icon name="hourglass_empty" size={18} />
      {automatic
        ? t("groups.incompleteAuto", { n: count })
        : t("groups.incompleteManual", { n: count, load: t("groups.load") })}
    </p>
  );
}
