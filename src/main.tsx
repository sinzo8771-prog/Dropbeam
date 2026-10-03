import { render } from "preact";
import "./ui/fonts.css";
import "./ui/tokens.css";
import "./ui/base.css";
import { App } from "./ui/App";

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");
render(<App />, root);
