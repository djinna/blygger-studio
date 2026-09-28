import { routes } from "./contract/routes.ts";
import { contractApp } from "./contract/app.ts";
import { verifyPostToken, verifySession } from "./auth.ts";
import { api } from "./api.ts";
import { importerApi } from "./importer/api.ts";
import { mentionsApi } from "./mentions/api.ts";
import spec from "../openapi.json";
import { readApi } from "./read-api.ts";

export const ownerApi = contractApp();
ownerApi.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  // The quick-post endpoint alone also accepts the scoped POST_TOKEN bearer.
  const path = c.req.path.replace(/\/+$/, "");
  if (path === "/api/post" && c.req.method === "POST" && (await verifyPostToken(c.env, c.req.header("authorization")))) {
    return next();
  }
  if (!(await verifySession(c.env, c.req.header("cookie")))) return c.json({ error: "unauthorized" }, 401);
  return next();
});
ownerApi.route("/", api);
ownerApi.route("/", importerApi);
ownerApi.route("/", mentionsApi);
ownerApi.route("/", readApi);

ownerApi.get("/openapi.json", (c) => c.json(spec));

ownerApi.all("*", (c) => {
  const path = c.req.path.replace(/^\/api(?=\/|$)/, "");
  const methods = Object.values(routes).filter((route) => new RegExp(`^${route.path.replace(/\{\w+\}/g, "[^/]+")}/?$`).test(path)).map((route) => route.method.toUpperCase());
  if (methods.length) {
    c.header("Allow", [...new Set(methods.flatMap((method) => method === "GET" ? ["GET", "HEAD"] : [method]))].join(", "));
    return c.json({ error: "method not allowed" }, 405);
  }
  return c.json({ error: "not found" }, 404);
});
