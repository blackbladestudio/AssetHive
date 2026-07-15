import React, { Component, ErrorInfo, ReactNode } from "react";
const appBrandIconPath = new URL("../../LOGO/Icon_V2_256.png", import.meta.url).href;

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ position: "relative", height: "100vh", background: "#121212", color: "#fff" }}>
          <button
            onClick={() => {
              const bridge = (window as unknown as { arkhive?: { windowClose?: () => void } }).arkhive;
              if (bridge && typeof bridge.windowClose === "function") {
                bridge.windowClose();
              } else {
                window.close();
              }
            }}
            title="Close"
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              width: 48,
              height: 48,
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: 30,
              lineHeight: 1,
              opacity: 0.85
            }}
          >
            ×
          </button>
          <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24 }}>
            <img src={appBrandIconPath} alt="AssetHive" style={{ width: 82, height: 82, objectFit: "contain", opacity: 0.95 }} />
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, letterSpacing: ".04em" }}>Something went wrong</h2>
            <p style={{ margin: 0, color: "#ff5252", maxWidth: 600, textAlign: "center" }}>{this.state.error?.message}</p>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: 8,
                padding: "8px 16px",
                background: "#2196f3",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 12
              }}
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
