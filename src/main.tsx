import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { StartupTiming } from "./ui/StartupTiming";
import "./ui/styles.css";

window.arkhive?.reportStartupMilestone?.("modules-ready");

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      <StartupTiming />
    </ErrorBoundary>
  </React.StrictMode>
);
