import { useEffect, useState } from "react";
import { cn } from "../ui/index.js";

export interface AvatarProps {
  /** Facebook profile picture URL. CDN-signed, so it can 404 once the signature expires. */
  src?: string;
  /** Name the avatar stands for; its first character is the fallback. */
  name?: string;
  size?: number;
  className?: string;
}

/**
 * Profile picture with a graceful fallback to an initial.
 *
 * Facebook's avatar URLs are signed and expire, so a broken image is expected rather
 * than exceptional — it must degrade to something identifying, not a torn-image icon.
 * Decorative either way: every call site already names the account in adjacent text.
 */
export function Avatar({ src, name, size = 40, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  // A newly scraped URL deserves another attempt.
  useEffect(() => setFailed(false), [src]);

  const initial = (name ?? "").trim().slice(0, 1).toUpperCase();

  return (
    <span
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full",
        "bg-primary-container text-title-medium text-on-primary-container",
        className,
      )}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden>{initial || "?"}</span>
      )}
    </span>
  );
}
