import { createRoot } from "react-dom/client";
import { ControllerApp } from "./ControllerApp";
import "./styles.css";

// No StrictMode: its double-invoked effects would trigger duplicate joins.
createRoot(document.getElementById("root")!).render(<ControllerApp />);
