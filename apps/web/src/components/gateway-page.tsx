import { ArrowUpRight, MessageCircle } from "lucide-react";
import { ConnectorOnboarding } from "./connector-onboarding";
import { AIKO_TELEGRAM_URL } from "../lib/telegram";

export function GatewayPage() {
  return (
    <div className="gateway-page">
      <header className="gateway-header">
        <a className="gateway-brand" href="/" aria-label="Aiko home">
          <span aria-hidden="true">a.</span>
          <div>
            Aiko<small>by Unbrowse</small>
          </div>
        </a>
        <a className="text-button" href={AIKO_TELEGRAM_URL} rel="noreferrer">
          Open Telegram <ArrowUpRight size={17} aria-hidden="true" />
        </a>
      </header>
      <main id="main-content" className="gateway-main">
        <section className="gateway-intro" aria-labelledby="gateway-title">
          <p className="aiko-eyebrow">A CONVERSATION TO COME BACK TO.</p>
          <h1 id="gateway-title">
            Good to talk.
            <br />
            Better to remember.
          </h1>
          <p className="gateway-description">
            Ask a question, keep a useful decision, or send a public page to
            read. Aiko keeps the conversation in Telegram, with memory that
            belongs to your account.
          </p>
          <a
            className="button primary gateway-cta"
            href={AIKO_TELEGRAM_URL}
            rel="noreferrer"
          >
            <MessageCircle size={20} aria-hidden="true" /> Open Aiko in Telegram
          </a>
          <p className="gateway-hint">
            Press Start in the bot. No passwords or API keys in chat.
          </p>
        </section>
        <aside className="gateway-notes" aria-label="Example requests">
          <p className="aiko-eyebrow">TRY SAYING</p>
          <blockquote>“Remember: launch reviews use UTC.”</blockquote>
          <blockquote>“What did we decide about the launch?”</blockquote>
          <blockquote>
            “Read this public page and explain the important parts.”
          </blockquote>
          <p>Include the exact page URL when asking Aiko to read it.</p>
        </aside>
        <ConnectorOnboarding />
        <section
          className="gateway-boundaries"
          aria-label="Your data and available capabilities"
        >
          <div>
            <h2>Your account. Your context.</h2>
            <p>
              Conversations and cited memory are kept separately for each
              account. Remembered messages are records—not automatically
              verified facts.
            </p>
          </div>
          <div>
            <h2>No pretend connections.</h2>
            <p>
              Private apps are not connected until you authorize them. Search
              above to check availability. A website request does not mean its
              integration works; discovery and verification may be needed.
            </p>
          </div>
        </section>
        <details className="gateway-sdk">
          <summary>Connecting another agent?</summary>
          <p>
            Use the account-scoped HTTP plane or <code>@unlock/sdk/aiko</code>.
            Ask your operator for a credential bound to your account. Telegram
            is one gateway; it is not required by the SDK.
          </p>
        </details>
      </main>
      <footer className="gateway-footer">
        <span>Aiko by Unbrowse</span>
        <span>AI answers can be wrong. Check important information.</span>
      </footer>
    </div>
  );
}
