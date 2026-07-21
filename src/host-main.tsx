import { createRoot } from "react-dom/client";
import { HostApp } from "./HostApp";
import "./styles.css";

// No StrictMode: its double-invoked effects would open two network sessions.
createRoot(document.getElementById("root")!).render(<HostApp />);
