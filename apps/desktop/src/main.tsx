import ReactDOM from "react-dom/client";
import App from "./App";
import { applyPreferences, loadPreferences } from "./preferences";

applyPreferences(loadPreferences());

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
