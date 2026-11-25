import { ConvexClient } from "convex/browser";
import { anyApi as api } from "convex/server";

// This independent Edge page uses the signup session while the packaged host
// signs in separately. Only subscription callbacks write the control list.
window.startControl = bearer => {
  const client = new ConvexClient("http://127.0.0.1:3210", {
    logger: false, expectAuth: true, initialAuthTokenReuse: true,
  });
  client.setAuth(async () => bearer);
  const list = document.querySelector("ul");
  let callbacks = 0;
  let errors = 0;
  window.controlState = () => ({ connected: client.connectionState().isWebSocketConnected,
    authenticated: client.getAuth()?.token === bearer, rows: list.children.length, callbacks, errors });
  client.onUpdate(api.tasks.list, {}, tasks => {
    callbacks++;
    list.replaceChildren(...tasks.map(task => {
      const row = document.createElement("li");
      row.dataset.id = task._id;
      row.textContent = task.title;
      return row;
    }));
  }, () => { errors++; });
};
