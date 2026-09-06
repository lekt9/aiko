/** Demo data is an explicit development-only opt-in. Production builds cannot enable it. */
export const DEMO_WORKSPACE =
  import.meta.env.DEV && import.meta.env.VITE_AIKO_DEMO === "true";
