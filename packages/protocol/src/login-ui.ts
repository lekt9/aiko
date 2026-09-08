import { defineCatalog, defineSchema } from "@json-render/core";
import { z } from "zod";

export const LOGIN_UI_VERSION = "private-login/v2";
export const loginFieldKind = z.enum(["username", "password", "code"]);
export type LoginFieldKind = z.infer<typeof loginFieldKind>;
const fieldsSchema = z.array(loginFieldKind).max(3).refine(fields => new Set(fields).size === fields.length);
export function loginFields(value: unknown): LoginFieldKind[] | undefined {
  const parsed = fieldsSchema.safeParse(value);
  return parsed.success ? loginFieldKind.options.filter(kind => parsed.data.includes(kind)) : undefined;
}

// A json-render schema with no state, expressions, event bindings or built-in
// actions. React's general-purpose schema encourages stateful forms; login must not.
const schema = defineSchema(s => ({
  spec: s.object({ root: s.string(), elements: s.record(s.object({
    type: s.ref("catalog.components"), props: s.propsOf("catalog.components"), children: s.array(s.string()),
  })) }),
  catalog: s.object({ components: s.map({ props: s.zod(), slots: s.array(s.string()), description: s.string() }), actions: s.map({ params: s.zod(), description: s.string() }) }),
}), {
  // Do not inherit the general renderer's JSONL/sample-data/state tutorial.
  promptTemplate: ({ catalog, componentNames, options, formatZodType }) => {
    const { components } = catalog as { components: Record<string, { props: z.ZodType; description: string }> };
    return ["Compose a private sign-in UI using this json-render component catalog. Output one complete JSON spec.",
      ...componentNames.map(name => `${name}: ${components[name]!.description}\nProps: ${formatZodType(components[name]!.props)}`),
      ...(options.customRules ?? []),
    ].join("\n\n");
  },
});
const empty = z.object({}).strict();
export const nativeLoginCatalog = defineCatalog(schema, {
  components: {
    LoginStack: { props: z.object({ spacing: z.enum(["compact", "comfortable"]) }).strict(), slots: ["default"], description: "A vertical group. Compose headings, hints, nested field groups, and the submit button." },
    LoginHeading: { props: z.object({ text: z.enum(["Sign in", "Continue signing in", "Verify your sign-in"]) }).strict(), description: "An optional heading appropriate to this observed step." },
    LoginHint: { props: z.object({ message: z.enum(["account_details", "verification_code"]) }).strict(), description: "Reviewed guidance: account_details for username/password; verification_code for a code step." },
    UsernameField: { props: empty, description: "Private username/email input. Include exactly once only when username is observed. Never supply a value." },
    PasswordField: { props: empty, description: "Private masked password input with host-owned reveal control. Include exactly once only when password is observed." },
    VerificationCodeField: { props: empty, description: "Private verification-code input. Include exactly once only when code is observed. Values are never in this spec." },
    LoginSubmit: { props: z.object({ label: z.enum(["Continue", "Connect", "Verify and connect"]) }).strict(), description: "One native form submit button, last after all fields. Host owns submission; no action or event binding." },
  },
  actions: {},
});

const key = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const leaf = <T extends keyof typeof nativeLoginCatalog.data.components>(type: T) => z.object({
  type: z.literal(type), props: nativeLoginCatalog.data.components[type].props, children: z.tuple([]),
}).strict();
const element = z.discriminatedUnion("type", [
  z.object({ type: z.literal("LoginStack"), props: nativeLoginCatalog.data.components.LoginStack.props, children: z.array(key).max(12) }).strict(),
  leaf("LoginHeading"), leaf("LoginHint"), leaf("UsernameField"), leaf("PasswordField"), leaf("VerificationCodeField"), leaf("LoginSubmit"),
]);
export const loginSpecSchema = z.object({ root: key, elements: z.record(key, element) }).strict();
export type LoginSpec = z.infer<typeof loginSpecSchema>;
export interface LoginLayout { version: typeof LOGIN_UI_VERSION; source: "generated" | "fallback"; spec: LoginSpec }
const componentField: Partial<Record<keyof typeof nativeLoginCatalog.data.components, LoginFieldKind>> = {
  UsernameField: "username", PasswordField: "password", VerificationCodeField: "code",
};

/** Strict props + whole-tree invariants. catalog.validate alone does not validate
 * multi-component props in json-render 0.20. No model output grants authority. */
export function validateLoginSpec(raw: unknown, observed: unknown): LoginSpec | undefined {
  const fields = loginFields(observed), parsed = loginSpecSchema.safeParse(raw);
  if (!fields || !parsed.success) return;
  const spec = parsed.data, count = Object.keys(spec.elements).length;
  if (count > 18 || spec.elements[spec.root]?.type !== "LoginStack") return;
  const seen = new Set<string>(), found: LoginFieldKind[] = [];
  let submits = 0, headings = 0, hints = 0;
  function visit(id: string, depth: number): boolean {
    const node = spec.elements[id];
    if (!node || seen.has(id) || depth > 4) return false;
    seen.add(id);
    const field = componentField[node.type];
    if (field) { if (submits || found.includes(field)) return false; found.push(field); }
    if (node.type === "LoginSubmit" && ++submits > 1) return false;
    if (node.type === "LoginHeading" && ++headings > 1) return false;
    if (node.type === "LoginHint") {
      if (++hints > 1 || (node.props as { message: string }).message === "verification_code" && !fields!.includes("code")) return false;
    }
    return node.children.every(child => visit(child, depth + 1));
  }
  if (!visit(spec.root, 0) || seen.size !== count || found.length !== fields.length ||
      fields.some(field => !found.includes(field)) || submits !== (fields.length ? 1 : 0)) return;
  return spec;
}

/** Explicit recovery/older-host path, never labeled model-generated. */
export function fallbackLoginSpec(observed: unknown): LoginSpec | undefined {
  const fields = loginFields(observed);
  if (!fields) return;
  const spec: LoginSpec = { root: "login", elements: {
    login: { type: "LoginStack", props: { spacing: "comfortable" }, children: fields.length ? [...fields, "submit"] : [] },
  } };
  for (const field of fields) {
    const type = field === "username" ? "UsernameField" : field === "password" ? "PasswordField" : "VerificationCodeField";
    spec.elements[field] = { type, props: {}, children: [] };
  }
  if (fields.length) spec.elements.submit = { type: "LoginSubmit", props: { label: fields.includes("code") ? "Verify and connect" : "Connect" }, children: [] };
  return spec;
}

// The catalog drives generation using its private, inert JSON contract.
export const LOGIN_UI_PROMPT = nativeLoginCatalog.prompt({ customRules: [
  "Return one complete JSON object with root and elements, not JSONL patches or Markdown. This is a private sign-in form, not a sample-data UI.",
  "Compose a useful layout from the catalog. Choose grouping, spacing, optional heading/help and submit label for the observed step. Prefer Continue for a single username/password field and Verify and connect for a code step.",
  "Include every observed field exactly once and no other fields. Put exactly one LoginSubmit after the inputs. Root must be LoginStack; maximum 18 elements and depth 4. No unused nodes, cycles, shared children or duplicate headings/hints.",
  "Only the documented literal props are permitted. Never include state, values, defaults, expressions, visibility, repeat, slots, on, actions, URLs, HTML, scripts, or invented component names. No tools are available. Credentials are entered later into private DOM inputs and never supplied to you.",
] });
