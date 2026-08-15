import { IconAikoMark } from "@/components/icons";

/** Aiko App brand mark; color follows the surrounding text. */
export function AikoLogo({ size = 22 }: { size?: number }) {
  return <IconAikoMark size={size} className="aiko-logo" title="Aiko" />;
}
