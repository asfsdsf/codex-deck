import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CodexDeckApp from "./app/codex-deck-app";

const rootElement =
  typeof document !== "undefined" ? document.getElementById("root") : null;

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <CodexDeckApp />
    </StrictMode>,
  );
}
