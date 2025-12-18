import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import type { ApiResponse } from "shared/dist";

export const app = new Hono()

  .use(cors())

  .get("/", (c) => {
    return c.text("Hello Hono!");
  })

  .get("/hello", async (c) => {
    const data: ApiResponse = {
      message: "Hello BHVR!",
      success: true,
    };

    return c.json(data, { status: 200 });
  });

app.use('*', serveStatic({ root: '../client/dist' }))
app.get('*', serveStatic({ path: '../client/dist/index.html' }))


export default {
  port: Number(process.env.PORT) || 3000,
  hostname: '0.0.0.0',
  fetch: app.fetch,
};

