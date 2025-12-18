import { hc } from "hono/client";
import type { api } from "./index";

export type AppType = typeof api;
export type Client = ReturnType<typeof hc<AppType>>;

export const hcWithType = (...args: Parameters<typeof hc>): Client =>
  hc<AppType>(...args);
