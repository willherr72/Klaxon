import { defineApp } from "convex/server";
import auth from "@convex-dev/auth/convex.config";
import username from "@convex-dev/auth/components/username/convex.config";
import password from "@convex-dev/auth/components/password/convex.config";

const app = defineApp();
app.use(auth);
app.use(username);
app.use(password);
export default app;
