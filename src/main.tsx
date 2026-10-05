import { render } from "preact";
import "./ui/fonts.css";
import "./ui/tokens.css";
import "./ui/base.css";
import { App } from "./ui/App";

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");
render(<App />, root);

/**
 * Service worker (FR-50). Registered only in the production build:
 * `vite dev` serves files that change on every save, which would
 * churn the cache. The worker announces a takeover to tabs still
 * running the previous build; that is surfaced as the
 * "New version, reload" prompt in the app shell.
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(
    // Offline-first is a bonus, never a blocker: a failed
    // registration (private mode, file:// preview) just means
    // the app runs as a plain page.
    () => {},
  );
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "dropbeam.updated") {
      window.dispatchEvent(new CustomEvent("dropbeam:update"));
    }
  });
}
