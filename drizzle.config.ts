import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/db/schema.ts", "./src/db/auth-schema.ts"],
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./dev.sqlite",
  },
});
