import "./app.css";
import Capture from "./Capture.svelte";
import { mount } from "svelte";

const app = mount(Capture, { target: document.getElementById("capture")! });

export default app;
