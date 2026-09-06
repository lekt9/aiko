import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import type { Profile } from "@unlock/sdk";
import { useNotify } from "../../lib/workspace";
export { Modal, ServiceIcon } from "../ui";
export function Avatar({
  profile,
  small = false,
}: {
  profile?: Profile;
  small?: boolean;
}) {
  const color =
    profile?.avatar ??
    (profile?.id === "research"
      ? "mint"
      : profile?.id === "design"
        ? "peach"
        : "violet");
  return (
    <span
      aria-hidden="true"
      className={`v-avatar ${color} ${small ? "small" : ""}`}
    >
      {profile ? (
        profile.name
          .split(" ")
          .slice(0, 2)
          .map((s) => s[0])
          .join("")
          .toUpperCase()
      ) : (
        <KeyRound size={small ? 16 : 21} />
      )}
    </span>
  );
}
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const notify = useNotify();
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          notify("Clipboard unavailable. Select the text to copy it.");
        }
      }}
    >
      {copied ? <Check size={18} /> : <Copy size={18} />}
    </button>
  );
}
export function FormError({ error }: { error?: Error | null }) {
  return (
    <div className="form-error" role={error ? "alert" : undefined}>
      {error?.message}
    </div>
  );
}
