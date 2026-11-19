import { databaseTransport } from "./scripts/db-transport.cjs";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ? databaseTransport(process.env.DATABASE_URL).libpqUrl : "",
  },
});
