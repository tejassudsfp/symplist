import { createApp } from "./app.ts";

const app = await createApp();
await app.listen(Number(process.env.PORT ?? 4000), "0.0.0.0");
