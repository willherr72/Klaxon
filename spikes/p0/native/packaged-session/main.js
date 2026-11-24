import { mount } from "svelte";
import "../../portable/main.js";
import SessionCheck from "./SessionCheck.svelte";

mount(SessionCheck, { target: document.getElementById("app") });
