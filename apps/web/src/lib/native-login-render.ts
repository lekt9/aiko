import { LOGIN_UI_VERSION, fallbackLoginSpec, loginFields, validateLoginSpec, type LoginLayout } from "../../../../packages/protocol/src/login-ui";
export { nativeLoginCatalog, loginFields, type LoginFieldKind as NativeLoginFieldKind } from "../../../../packages/protocol/src/login-ui";

/** Treat model/host specs as untrusted, even after server validation. */
export function resolveNativeLoginLayout(fields: unknown, value?: unknown): LoginLayout | undefined {
  if (!loginFields(fields)) return;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const layout = value as Record<string, unknown>;
    if (Object.keys(layout).every(key => ["version", "source", "spec"].includes(key)) &&
        layout.version === LOGIN_UI_VERSION && (layout.source === "generated" || layout.source === "fallback")) {
      const spec = validateLoginSpec(layout.spec, fields);
      if (spec) return { version: LOGIN_UI_VERSION, source: layout.source, spec };
    }
  }
  return { version: LOGIN_UI_VERSION, source: "fallback", spec: fallbackLoginSpec(fields)! };
}

/** Compatibility helper for callers that need the validated spec alone. */
export function nativeLoginRenderSpec(fields: unknown, layout?: unknown) {
  return resolveNativeLoginLayout(fields, layout)?.spec;
}
