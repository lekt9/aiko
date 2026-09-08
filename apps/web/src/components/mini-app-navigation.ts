import { createContext, type ReactNode } from "react";

/** Account-owned navigation, also visible on full-screen pages without remounting their task. */
export const MiniAppNavigationContext = createContext<ReactNode>(null);
