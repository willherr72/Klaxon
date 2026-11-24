import { mount } from "svelte";
import "../../portable/main.js";
import SessionCheck from "./SessionCheck.svelte";

const target = document.getElementById("app");
if (P0_WINDOWS_TASKS && location.hash === "#sdk") {
  import("./SdkSessionCheck.svelte").then(({ default: check }) => mount(check, { target }));
} else {
  mount(SessionCheck, { target });
}
