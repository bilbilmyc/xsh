import ReactDOM from "react-dom/client";
import App from "./App";
import { applyPreferences, loadPreferences } from "./preferences";

applyPreferences(loadPreferences());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
