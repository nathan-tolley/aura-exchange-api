import type { FastifyInstance } from "fastify";
import { maybeOne, pool } from "../db.js";
import { appError } from "../errors.js";
import type { AppUserRow } from "../services/login-code-service.js";
import { serializeUser } from "./serialize.js";
import { membershipsOf } from "./views.js";

export async function registerMeRoutes(v1: FastifyInstance): Promise<void> {
  v1.get("/me", async (request) => {
    const user = await maybeOne<AppUserRow>(pool,
      "SELECT id,email::text,display_name,username::text,created_at FROM users WHERE id=$1",
      [request.v1User!.id]
    );
    if (!user) throw appError("AUTH_EXPIRED", {}, "This account no longer exists");
    return { user: serializeUser(user), memberships: await membershipsOf(pool, user.id) };
  });
}
