import { createContext, useContext, useState } from "react";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";
import { Eye, EyeOff } from "lucide-react";
import { nativeLoginCatalog, loginFields, resolveNativeLoginLayout, type NativeLoginFieldKind } from "../lib/native-login-render";
import type { LoginLayout } from "../../../../packages/protocol/src/login-ui";

interface PrivateInputControls {
  disabled: boolean;
  busy?: boolean;
  initialUsername?: string;
  showPassword: boolean;
  togglePassword: () => void;
}
// Host-only controls, not json-render state. There is deliberately no password,
// code, request transport or generic action dispatcher in this context.
const Controls = createContext<PrivateInputControls | null>(null);
const labels: Record<NativeLoginFieldKind, string> = {
  username: "Email or username", password: "Password", code: "Verification code",
};
const placeholders: Record<NativeLoginFieldKind, string> = {
  username: "you@example.com", password: "Enter your password", code: "Enter code",
};
const autocomplete: Record<NativeLoginFieldKind, string> = {
  username: "username", password: "current-password", code: "one-time-code",
};

function PrivateInput({ kind }: { kind: NativeLoginFieldKind }) {
  const controls = useContext(Controls);
  if (!controls) throw new Error("Private login controls missing");
  const password = kind === "password";
  const input = <input
    id={`website-${kind}`}
    name={kind}
    type={password && !controls.showPassword ? "password" : "text"}
    placeholder={placeholders[kind]}
    autoComplete={autocomplete[kind]}
    autoCapitalize="none"
    spellCheck={false}
    maxLength={2048}
    required
    defaultValue={kind === "username" ? controls.initialUsername ?? "" : undefined}
    disabled={controls.disabled}
  />;
  return <div className="credential-field">
    <label htmlFor={`website-${kind}`}>{labels[kind]}</label>
    {password ? <div className="credential-password">
      {input}
      <button
        type="button"
        className="icon-button"
        aria-label={controls.showPassword ? "Hide password" : "Show password"}
        aria-pressed={controls.showPassword}
        disabled={controls.disabled}
        onClick={controls.togglePassword}
      >
        {controls.showPassword ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
      </button>
    </div> : input}
  </div>;
}

function PrivateSubmit({ label }: { label: string }) {
  const controls = useContext(Controls);
  if (!controls) throw new Error("Private login controls missing");
  return <button className="button primary credential-submit" type="submit" disabled={controls.disabled}>
    {controls.busy ? "Connecting…" : label}
  </button>;
}

/** The full registry is shared by generated and fallback compositions. No
 * component can dispatch a model action, read another field, or choose a URL. */
export const { registry: nativeLoginRegistry } = defineRegistry(nativeLoginCatalog, {
  components: {
    LoginStack: ({ props, children }) => <div className="credential-fields" style={{ gap: props.spacing === "compact" ? "0.75rem" : "1rem" }}>{children}</div>,
    LoginHeading: ({ props }) => <h4>{props.text}</h4>,
    LoginHint: ({ props }) => <p className="aiko-fineprint">{props.message === "verification_code"
      ? "Enter the verification code from your email or app."
      : "Use your account details for this website."}</p>,
    UsernameField: () => <PrivateInput kind="username" />,
    PasswordField: () => <PrivateInput kind="password" />,
    VerificationCodeField: () => <PrivateInput kind="code" />,
    LoginSubmit: ({ props }) => <PrivateSubmit label={props.label} />,
  },
});
const noActions = {};

function LoginComposition({ initialLayout, ...controls }: PrivateInputControls & { initialLayout: LoginLayout }) {
  // Pin presentation while the owner types. A regenerated layout must not move
  // uncontrolled inputs to another parent and silently erase a credential draft.
  const [layout] = useState(initialLayout);
  return <Controls.Provider value={controls}>
    <div data-login-layout={layout.source}>
      <JSONUIProvider registry={nativeLoginRegistry} handlers={noActions}>
        <Renderer spec={layout.spec} registry={nativeLoginRegistry} />
      </JSONUIProvider>
    </div>
  </Controls.Provider>;
}

/** Native DOM inputs belong to the enclosing private form, never JSON state. */
export function NativeLoginFields({ fields, layout, ...controls }: PrivateInputControls & { fields: unknown; layout?: unknown }) {
  const kinds = loginFields(fields), resolved = resolveNativeLoginLayout(fields, layout);
  if (!kinds || !resolved) return <p className="credential-error" role="alert">This sign-in step is not supported yet. Check sign-in status after completing any verification in the app.</p>;
  return <LoginComposition key={kinds.join(",")} initialLayout={resolved} {...controls} />;
}
