import auth from "@convex-dev/auth/convex.config";
import password from "@convex-dev/auth/components/password/convex.config";
import username from "@convex-dev/auth/components/username/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(auth);
app.use(username);
app.use(password);

export default app;
