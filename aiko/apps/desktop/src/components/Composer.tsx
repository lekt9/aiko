import { ArrowUp, Paperclip } from "lucide-react";
import { useState } from "react";

interface ComposerProps {
  busy: boolean;
  attachment?: string;
  onAttach: () => void;
  onCancel: () => void;
  onSubmit: (value: string) => Promise<void>;
  workspaceName?: string;
}

export function Composer({
  busy,
  attachment,
  onAttach,
  onCancel,
  onSubmit,
  workspaceName,
}: ComposerProps) {
  const [value, setValue] = useState("");

  function submit() {
    const prompt = value.trim();
    if (!prompt) return;
    setValue("");
    void onSubmit(prompt);
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor="aiko-prompt">
        Tell Aiko what outcome you want
      </label>
      <textarea
        id="aiko-prompt"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.nativeEvent.isComposing
          ) {
            return;
          }
          event.preventDefault();
          submit();
        }}
        placeholder={busy ? "Queue a follow-up…" : "What should we make true?"}
        rows={2}
      />
      <div className="composer__controls">
        <button
          className="icon-button"
          type="button"
          aria-label="Add attachment"
          onClick={onAttach}
        >
          <Paperclip size={17} aria-hidden="true" />
        </button>
        <div className="composer__context">
          <span>{workspaceName ?? "Choose workspace"}</span>
          <span aria-hidden="true">·</span>
          <span>{attachment ?? "Default authority"}</span>
        </div>
        {busy && (
          <button className="cancel-button" type="button" onClick={onCancel}>
            Stop
          </button>
        )}
        <button
          className="send-button"
          type="submit"
          disabled={!value.trim()}
          aria-label="Send prompt"
        >
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
