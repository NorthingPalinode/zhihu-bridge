import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// 字体随包打包（离线可用，不依赖外链）
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/600.css";
import "./styles.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
