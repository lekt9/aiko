import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Download, KeyRound, Plus } from "lucide-react";
import { api, useAction, useWorkspace } from "../../lib/workspace";
import { useVault } from "../../lib/vault";
import { FormError, Modal } from "./primitives";
export function VaultSettings() {
  const data = useWorkspace();
  const vault = useVault();
  const [name, setName] = useState(data.settings.name);
  const [confirm, setConfirm] = useState<"disconnect" | "reset" | null>(null);
  const source = data.sources.find((s) => s.id === "onepassword")!;
  const save = useAction(
    () => api.settings.update({ ...data.settings, name }),
    "Vault name saved",
  );
  const sourceAction = useAction(
    (connected: boolean) => api.sources.update("onepassword", connected),
    "",
  );
  const reset = useAction(() => api.reset(), "Demo vault reset");
  return (
    <div className="vault-settings">
      <Link to="/" search={vault.search} className="settings-back">
        <ArrowLeft size={18} />
        Back to logins
      </Link>
      <header className="vault-header">
        <div>
          <h1>Settings</h1>
          <p>Make your vault feel at home.</p>
        </div>
      </header>
      <section className="settings-section">
        <h2>Your vault</h2>
        <form
          className="vault-name-form"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label className="field">
            Vault name
            <input
              value={name}
              maxLength={60}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button className="button" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save name"}
          </button>
        </form>
        <FormError error={save.error} />
      </section>
      <section className="settings-section">
        <h2>Bring your logins</h2>
        <p>Start with what you already have.</p>
        <div className="settings-row">
          <span className="setting-icon">
            <Download size={21} />
          </span>
          <div>
            <h3>Import from CSV</h3>
            <p>
              Bring a whole export. Match columns and review all your logins.
            </p>
          </div>
          <button
            className="button"
            onClick={() => vault.setDialog({ kind: "csv" })}
          >
            Import CSV
          </button>
        </div>
        <div className="settings-row">
          <span className="setting-icon">
            <KeyRound size={21} />
          </span>
          <div>
            <h3>
              1Password{" "}
              <span className="small-badge">
                {source.connected ? "Demo connected" : "Disconnected"}
              </span>
            </h3>
            <p>Keep passwords in 1Password. Choose which logins to use here.</p>
          </div>
          <button
            className="button"
            disabled={sourceAction.isPending}
            onClick={() =>
              source.connected
                ? setConfirm("disconnect")
                : sourceAction.mutate(true)
            }
          >
            {source.connected
              ? "Disconnect"
              : sourceAction.isPending
                ? "Connecting…"
                : "Reconnect demo"}
          </button>
        </div>
        {source.connected && (
          <button
            className="text-button add-from-manager"
            onClick={() => vault.setDialog({ kind: "add", mode: "reference" })}
          >
            <Plus size={17} />
            Add a login from 1Password
          </button>
        )}
        <FormError error={sourceAction.error} />
        <p className="helper">
          CSV files are parsed locally; this demo imports only fictional login
          metadata, never passwords. Real password-manager connections are not
          available.
        </p>
      </section>
      <section className="settings-section">
        <details className="advanced">
          <summary>Developer setup</summary>
          <p>
            The typed SDK is in the local <code>@unlock/sdk</code> workspace
            package. Agent connection setup is available under Edit profile.
            OAuth and external integrations are not connected yet.
          </p>
          <pre>
            <code>{`import { createUnlockClient } from '@unlock/sdk'\n\nconst vault = createUnlockClient({\n  baseUrl: 'http://127.0.0.1:4174/api',\n})\nconst logins = await vault.connections.list()`}</code>
          </pre>
          <p>
            Secret material stays in trusted host code, outside agent prompts
            and tool results. See <code>packages/sdk/README.md</code> for the
            private runtime contract.
          </p>
        </details>
      </section>
      <section className="settings-section">
        <details className="advanced">
          <summary>About this demo</summary>
          <p>
            Only fictional logins and a fixed sample password are used. Changes
            are kept in memory until the server restarts. Real credential
            storage, automatic sign-in and agent pairing are not connected.
          </p>
          <button className="button danger" onClick={() => setConfirm("reset")}>
            Reset demo vault
          </button>
        </details>
      </section>
      {confirm && (
        <Modal
          title={
            confirm === "reset"
              ? "Reset your demo vault?"
              : "Disconnect 1Password?"
          }
          close={() => setConfirm(null)}
        >
          <p className="modal-intro">
            {confirm === "reset"
              ? "This removes your demo changes and restores the original sample logins and profiles."
              : "Logins from 1Password will need reconnecting. Imported copies are not affected. Agents already signed in may stay signed in."}
          </p>
          <FormError
            error={confirm === "reset" ? reset.error : sourceAction.error}
          />
          <div className="form-actions">
            <button className="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="button danger"
              disabled={reset.isPending || sourceAction.isPending}
              onClick={() =>
                confirm === "reset"
                  ? reset.mutate(undefined, {
                      onSuccess: () => {
                        setConfirm(null);
                        vault.switchProfile();
                      },
                    })
                  : sourceAction.mutate(false, {
                      onSuccess: () => setConfirm(null),
                    })
              }
            >
              {confirm === "reset" ? "Reset vault" : "Disconnect"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
