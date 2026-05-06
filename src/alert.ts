import "./app.css";
import Alert from "./Alert.svelte";
import { mount } from "svelte";

const app = mount(Alert, { target: document.getElementById("alert")! });

export default app;
