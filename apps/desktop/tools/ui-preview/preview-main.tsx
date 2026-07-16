/**
 * UI-preview entry: install the mock `window.vibe` bridge, then mount the real
 * renderer App (without StrictMode, so scripted event timelines run once and
 * screenshots are deterministic).
 */
import "./mock-vibe";
import { createRoot } from "react-dom/client";
import { App } from "../../src/renderer/App";
import "../../src/renderer/styles.css";

createRoot(document.getElementById("root")!).render(<App />);
