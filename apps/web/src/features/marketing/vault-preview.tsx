"use client";

import { ArrowUpRight, Lock, Search } from "lucide-react";
import { useState } from "react";
import { SymplistMark } from "@/components/brand/logo";

/**
 * The Vault quick-access panel, as it sits under the menu bar.
 *
 * It is the one part of Symplist that is not a page in the app, so a screenshot of the workspace could
 * never show it. The panel really does look like this — the copy is the shipped copy — and typing a
 * passphrase here opens the list, because a vault you have to take on faith is the wrong thing to
 * illustrate with a still image.
 *
 * Nothing leaves the page: there is no vault behind this and no request is made.
 */

const items: readonly { readonly title: string; readonly type: string; readonly when: string }[] = [
  { title: "Personal API key", type: "Secret", when: "Sep 10" },
  { title: "Recovery notes", type: "Secure note", when: "Aug 30" },
  { title: "Home network notes", type: "Secure note", when: "Jul 22" },
  { title: "Maps API token", type: "Secret", when: "Aug 2" },
];

export function VaultPreview() {
  const [passphrase, setPassphrase] = useState("");
  const [unlocked, setUnlocked] = useState(false);

  return (
    <section id="vault" className="sym-section" aria-labelledby="sym-vault-heading">
      <div className="sym-vault-head">
        <div>
          <p className="sym-eyebrow">The vault</p>
          <h2 id="sym-vault-heading" className="sym-display">
            One secret, without opening the app.
          </h2>
        </div>
        <p className="sym-section-lede">
          The desktop app puts Symplist in the menu bar. Click it, enter the vault passphrase —
          which is not your sign-in — and the panel lists what is in there. It locks again when the
          panel closes.
        </p>
      </div>

      <div className="sym-vault-stage">
        {/* The menu bar the panel hangs from, so the panel reads as a popover rather than a window. */}
        <div aria-hidden="true" className="sym-vault-menubar">
          <span className="sym-vault-menubar-app">Finder</span>
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Go</span>
          <span className="sym-vault-menubar-right">
            <SymplistMark className="sym-vault-menubar-mark" />
            Wed 09:41
          </span>
        </div>

        <fieldset className="sym-vault-panel">
          <legend className="sr-only">Vault quick access</legend>
          {unlocked ? (
            <>
              <div className="sym-vault-panel-head">
                <span className="sym-vault-panel-title">
                  <Lock size={13} strokeWidth={2} aria-hidden="true" />
                  Vault
                </span>
                <span className="sym-vault-timer">Locks in 4:32</span>
              </div>
              <div className="sym-vault-search">
                <Search size={13} strokeWidth={2} aria-hidden="true" />
                <span>Search vault</span>
                <span className="sym-kbd">⌘F</span>
              </div>
              <ul className="sym-vault-items">
                {items.map((item) => (
                  <li key={item.title}>
                    <span className="sym-vault-item-title">{item.title}</span>
                    <span className="sym-vault-item-meta">{`${item.type} · ${item.when}`}</span>
                  </li>
                ))}
              </ul>
              <div className="sym-vault-foot">
                <span>
                  Open full vault <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
                </span>
                <button type="button" onClick={() => setUnlocked(false)}>
                  ⌘L lock
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="sym-vault-panel-head">
                <span className="sym-vault-panel-title">
                  <Lock size={13} strokeWidth={2} aria-hidden="true" />
                  Vault
                </span>
                <span className="sym-vault-who">maya@example.com</span>
              </div>
              <div className="sym-vault-locked">
                <h3>Your vault is locked</h3>
                <p>Enter your vault passphrase. It is separate from signing in.</p>
                <form
                  className="sym-vault-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (passphrase.length > 0) setUnlocked(true);
                  }}
                >
                  <label className="sr-only" htmlFor="sym-vault-demo-passphrase">
                    Vault passphrase, for this demonstration only
                  </label>
                  <input
                    id="sym-vault-demo-passphrase"
                    type="password"
                    autoComplete="off"
                    placeholder="Vault passphrase"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                  <button type="submit" disabled={passphrase.length === 0}>
                    Unlock
                  </button>
                </form>
              </div>
              <div className="sym-vault-foot">
                <span>Locks when this panel closes</span>
              </div>
            </>
          )}
        </fieldset>
      </div>

      <p className="sym-fine sym-vault-note">
        A demonstration — type anything. There is no vault behind this page and nothing is sent
        anywhere.
      </p>
    </section>
  );
}
