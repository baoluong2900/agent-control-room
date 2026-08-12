import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "../web/api-client";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

