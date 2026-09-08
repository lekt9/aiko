import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { nativeLoginCatalog, nativeLoginRenderSpec, resolveNativeLoginLayout } from "../src/lib/native-login-render";
import { NativeLoginFields, nativeLoginRegistry } from "../src/components/native-login-fields";
import { LOGIN_UI_VERSION, fallbackLoginSpec, validateLoginSpec, type LoginSpec } from "../../../packages/protocol/src/login-ui";

const controls = { disabled: false, showPassword: false, togglePassword() {} };
function composition(): LoginSpec {
  return { root: "surface", elements: {
    surface: { type: "LoginStack", props: { spacing: "comfortable" }, children: ["title", "hint", "inputs", "go"] },
    title: { type: "LoginHeading", props: { text: "Sign in" }, children: [] },
    hint: { type: "LoginHint", props: { message: "account_details" }, children: [] },
    inputs: { type: "LoginStack", props: { spacing: "compact" }, children: ["user", "pass"] },
    user: { type: "UsernameField", props: {}, children: [] },
    pass: { type: "PasswordField", props: {}, children: [] },
    go: { type: "LoginSubmit", props: { label: "Continue" }, children: [] },
  } };
}
const envelope = (spec: unknown) => ({ version: LOGIN_UI_VERSION, source: "generated", spec });
describe("generative private login registry", () => {
  it("renders the generated composition, not a field-to-layout mapping", () => {
    const spec = composition(), layout = envelope(spec);
    expect(nativeLoginCatalog.validate(spec).success).toBe(true);
    expect(Object.keys(nativeLoginRegistry).sort()).toEqual(nativeLoginCatalog.componentNames.toSorted());
    expect(nativeLoginRenderSpec(["username", "password"], layout)).toEqual(spec);
    const markup = renderToStaticMarkup(<NativeLoginFields {...controls} fields={["username", "password"]} layout={layout} />);
    expect(markup).toContain('data-login-layout="generated"');
    expect(markup).toContain("<h4>Sign in</h4>");
    expect(markup).toContain("Use your account details for this website.");
    expect(markup).toContain("Continue</button>");
    expect(markup).toContain("gap:0.75rem");
    expect(markup).not.toContain("<form"); // The private host owns submission.
    expect(spec).not.toEqual(fallbackLoginSpec(["username", "password"]));
  });

  it.each([
    [], ["username"], ["password"], ["code"], ["username", "password"],
    ["username", "code"], ["password", "code"], ["username", "password", "code"],
  ].map(fields => ({ fields })))("fallback still renders exactly the observed fields: $fields", ({ fields }) => {
    const spec = nativeLoginRenderSpec(fields)!;
    expect(validateLoginSpec(spec, fields)).toEqual(spec);
    const markup = renderToStaticMarkup(<NativeLoginFields {...controls} fields={fields} />);
    for (const kind of ["username", "password", "code"])
      expect(markup.includes(`name="${kind}"`)).toBe(fields.includes(kind));
    expect(markup).toContain('data-login-layout="fallback"');
    expect((markup.match(/type="submit"/g) ?? []).length).toBe(fields.length ? 1 : 0);
  });

  it("keeps fallback identity stable and imported usernames outside specs", () => {
    expect(nativeLoginRenderSpec(["password", "username"])).toEqual(nativeLoginRenderSpec(["username", "password"]));
    const spec = composition();
    expect(spec).not.toHaveProperty("state");
    const markup = renderToStaticMarkup(<NativeLoginFields {...controls} fields={["username", "password"]} layout={envelope(spec)} initialUsername="fixture-private-user" />);
    expect(markup).toContain('value="fixture-private-user"');
    expect(JSON.stringify(spec)).not.toContain("fixture-private-user");
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="current-password"');
  });

  it.each([
    null, {}, "password", ["password", "password"], ["username", "secret_question"],
    [{ kind: "password", value: "fixture-secret" }], ["$bindState"], ["<script>alert(1)</script>"],
  ].map(fields => ({ fields })))("refuses malformed or invented fields: $fields", ({ fields }) => {
    expect(nativeLoginRenderSpec(fields)).toBeUndefined();
    const markup = renderToStaticMarkup(<NativeLoginFields {...controls} fields={fields} layout={envelope(composition())} />);
    expect(markup).toContain("not supported yet");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("fixture-secret");
    expect(markup).not.toContain("<script");
  });

  it.each([
    ["value props", (s: any) => { s.elements.pass.props.value = "fixture-secret"; }],
    ["bindings", (s: any) => { s.elements.pass.props.value = { $bindState: "/secret" }; }],
    ["state", (s: any) => { s.state = { password: "fixture-secret" }; }],
    ["action", (s: any) => { s.elements.go.on = { press: { action: "fetch", params: { url: "https://evil.example" } } }; }],
    ["HTML", (s: any) => { s.elements.title.props.text = "<img src=x onerror=alert(1)>"; }],
    ["missing field", (s: any) => { delete s.elements.pass; s.elements.inputs.children = ["user"]; }],
    ["extra field", (s: any) => { s.elements.otp = { type: "VerificationCodeField", props: {}, children: [] }; s.elements.inputs.children.push("otp"); }],
    ["duplicate field", (s: any) => { s.elements.other = { ...s.elements.pass }; s.elements.inputs.children.push("other"); }],
    ["cycle", (s: any) => { s.elements.inputs.children.push("surface"); }],
    ["missing reference", (s: any) => { s.elements.inputs.children.push("missing"); }],
    ["orphan", (s: any) => { s.elements.orphan = { ...s.elements.title }; }],
    ["shared node", (s: any) => { s.elements.inputs.children.push("user"); }],
    ["hidden input", (s: any) => { s.elements.pass.visible = false; }],
    ["early submit", (s: any) => { s.elements.surface.children = ["go", "title", "hint", "inputs"]; }],
    ["missing submit", (s: any) => { delete s.elements.go; s.elements.surface.children.pop(); }],
    ["unknown component", (s: any) => { s.elements.pass.type = "RemoteBrowser"; }],
  ] as const)("rejects unsafe generation (%s) before rendering and uses explicit fallback", (_name, corrupt) => {
    const spec = composition(); corrupt(spec);
    expect(validateLoginSpec(spec, ["username", "password"])).toBeUndefined();
    expect(resolveNativeLoginLayout(["username", "password"], envelope(spec))?.source).toBe("fallback");
    const markup = renderToStaticMarkup(<NativeLoginFields {...controls} fields={["username", "password"]} layout={envelope(spec)} />);
    expect(markup).toContain('data-login-layout="fallback"');
    expect(markup).not.toContain("fixture-secret");
    expect(markup).not.toContain("evil.example");
  });

  it("rejects deep graphs and old catalog versions; codes allow letters and digits", () => {
    const spec = composition();
    for (let i = 0; i < 5; i++) {
      const child = spec.root; spec.root = `nested${i}`;
      spec.elements[spec.root] = { type: "LoginStack", props: { spacing: "compact" }, children: [child] };
    }
    expect(validateLoginSpec(spec, ["username", "password"])).toBeUndefined();
    expect(resolveNativeLoginLayout(["username", "password"], { ...envelope(composition()), version: "old" })?.source).toBe("fallback");
    for (const source of [null, 42, { toString: null }])
      expect(resolveNativeLoginLayout(["username", "password"], { ...envelope(composition()), source })?.source).toBe("fallback");
    const markup = renderToStaticMarkup(<NativeLoginFields {...controls} disabled fields={["code"]} />);
    expect(markup).toContain('autoComplete="one-time-code"');
    expect(markup).toContain("disabled");
    expect(markup).not.toContain('inputMode="numeric"');
  });
});
