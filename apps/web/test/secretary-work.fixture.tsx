import { createRoot } from "react-dom/client";
import { SecretaryWorkPanel } from "../src/components/secretary-work-panel";
import "../src/styles/mini-app.css";

async function request<T>(
  path: string,
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: body ? "POST" : "GET",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secretary-preview-only",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result;
}
function Preview() {
  return (
    <main
      style={{
        maxWidth: 720,
        margin: "24px auto",
        padding: 20,
        background: "var(--surface)",
        borderRadius: 18,
      }}
    >
      <p className="aiko-fineprint">
        Local preview · synthetic contact and simulated delivery
      </p>
      <SecretaryWorkPanel request={request} />
      <details>
        <summary>Preview controls</summary>
        <button
          onClick={() =>
            void fetch("/preview/reply", {
              method: "POST",
              headers: { authorization: "Bearer secretary-preview-only" },
            })
          }
        >
          Simulate Maya’s reply
        </button>
        <p>
          Refresh work after simulating a reply. All data stays in this isolated
          preview.
        </p>
      </details>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
