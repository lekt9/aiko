/**
 * Tasks panel bound to sessionTranscriptStore content.
 *
 * Keeps AppWorkbench off the stream content subscription — only this
 * bridge re-renders while tools/token steps grow. The heavy panel chunk
 * is lazy-loaded the first time the panel opens.
 */

import { lazy, Suspense } from "react";
import { useViewingMessages } from "@/hooks/useSessionTranscript";
import type { AgentTasksPanelProps } from "@/components/AgentTasksPanel";

const AgentTasksPanel = lazy(async () => {
  const m = await import("@/components/AgentTasksPanel");
  return { default: m.AgentTasksPanel };
});

export type AgentTasksPanelLiveProps = Omit<AgentTasksPanelProps, "messages">;

export function AgentTasksPanelLive(props: AgentTasksPanelLiveProps) {
  const messages = useViewingMessages();
  return (
    <Suspense fallback={null}>
      <AgentTasksPanel {...props} messages={messages} />
    </Suspense>
  );
}
