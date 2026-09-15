import { startApi } from "./app.ts";

const app = await startApi(process.env);
if (!app) process.exitCode = 1;
