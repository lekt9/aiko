import React from "react";
import { createRoot } from "react-dom/client";
import { ConnectorOnboarding } from "../src/components/connector-onboarding";
import "../src/styles/vault.css";
import "../src/styles/apps.css";
import "../src/styles/gateway.css";
createRoot(document.getElementById("root")!).render(<main style={{maxWidth:960,margin:"0 auto",padding:"32px 20px"}}><p className="aiko-eyebrow">AIKO BY UNBROWSE</p><h1 style={{fontSize:36,marginTop:12}}>Your apps, connected.</h1><ConnectorOnboarding /></main>);
