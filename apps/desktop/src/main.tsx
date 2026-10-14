import ReactDOM from "react-dom/client";
import App from "./App";
import { applyPreferences, loadPreferences } from "./preferences";
import { IS_MACOS } from "./platform";

applyPreferences(loadPreferences());

// The window ships undecorated so Windows/Linux get the integrated custom
// title bar. macOS keeps its native traffic lights, restored here before the
// first paint to avoid a frame without them.
if (IS_MACOS) {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setDecorations(true))
    .catch(() => undefined);
}

// WebView2 turns touchpad pinch (and Ctrl+wheel) into browser page zoom, which
// stretches the whole app like a web page. Swallow those wheel events at the
// window level; the terminal pane's own handler still runs afterwards and maps
// them to font-size changes.
window.addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey) event.preventDefault();
  },
  { passive: false, capture: true },
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
